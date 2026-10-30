import test from 'node:test';
import assert from 'node:assert/strict';
import {persistentRig,deferred} from '../../../fixtures/film-printing/persistent-client-staging-20261030/rig.mjs';
import {createResourceSession} from '../theme/resource-session.js';
import {createFilmPrintingForm} from '../theme/film-printing-form.js';
import {createPreparedCheckout} from '../theme/prepared-checkout.js';
import {BINDING_MUTATION} from '../checkout/cart-capability.mjs';
const POLICY='bfl-persistent-staging-client-v1',key='bfl:accepted-cart-session:v1';
const plain=x=>JSON.parse(JSON.stringify(x));
async function fixture(t){
 const f=await persistentRig(t),data=new Map(),writes=[];
 const storage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};
 const fetchImpl=f.browserFetch;
 f.hook=async(stage,{query}={})=>{if(stage==='storefront'&&query.startsWith('mutation'))writes.push(query);};
 const options={fetchImpl,now:()=>f.clock.time,reloadStorage:storage,preparedMode:true,clientPolicy:POLICY,verifyNewCart:async()=>f.ids.A};
 class Form extends EventTarget{dataset={filmPrintingForm:''};querySelector(){return null;}querySelectorAll(){return [];}}
 const actions={getCart:async()=>({cart:{id:f.ids.A,lines:[],totalQuantity:0,cost:{totalAmount:{amount:'0.00',currencyCode:'USD'}}}})};
 const ajax=async path=>({ok:true,redirected:false,json:async()=>path==='/cart.js'?{currency:'USD',items:[],item_count:0,total_price:0}:{'cart-drawer':'<div>Empty</div>'}});
 return Object.assign(f,{storage,writes,options,session:()=>createResourceSession(options),make:()=>createFilmPrintingForm(new Form(),{sessionOptions:options,checkoutForSession:s=>createPreparedCheckout(s,{actions,fetchImpl:ajax,now:()=>f.clock.time})})});
}
const act=(s,f,action)=>s.checkout(action,async()=>f.ids.A);

test('original finite issue credential is durable before bind; reload continues same owner',async t=>{
 const f=await fixture(t),s=f.session();await s.issue();const original=plain(f.rows().resource_sessions),saved=JSON.parse(f.storage.getItem(key));
 assert.equal(saved.state,'initializing');assert.match(saved.token,/^bflr1_/);assert.equal(f.rows().staging_capability_attempts.length,0);
 await f.make().issue();assert.equal(JSON.parse(f.storage.getItem(key)).state,'initialized');assert.deepEqual(plain(f.rows().resource_sessions),original);
 assert.equal(f.writes.length,2);await f.make().issue();assert.equal(f.writes.length,2);assert.deepEqual(plain(f.rows().resource_sessions),original);
});

test('tokenless orphan receives only one fresh owner and preserves original history and expiry',async t=>{
 const f=await fixture(t),orphan=f.session();await orphan.issue();const old=plain(f.rows().resource_sessions[0]);f.storage.setItem(key,JSON.stringify({state:'blocked'}));
 await f.make().issue();assert.equal(f.rows().resource_sessions.length,2);assert.deepEqual(plain(f.rows().resource_sessions.find(r=>r.owner===old.owner)),old);
 assert.equal(f.rows().staging_capability_attempts.length,1);assert.equal(f.rows().upload_intents.length,0);assert.equal(f.rows().jobs.length,0);
 const saved=JSON.parse(f.storage.getItem(key));assert.equal(saved.initialization_recovery,JSON.stringify({state:'blocked'}));assert.equal(saved.state,'initialized');
 await assert.rejects(act(orphan,f,'bind'));assert.equal(f.writes.length,2);await f.make().issue();assert.equal(f.rows().resource_sessions.length,2);assert.equal(f.writes.length,2);
});

