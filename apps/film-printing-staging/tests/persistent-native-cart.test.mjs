import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {readPersistentNativeCart,mountPersistentCustomer} from '../theme/persistent-cart.js';
const key='bfl:persistent-native-init:v1',id='gid://shopify/Cart/fresh?key=capability',other='gid://shopify/Cart/other?key=otherCapability';
const empty=(cartId=id)=>({id:cartId,totalQuantity:0,lines:[],cost:{totalAmount:{amount:'0.0',currencyCode:'USD'}},discountCodes:[]});
const pending=JSON.stringify({version:1,state:'pending',cart_hash:null});
function setup(){
 const data=new Map(),calls=[],queues=new Map();let current=null;
 const storage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};
 const locks={request(name,options,work){assert.equal(options.mode,'exclusive');const p=(queues.get(name)??Promise.resolve()).catch(()=>{}).then(work);queues.set(name,p);return p;}};
 const actions={getCart:async()=>{calls.push('read');return {cart:current===null?null:structuredClone(current)};},updateCart:async(payload,options)=>{assert.deepEqual(payload,{note:''});assert.ok(options.signal instanceof AbortSignal);assert.equal(data.get(key),pending);calls.push('update');current=empty();return {cart:structuredClone(current)};}};
 const run=extra=>readPersistentNativeCart({actions,storage,locks,cryptoImpl:webcrypto,createIfMissing:true,...extra});
 return {data,storage,locks,actions,calls,run,set cart(value){current=value;},get cart(){return current;}};
}
test('fresh product browser initializes once, verifies two exact native reads and removes reservation',async()=>{
 const w=setup(),cart=await w.run();assert.deepEqual(cart,empty());assert.deepEqual(w.calls,['read','update','read','read']);assert.equal(w.data.size,0);
 await w.run();assert.equal(w.calls.filter(c=>c==='update').length,1);
});
test('two new product tabs serialize one initialization',async()=>{
 const w=setup();const [a,b]=await Promise.all([w.run(),w.run()]);assert.deepEqual(a,b);assert.equal(w.calls.filter(c=>c==='update').length,1);assert.equal(w.data.size,0);
});
test('existing native cart is preserved without note update or storage writes',async()=>{
 const w=setup();w.cart={...empty(),totalQuantity:2,lines:[{id:'ordinary',quantity:2}],note:'keep me'};
 const before=structuredClone(w.cart);assert.deepEqual(await w.run(),before);assert.deepEqual(w.calls,['read']);assert.equal(w.data.size,0);
});
test('ordinary empty cart page performs only a read, without lock/storage or initialization',async()=>{
 const w=setup();assert.equal(await w.run({createIfMissing:false,storage:null,locks:null}),null);assert.deepEqual(w.calls,['read']);
});
test('mounting an ordinary empty cart page returns idle without creating a resource owner',async t=>{
 const prior=globalThis.location;globalThis.location={hostname:'bellows-film-printing-staging.myshopify.com'};t.after(()=>{globalThis.location=prior;});
 const w=setup(),mounted=await mountPersistentCustomer({form:null,actions:w.actions,storage:null,locks:null,fetchImpl:()=>assert.fail('no resource request')});
 assert.equal(await mounted.ready,null);mounted.dispose();assert.deepEqual(w.calls,['read']);
});
test('lost initialization response retains custody and never replays while cart is still null',async()=>{
 const w=setup();w.actions.updateCart=async()=>{w.calls.push('update');throw Error('network lost');};
 await assert.rejects(w.run(),e=>e.cartUncertain===true);assert.equal(w.data.get(key),pending);
 await assert.rejects(w.run(),e=>e.cartUncertain===true);assert.equal(w.calls.filter(c=>c==='update').length,1);assert.equal(w.data.get(key),pending);
});
test('reload after interrupted SDK response reconciles an existing stable empty cart read-only',async()=>{
 const w=setup();w.actions.updateCart=async()=>{w.calls.push('update');w.cart=empty();throw Error('SDK triggered navigation');};
 await assert.rejects(w.run(),e=>e.cartUncertain===true);assert.equal(w.data.get(key),pending);
 assert.deepEqual(await w.run(),empty());assert.equal(w.calls.filter(c=>c==='update').length,1);assert.equal(w.data.size,0);
});
test('pending unknown initialization cannot adopt a nonempty cart',async()=>{
 const w=setup();w.data.set(key,pending);w.cart={...empty(),totalQuantity:1,lines:[{id:'ordinary',quantity:1}]};
 await assert.rejects(w.run(),e=>e.cartUncertain===true);assert.deepEqual(w.calls,['read']);assert.equal(w.data.get(key),pending);
});
test('known mutation cart must match current native cart, including after reload',async()=>{
 const w=setup();const update=w.actions.updateCart;w.actions.updateCart=async(...args)=>{const result=await update(...args);w.cart=empty(other);return result;};
 await assert.rejects(w.run(),e=>e.cartUncertain===true);const saved=w.data.get(key);assert.match(JSON.parse(saved).cart_hash,/^[a-f0-9]{64}$/);assert.ok(!saved.includes('capability'));
 await assert.rejects(w.run(),e=>e.cartUncertain===true);assert.equal(w.data.get(key),saved);assert.equal(w.calls.filter(c=>c==='update').length,1);
});
test('cart changing between native readbacks remains pending without another mutation',async()=>{
 const w=setup(),read=w.actions.getCart;let n=0;w.actions.getCart=async()=>{const result=await read();if(++n===3)result.cart=empty(other);return result;};
 await assert.rejects(w.run(),e=>e.cartUncertain===true);assert.notEqual(w.data.get(key),null);assert.equal(w.calls.filter(c=>c==='update').length,1);
});
for(const result of [{},{cart:undefined},{cart:{id:'not-a-capability'}},{cart:{id:id+'bad/path'}}])test(`malformed native response does not initialize ${JSON.stringify(result)}`,async()=>{
 const w=setup();w.actions.getCart=async()=>result;await assert.rejects(w.run(),/PERSISTENT_CART_UNAVAILABLE/);assert.equal(w.calls.includes('update'),false);assert.equal(w.data.size,0);
});
for(const result of [{userErrors:[{message:'failed'}]},{warnings:[{message:'changed'}]},{userErrors:{}},{cart:empty(other)}])test(`unexpected initialization result remains pending ${JSON.stringify(result)}`,async()=>{
 const w=setup(),update=w.actions.updateCart;w.actions.updateCart=async(...args)=>({...await update(...args),...result});await assert.rejects(w.run(),e=>e.cartUncertain===true);assert.notEqual(w.data.get(key),null);assert.equal(w.calls.filter(c=>c==='update').length,1);
});
test('unavailable durable storage prevents native initialization',async()=>{
 const w=setup();w.storage.setItem=()=>{throw Error('storage denied');};await assert.rejects(w.run(),/storage denied/);assert.equal(w.calls.includes('update'),false);
});
test('foreign reservation change cannot be removed or treated as success',async()=>{
 const w=setup(),update=w.actions.updateCart;w.actions.updateCart=async(...args)=>{const value=await update(...args);w.data.set(key,'foreign custody');return value;};
 await assert.rejects(w.run(),e=>e.cartUncertain===true);assert.equal(w.data.get(key),'foreign custody');
});
for(const record of ['bad json','{}','null',JSON.stringify({version:0,state:'pending',cart_hash:null})])test(`unrecognized init custody never starts a replacement ${record}`,async()=>{
 const w=setup();w.data.set(key,record);await assert.rejects(w.run(),e=>e.cartUncertain===true);assert.equal(w.calls.length,0);assert.equal(w.data.get(key),record);
});
test('readback network failure retains uncertain state and known cart hash',async()=>{
 const w=setup(),read=w.actions.getCart;let n=0;w.actions.getCart=async()=>{if(++n===2)throw Error('read failed');return read();};
 await assert.rejects(w.run(),e=>e.cartUncertain===true);assert.match(JSON.parse(w.data.get(key)).cart_hash,/^[a-f0-9]{64}$/);
 assert.deepEqual(await w.run(),empty());assert.equal(w.calls.filter(c=>c==='update').length,1);
});
test('missing crypto prevents native initialization before send',async()=>{
 const w=setup();await assert.rejects(w.run({cryptoImpl:null}),/PERSISTENT_CART_UNAVAILABLE/);assert.equal(w.calls.includes('update'),false);assert.equal(w.data.size,0);
});

