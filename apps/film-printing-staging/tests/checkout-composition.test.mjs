import test from 'node:test';
import assert from 'node:assert/strict';
import {rig,id,deferred} from '../../../fixtures/film-printing/f06p-composition/rig.mjs';
import {createCheckoutComposition} from '../checkout/composition.mjs';
import {openCartCapability} from '../checkout/cart-capability.mjs';

async function bound(t){const f=rig(t),token=f.issue();await f.bind(token);return {...f,token};}
async function installed(t){const f=await bound(t);await f.install(f.token);return f;}

test('real new-owner proof, encrypted full capability, fresh post-clear marker and job/projector preparation',async t=>{
 const f=await installed(t),job=await f.addJob(f.token);const result=await f.prepare(f.token);
 assert.equal(result.state,'prepared');assert.equal(result.checkout_ready,false);assert.equal(result.cart_verified,false);
 assert.equal(f.state.checks,1);assert.equal(f.state.markerWrites,1);
 assert.equal(openCartCapability(f.rows('checkout_capability_attempts')[0].sealed_cart,f.config.sessionSecret),id);
 assert.equal(f.rows('cart_job_bindings')[0].job_id,job.reference.id);
 assert.equal(f.rows('cart_owner_admissions').length,0);assert.equal(f.rows('cart_capability_attempts').length,0);
 assert.deepEqual(JSON.parse(f.m.data.shop.authority.value).grants,[]);
});

test('composition default closes every action before transport',async t=>{
 const f=await bound(t),closed=createCheckoutComposition({...f.options,enabled:undefined});
 for(const action of ['bind','observe','install','prepare'])await assert.rejects(closed[action](f.input(f.token)),/DISABLED/);
 assert.equal(f.state.markerWrites,0);assert.equal(f.state.checks,1);
});

test('fresh content edit remains owned; old snapshot is not replayed and fresh preparation uses current quantity',async t=>{
 const f=await installed(t);await f.addJob(f.token);await f.prepare(f.token);
 f.state.cart.lines.nodes[0].quantity=5;f.state.cart.totalQuantity=5;f.state.cart.lines.nodes[0].cost.subtotalAmount.amount='6.00';
 assert.equal((await f.composition.observe(f.input(f.token))).owned,true);
 assert.equal((await f.prepare(f.token,'refresh-request-0002')).state,'prepared');
 assert.equal(f.rows('cart_refresh_requests').length,2);assert.equal(f.state.checks,1);assert.equal(f.state.markerWrites,1);
 f.state.cart.lines.nodes=[];f.state.cart.totalQuantity=0;
 assert.equal((await f.prepare(f.token,'refresh-request-0003')).state,'revoked');
});

test('post-clear proof must be newly exchanged at that epoch; pre-clear proof cannot install or prepare',async t=>{
 const f=await bound(t),old=f.input(f.token);
 await assert.rejects(f.composition.install(f.input(f.token),{freshContext:()=>old}),/FENCED/);
 assert.equal(f.state.markerWrites,0);assert.equal(f.rows('cart_checkout_bindings')[0].state,'retired');
 const g=await installed(t);await g.addJob(g.token);const stale=g.input(g.token);
 await assert.rejects(g.composition.prepare(g.input(g.token),{request_key:'refresh-stale-0001',freshContext:()=>stale}),/FENCED/);
 assert.equal(g.rows('cart_refresh_requests')[0].state,'invalidated');
});

test('absent, foreign, replayed, expired and changed-customer proof cannot observe',async t=>{
 const f=await installed(t),other=f.issue(),p=f.input(f.token);
 await assert.rejects(f.composition.observe({...p,request:f.request()}),/REJECTED/);
 await assert.rejects(f.composition.observe({...p,request:f.request(other)}),/UNAVAILABLE/);
 await f.composition.observe(p);await assert.rejects(f.composition.observe(p),/REJECTED/);
 const stale=f.input(f.token);f.clock.time+=30001;await assert.rejects(f.composition.observe(stale),/REJECTED/);
 await assert.rejects(f.composition.observe(f.input(f.token,id,'123')),/CUSTOMER_PROOF_UNAVAILABLE/);
});

test('copied capability, changed key, copied marker and account change cannot establish another owner/cart',async t=>{
 const f=await installed(t),other=f.issue();await assert.rejects(f.bind(other),/REPLAY/);
 await assert.rejects(f.composition.observe(f.input(f.token,id+'x')),/OWNER_REJECTED/);
 f.state.marker='b'.repeat(64);await assert.rejects(f.composition.observe(f.input(f.token)),/UNAVAILABLE/);
 f.state.cart.buyerIdentity.customer={id:'gid://shopify/Customer/123'};
 await assert.rejects(f.composition.observe(f.input(f.token)),/OWNER_REJECTED/);
});

for(const cause of ['epoch','revoke','renew','age'])test('guards after await reject '+cause,async t=>{
 const f=await installed(t);let done=false;
 f.state.hook=async kind=>{if(kind!=='markerReads'||done)return;done=true;
  const s=f.store.resourceSessions,ticket=s.authenticate(f.request(f.token));
  if(cause==='epoch'){const op=f.store.lifecycle.startRecovery();f.store.lifecycle.finish(op);}
  if(cause==='revoke')s.revoke(ticket);
  if(cause==='renew')s.renew(ticket,f.proofs.observeFreshContext({request:f.request(f.token),proof:f.proof('renew',f.token),action:'renew',ticket}));
  if(cause==='age')f.clock.time+=30001;
 };
 await assert.rejects(f.composition.observe(f.input(f.token)),/FENCED|REJECTED|UNAVAILABLE/);
});

