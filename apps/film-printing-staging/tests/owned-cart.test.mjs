import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {readFileSync} from 'node:fs';
import {rig,id,deferred,origin} from '../../../fixtures/film-printing/f06n/rig.mjs';
import {openCartCapability} from '../checkout/cart-capability.mjs';
import {openDatabase} from '../backend/storage.mjs';
import {createSessionOnlyRuntime} from '../backend/session-only.mjs';
const token=async f=>{const r=await f.issue();assert.equal(r.status,200,JSON.stringify(r.body));return r.body.token;};
const state=f=>f.rows('SELECT * FROM authority_state');

test('F06N fresh current application owner + response proof + exact full capability binds once over HTTP/SQLite',async t=>{
 const f=await rig(t),a=await token(f),b=await token(f),r=await f.inspect(a);assert.equal(r.status,200,JSON.stringify(r.body));
 assert.equal(r.body.owned,true);assert.equal(r.body.owner_kind,'application');assert.equal(r.body.cart_verified,false);assert.equal(r.body.checkout_ready,false);
 assert.equal(f.state.writes,1);assert.equal(f.state.reads,2);assert.deepEqual(f.state.ips,['127.0.0.1','127.0.0.1','127.0.0.1']);
 assert.equal(openCartCapability(f.rows()[0].sealed_cart,f.config.sessionSecret),id);assert.equal(readFileSync(join(f.config.dataDir,'jobs.sqlite')).includes(Buffer.from(id)),false);
 assert.equal((await f.inspect(a,id,undefined,'status')).body.binding_id,r.body.binding_id);
 for(const [x,cart] of [[b,id],[a,id],[a,id+'x'],[b,id+'x'],[a,id.replace('synthetic','other')]])assert.notEqual((await f.inspect(x,cart)).status,200);
 assert.notEqual((await f.inspect(b,id,undefined,'status')).status,200);
 assert.equal(f.state.writes,1);assert.equal(f.rows().length,1);
 const renewal=await f.renew(a);assert.equal(renewal.status,200);assert.notEqual((await f.inspect(a,id,undefined,'status')).status,200);
 assert.equal((await f.inspect(renewal.body.token,id,undefined,'status')).body.owned,true);
 assert.equal((await f.call('/resource-sessions/revoke',{},renewal.body.token)).status,200);
 assert.equal(f.rows('SELECT count(*) AS n FROM authority_events WHERE acknowledged=0')[0].n,1);
 assert.notEqual((await f.issue()).status,200);assert.equal((await f.call('/resource-sessions/revoke',{},b)).status,200);
 assert.equal(f.rows('SELECT count(*) AS n FROM authority_events WHERE acknowledged=0')[0].n,2);
});

test('F06N proof substitution, purpose/action, stale/replay and caller-positive fields cannot bind',async t=>{
 const f=await rig(t),a=await token(f),b=await token(f),p=(await f.proof('cart-capability',a)).body.proof;
 assert.equal((await f.inspect(b,id,p)).body.code,'PROOF_BINDING');
 assert.equal((await f.call('/owned-cart/bind',{cart_id:id,proof:p,verified:true},a)).status,403);
 assert.notEqual((await f.inspect(undefined,id,p)).status,200);
 assert.notEqual((await f.inspect(a,id,(await f.proof('renew',a)).body.proof)).status,200);
 assert.equal((await f.inspect(a,id,p)).status,200);assert.notEqual((await f.inspect(a,id,p)).status,200);
 assert.equal(f.state.writes,1);
});

