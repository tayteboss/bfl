import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {createPersistentCartCoordinator,coordinateWidgetFlow,readUnprotectedNativeCart,PERSISTENT_CLIENT_POLICY as POLICY} from '../theme/persistent-cart.js';
import {createResourceSession} from '../theme/resource-session.js';
import {createFilmPrintingForm} from '../theme/film-printing-form.js';
const origin='https://bellows-film-printing-staging.myshopify.com',cartA='gid://shopify/Cart/cartA?key=secretA',cartB='gid://shopify/Cart/cartB?key=secretB';
const TOKEN='bflr1_'+'a'.repeat(43),NEXT='bflr1_'+'b'.repeat(43),opaque='p'.repeat(43),clock=1800000000000;
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
function env(t){const prior=globalThis.location;globalThis.location={origin,hostname:new URL(origin).hostname};t.after(()=>{globalThis.location=prior;});}
function world(){
 const data=new Map(),tabs=[],queues=new Map(),requests=[];
 const locks={request(name,options,work){requests.push(name);const promise=(queues.get(name)??Promise.resolve()).catch(()=>{}).then(work);queues.set(name,promise);return promise;}};
 const tab=()=>{const events=new EventTarget();const storage={getItem:key=>data.get(key)??null,removeItem(key){data.delete(key);for(const other of tabs)if(other.storage!==storage){const event=new Event('storage');Object.assign(event,{key,storageArea:other.storage});other.events.dispatchEvent(event);}},setItem(key,value){data.set(key,value);for(const other of tabs)if(other.storage!==storage){const event=new Event('storage');Object.assign(event,{key,storageArea:other.storage});other.events.dispatchEvent(event);}}};const value={storage,events};tabs.push(value);return value;};
 return {data,tab,locks,requests,async settle(){for(let i=0;i<3;i++)await Promise.allSettled([...queues.values()]);}};
}
const coord=(w,tab,extra={})=>createPersistentCartCoordinator({...tab,locks:w.locks,cartId:cartA,cryptoImpl:webcrypto,...extra});
const receipt=(patch={})=>({state:'accepted',token:TOKEN,expires:clock+86400000,generation:1,prepared_generation:0,operation:null,client_policy:POLICY,...patch});
function transport({replaceError,proofError,issuePatch={},replacePatch={}}={}){
 const calls=[];const fetchImpl=async(url,init={})=>{const path=new URL(url,origin).pathname,body=init.body?JSON.parse(init.body):null;calls.push({path,body,headers:init.headers??{}});
 if(path==='/resource-proof/challenge'){if(proofError)throw proofError;return Response.json({challenge:opaque,verifier:opaque,purpose:'bfl:resource-fresh-proof:v1',audience:origin+'/bfl-application-resources',action:body.action,expires_in:30});}
 if(path==='/apps/bfl-staging/resource-proof')return Response.json({ticket:opaque});
 if(path==='/resource-proof/exchange')return Response.json({proof:opaque,expires_in:30});
 if(path==='/resource-sessions/issue')return Response.json({token:TOKEN,resource_only:true,cart_verified:false,checkout_ready:false,generation:1,expires_in:86400,expires_at:clock+86400000,client_policy:POLICY,...issuePatch});
 if(path==='/checkout/replace_session'){if(replaceError)throw replaceError;return Response.json({token:NEXT,resource_only:true,cart_verified:false,checkout_ready:false,generation:1,expires_in:86400,expires_at:clock+86400000,client_policy:POLICY,replaced:true,...replacePatch});}
 if(path==='/resource-sessions/revoke')return Response.json({revoked:true});
 throw Error('Unexpected synthetic endpoint');};return {fetchImpl,calls};
}
function session(tab,c,wire){return createResourceSession({clientPolicy:POLICY,preparedMode:true,now:()=>clock,reloadStorage:c.storage,reloadKey:c.key,fetchImpl:wire.fetchImpl});}