test('lost initial send is permanent across restart and late response cannot complete membership',async t=>{
 const f=rig(t),token=f.issue();f.state.lost=true;await assert.rejects(f.bind(token));
 const before=f.rows('checkout_capability_attempts');assert.equal(before[0].state,'unknown');f.close();
 const g=rig(t,{config:f.config,clock:f.clock,state:f.state});g.state.lost=false;
 assert.deepEqual(g.rows('checkout_capability_attempts'),before);await assert.rejects(g.bind(token),/UNKNOWN/);
 await assert.rejects(g.composition.observe(g.input(token)),/UNAVAILABLE/);assert.equal(g.state.checks,1);
});

test('concurrent installation spends one journal and late marker write cannot revive retirement',async t=>{
 const f=await bound(t),gate=deferred();f.state.hook=async kind=>{if(kind==='markerWrites')await gate.promise;};
 const pending=f.install(f.token);while(!f.state.markerWrites)await new Promise(r=>setImmediate(r));
 await assert.rejects(f.install(f.token),/SPENT/);
 const ticket=f.store.resourceSessions.authenticate(f.request(f.token));f.store.resourceSessions.revoke(ticket);gate.resolve();
 await assert.rejects(pending,/REJECTED/);assert.equal(f.state.markerWrites,1);assert.equal(f.rows('cart_checkout_bindings')[0].state,'retired');
});

for(const kind of ['job','upload','order'])test('recorded '+kind+' retirement prevents restored job preparation',async t=>{
 const f=await installed(t),job=await f.addJob(f.token);await f.prepare(f.token);
 const owner=f.store.resourceSessions.authenticate(f.request(f.token)).owner;
 if(kind==='upload')f.store.recordUpload(owner,{id:'asset-0001',state:'removed'});
 else f.store.revoke({id:'retirement-'+kind,kind,owner,references:[job.reference]});
 await f.admin.reconcile();
 await assert.rejects(f.prepare(f.token,'refresh-retired-0002'),/REVOKED|UNAVAILABLE|RETIRED/);
});

test('missing genuine source fails closed after exact clearing without synthetic grant substitution',async t=>{
 const f=await installed(t);await f.addJob(f.token);f.m.data.currentAppInstallation.catalog=null;
 await assert.rejects(f.prepare(f.token),/SOURCE_UNAVAILABLE|CATALOG|PRICE|CONTEXT/);
 assert.equal(f.rows('cart_refresh_requests')[0].state,'invalidated');assert.deepEqual(JSON.parse(f.m.data.shop.authority.value).grants,[]);
});

test('foreign current owner after clearing and newer concurrent refresh cannot reuse an old action',async t=>{
 const f=await installed(t);await f.addJob(f.token);const other=f.issue();
 await assert.rejects(f.composition.prepare(f.input(f.token),{request_key:'foreign-after-clear',freshContext:()=>f.input(other)}),/OWNER_UNAVAILABLE|FENCED/);
 const gate=deferred();let entered=false;
 const pending=f.composition.prepare(f.input(f.token),{request_key:'concurrent-refresh-a',freshContext:async()=>{entered=true;await gate.promise;return f.input(f.token);}});
 while(!entered)await new Promise(r=>setImmediate(r));
 assert.equal((await f.prepare(f.token,'concurrent-refresh-b')).state,'prepared');
 gate.resolve();await assert.rejects(pending,/STALE/);
 assert.equal(f.rows('cart_refresh_requests').at(-1).state,'prepared');
});

test('credential rotation during completed-job resolution is fenced before staging authority',async t=>{
 const f=await installed(t);await f.addJob(f.token);let rotated=false;
 const original=f.jobs.resolveForCheckout;
 const jobs={...f.jobs,resolveForCheckout:async(...args)=>{
  const result=await original(...args),s=f.store.resourceSessions,ticket=s.authenticate(f.request(f.token));
  s.renew(ticket,f.proofs.observeFreshContext({request:f.request(f.token),proof:f.proof('renew',f.token),action:'renew',ticket}));rotated=true;return result;
 }};
 const c=createCheckoutComposition({...f.options,jobs});
 await assert.rejects(c.prepare(f.input(f.token),{request_key:'rotate-during-project',freshContext:()=>f.input(f.token)}),/REJECTED/);
 assert.equal(rotated,true);assert.equal(f.rows('cart_refresh_requests')[0].state,'invalidated');
 assert.ok(f.rows('authority_preparations').every(r=>r.value_hash===null));
});

test('initial in-flight response after epoch overturn remains unknown without completing ownership',async t=>{
 const f=rig(t),token=f.issue(),gate=deferred();f.state.hook=async kind=>{if(kind==='checks')await gate.promise;};
 const pending=f.bind(token);while(!f.state.checks)await new Promise(r=>setImmediate(r));
 const op=f.store.lifecycle.startRecovery();f.store.lifecycle.finish(op);gate.resolve();
 await assert.rejects(pending,/FENCED/);assert.equal(f.rows('checkout_capability_attempts')[0].state,'unknown');
 assert.equal(f.rows('checkout_owner_admissions')[0].binding_id,null);
});