for(const purpose of ['session','upload','resource'])test('F06N historical '+purpose+' principal cannot acquire new binding',async t=>{
 let old;const f=await rig(t,{beforeMigration(c,clock){const h=openDatabase(c,{resourceSessions:true,cartCapability:true,now:()=>clock.time});
  if(purpose==='resource')old=h.store.resourceSessions.issue({id:'a'.repeat(43),observedAt:clock.time,customerId:null}).token;
  h.close();if(purpose!=='resource'){
   // Existing issuers on this same database, with their original purpose.
   const db=new DatabaseSync(join(c.dataDir,'jobs.sqlite'));
   return import('../backend/resource-session.mjs').then(async({createResourceSessions})=>{const {createLifecycle}=await import('../jobs/lifecycle.mjs');old=createResourceSessions(db,createLifecycle(db),()=>clock.time,{sessionOnly:purpose==='session',uploadOnly:purpose==='upload'}).issue({id:'b'.repeat(43),observedAt:clock.time,customerId:null}).token;db.close();});
  }
 }});assert.notEqual((await f.inspect(old)).status,200);assert.equal(f.state.writes,0);assert.equal(f.rows().length,0);
 assert.equal((await f.inspect(await token(f))).status,200);
});

for(const mode of ['incomplete','invalid','changed','lost'])test('F06N '+mode+' retains attempt and never produces/retries binding',async t=>{
 const f=await rig(t,{mode}),a=await token(f);assert.notEqual((await f.inspect(a)).status,200);
 assert.equal(f.rows()[0].state,mode==='incomplete'||mode==='invalid'?'rejected':'unknown');
 assert.equal(f.rows('SELECT binding_id FROM cart_owner_admissions')[0].binding_id,null);assert.notEqual((await f.inspect(a)).status,200);
 assert.equal(f.state.writes,mode==='incomplete'?0:1);await f.close();
 const g=await rig(t,{config:f.config,clock:f.clock});assert.notEqual((await g.inspect(a)).status,200);assert.equal(g.state.writes,0);
});

for(const change of ['renew','revoke','expire','proof_age','customer','key','epoch','pending','operation'])test('F06N async '+change+' cannot commit a late binding',async t=>{
 const f=await rig(t),a=await token(f),gate=deferred(),started=deferred();f.state.gate=gate;f.state.before=write=>{if(write)started.resolve();};
 const pending=f.inspect(a);await started.promise;
 if(change==='renew')assert.equal((await f.renew(a)).status,200);
 if(change==='revoke')assert.equal((await f.call('/resource-sessions/revoke',{},a)).status,200);
 if(change==='expire')f.clock.time+=300001;
 if(change==='proof_age')f.clock.time+=30001;
 if(change==='customer')f.state.current.buyerIdentity.customer={id:'gid://shopify/Customer/123'};
 if(change==='key')f.state.after=(_w,c)=>{c.id=id+'x';};
 if(['epoch','pending','operation'].includes(change)){
  const db=new DatabaseSync(join(f.config.dataDir,'jobs.sqlite'));
  if(change==='epoch')db.exec('UPDATE authority_state SET epoch=epoch+1');
  if(change==='pending')db.exec("INSERT INTO authority_events VALUES ('synthetic-pending','hash',0,0)");
  if(change==='operation')db.prepare('UPDATE authority_state SET operation=?').run(JSON.stringify({id:'synthetic-unknown',epoch:0,kind:'publish'}));db.close();
 }
 gate.resolve();assert.notEqual((await pending).status,200);assert.equal(f.rows()[0].state,'unknown');assert.equal(f.rows('SELECT binding_id FROM cart_owner_admissions')[0].binding_id,null);assert.equal(f.state.writes,1);
});

test('F06N fresh customer mismatch, changed/incomplete status fields and key changes deny without sends',async t=>{
 const f=await rig(t),a=await token(f);
 assert.notEqual((await f.inspect(a,id,(await f.proof('cart-capability',a,'123')).body.proof)).status,200);assert.equal(f.rows().length,0);
 assert.equal((await f.inspect(a)).status,200);
 for(const mutate of [()=>{f.state.current.note='changed';},()=>{delete f.state.current.buyerIdentity;},()=>{f.state.current.buyerIdentity={customer:{id:'gid://shopify/Customer/123'},purchasingCompany:null};}]){
  mutate();assert.notEqual((await f.inspect(a,id,undefined,'status')).status,200);
 }
 assert.notEqual((await f.inspect(a,id+'x',undefined,'status')).status,200);assert.equal(f.state.writes,1);
});

