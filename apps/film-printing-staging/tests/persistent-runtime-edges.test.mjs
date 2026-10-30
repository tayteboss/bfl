import test from 'node:test';
import assert from 'node:assert/strict';
import {persistentRig} from '../../../fixtures/film-printing/persistent-client-staging-20261030/rig.mjs';
import {quantitySignature} from '../checkout/quantity-signature.js';
import {createResourceSession} from '../theme/resource-session.js';

const darkroom={service:'Darkroom Prints',size:'8” × 10”',paper:'RC Matte',lab:'Chicago',options:{Process:'Color',Borders:'Borderless (Edge-to-edge)',Turnaround:'Standard (4-5 days)','Scanning Options':'Yes',Negatives:'Mail In'},asset_ids:[],copies:1,message:'Persistent edge fixture'};
const photo={service:'Photo Prints',size:'4x6',paper:null,lab:'Miami',copies:1,options:{Turnaround:'Standard (4-5 days)'},message:'Persistent asset fixture'};
const grants=f=>JSON.parse(f.m.data.shop.authority.value);
const plain=value=>JSON.parse(JSON.stringify(value));
const act=(f,role,name,input={})=>f.clients[role].session.checkout(name,async()=>f.ids[role],input);
async function initialize(f,role){await f.clients[role].session.issue();await act(f,role,'bind');await act(f,role,'install');}
async function prepare(f,role,key,generation=1,selection=darkroom){
 const job=await f.clients[role].session.request('/jobs',{...selection,request_key:key});return act(f,role,'eligible',{reference:job.reference,generation});
}
async function accept(f,role,p){
 const state=f.carts.get(f.ids[role]),prior=state.cart.lines.nodes.slice();
 f.addJob({...p.item,properties:{...p.item.properties,_bfl_signature:quantitySignature(p.reference.signature,p.item.quantity)}},role);
 const fresh=state.cart.lines.nodes[0];fresh.id=`gid://shopify/CartLine/${p.reference.id}?cart=generated-edge`;state.cart.lines.nodes=[...prior,fresh];f.reprice(role);
 await act(f,role,'resume',{operation:{kind:'add',job:p.reference.id,operation_id:p.reservation.operation_id,quantity:p.item.quantity}});return p;
}
async function add(f,role,key,generation=1,selection=darkroom){return accept(f,role,await prepare(f,role,key,generation,selection));}
async function upload(f,role,key){const session=f.clients[role].session,file=f.inputFiles[0],intent=await session.request('/uploads/intents',{request_key:key});return session.request(`/uploads/${intent.intent_id}/bytes`,new Blob([file.bytes],{type:file.mime}),{mime:file.mime});}

test('persistent HTTP cancelling A candidate preserves accepted A and all B eligibility across restart',async t=>{
 const f=await persistentRig(t);await initialize(f,'A');const a=await add(f,'A','edge-cancel-a');await initialize(f,'B');const b=await add(f,'B','edge-cancel-b');
 const beforeB=plain(grants(f).grants.find(g=>g.lines.some(line=>line.claims.job===b.reference.id))),sessions=plain(f.rows().resource_sessions);
 const candidate=await prepare(f,'A','edge-cancel-candidate',2);assert.equal(grants(f).grants.reduce((n,g)=>n+g.lines.length,0),3);
 const cancelled=await act(f,'A','cancel_preparation',{reservation:candidate.reservation});assert.equal(cancelled.cancelled,true);assert.equal(cancelled.expires_at,a.expires_at);
 assert.deepEqual(grants(f).grants.find(g=>g.lines.some(line=>line.claims.job===b.reference.id)),beforeB);assert.equal(grants(f).grants.reduce((n,g)=>n+g.lines.length,0),2);
 assert.equal((await act(f,'A','resume')).items[0].subtotal_cents,4800);assert.equal((await act(f,'B','resume')).items[0].subtotal_cents,4800);
 const writes=f.counts.admin_mutations;await f.restart();assert.equal(f.counts.admin_mutations,writes);assert.deepEqual(plain(f.rows().resource_sessions),sessions);
 assert.equal((await act(f,'B','resume')).items[0].subtotal_cents,4800);assert.equal(f.rows().cart_prepared_jobs.find(row=>row.job_id===candidate.reference.id).state,'cancelled');
});

