import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fullRig} from '../../../fixtures/film-printing/f06v3-candidate/full-rig.mjs';
import {prepareEngineeringSources,createEngineeringScope} from '../configuration/engineering.mjs';
import {STORE,APP,CLIENT} from '../configuration/schema.mjs';
import {SHOP,INSTALLATION} from '../backend/config.mjs';
import {leaseDeadline} from '../checkout/lease.mjs';
import {createResourceSession} from '../theme/resource-session.js';
import {quantitySignature} from '../checkout/quantity-signature.js';
import {inspectCart} from '../checkout/authority.js';
const read=name=>JSON.parse(readFileSync(new URL('../../../fixtures/film-printing/full-product-readiness-20261030/'+name,import.meta.url)));
const identity={shop:{id:SHOP,myshopifyDomain:STORE},currentAppInstallation:{id:INSTALLATION,app:{id:APP,apiKey:CLIENT}}};
function scope(start,until){const clock={time:start};return {clock,sourceScope:createEngineeringScope({...prepareEngineeringSources({config:read('engineering-config-proposal.json'),catalog:read('engineering-catalog-proposal.json'),issuedAt:start,until}),identity,now:()=>clock.time})};}
for(const [label,start,zone,deadline] of [
 ['New York midnight','2026-10-30T03:59:00.750Z','America/New_York','2026-10-30T00:59:00'],
 ['UTC year boundary','2026-12-31T23:59:00.750Z','UTC','2027-01-01T00:59:00'],
 ['Tokyo month boundary','2026-10-31T14:59:00.750Z','Asia/Tokyo','2026-11-01T00:59:00'],
])test(`new exact full-product lease crosses ${label} only within its original finite source interval`,()=>{
 const now=Date.parse(start),until=now+3600000,{sourceScope,clock}=scope(now,until);
 const lease=leaseDeadline(until,now,zone,{sourceScope});assert.equal(lease.expires_at,Math.floor(until/1000)*1000);assert.equal(lease.deadline,deadline);
 const original={...lease};clock.time=until;assert.throws(()=>leaseDeadline(until+1000,clock.time,zone,{sourceScope}),/ENGINEERING_EXPIRED/);assert.deepEqual(lease,original);
});
test('legacy midnight cutoff, DST rejection, private source and maximum interval guards stay unchanged',()=>{
 const now=Date.parse('2026-10-30T03:59:00Z'),until=now+3600000,{sourceScope}=scope(now,until);
 assert.equal(leaseDeadline(now+240000,now,'America/New_York').expires_at,Date.parse('2026-10-30T04:00:00Z'));
 assert.throws(()=>leaseDeadline(until,now,'America/New_York',{sourceScope:{kind:'staging_engineering'}}),/ENGINEERING_SCOPE/);
 assert.throws(()=>leaseDeadline(until+1,now,'America/New_York',{sourceScope}),/LEASE_WINDOW/);
 const dst=Date.parse('2026-11-01T05:59:00Z'),transition=scope(dst,dst+3600000);
 assert.throws(()=>leaseDeadline(dst+3600000,dst,'America/New_York',{sourceScope:transition.sourceScope}),/LEASE_TIMEZONE_TRANSITION/);
});
test('accepted A remains priced after shop midnight and B Add uses today’s verified source with the same original lease',async t=>{
 const start=Date.parse('2026-10-30T03:59:00Z'),f=await fullRig(t,{fullProduct:true,initialTime:start});f.m.data.shop.ianaTimezone='America/New_York';
 const session=createResourceSession({fetchImpl:f.browserFetch,now:()=>f.clock.time,preparedMode:true});const act=(name,input={})=>session.checkout(name,async()=>f.ids.A,input);
 await session.issue();await act('bind');await act('install');
 const row=JSON.parse(f.plan.engineering.catalogValue); // Source choices below come from the captured catalog, not invented options.
 const {expandFullProductCatalog}=await import('../pricing/compact-catalog.mjs');const catalog=expandFullProductCatalog(row);
 const chosen=catalog.rows.find(r=>r.service==='darkroom'&&r.size==='12x16'&&r.lab==='chicago');assert(chosen);
 const input={service:'Darkroom Prints',size:chosen.size,paper:chosen.paper_input,lab:'Chicago',copies:1,message:'',options:chosen.options,asset_ids:[]};
 let generation=0;
 async function prepare(){const job=await session.request('/jobs',{...input,request_key:'midnight-job-'+(++generation)});return act('eligible',{reference:job.reference,generation});}
 async function add(p){const state=f.carts.get(f.ids.A),prior=state.cart.lines.nodes.slice();f.addJob({...p.item,properties:{...p.item.properties,_bfl_signature:quantitySignature(p.reference.signature,p.item.quantity)}});const line=state.cart.lines.nodes[0];line.id='gid://shopify/CartLine/midnight-'+generation;line.quantity=p.item.quantity;state.cart.lines.nodes=[...prior,line];f.reprice();return act('resume',{operation:{kind:'add',job:p.reference.id,operation_id:p.reservation.operation_id,quantity:p.item.quantity}});}
 const a=await prepare();await add(a);const before=JSON.parse(f.m.data.shop.authority.value),sessions=f.rows().resource_sessions;
 assert.equal(before.valid_on,'2026-10-29');assert.equal(a.expires_at,start+3600000);
 f.clock.time=Date.parse('2026-10-30T04:01:00Z');f.reprice();assert.equal(inspectCart(f.functionInput(f.carts.get(f.ids.A))).valid,true);
 const resumed=await act('resume');assert.equal(resumed.items.length,1);assert.equal(resumed.items[0].subtotal_cents,a.unit_price_cents);assert.equal(resumed.expires_at,a.expires_at);
 const b=await prepare();const added=await add(b),after=JSON.parse(f.m.data.shop.authority.value);
 assert.equal(after.valid_on,'2026-10-30');assert.deepEqual(after.lease,before.lease);assert.equal(b.expires_at,a.expires_at);assert.equal(added.items.length,2);assert.equal(added.items.reduce((s,x)=>s+x.subtotal_cents,0),a.unit_price_cents+b.unit_price_cents);
 assert.deepEqual(f.rows().resource_sessions,sessions);assert(!f.journal().some(e=>e.event==='retirement_started'));
 f.clock.time=a.expires_at;f.reprice();assert.equal(inspectCart(f.functionInput(f.carts.get(f.ids.A))).valid,false);await assert.rejects(act('resume'));assert.equal(f.rows().resource_sessions.length,1);
});