test('F06N concurrent same and foreign requests have one durable send admission',async t=>{
 const f=await rig(t),a=await token(f),b=await token(f),p=(await f.proof('cart-capability',a)).body.proof,q=(await f.proof('cart-capability',b)).body.proof;
 const results=await Promise.all([f.inspect(a,id,p),f.inspect(a,id,p),f.inspect(b,id.replace('cart?','other?'),q)]);
 assert.equal(results.filter(x=>x.status===200).length,1);assert.equal(f.state.writes,1);assert.equal(f.rows().length,1);
});

test('F06N routes remain bounded and window/status/restart preserve current history and authority obligations',async t=>{
 const f=await rig(t),a=await token(f);await f.inspect(a);
 for(const path of ['/jobs','/uploads/intents','/quote','/checkout','/authority','/orders','/cart','/hooks/uploadcare'])assert.equal((await f.call(path,{},a)).status,404);
 for(const headers of [{cookie:'x=1'},{origin:'https://foreign.invalid'}])assert.notEqual((await f.call('/owned-cart/bind',{cart_id:id,proof:'a'.repeat(43)},a,headers)).status,200);
 assert.notEqual((await f.call('/owned-cart/bind?key=not-secret',{},a)).status,200);
 await f.close();const g=await rig(t,{config:f.config,clock:f.clock});assert.equal((await g.inspect(a,id,undefined,'status')).status,200);assert.equal(g.state.writes,0);
 assert.equal((await g.call('/resource-sessions/revoke',{},a)).status,200);const before=state(g);await g.close();
 const closed=createSessionOnlyRuntime({...g.config,resourceSessions:'session-only-closed'},{now:()=>g.clock.time});t.after(()=>closed.close());const address=await closed.start();
 for(const path of ['/resource-proof/challenge','/owned-cart/bind','/owned-cart/status','/jobs'])assert.equal((await fetch(`http://127.0.0.1:${address.port}`+path,{method:'POST'})).status,404);
 assert.deepEqual(state(g),before);assert.equal(g.rows('SELECT count(*) AS n FROM authority_events WHERE acknowledged=0')[0].n,1);await closed.close();
});

test('F06N nonvisual memory-only consumer uses native exact locator and fresh same-session proof',async t=>{
 const f=await rig(t),{createOwnedCart}=await import('../theme/owned-cart.js');
 const oldLocation=globalThis.location,oldLocator=globalThis.BFLPrintCartLocator;
 globalThis.location={origin};let located=0;globalThis.BFLPrintCartLocator={locate:async()=>{located++;return {cart_id:id};}};
 t.after(()=>{if(oldLocation===undefined)delete globalThis.location;else globalThis.location=oldLocation;if(oldLocator===undefined)delete globalThis.BFLPrintCartLocator;else globalThis.BFLPrintCartLocator=oldLocator;});
 const calls=[];const fetchImpl=async(url,init)=>{
  calls.push({url,init});assert.equal(url.includes('key='),false);
  if(url.startsWith('/apps/')){const q=new URL(url,origin).searchParams;assert.equal(init.credentials,'same-origin');return fetch(f.url+'/proxy/resource-proof?'+f.sign(Object.fromEntries(q)));}
  assert.equal(init.credentials,'omit');return fetch(f.url+new URL(url).pathname,{...init,headers:{...init.headers,origin}});
 };
 const client=createOwnedCart({fetchImpl,now:()=>f.clock.time});assert.equal(calls.length,0);
 assert.equal((await client.issue()).token,undefined);assert.equal((await client.bind()).owned,true);assert.equal((await client.renew()).generation,2);assert.equal((await client.status()).owned,true);assert.equal(located,2);
 assert.equal((await client.revoke()).remote_confirmed,true);assert.equal(f.state.writes,1);
});