// Retained actual Shopify SDK uses lines.nodes internally/on reads; public
// documentation and some action results expose an array. Accept both safely.
for(const [readConnection,updateConnection] of [[true,true],[true,false],[false,true]])test(`fresh cart accepts native lines shapes readConnection=${readConnection} updateConnection=${updateConnection}`,async()=>{
 const w=setup(),read=w.actions.getCart,update=w.actions.updateCart;
 const shape=(result,connection)=>{if(result.cart&&connection)result.cart.lines={nodes:result.cart.lines};return result;};
 w.actions.getCart=async()=>shape(await read(),readConnection);
 w.actions.updateCart=async(...args)=>shape(await update(...args),updateConnection);
 const cart=await w.run();assert.equal(cart.id,id);assert.deepEqual(cart.lines,readConnection?{nodes:[]}:[]);assert.equal(w.data.size,0);assert.equal(w.calls.filter(c=>c==='update').length,1);
});
test('pending initialization reconciles a stable empty native connection after reload without a send',async()=>{
 const w=setup();w.data.set(key,pending);w.cart={...empty(),lines:{nodes:[]}};
 assert.deepEqual(await w.run(),w.cart);assert.deepEqual(w.calls,['read','read']);assert.equal(w.data.size,0);
});
for(const lines of [{nodes:[{id:'ordinary',quantity:1}]},{nodes:null},{nodes:{}},{edges:[]}])test(`pending initialization rejects nonempty or malformed connection ${JSON.stringify(lines)}`,async()=>{
 const w=setup();w.data.set(key,pending);w.cart={...empty(),lines};await assert.rejects(w.run(),e=>e.cartUncertain===true);assert.equal(w.data.get(key),pending);assert.deepEqual(w.calls,['read']);
});