test('two tab operations serialize; changed custody invalidates old controller before any second write',async()=>{
 const w=world(),a=await coord(w,w.tab()),b=await coord(w,w.tab(),{onStale(){refreshes++;}});let refreshes=0,writes=0;const gate=deferred();
 const first=a.run(async()=>{a.storage.setItem(a.key,JSON.stringify(receipt({state:'pending',operation:{kind:'add'}})));await gate.promise;a.storage.setItem(a.key,JSON.stringify(receipt()));});
 const second=b.run(()=>{writes++;});await Promise.resolve();assert.equal(writes,0);gate.resolve();await first;await assert.rejects(second,e=>e.message==='RESOURCE_SUPERSEDED'&&e.refreshRequired);assert.equal(writes,0);assert.equal(refreshes,1);assert.equal(JSON.parse(a.storage.getItem(a.key)).expires,clock+86400000);
});
test('read-only restore transient checkpoint does not cause tab refresh loops',async()=>{
 const w=world(),t1=w.tab(),a=await coord(w,t1);await a.run(()=>a.storage.setItem(a.key,JSON.stringify(receipt())));let invalid=0;
 const b=await coord(w,w.tab(),{onInvalidate(){invalid++;}});await a.run(()=>{a.storage.setItem(a.key,JSON.stringify(receipt({state:'pending'})));a.storage.setItem(a.key,JSON.stringify(receipt()));});await w.settle();await b.run(()=>{});assert.equal(invalid,0);
});
test('separate native cart capabilities have independent custody and locks',async()=>{
 const w=world(),a=await coord(w,w.tab()),b=await coord(w,w.tab(),{cartId:cartB});assert.notEqual(a.key,b.key);assert.ok(!a.key.includes('secretA'));
 const gate=deferred(),hold=a.run(()=>gate.promise);let completed=false;await b.run(()=>{completed=true;b.storage.setItem(b.key,JSON.stringify(receipt()));});assert.equal(completed,true);gate.resolve();await hold;
});
test('changed custody requires lock; identical async upload checkpoint is a no-op and foreign change still blocks',async()=>{
 const w=world(),a=await coord(w,w.tab()),value=JSON.stringify(receipt({state:'pending'}));assert.throws(()=>a.storage.setItem(a.key,value),/PERSISTENT_OPERATION_REQUIRED/);
 await a.run(()=>a.storage.setItem(a.key,value));a.storage.setItem(a.key,value);const b=await coord(w,w.tab());await b.run(()=>b.storage.setItem(b.key,JSON.stringify(receipt())));
 assert.throws(()=>a.storage.setItem(a.key,value),/RESOURCE_SUPERSEDED/);
});
for(const operation of [{kind:'replace_session',operation_id:'one'}])test(`in-progress/unknown ${operation.kind} custody survives reload without issuance`,async()=>{
 const w=world(),t=w.tab(),c=await coord(w,t),raw=JSON.stringify(receipt({state:'pending',operation}));await c.run(()=>c.storage.setItem(c.key,raw));const next=await coord(w,w.tab());await assert.rejects(next.run(()=>next.assertInitial()),e=>e.cartUncertain===true);assert.equal(next.storage.getItem(next.key),raw);
});
test('pending/null original custody may enter read-only diagnosis without issuing or losing its credential',async t=>{
 env(t);const w=world(),tab=w.tab(),c=await coord(w,tab),wire=transport(),raw=JSON.stringify(receipt({state:'pending',prepared_generation:9,cart_revision:3}));
 await c.run(()=>c.storage.setItem(c.key,raw));const next=await coord(w,w.tab()),reopened=session(tab,next,wire);
 await next.run(()=>{next.assertInitial();assert.deepEqual(reopened.restore(),{state:'pending',operation:null});});
 const retained=JSON.parse(next.storage.getItem(next.key));assert.equal(retained.token,TOKEN);assert.equal(retained.state,'pending');assert.equal(retained.operation,null);assert.equal(retained.prepared_generation,9);assert.equal(retained.cart_revision,3);assert.equal(wire.calls.length,0);
});
test('pending owned mutation remains available only to existing read-only recovery path',async()=>{
 const w=world(),c=await coord(w,w.tab()),raw=JSON.stringify(receipt({state:'pending',operation:{kind:'add',operation_id:'existing',job:'job',quantity:1}}));await c.run(()=>c.storage.setItem(c.key,raw));const next=await coord(w,w.tab());await next.run(()=>next.assertInitial());assert.equal(next.storage.getItem(next.key),raw);
});
test('new persistent issue uses exact server 24h deadline, cannot renew, and reopens the same owner',async t=>{
 env(t);const w=world(),tab=w.tab(),c=await coord(w,tab),wire=transport(),s=session(tab,c,wire);let issued;
 await c.run(async()=>{issued=await s.issue();s.checkpoint('initialized');});assert.equal(issued.expires_at,clock+86400000);await assert.rejects(c.run(()=>s.renew()),/RESOURCE_SESSION_POLICY/);
 const next=await coord(w,w.tab()),reopened=session(tab,next,wire);await next.run(()=>{assert.equal(reopened.restore().state,'initialized');reopened.checkpoint('initialized');});assert.equal(reopened.receipt().expires_at,issued.expires_at);assert.equal(wire.calls.filter(c=>c.path==='/resource-sessions/issue').length,1);assert.equal(wire.calls.filter(c=>c.path.includes('renew')).length,0);
});
for(const patch of [{client_policy:'bfl-full-product-client-v1'},{expires_at:clock+86400001},{expires_in:86401},{expires_at:undefined}])test(`persistent issuance rejects altered policy/deadline ${JSON.stringify(patch)}`,async t=>{
 env(t);const w=world(),tab=w.tab(),c=await coord(w,tab),wire=transport({issuePatch:patch}),s=session(tab,c,wire);await assert.rejects(c.run(()=>s.issue()));assert.throws(()=>s.receipt(),/RESOURCE_EXPIRED/);
});
test('terminal replacement uses fresh unauthenticated issue proof then expired token only at exact replace route',async t=>{
 env(t);const w=world(),tab=w.tab(),c=await coord(w,tab),wire=transport(),s=session(tab,c,wire),prior=JSON.stringify(receipt({expires:clock-1}));await c.run(()=>c.storage.setItem(c.key,prior));
 const result=await c.run(()=>s.replaceSession(cartA));assert.equal(result.replaced,true);assert.equal(result.expires_at,clock+86400000);
 for(const call of wire.calls)if(call.path!=='/checkout/replace_session')assert.equal(call.headers.Authorization,undefined);
 const terminal=wire.calls.find(c=>c.path==='/checkout/replace_session');assert.equal(terminal.headers.Authorization,`Bearer ${TOKEN}`);assert.deepEqual(terminal.body,{proof:opaque,cart_id:cartA});assert.equal(JSON.parse(c.storage.getItem(c.key)).token,NEXT);assert.equal(JSON.parse(c.storage.getItem(c.key)).state,'initializing');assert.equal(wire.calls.some(c=>c.path==='/resource-sessions/issue'),false);
});
test('lost replacement response retains one pending operation; reload cannot replay it',async t=>{
 env(t);const w=world(),tab=w.tab(),c=await coord(w,tab),wire=transport({replaceError:new TypeError('lost response')}),s=session(tab,c,wire);await c.run(()=>c.storage.setItem(c.key,JSON.stringify(receipt({expires:clock-1}))));await assert.rejects(c.run(()=>s.replaceSession(cartA)),e=>e.cartUncertain===true);
 const saved=c.storage.getItem(c.key);assert.equal(JSON.parse(saved).operation.kind,'replace_session');const next=await coord(w,w.tab()),second=session(tab,next,wire);await assert.rejects(next.run(()=>{next.assertInitial();return second.replaceSession(cartA);}));assert.equal(next.storage.getItem(next.key),saved);assert.equal(wire.calls.filter(c=>c.path==='/checkout/replace_session').length,1);
});
test('replacement proof failure before terminal dispatch preserves exact expired receipt',async t=>{
 env(t);const w=world(),tab=w.tab(),c=await coord(w,tab),wire=transport({proofError:new TypeError('not sent')}),s=session(tab,c,wire),saved=JSON.stringify(receipt({expires:clock-1}));await c.run(()=>c.storage.setItem(c.key,saved));await assert.rejects(c.run(()=>s.replaceSession(cartA)));assert.equal(c.storage.getItem(c.key),saved);assert.equal(wire.calls.some(c=>c.path==='/checkout/replace_session'),false);
});
for(const patch of [{state:'pending',operation:{kind:'add'}},{state:'prepared',operation:{kind:'prepared'}},{expires:clock+1},{client_policy:'bfl-full-product-client-v1'}])test(`terminal replacement never abandons invalid/unfinished prior ${JSON.stringify(patch)}`,async t=>{
 env(t);const w=world(),tab=w.tab(),c=await coord(w,tab),wire=transport(),s=session(tab,c,wire),saved=JSON.stringify(receipt({expires:clock-1,...patch}));await c.run(()=>c.storage.setItem(c.key,saved));await assert.rejects(c.run(()=>s.replaceSession(cartA)));assert.equal(c.storage.getItem(c.key),saved);assert.equal(wire.calls.length,0);
});
test('widget keeps one transfer under its lock and releases before readiness or removal',async()=>{
 const w=world(),c=await coord(w,w.tab()),transfer=deferred(),entered=deferred(),calls=[];let n=0;const f=coordinateWidgetFlow({select(){c.storage.setItem(c.key,'pending');calls.push('select');entered.resolve();return [{key:'actual',completion:transfer.promise}];},selectionReady:async key=>c.run(()=>{calls.push(key);c.storage.setItem(c.key,'ready');}),remove:key=>c.run(()=>calls.push('remove:'+key))},c,{id:()=>`local${++n}`});
 const row=f.select([{}])[0];await entered.promise;const next=c.run(()=>calls.push('next operation'));await new Promise(setImmediate);assert.deepEqual(calls,['select']);transfer.resolve('complete');await row.completion;await next;await f.selectionReady(row.key);assert.deepEqual(calls,['select','next operation','actual']);await f.remove(row.key);assert.equal(calls.at(-1),'remove:actual');
});
test('queued widget removal cancels before start without remote mutation',async()=>{
 const w=world(),c=await coord(w,w.tab()),gate=deferred(),hold=c.run(()=>gate.promise);let starts=0;const f=coordinateWidgetFlow({select(){starts++;throw Error('must not start');},remove(){throw Error('must not remove');}},c,{id:()=> 'local'}),row=f.select([{}])[0],remove=f.remove(row.key);gate.resolve();await hold;await remove;await assert.rejects(row.completion,/UPLOAD_CANCELLED/);assert.equal(starts,0);
});
test('two actual form controllers share one owner; stale second form cannot initialize or issue until refresh',async t=>{
 env(t);const w=world(),wire=transport(),t1=w.tab(),t2=w.tab(),a=await coord(w,t1),b=await coord(w,t2);let initializations=0;
 const build=(c)=>{const form=Object.assign(new EventTarget(),{dataset:{filmPrintingForm:''},querySelector:()=>null,querySelectorAll:()=>[],bflSelectionComplete:()=>false});const owner=createFilmPrintingForm(form,{operation:c.run,sessionOptions:{clientPolicy:POLICY,preparedMode:true,now:()=>clock,reloadStorage:c.storage,reloadKey:c.key,fetchImpl:wire.fetchImpl,verifyNewCart:async()=>cartA,assertInitial:c.assertInitial,assertCurrent:c.assertCurrent},checkoutForSession:s=>({mode:'prepared-unit-v3',prepare:async()=>assert.fail('incomplete selection'),cancelPreparation:async()=>assert.fail('no preparation'),addPrepared:async()=>assert.fail('no Add'),initialize:async()=>{initializations++;s.checkpoint('initialized');return {upload_recovery:'uncommitted-v1'};}})});t.after(()=>globalThis.BFLPrintJob.forForm(form).invalidateSharedCart());return owner;};
 const first=build(a),second=build(b);await first.issue();await assert.rejects(second.issue(),/RESOURCE_SUPERSEDED/);assert.equal(initializations,1);assert.equal(wire.calls.filter(c=>c.path==='/resource-sessions/issue').length,1);
 const reloaded=build(await coord(w,w.tab()));const restored=await reloaded.issue();assert.equal(restored.resumed,true);assert.equal(restored.expires_at,clock+86400000);assert.equal(initializations,2);assert.equal(wire.calls.filter(c=>c.path==='/resource-sessions/issue').length,1);
});

