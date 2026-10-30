import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {createPersistentCartCoordinator,mountPersistentCustomer,readPersistentNativeCart} from '../theme/persistent-cart.js';
import {readNativeCart} from '../theme/native-cart-read.js';
import {createPreparedCheckout} from '../theme/prepared-checkout.js';
import '../theme/film-printing-job.js';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {resolve,reject,promise};};
const cartId='gid://shopify/Cart/cartA?key=secretA';
function locks(){
 const queues=new Map(),held=new Set();
 const pump=name=>{
  const queue=queues.get(name);if(held.has(name)||!queue?.length)return;
  const row=queue.shift();if(row.signal.aborted){row.reject(row.signal.reason);pump(name);return;}
  held.add(name);row.signal.removeEventListener('abort',row.abort);
  Promise.resolve().then(row.work).then(row.resolve,row.reject).finally(()=>{held.delete(name);pump(name);});
 };
 return {held,request(name,{signal},work){return new Promise((resolve,reject)=>{
  if(signal.aborted){reject(signal.reason);return;}
  const row={signal,work,resolve,reject};row.abort=()=>{const queue=queues.get(name),index=queue.indexOf(row);if(index>=0)queue.splice(index,1);reject(signal.reason);};
  signal.addEventListener('abort',row.abort,{once:true});const queue=queues.get(name)??[];queue.push(row);queues.set(name,queue);pump(name);
 });}};
}
async function rig(t){
 const events=new EventTarget(),data=new Map(),lock=locks(),storage={getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value),removeItem:key=>data.delete(key)};
 const c=await createPersistentCartCoordinator({cartId,storage,locks:lock,events,cryptoImpl:webcrypto});t.after(()=>c.dispose());return {c,data,lock,events,storage};
}

test('another tab acquisition has a 30 second bound, preserves custody and never enters its action',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const {c,data,lock,storage}=await rig(t),gate=deferred();let writes=0;
 const other=await createPersistentCartCoordinator({cartId,storage,locks:lock,events:new EventTarget(),cryptoImpl:webcrypto});t.after(()=>other.dispose());
 const retained='{"state":"pending","operation":{"kind":"add","operation_id":"spent"}}';
 const first=c.run(async()=>{c.storage.setItem(c.key,retained);await gate.promise;});await tick();
 const queued=other.run(()=>{writes++;c.storage.setItem(c.key,'must not write');});const rejected=assert.rejects(queued,/PERSISTENT_CART_BUSY/);await tick();
 t.mock.timers.tick(30000);await rejected;assert.equal(data.get(c.key),retained);assert.equal(writes,0);
 gate.resolve();await first;await c.run(()=>{writes++;});assert.equal(writes,1);
});
test('acquisition deadline does not release an active mutation or permit another callback',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const {c,lock}=await rig(t),gate=deferred();let second=false;
 const first=c.run(()=>gate.promise);await tick();t.mock.timers.tick(120000);await tick();assert.equal(lock.held.size,1);
 const next=c.run(()=>{second=true;});await tick();assert.equal(second,false);gate.resolve();await first;await next;assert.equal(second,true);
});
test('pagehide cancels queued operations but retains active lock and exact pending custody',async t=>{
 const {c,data,events,lock}=await rig(t),gate=deferred();const retained='{"state":"pending","operation":null}';let later=false;
 const first=c.run(async()=>{c.storage.setItem(c.key,retained);await gate.promise;});await tick();
 const next=c.run(()=>{later=true;});const rejected=assert.rejects(next,/PERSISTENT_CART_UNAVAILABLE/);await tick();events.dispatchEvent(new Event('pagehide'));await rejected;
 assert.equal(c.signal.aborted,true);assert.equal(lock.held.size,1);assert.equal(data.get(c.key),retained);assert.equal(later,false);
 assert.throws(()=>c.assertCurrent(),/PERSISTENT_CART_UNAVAILABLE/);await assert.rejects(c.run(()=>{}),/PERSISTENT_CART_UNAVAILABLE/);
 gate.resolve();await first;await tick();assert.equal(lock.held.size,0);assert.equal(data.get(c.key),retained);
});
test('native read settles at its deadline even when SDK ignores abort; late completion has no continuation',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const gate=deferred();let reads=0,continued=false,signal;
 const read=readNativeCart({getCart:(_,options)=>{reads++;signal=options.signal;return gate.promise;}}).then(()=>{continued=true;});
 const rejected=assert.rejects(read,e=>e.message==='NATIVE_CART_TIMEOUT'&&e.readOnlyFailure===true);await tick();t.mock.timers.tick(10000);await rejected;
 assert.equal(reads,1);assert.equal(signal.aborted,true);gate.resolve({cart:{id:cartId}});await tick();assert.equal(continued,false);assert.equal(reads,1);
});
test('pagehide aborts an active read, releases its settled operation, and cannot alter saved custody',async t=>{
 const {c,data,events,lock}=await rig(t),gate=deferred();let readStarted=false,continued=false;
 const retained='{"state":"pending","operation":null}';const work=c.run(async()=>{
  c.storage.setItem(c.key,retained);await readNativeCart({getCart:()=>{readStarted=true;return gate.promise;}},{signal:c.signal});continued=true;c.storage.setItem(c.key,'must not write');
 });const rejected=assert.rejects(work,/PERSISTENT_CART_UNAVAILABLE/);await tick();assert.equal(readStarted,true);events.dispatchEvent(new Event('pagehide'));await rejected;await tick();
 assert.equal(lock.held.size,0);assert.equal(data.get(c.key),retained);gate.resolve({cart:null});await tick();assert.equal(continued,false);
});
test('already disposed read never calls the native SDK',async()=>{
 const stop=new AbortController();stop.abort();let reads=0;await assert.rejects(readNativeCart({getCart:()=>{reads++;}},{signal:stop.signal}),/PERSISTENT_CART_UNAVAILABLE/);assert.equal(reads,0);
});
test('native successful read clears deadline and preserves the exact SDK response',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const result={cart:{id:cartId}},stop=new AbortController();let nativeSignal;
 assert.equal(await readNativeCart({getCart:(_,options)=>{nativeSignal=options.signal;return result;}},{signal:stop.signal}),result);
 t.mock.timers.tick(10000);stop.abort();assert.equal(nativeSignal.aborted,false);
});
test('prepared initialization times out its native read before bind and does not retry it',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const old=globalThis.location;globalThis.location={origin:'https://bellows-film-printing-staging.myshopify.com'};t.after(()=>{globalThis.location=old;});
 let reads=0,writes=0;const session={checkout:()=>{writes++;},request:()=>{writes++;},assertLive(){},beginMutation(){writes++;},preparationGeneration:()=>0,rememberPreparationGeneration(){}};
 const flow=createPreparedCheckout(session,{actions:{getCart:()=>{reads++;return new Promise(()=>{});}},fetchImpl:()=>{writes++;}});
 const first=flow.initialize(),rejected=assert.rejects(first,e=>e.message==='NATIVE_CART_TIMEOUT'&&e.readOnlyFailure===true);await tick();t.mock.timers.tick(10000);await rejected;assert.equal(reads,1);assert.equal(writes,0);
 assert.equal(flow.initialize(),first);await assert.rejects(flow.initialize(),/NATIVE_CART_TIMEOUT/);assert.equal(reads,1);assert.equal(writes,0);
});
test('bounded read/wait errors are actionable, while uncertain cart results still prohibit retry',()=>{
 assert.match(globalThis.BFLPrintJob.customerError(Error('PERSISTENT_CART_BUSY')),/Refresh this page/);
 assert.match(globalThis.BFLPrintJob.customerError(Error('NATIVE_CART_TIMEOUT')),/Refresh this page/);
 assert.match(globalThis.BFLPrintJob.customerError(Object.assign(Error('NATIVE_CART_TIMEOUT'),{cartUncertain:true})),/contact us before trying again/);
});

