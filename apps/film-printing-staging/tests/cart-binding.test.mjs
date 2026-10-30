import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createJobStore} from '../jobs/service.mjs';
import {createCartBinding,installCartBindingSchema,createCartBindingLedger} from '../checkout/cart-binding.mjs';
import {createCartRefresh} from '../checkout/refresh.mjs';
import {createCheckoutProjector} from '../checkout/projector.mjs';
import {inspectCart} from '../checkout/authority.js';
import {scenario} from '../../../fixtures/film-printing/f06p-candidate/synthetic.mjs';
import {fixture as refreshFixture,owner,id} from '../../../fixtures/film-printing/f06c-continuation/synthetic.mjs';

// External positives are synthetic. Tests never contact a cart, owner or store.
async function setup(t,path=':memory:') {
 const s=createJobStore(path,{bindingCandidate:true});t.after(()=>s.close());
 const cart={id:'gid://shopify/Cart/synthetic?key=synthetic-key',owner:'synthetic-owner',binding_id:'synthetic-binding-0001',customer_id:null,complete:true,lines:[]};
 let value=null,writes=0,beforeWrite=async()=>{},beforeRead=async()=>{};
 const admin={reconcile:async()=>{const op=s.lifecycle.startRecovery();s.lifecycle.finish(op);}};
 const adapter=createCartBinding({ledger:s.cartBinding,bindCurrent:async()=>structuredClone(cart),readMarker:async()=>{await beforeRead();return value;},writeMarker:async(c,m)=>{writes++;await beforeWrite(c,m);value=m;},admin,enabled:true});
 return {s,cart,admin,adapter,get value(){return value;},set value(v){value=v;},get writes(){return writes;},set beforeWrite(v){beforeWrite=v;},set beforeRead(v){beforeRead=v;}};
}
test('V2 marker installation is disabled by default and no claimed locator is approval',async t=>{
 const f=await setup(t);await assert.rejects(createCartBinding({}).install({}),/DISABLED/);
 await assert.rejects(f.adapter.observe(f.cart),/REBIND/);assert.equal(f.writes,0);
 assert.deepEqual(await f.adapter.install({}),{installed:true,cart_verified:false,checkout_ready:false});
 assert.match(f.value,/^[a-f0-9]{64}$/);assert.deepEqual(await f.adapter.observe(f.cart),{marker:f.value});
 await assert.rejects(f.adapter.install({}),/SPENT/);assert.equal(f.writes,1);
});
test('V2 initial existing marker is never adopted or overwritten, even a well-formed one',async t=>{
 const f=await setup(t);f.value='a'.repeat(64);
 await assert.rejects(f.adapter.install({}),/ALREADY_PRESENT/);assert.equal(f.writes,0);
 await assert.rejects(f.adapter.install({}),/SPENT/);await assert.rejects(f.adapter.observe(f.cart),/UNAVAILABLE/);
});
test('V2 stable marker rejects foreign cart/owner, identity or customer changes, missing and conflicting values',async t=>{
 const f=await setup(t);await f.adapter.install({});
 for(const patch of [{id:f.cart.id+'x'},{owner:'other'},{binding_id:'new-binding-0002'},{customer_id:'gid://shopify/Customer/1'}])
  await assert.rejects(f.adapter.observe({...f.cart,...patch}),/REBIND/);
 for(const value of [null,'bad','b'.repeat(64)]){f.value=value;await assert.rejects(f.adapter.observe(f.cart),/UNAVAILABLE/);}
 assert.equal(f.writes,1);
});
test('V2 unknown write is terminal, cannot be retried or revived by a late successful write',async t=>{
 const f=await setup(t);let sent;
 f.beforeWrite=async(c,m)=>{sent=m;throw Error('lost response');};
 await assert.rejects(f.adapter.install({}),/lost response/);assert.equal(f.writes,1);
 f.value=sent;await assert.rejects(f.adapter.observe(f.cart),/UNAVAILABLE/);
 await assert.rejects(f.adapter.install({}),/SPENT/);assert.equal(f.writes,1);
});
test('V2 retirement or newer lifecycle epoch during installation fences confirmation',async t=>{
 for(const cause of ['owner','epoch']){
  const f=await setup(t);f.beforeWrite=async()=>{
   if(cause==='owner')f.s.revoke({id:'retire-owner',kind:'owner',owner:f.cart.owner});
   else {const op=f.s.lifecycle.startRecovery();f.s.lifecycle.finish(op);}
  };
  await assert.rejects(f.adapter.install({}),/PENDING|FENCED|REVOKED/);
  await assert.rejects(f.adapter.observe(f.cart));assert.equal(f.writes,1);
 }
});
test('V2 readback mismatch and cart change cannot confirm a marker',async t=>{
 for(const cause of ['readback','cart']){
  const f=await setup(t);f.beforeWrite=async()=>{if(cause==='cart')f.cart.lines.push({id:'changed'});else f.beforeRead=async()=>{f.value='c'.repeat(64);};};
  await assert.rejects(f.adapter.install({}),/CHANGED/);await assert.rejects(f.adapter.observe(f.cart));
 }
});
test('V2 crash journal and retained job history survive local opt-in without reset or retry',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'bfl-binding-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'jobs.sqlite');
 let s=createJobStore(path);s.recordUpload('old-owner',{id:'old-asset',state:'complete',verified:true,url:'https://example.invalid/a'});
 s.lifecycle.event('old-event',{old:true},()=>{});s.close();
 let db=new DatabaseSync(path);const prior=db.prepare('SELECT * FROM uploads').all(),events=db.prepare('SELECT * FROM authority_events').all();
 installCartBindingSchema(db);assert.deepEqual(db.prepare('SELECT * FROM uploads').all(),prior);assert.deepEqual(db.prepare('SELECT * FROM authority_events').all(),events);db.close();
 s=createJobStore(path,{bindingCandidate:true});let op=s.lifecycle.startRecovery();s.lifecycle.finish(op);
 const cart={id:'gid://shopify/Cart/crash?key=synthetic-key',owner:'crash-owner',binding_id:'binding-0001',customer_id:null,complete:true};
 const marker=s.cartBinding.reserve(cart);op=s.lifecycle.startRecovery();s.lifecycle.finish(op);s.cartBinding.sending(cart,marker);s.close();
 s=createJobStore(path,{bindingCandidate:true});assert.throws(()=>s.cartBinding.reserve(cart),/SPENT/);assert.throws(()=>s.cartBinding.observe(cart,marker),/UNAVAILABLE/);
 s.cartBinding.retire(marker);assert.ok(s.lifecycle.state().pending);s.close();
 db=new DatabaseSync(path,{readOnly:true});assert.equal(db.prepare('SELECT state FROM cart_checkout_bindings').get().state,'retired');
 assert.deepEqual(db.prepare('SELECT * FROM uploads').all(),prior);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM authority_events WHERE id=?').get('old-event').n,1);db.close();
});
test('V2 direct-content equivalence uses target-local output IDs but old schema/missing binding denies',async t=>{
 const f=await scenario();t.after(()=>f.store.close());
 const {cartTransformRun}=await import('../checkout/functions.js');
 f.input.cart.lines[0].id='gid://shopify/CartLine/current-target-42';
 assert.equal(cartTransformRun(f.input).operations[0].lineUpdate.cartLineId,f.input.cart.lines[0].id);
 f.input.cart.lines[0].quantity=9;assert.equal(inspectCart(f.input).valid,false);
 f.input.cart.lines[0].quantity=4;assert.equal(inspectCart(f.input).valid,true);
 f.input.cart.binding=null;assert.equal(inspectCart(f.input).valid,false);
});
test('V2 preparation composes real refresh generations and binding; publication cannot use old ID callback',async t=>{
 const f=await refreshFixture({publicationEnabled:false});t.after(()=>f.store.close());
 // Synthetic marker observation injected at the same trusted seam as real
 // ledger.observe. No Function identity verifier is created for V2.
 const cartBinding={observe:async()=>({marker:'a'.repeat(64)})};
 let captured;
 const original=f.store.cartRefresh.stage;f.store.cartRefresh.stage=(ticket,cart,value)=>{captured=JSON.parse(value);return original(ticket,cart,value);};
 const options={store:f.store,jobs:f.jobs,admin:f.admin,readCart:f.readCart,verifyOwnership:f.verify,cartBinding,now:()=>Date.parse('2026-10-21T12:00:00Z')};
 const run=createCartRefresh(options);assert.equal((await run({owner,cart_id:id,request_key:'bound-refresh-0001'})).state,'prepared');
 assert.equal(captured.schema,2);assert.equal(captured.grants[0].generation,1);assert.equal(captured.grants[0].binding,'a'.repeat(64));assert.equal('id' in captured.grants[0].lines[0],false);
 const publish=createCartRefresh({...options,publicationEnabled:true,verifyFunctionIdentity:async()=>{throw Error('must not call');}});
 await assert.rejects(publish({owner,cart_id:id,request_key:'bound-refresh-0002'}),/BINDING_INTEGRATION_UNPROVEN/);
 assert.equal(f.grants().length,0);
});
test('V2 recorded owner/job/order/upload retirements reject fresh authority after equivalent restoration',async t=>{
 for(const kind of ['owner','job','order','upload']){
  const f=await scenario();t.after(()=>f.store.close());
  if(kind==='upload')f.store.recordUpload(f.cart.owner,{id:'asset-0001',state:'removed'});
  else f.store.revoke({id:`retire-${kind}`,kind,owner:f.cart.owner,references:[f.preparations[0].reference]});
  await assert.rejects(f.projector.prepare({}),/PENDING/);
  const op=f.store.lifecycle.startRecovery();f.store.lifecycle.finish(op); // synthetic exact-clear acknowledgment only
  await assert.rejects(f.projector.prepare({}),/REVOKED|UNAVAILABLE|RETIRED/);
 }
});