for(const path of ['/checkout/bind','/checkout/install'])test(`lost successful ${path} response recovers original owner without another native write`,async t=>{
 const f=await fixture(t);let once=true;
 f.options.fetchImpl=async(url,options)=>{const result=await f.browserFetch(url,options);if(new URL(url,globalThis.location.origin).pathname===path&&once){once=false;throw new TypeError('lost successful response');}return result;};
 await assert.rejects(f.make().issue());assert.equal(JSON.parse(f.storage.getItem(key)).state,'initializing');const original=plain(f.rows().resource_sessions);
 await f.make().issue();assert.deepEqual(plain(f.rows().resource_sessions),original);assert.equal(f.writes.filter(q=>q===BINDING_MUTATION).length,1);assert.equal(f.writes.filter(q=>q!==BINDING_MUTATION).length,1);
 assert.equal(JSON.parse(f.storage.getItem(key)).state,'initialized');
});

for(const failure of ['rejected','unknown'])test(`prior ${failure} capability attempt denies same-owner and fresh-owner recovery`,async t=>{
 const f=await fixture(t);let once=true,mutations=0;
 f.hook=async(stage,{query}={})=>{if(stage!=='storefront')return;if(query.startsWith('mutation'))mutations++;if(once&&(failure==='rejected'?!query.startsWith('mutation'):query.startsWith('mutation'))){once=false;throw new TypeError('lost capability transport');}};
 await assert.rejects(f.make().issue());const prior=plain(f.rows().staging_capability_attempts);assert.equal(prior[0].state,failure);const before=mutations;
 await assert.rejects(f.make().issue());assert.equal(mutations,before);assert.deepEqual(plain(f.rows().staging_capability_attempts),prior);assert.equal(f.rows().resource_sessions.length,1);
 f.storage.setItem(key,JSON.stringify({state:'blocked'}));await assert.rejects(f.make().issue());assert.equal(f.rows().resource_sessions.length,2);assert.deepEqual(plain(f.rows().staging_capability_attempts),prior);assert.equal(mutations,before);
 await assert.rejects(f.make().issue());assert.equal(f.rows().resource_sessions.length,2);assert.equal(mutations,before);
});

test('two owners racing the same native cart send exactly one capability mutation',async t=>{
 const f=await fixture(t),a=f.session();await a.issue();const b=createResourceSession({...f.options,reloadStorage:null});await b.issue();const entered=deferred(),release=deferred();let held=false,writes=0;
 f.hook=async(stage,{query}={})=>{if(stage!=='storefront')return;if(query.startsWith('mutation'))writes++;else if(!held){held=true;entered.resolve();await release.promise;}};
 const first=act(a,f,'bind');await entered.promise;await assert.rejects(act(b,f,'bind'));release.resolve();await first;
 assert.equal(writes,1);assert.equal(f.rows().staging_capability_attempts.length,1);assert.equal(f.rows().resource_sessions.length,2);
});

test('lost fresh recovery issue leaves one tombstone and never issues a third owner',async t=>{
 const f=await fixture(t),orphan=f.session();await orphan.issue();const original=plain(f.rows().resource_sessions[0]);f.storage.setItem(key,JSON.stringify({state:'blocked'}));let requests=0;
 f.options.fetchImpl=async(url,options)=>{const result=await f.browserFetch(url,options);if(new URL(url,globalThis.location.origin).pathname==='/resource-sessions/issue'){requests++;throw new TypeError('lost recovery issue');}return result;};
 await assert.rejects(f.make().issue());const saved=f.storage.getItem(key);assert.deepEqual(JSON.parse(saved),{state:'blocked',initialization_recovery:JSON.stringify({state:'blocked'})});
 await assert.rejects(f.make().issue());await assert.rejects(f.make().issue());assert.equal(requests,1);assert.equal(f.storage.getItem(key),saved);assert.equal(f.rows().resource_sessions.length,2);assert.equal(f.rows().staging_capability_attempts.length,0);
 assert.deepEqual(plain(f.rows().resource_sessions.find(r=>r.owner===original.owner)),original);assert.equal(f.writes.length,0);
});


test('a completed checkpoint cannot later disguise a pending native mutation as initialization',async t=>{
 const f=await fixture(t),s=f.session();await s.issue();s.checkpoint('accepted');
 s.beginMutation({kind:'add',operation_id:'existing-attempt',job:'existing-job',quantity:1});
 const record=JSON.parse(f.storage.getItem(key));assert.equal(record.state,'pending');assert.equal(record.operation.kind,'add');assert.equal(record.cart_revision,1);
});