for(const item of [{product_id:15620086005871},{variant_id:68068358848623},{properties:{_bfl_job:'partial'}}])test(`new/replacement native cart guard rejects protected marker ${JSON.stringify(item)}`,async()=>{
 let reads=0;await assert.rejects(readUnprotectedNativeCart({cartId:cartA,actions:{getCart:async()=>{reads++;return {cart:{id:cartA}};}},fetchImpl:async()=>Response.json({items:[item]})}),/RESOURCE_EXPIRED/);assert.equal(reads,1);
});
test('new/replacement native cart guard preserves ordinary lines and requires exact native double read',async()=>{
 const cart={id:cartA,lines:[{id:'ordinary',quantity:2}]};let reads=0;assert.equal(await readUnprotectedNativeCart({cartId:cartA,actions:{getCart:async()=>{reads++;return {cart};}},fetchImpl:async()=>Response.json({items:[{product_id:123,variant_id:456,properties:{},quantity:2}]})}),cartA);assert.equal(reads,2);
 reads=0;await assert.rejects(readUnprotectedNativeCart({cartId:cartA,actions:{getCart:async()=>({cart:{...cart,lines:[{id:'ordinary',quantity:++reads}]}})},fetchImpl:async()=>Response.json({items:[]})}),/RESOURCE_SUPERSEDED/);
});

