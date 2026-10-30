import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes} from 'node:crypto';
import {createLifecycle} from '../jobs/lifecycle.mjs';
import {createResourceSessions,installResourceSchema} from '../backend/resource-session.mjs';
import {STOREFRONT_ORIGIN} from '../backend/storefront-session.mjs';
for(const mode of ['cartOwner','checkoutOwner'])test(`${mode}: durable owner retirement terminalizes only exact member credentials, once, without changing deadlines`,()=>{
 const db=new DatabaseSync(':memory:');try{
  const lifecycle=createLifecycle(db);installResourceSchema(db);
  const membership=mode==='cartOwner'?'cart_owner_admissions':'checkout_owner_admissions';
  db.exec(`CREATE TABLE ${membership}(owner TEXT PRIMARY KEY,created INTEGER,attempt_id TEXT,binding_id TEXT)`);
  let time=1793318400000;const sessions=createResourceSessions(db,lifecycle,()=>time,{[mode]:true});
  const ordinary=createResourceSessions(db,lifecycle,()=>time);
  const issue=service=>{const issued=service.issue({id:randomBytes(32).toString('base64url'),observedAt:time,customerId:null});return service.authenticate({headers:{origin:STOREFRONT_ORIGIN,authorization:`Bearer ${issued.token}`}});};
  const retired=issue(sessions),live=issue(sessions),outsider=issue(ordinary),read=owner=>({...db.prepare('SELECT * FROM resource_sessions WHERE owner=?').get(owner)});
  const before=[retired,live,outsider].map(t=>({...read(t.owner)}));
  for(const ticket of [retired,outsider])lifecycle.event(`owner-retired:${ticket.owner}`,{kind:'owner',owner:ticket.owner},()=>lifecycle.retire('owner',ticket.owner));
  sessions.retireExpiredCartOwners();const changed=read(retired.owner);
  assert.equal(changed.revoked,time);assert.equal(changed.generation,before[0].generation+1);
  for(const key of ['owner','verifier','purpose','audience','created','expires','deadline','observation'])assert.equal(changed[key],before[0][key]);
  assert.deepEqual(read(live.owner),before[1]);assert.deepEqual(read(outsider.owner),before[2]);assert.ok(lifecycle.state().pending>0);
  const state=lifecycle.state();sessions.retireExpiredCartOwners();assert.deepEqual(read(retired.owner),changed);assert.deepEqual(lifecycle.state(),state);
  time=before[1].expires;sessions.retireExpiredCartOwners();assert.equal(read(live.owner).revoked,time);assert.equal(read(live.owner).expires,before[1].expires);assert.deepEqual(read(outsider.owner),before[2]);
 }finally{db.close();}
});