test('persistent HTTP original 24h expiry retires A while later B keeps original remaining hour',async t=>{
 const f=await persistentRig(t);await initialize(f,'A');const a=await add(f,'A','edge-expiry-a');f.clock.time+=3600000;
 await initialize(f,'B');const b=await add(f,'B','edge-expiry-b'),sessionB=plain(f.rows().resource_sessions.find(row=>row.expires===b.expires_at));
 const originalB=plain(grants(f).grants.find(g=>g.lines.some(line=>line.claims.job===b.reference.id)));assert.equal(b.expires_at-a.expires_at,3600000);
 f.clock.time=a.expires_at;await f.runtime.tick();assert.deepEqual(grants(f).grants,[originalB]);assert.equal(grants(f).lease.expires_at,b.expires_at);
 assert.equal((await act(f,'B','resume')).items[0].subtotal_cents,4800);assert.deepEqual(plain(f.rows().resource_sessions.find(row=>row.owner===sessionB.owner)),sessionB);
 await assert.rejects(act(f,'A','resume'));await f.restart();assert.equal((await act(f,'B','resume')).items[0].subtotal_cents,4800);
});

test('persistent HTTP expired empty cart replaces once with new owner while preserving original history and another cart',async t=>{
 const f=await persistentRig(t),saved=new Map(),reloadStorage={getItem:key=>saved.get(key)??null,setItem:(key,value)=>saved.set(key,value)};
 const fresh=()=>createResourceSession({fetchImpl:f.browserFetch,now:()=>f.clock.time,preparedMode:true,clientPolicy:'bfl-persistent-staging-client-v1',reloadStorage});
 f.clients.A.session=fresh();await initialize(f,'A');const a=await add(f,'A','edge-replace-a');
 f.carts.get(f.ids.A).cart.lines.nodes=[];f.reprice('A');await act(f,'A','resume',{operation:{kind:'remove',job:a.reference.id,operation_id:'edge-empty-a',quantity:0}});f.clients.A.session.checkpoint();
 const original=plain(f.rows().resource_sessions[0]);f.clock.time+=3600000;await initialize(f,'B');const b=await add(f,'B','edge-replace-b');
 f.clock.time=a.expires_at;await f.runtime.tick();f.clients.A.session=fresh();
 const replacement=await f.clients.A.session.replaceSession(f.ids.A);assert.equal(replacement.replaced,true);assert.equal(replacement.expires_at,f.clock.time+86400000);
 await act(f,'A','bind');await act(f,'A','install');f.clients.A.session.checkpoint('initialized');await add(f,'A','edge-replace-new-a');
 const old=f.rows().resource_sessions.find(row=>row.owner===original.owner);assert.equal(old.expires,original.expires);assert.equal(old.deadline,original.deadline);assert.equal(old.verifier,original.verifier);
 assert.equal(f.rows().staging_binding_history.length,1);assert.equal(f.rows().staging_cart_replacements.length,1);assert.equal(f.rows().resource_sessions.length,3);
 assert.equal((await act(f,'B','resume')).items[0].subtotal_cents,4800);assert.ok(grants(f).grants.some(g=>g.lines.some(line=>line.claims.job===b.reference.id)));
});

test('persistent HTTP lost publication response is fenced across SQLite restart without replaying its candidate',async t=>{
 const f=await persistentRig(t);await initialize(f,'A');let lost=false;
 f.hook=async(stage,{query,variables}={})=>{if(stage==='after_admin'&&query?.startsWith('mutation')&&!lost){const authority=variables?.fields?.find(field=>field.key==='authority');if(authority&&JSON.parse(authority.value).grants.length){lost=true;throw Error('generated lost publication response');}}};
 await assert.rejects(prepare(f,'A','edge-lost-publication'));assert.equal(lost,true);const before=f.rows(),uncertain=before.cart_prepared_jobs[0];assert.equal(uncertain.state,'uncertain');
 assert.equal(before.staging_grant_publication[0].pending!==null,true);f.hook=null;await f.restart();
 assert.equal(grants(f).grants.length,0);assert.equal(f.rows().cart_prepared_jobs[0].state,'uncertain');assert.equal(f.rows().staging_grant_publication[0].pending,null);
 const writes=f.counts.admin_mutations;await f.runtime.tick();await f.restart();assert.equal(f.counts.admin_mutations,writes);assert.equal(f.rows().cart_prepared_jobs.length,1);
 assert.equal(f.rows().staging_grant_versions.at(-1).state,'suspended');
});