test('same-owner quantity mutation advances custody even when accepted receipt otherwise returns unchanged',async t=>{
 env(t);const w=world(),tab=w.tab(),a=await coord(w,tab),wire=transport(),s=session(tab,a,wire);
 await a.run(async()=>{await s.issue();s.checkpoint('accepted');});
 const before=JSON.parse(a.storage.getItem(a.key));let invalidated=0;
 const b=await coord(w,w.tab(),{onInvalidate(){invalidated++;}});
 await a.run(()=>{s.beginMutation({kind:'change',operation_id:'quantity-one',job:'job',quantity:2});s.checkpoint('accepted');});
 await w.settle();assert.equal(JSON.parse(a.storage.getItem(a.key)).cart_revision,before.cart_revision+1);
 await assert.rejects(b.run(()=>assert.fail('stale controller must never write')),e=>e.refreshRequired===true);assert.equal(invalidated,1);
 const c=await coord(w,w.tab()),restored=session(tab,c,wire);await c.run(()=>{restored.restore();restored.checkpoint('accepted');});
 assert.equal(JSON.parse(c.storage.getItem(c.key)).cart_revision,before.cart_revision+1);
});

for(const path of ['/resource-proof/challenge','/apps/bfl-staging/resource-proof','/resource-proof/exchange'])test(`new-client proof failure at ${path} remains retryable without issuing or mutating cart`,async t=>{
 env(t);const w=world(),tab=w.tab(),c=await coord(w,tab),wire=transport(),original=wire.fetchImpl;let failed=false;
 wire.fetchImpl=async(url,options)=>{if(!failed&&new URL(url,origin).pathname===path){failed=true;throw new TypeError('temporary network failure');}return original(url,options);};
 const s=session(tab,c,wire);await assert.rejects(c.run(()=>s.issue()));assert.equal(wire.calls.filter(c=>c.path==='/resource-sessions/issue').length,0);assert.equal(c.storage.getItem(c.key),null);
 const next=await coord(w,w.tab()),reopened=session(tab,next,wire);await next.run(async()=>{next.assertInitial();await reopened.issue();reopened.checkpoint('initialized');});assert.equal(wire.calls.filter(c=>c.path==='/resource-sessions/issue').length,1);
});
test('lost initial issue allows one bounded recovery; lost recovery never issues again',async t=>{
 env(t);const w=world(),tab=w.tab(),c=await coord(w,tab),wire=transport(),original=wire.fetchImpl;let issues=0;
 wire.fetchImpl=async(url,options)=>{if(new URL(url,origin).pathname==='/resource-sessions/issue'){issues++;await original(url,options);throw new TypeError('lost issue response');}return original(url,options);};
 await assert.rejects(c.run(()=>session(tab,c,wire).issue()));const retained=c.storage.getItem(c.key);assert.equal(JSON.parse(retained).state,'blocked');
 const next=await coord(w,w.tab()),recover=session(tab,next,wire);await assert.rejects(next.run(()=>{next.assertInitial();return recover.recoverUnbound();}));
 const tombstone=next.storage.getItem(next.key);assert.equal(JSON.parse(tombstone).initialization_recovery,retained);assert.equal(issues,2);
 const final=await coord(w,w.tab());await assert.rejects(final.run(()=>final.assertInitial()));assert.equal(final.storage.getItem(final.key),tombstone);assert.equal(issues,2);
});
test('pre-issue rollback cannot remove another tab custody',async t=>{
 env(t);const w=world(),tab=w.tab(),c=await coord(w,tab),wire=transport({proofError:new TypeError('not sent')}),original=wire.fetchImpl,foreign=JSON.stringify(receipt());
 wire.fetchImpl=async(url,options)=>{w.data.set(c.key,foreign);return original(url,options);};
 await assert.rejects(c.run(()=>session(tab,c,wire).issue()));assert.equal(c.storage.getItem(c.key),foreign);assert.equal(wire.calls.filter(c=>c.path==='/resource-sessions/issue').length,0);
});
test('checkpoint removal requires owning the current cart operation and preserves changed custody',async()=>{
 const w=world(),a=await coord(w,w.tab());assert.throws(()=>a.storage.removeItem(a.key),/PERSISTENT_OPERATION_REQUIRED/);
 await a.run(()=>a.storage.setItem(a.key,'own checkpoint'));const b=await coord(w,w.tab());await b.run(()=>b.storage.setItem(b.key,'other checkpoint'));
 await assert.rejects(a.run(()=>a.storage.removeItem(a.key)),/RESOURCE_SUPERSEDED/);assert.equal(a.storage.getItem(a.key),'other checkpoint');
});