test('F06N old capability-only reservation cannot be promoted by a new owner',async t=>{
 const f=await rig(t,{beforeMigration(c,clock){const h=openDatabase(c,{resourceSessions:true,cartCapability:true,now:()=>clock.time}),s=h.store;
  const old=s.resourceSessions.issue({id:'o'.repeat(43),observedAt:clock.time,customerId:null}).token;
  const ticket=s.resourceSessions.authenticate({headers:{origin,authorization:'Bearer '+old}});
  const a=s.cartCapability.reserve({ticket,cart_id:id,proofId:'p'.repeat(43),created:clock.time,sealed:'historical-immutable-custody'});s.cartCapability.sending(a,'historical-snapshot');s.cartCapability.finish(a,'capability_only');h.close();
 }}),a=await token(f);const before=f.rows();assert.notEqual((await f.inspect(a)).status,200);assert.deepEqual(f.rows(),before);assert.equal(f.state.writes,0);
});

test('F06N expiry retains a real pending event; resource/table restrictions survive other modes',async t=>{
 const f=await rig(t),a=await token(f);await f.inspect(a);const owner=f.rows('SELECT owner FROM cart_owner_admissions')[0].owner;
 f.clock.time+=300001;assert.notEqual((await f.issue()).status,200);assert.equal(f.rows('SELECT count(*) AS n FROM authority_events WHERE acknowledged=0')[0].n,1);
 await f.close();const db=new DatabaseSync(join(f.config.dataDir,'jobs.sqlite'));
 assert.throws(()=>db.prepare('INSERT INTO jobs VALUES (?,?,?,?,?)').run('job-id',owner,'request-key','fp','{}'),/CART_OWNER_RESOURCE_CLOSED/);
 assert.throws(()=>db.prepare('INSERT INTO uploads VALUES (?,?,?,?)').run(owner,'asset','complete','private'),/CART_OWNER_RESOURCE_CLOSED/);
 assert.throws(()=>db.prepare('DELETE FROM cart_owner_admissions').run(),/CART_OWNER_RETAINED/);db.close();
 const next=await rig(t,{config:f.config,clock:f.clock});assert.notEqual((await next.issue()).status,200);assert.equal(next.rows('SELECT count(*) AS n FROM authority_events WHERE acknowledged=0')[0].n,1);
});

test('F06N ordinary nonempty full selection binds; printing and customer preconditions remain closed',async t=>{
 const f=await rig(t),a=await token(f);f.state.current.totalQuantity=1;f.state.current.lines.nodes=[{__typename:'CartLine',id:'gid://shopify/CartLine/synthetic',quantity:1,parentRelationship:null,attributes:[],sellingPlanAllocation:null,cost:{subtotalAmount:{amount:'1.00',currencyCode:'USD'}},merchandise:{__typename:'ProductVariant',id:'gid://shopify/ProductVariant/123',requiresComponents:false,product:{id:'gid://shopify/Product/123'}}}];
 assert.equal((await f.inspect(a)).status,200);assert.equal((await f.inspect(a,id,undefined,'status')).status,200);assert.equal(f.state.writes,1);
 f.state.current.lines.nodes[0].quantity=2;f.state.current.totalQuantity=2;assert.notEqual((await f.inspect(a,id,undefined,'status')).status,200);
});

test('F06N changed signed renewal context retires owner without pretending authority acknowledgement',async t=>{
 const f=await rig(t),a=await token(f);await f.inspect(a);
 const p=(await f.proof('renew',a,'123')).body.proof;assert.equal((await f.call('/resource-sessions/renew',{proof:p},a)).body.code,'RESOURCE_CONTEXT_CHANGED');
 assert.equal(f.rows('SELECT count(*) AS n FROM authority_events WHERE acknowledged=0')[0].n,1);assert.notEqual((await f.inspect(a,id,undefined,'status')).status,200);
});

test('F06N finite window fences a delayed pre-read before any mutation, keeps permanent admission',async t=>{
 const f=await rig(t),a=await token(f),gate=deferred(),started=deferred();f.state.before=async write=>{if(!write){started.resolve();await gate.promise;}};
 const pending=f.inspect(a);await started.promise;f.config.cartWindowUntil=f.clock.time;gate.resolve();assert.notEqual((await pending).status,200);assert.equal(f.state.writes,0);assert.equal(f.rows()[0].state,'rejected');
 assert.equal((await f.inspect(a)).status,404);assert.equal((await f.call('/resource-sessions/revoke',{},a)).status,200);
});