test('persistent HTTP removed provider asset fences only A and restores valid uploaded B under its original deadline',async t=>{
 const f=await persistentRig(t);await initialize(f,'A');const assetA=await upload(f,'A','edge-asset-upload-a'),a=await add(f,'A','edge-asset-job-a',1,{...photo,asset_ids:[assetA.asset_id]});
 await initialize(f,'B');const assetB=await upload(f,'B','edge-asset-upload-b'),b=await add(f,'B','edge-asset-job-b',1,{...photo,asset_ids:[assetB.asset_id]});
 const beforeB=plain(grants(f).grants.find(g=>g.lines.some(line=>line.claims.job===b.reference.id)));
 f.hook=async(stage,{url,body}={})=>{if(stage==='provider_info'&&url===`https://api.uploadcare.com/files/${assetA.asset_id}/`)body.datetime_removed='2026-10-30T05:01:01Z';};
 f.clock.time+=61000;await f.runtime.tick();assert.deepEqual(grants(f).grants,[beforeB]);assert.equal(grants(f).lease.expires_at,b.expires_at);
 assert.equal(f.rows().upload_intents.find(row=>row.asset===assetA.asset_id).state,'removed');assert.equal(f.rows().upload_intents.find(row=>row.asset===assetB.asset_id).state,'complete');
 assert.equal((await act(f,'B','resume')).items[0].subtotal_cents,40);await assert.rejects(act(f,'A','resume'));assert.equal(f.rows().jobs.length,2);
});

test('live maintenance fences a lost publication and admits a new client without replaying or reviving prior carts',async t=>{
 const f=await persistentRig(t);await initialize(f,'B');const b=await add(f,'B','edge-live-known-b');await initialize(f,'A');let lost=false,candidate;
 f.hook=async(stage,{query,variables}={})=>{if(stage==='after_admin'&&query?.startsWith('mutation')&&!lost){const value=variables?.fields?.find(field=>field.key==='authority')?.value;if(value&&JSON.parse(value).grants.length){candidate=value;lost=true;throw Error('generated lost publication response');}}};
 await assert.rejects(prepare(f,'A','edge-live-unknown-a'));assert.equal(lost,true);const original=plain(f.rows().resource_sessions),uncertain=f.rows().cart_prepared_jobs.find(row=>row.job_id!==b.reference.id);f.hook=null;
 await f.runtime.tick();assert.equal(f.runtime.status().phase,'admitting');assert.equal(grants(f).grants.length,0);assert.equal(f.rows().authority_state[0].operation,null);assert.equal(f.rows().staging_grant_publication[0].pending,null);
 assert.equal(f.rows().cart_prepared_jobs.find(row=>row.operation_id===uncertain.operation_id).state,'uncertain');assert.deepEqual(plain(f.rows().resource_sessions),original);
 const heads=new Map(f.rows().staging_grant_versions.map(row=>[row.owner,row]));assert.equal(heads.size,2);for(const row of heads.values())assert.equal(row.state,'suspended');
 assert.equal(f.m.writes.filter(fields=>fields.find(field=>field.key==='authority')?.value===candidate).length,1);await assert.rejects(act(f,'A','resume'));
 f.ids.C='gid://shopify/Cart/generated-live-C?key=private-generated-C';f.carts.set(f.ids.C,{cart:{...structuredClone(f.carts.get(f.ids.A).cart),id:f.ids.C},marker:null});
 f.clients.C={session:createResourceSession({fetchImpl:f.browserFetch,now:()=>f.clock.time,preparedMode:true,clientPolicy:'bfl-persistent-staging-client-v1'})};
 await initialize(f,'C');const c=await add(f,'C','edge-live-fresh-c');assert.equal(grants(f).grants.length,1);assert.equal(grants(f).grants[0].lines[0].claims.job,c.reference.id);assert.equal((await act(f,'C','resume')).items[0].subtotal_cents,4800);
 assert.equal(f.m.writes.filter(fields=>fields.find(field=>field.key==='authority')?.value===candidate).length,1);assert.equal(f.rows().cart_prepared_jobs.find(row=>row.operation_id===uncertain.operation_id).state,'uncertain');
});

test('multi-image maintenance uses four bounded provider reads and preserves accepted pricing',async t=>{
 const f=await persistentRig(t);await initialize(f,'A');const assets=[];
 for(let i=0;i<10;i++)assets.push((await upload(f,'A',`edge-parallel-upload-${i}`)).asset_id);
 await add(f,'A','edge-parallel-job',1,{...photo,asset_ids:assets});
 let active=0,peak=0,reads=0;
 f.hook=async(stage,{url}={})=>{if(stage==='provider_info'&&url.includes('/files/')){active++;reads++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,10));active--;}};
 f.clock.time+=61000;await f.runtime.tick();assert.equal(reads,10);assert.equal(peak,4);assert.equal(active,0);
 assert.equal(f.rows().upload_intents.filter(row=>row.state==='complete').length,10);
 assert.equal((await act(f,'A','resume')).items[0].subtotal_cents,400);
});