test('same-page queued uploads do not consume the cross-tab acquisition timeout',async t=>{
 const original=globalThis.setTimeout;globalThis.setTimeout=(work,ms,...args)=>original(work,ms===30000?5:ms,...args);t.after(()=>{globalThis.setTimeout=original;});
 const w=world(),c=await coord(w,w.tab()),transfer=deferred(),entered=deferred(),calls=[];
 const flow=coordinateWidgetFlow({selectSource(url){calls.push(url);if(calls.length===1){entered.resolve();return {key:url,completion:transfer.promise};}return {key:url,completion:Promise.resolve(url)};}},c);
 const first=flow.selectSource('first');await entered.promise;const second=flow.selectSource('second'),third=flow.selectSource('third');
 await new Promise(resolve=>original(resolve,20));assert.deepEqual(calls,['first']);assert.equal(w.requests.length,1);
 transfer.resolve('first');assert.deepEqual(await Promise.all([first.completion,second.completion,third.completion]),['first','second','third']);assert.deepEqual(calls,['first','second','third']);assert.equal(w.requests.length,3);
});

test('failed transfer preserves its actual handle for explicit removal and is never resent',async()=>{
 const w=world(),c=await coord(w,w.tab());let starts=0,removes=0;const f=coordinateWidgetFlow({selectSource(){starts++;return {key:'actual',completion:Promise.reject(Error('lost transfer'))};},remove:key=>c.run(()=>{assert.equal(key,'actual');removes++;})},c);
 const row=f.selectSource('fixture');await assert.rejects(row.completion,/lost transfer/);await f.remove(row.key);assert.equal(starts,1);assert.equal(removes,1);
});