for(const explicitDispose of [false,true])test(`BFCache return after pagehide ${explicitDispose?'remains detached after explicit dispose':'reloads through normal custody recovery'}`,async t=>{
 const prior=globalThis.location;globalThis.location={origin:'https://bellows-film-printing-staging.myshopify.com',hostname:'bellows-film-printing-staging.myshopify.com'};t.after(()=>{globalThis.location=prior;});
 const events=new EventTarget(),data=new Map();let reloads=0;
 const flow=await mountPersistentCustomer({form:null,actions:{getCart:async()=>({cart:{id:cartId}})},storage:{getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value)},locks:locks(),events,fetchImpl:()=>assert.fail('no server or cart write'),reload:()=>{reloads++;}});
 await flow.ready;events.dispatchEvent(new Event('pageshow'));assert.equal(reloads,0);events.dispatchEvent(new Event('pagehide'));if(explicitDispose)flow.dispose();
 const restored=new Event('pageshow');Object.assign(restored,{persisted:true});events.dispatchEvent(restored);assert.equal(reloads,explicitDispose?0:1);assert.equal(data.size,0);flow.dispose();
});

test('native initialization queue times out behind an unresolved update without replay or journal clearing',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const lock=locks(),data=new Map(),gate=deferred(),key='bfl:persistent-native-init:v1';let current=null,reads=0,writes=0;
 const storage={getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value),removeItem:key=>data.delete(key)};
 const actions={getCart:async()=>{reads++;return {cart:current};},updateCart:async()=>{writes++;const result=await gate.promise;current=result.cart;return result;}};
 const start=()=>readPersistentNativeCart({actions,createIfMissing:true,storage,locks:lock,cryptoImpl:webcrypto});
 const first=start();await tick();assert.equal(writes,1);assert.equal(reads,1);const reserved=data.get(key);assert.equal(reserved,JSON.stringify({version:1,state:'pending',cart_hash:null}));
 const second=start(),rejected=assert.rejects(second,/PERSISTENT_CART_BUSY/);await tick();t.mock.timers.tick(30000);await rejected;
 assert.equal(data.get(key),reserved);assert.equal(writes,1);assert.equal(reads,1);assert.equal(lock.held.size,1);
 const cart={id:cartId,totalQuantity:0,lines:[]};gate.resolve({cart,userErrors:[],warnings:[]});assert.deepEqual(await first,cart);assert.equal(data.has(key),false);assert.equal(writes,1);
});