test('F06N actual killed writer keeps lock and unknown attempt; explicit recovery retains schema9 closed history',async t=>{
 const {spawn}=await import('node:child_process'),{once}=await import('node:events'),{releaseAbandonedLock}=await import('../backend/storage.mjs');
 const f=await rig(t),a=await token(f),request={headers:{origin,authorization:'Bearer '+a}};await f.close();
 const storage=new URL('../backend/storage.mjs',import.meta.url).href;
 const code=`import {openDatabase} from ${JSON.stringify(storage)};const s=openDatabase(JSON.parse(process.env.SYNTHETIC_CONFIG),{resourceSessions:true,cartOwner:true}).store;const t=s.resourceSessions.authenticate(${JSON.stringify(request)});const id=s.lifecycle.transaction(()=>{const id=s.cartCapability.reserve({ticket:t,cart_id:${JSON.stringify(id)},proofId:'x'.repeat(43),created:Date.now(),sealed:'synthetic-unknown-custody'});s.ownedCart.reserve(t,id);return id;});s.cartCapability.sending(id,'synthetic-snapshot');console.log('ready');setInterval(()=>{},1000);`;
 const child=spawn(process.execPath,['--input-type=module','-e',code],{env:{...process.env,SYNTHETIC_CONFIG:JSON.stringify(f.config)},stdio:['ignore','pipe','ignore']});t.after(()=>child.kill('SIGKILL'));await once(child.stdout,'data');
 const lock=JSON.parse(readFileSync(join(f.config.dataDir,'runtime.lock/owner.json')));assert.throws(()=>releaseAbandonedLock(f.config,lock.token,true),/WRITER_STILL_ALIVE/);
 const ended=once(child,'exit');child.kill('SIGKILL');await ended;assert.throws(()=>openDatabase(f.config,{resourceSessions:true,cartOwner:true}),/DATABASE_LOCKED/);
 releaseAbandonedLock(f.config,lock.token,true);const before=f.rows();const g=await rig(t,{config:f.config,clock:f.clock});assert.notEqual((await g.inspect(a)).status,200);assert.equal(g.state.writes,0);assert.deepEqual(g.rows(),before);await g.close();
 const closed=createSessionOnlyRuntime({...f.config,resourceSessions:'session-only-closed'});await closed.start();await closed.close();assert.deepEqual(f.rows(),before);
});

test('F06N two-owner capacity and one spent failed attempt cannot reset through renewal/restart',async t=>{
 const f=await rig(t,{mode:'invalid'}),a=await token(f),b=await token(f);assert.notEqual((await f.issue()).status,200);
 assert.notEqual((await f.inspect(a)).status,200);assert.equal(f.state.writes,1);const fresh=await f.renew(b);assert.equal(fresh.status,200);
 assert.notEqual((await f.inspect(fresh.body.token,id.replace('f06n','another'))).status,200);assert.equal(f.state.writes,1);
 await f.close();const g=await rig(t,{config:f.config,clock:f.clock});assert.notEqual((await g.issue()).status,200);assert.notEqual((await g.inspect(fresh.body.token,id.replace('f06n','another'))).status,200);assert.equal(g.state.writes,0);
});

test('F06N lost successful HTTP response does not replay; same owner can inspect the retained binding',async t=>{
 const f=await rig(t),a=await token(f);const r=await f.inspect(a);assert.equal(r.status,200);
 // Discard the response as the client would on disconnect. No returned binding
 // ID is required by status, but both the current owner and exact key still are.
 await f.close();const g=await rig(t,{config:f.config,clock:f.clock});assert.equal((await g.inspect(a,id,undefined,'status')).status,200);assert.notEqual((await g.inspect(a)).status,200);assert.equal(g.state.writes,0);
});
