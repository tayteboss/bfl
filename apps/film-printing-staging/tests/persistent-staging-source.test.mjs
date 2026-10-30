import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes} from 'node:crypto';
import {preparePersistentStagingSources,createPersistentStagingScope,createEngineeringScope,assertEngineeringScope,revokeEngineeringScope} from '../configuration/engineering.mjs';
import {preparedPolicy,preparedOwnerPolicy} from '../checkout/prepared-limits.mjs';
import {verifyRelease} from '../configuration/config.mjs';
import {createLifecycle} from '../jobs/lifecycle.mjs';
import {installResourceSchema,createResourceSessions} from '../backend/resource-session.mjs';
import {STOREFRONT_ORIGIN} from '../backend/storefront-session.mjs';
import {leaseDeadline} from '../checkout/lease.mjs';
import {STORE,APP,CLIENT} from '../configuration/schema.mjs';
import {SHOP,INSTALLATION} from '../backend/config.mjs';
const read=name=>JSON.parse(readFileSync(new URL('../../../fixtures/film-printing/full-product-lab-routing-20261030/'+name,import.meta.url)));
const identity={shop:{id:SHOP,myshopifyDomain:STORE},currentAppInstallation:{id:INSTALLATION,app:{id:APP,apiKey:CLIENT}}};
function setup(start=Date.parse('2026-10-30T05:00:00Z')){const clock={time:start},source=preparePersistentStagingSources({config:read('engineering-config-proposal.json'),catalog:read('engineering-catalog-proposal.json'),issuedAt:start});return {clock,source,scope:createPersistentStagingScope({...source,identity,now:()=>clock.time})};}
test('persistent exact source remains available on a later client visit without extending an experiment',()=>{
 const f=setup();assert.equal(f.source.contract.expires_at,undefined);assert.equal(preparedPolicy(f.scope).clientPolicy,'bfl-persistent-staging-client-v1');
 f.clock.time+=30*86400000;assert.equal(verifyRelease(JSON.parse(f.source.releaseValue),{sourceScope:f.scope}).sha256,JSON.parse(f.source.releaseValue).sha256);
 assert.throws(()=>createEngineeringScope({...f.source,identity}),/ENGINEERING_TARGET/);
 assert.throws(()=>verifyRelease(JSON.parse(f.source.releaseValue)),/ENGINEERING_SCOPE/);
 assert.throws(()=>createPersistentStagingScope({...f.source,identity:{...identity,shop:{...identity.shop,myshopifyDomain:'production.myshopify.com'}}}),/PERSISTENT_STAGING_TARGET/);
 const config=read('engineering-config-proposal.json');config.packages[0].weight_status='confirmed';assert.throws(()=>preparePersistentStagingSources({config,catalog:read('engineering-catalog-proposal.json'),issuedAt:1}));
 revokeEngineeringScope(f.scope);assert.throws(()=>assertEngineeringScope(f.scope),/ENGINEERING_EXPIRED/);assertEngineeringScope(f.scope,'protect');
});
test('new visits receive independent original 24h deadlines; old owners never gain the policy',()=>{
 const f=setup(),db=new DatabaseSync(':memory:');try{
 const lifecycle=createLifecycle(db);installResourceSchema(db);db.exec('CREATE TABLE checkout_owner_admissions(owner TEXT PRIMARY KEY,created INTEGER,attempt_id TEXT,binding_id TEXT)');
 const sessions=createResourceSessions(db,lifecycle,()=>f.clock.time,{checkoutOwner:true}),proof=()=>({id:randomBytes(32).toString('base64url'),observedAt:f.clock.time,customerId:null}),request=token=>({headers:{origin:STOREFRONT_ORIGIN,authorization:'Bearer '+token}});
 const old=sessions.issue(proof(),{ttlMs:600000}),oldTicket=sessions.authenticate(request(old.token)),oldRow={...sessions.assert(oldTicket)};
 const first=sessions.issue(proof(),{ttlMs:86400000,sourceScope:f.scope}),ticket=sessions.authenticate(request(first.token)),row={...sessions.assert(ticket)};
 assert.equal(first.expires_in,86400);assert.equal(row.expires,f.clock.time+86400000);assert.equal(row.deadline,row.expires);assert.equal(preparedOwnerPolicy(db,oldTicket.owner,f.scope).clientPolicy,null);assert.deepEqual({...sessions.assert(oldTicket)},oldRow);
 assert.throws(()=>sessions.renew(ticket,proof()),/RESOURCE_SESSION_POLICY/);
 f.clock.time+=86400000;assert.throws(()=>sessions.authenticate(request(first.token)),/RESOURCE_REJECTED/);
 const second=sessions.issue(proof(),{ttlMs:86400000,sourceScope:f.scope}),newTicket=sessions.authenticate(request(second.token));assert.notEqual(ticket.owner,newTicket.owner);assert.equal(sessions.assert(newTicket).expires,f.clock.time+86400000);
 assert.deepEqual({...db.prepare('SELECT * FROM resource_sessions WHERE owner=?').get(ticket.owner)},row);
 }finally{db.close();}
});
for(const [start,end,expected] of [
 ['2026-10-31T12:00:00Z','2026-11-01T12:00:00Z','2026-11-01T12:00:00Z'],
 ['2026-10-31T05:30:00Z','2026-11-01T05:30:00Z','2026-11-01T05:00:00Z'],
 ['2026-10-31T06:30:00Z','2026-11-01T06:30:00Z','2026-11-01T05:00:00Z'],
 ['2026-03-07T12:00:00Z','2026-03-08T12:00:00Z','2026-03-08T12:00:00Z'],
 ])test('persistent deadline is finite and cannot reactivate during DST: '+end,()=>{
 const from=Date.parse(start),until=Date.parse(end),f=setup(from),lease=leaseDeadline(until,from,'America/New_York',{sourceScope:f.scope});assert.equal(lease.expires_at,Date.parse(expected));assert.ok(lease.expires_at<=until);
 const formatter=new Intl.DateTimeFormat('sv-SE',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
 for(let t=lease.expires_at;t<=lease.expires_at+3*3600000;t+=60000)assert.ok(formatter.format(t).replace(' ','T')>=lease.deadline);
});
