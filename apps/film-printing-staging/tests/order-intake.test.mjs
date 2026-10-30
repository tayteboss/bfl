import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,chmodSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {request as httpRequest} from 'node:http';
import {createJobStore,createJobService} from '../jobs/service.mjs';
import {parseOrderResponse,createOrderReader,authenticateOrderSignal,hash} from '../orders/shopify.mjs';
import {createOrderHandoff} from '../orders/service.mjs';
import {createOrderWorker} from '../orders/worker.mjs';
import {createRuntime} from '../backend/server.mjs';
import {initializeDatabase,openDatabase,migrateOrderInbox} from '../backend/storage.mjs';
import {fixture,signal,secret,config,orderId,owner,customer,id,response,orderResponse} from '../../../fixtures/film-printing/f06f/synthetic.mjs';
import {selection} from '../../../fixtures/film-printing/f06c-continuation/synthetic.mjs';
import {mockAdmin,now} from '../../../fixtures/film-printing/f06d/mock-admin.mjs';
import {decodeCatalog} from '../checkout/shopify.mjs';
const dirs=[];after(()=>dirs.forEach(d=>rmSync(d,{recursive:true,force:true})));
const directory=()=>{const d=mkdtempSync(join(tmpdir(),'bfl-intake-'));chmodSync(d,0o700);dirs.push(d);return d;};
const setup=async(t,options)=>{const f=await fixture(join(directory(),'jobs.sqlite'),options);t.after(()=>f.store.close());return f;};
const sql=(f,fn)=>{const db=new DatabaseSync(f.path);try{return fn(db);}finally{db.close();}};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const until=async(fn)=>{for(let i=0;i<200;i++){if(fn())return;await sleep(10);}throw Error('local condition timed out');};
const delivery=s=>authenticateOrderSignal(s,secret).delivery_hash;
const worker=f=>createOrderWorker({inbox:f.store.orderInbox,handoff:f.receive,enabled:true});
const c=()=>({...config,dataDir:directory(),jobSecret:'synthetic-job-signature-only'.repeat(3),sessionSecret:'synthetic-session-secret'.repeat(3),appSecret:secret,origin:'http://127.0.0.1:6076',host:'127.0.0.1',port:0,mode:'disabled'});
async function runtime(t,{orders={ingress:true,worker:true,enabled:true},fetcher,bound=true}={}) {
 const cfg=c();cfg.databaseId=initializeDatabase(cfg);let data,reads=0;
 const r=createRuntime(cfg,{api:async()=>{throw Error('SYNTHETIC_OFFLINE');},orders:{...orders,transport:{fetchImpl:async(...args)=>{reads++;return fetcher?fetcher(data,...args):response(data);}}}});
 t.after(()=>r.close());
 const m=mockAdmin(),catalog=decodeCatalog(m.data.currentAppInstallation.catalog.value);
 const jobs=createJobService({store:r.store,secret:cfg.jobSecret,loader:{load:async()=>m.release},loadCatalog:async()=>catalog});
 for(const a of selection.asset_ids)r.store.recordUpload(owner,{id:a,state:'complete',verified:true,url:`https://example.invalid/${a}`});
 const prepared=await jobs.prepare(owner,selection);data=orderResponse(prepared);
 const db=new DatabaseSync(join(cfg.dataDir,'jobs.sqlite'));
 db.prepare('INSERT INTO cart_job_bindings VALUES (?,?,?)').run(prepared.reference.id,hash(id),hash(owner));
 if(bound)db.prepare('INSERT INTO order_source_bindings VALUES (?,?,?,?,?)').run(hash(id),hash(owner),hash('synthetic-order-cart-token'),hash(customer),hash('synthetic-only-proof'));
 db.close();const address=await r.start();
 const url=`http://127.0.0.1:${address.port}/webhooks/orders/create`;
 return {r,cfg,data,prepared,url,reads:()=>reads,post:s=>fetch(url,{method:'POST',headers:s.headers,body:s.rawBody})};
}

test('F06F parser accepts only object envelopes with errors absent or an empty array',async t=>{
 const f=await setup(t);
 for(const errors of [{},'',0,false,null,undefined,{length:0},'error',[{message:'private'}]])assert.throws(()=>parseOrderResponse({...f.order,errors},orderId),/ORDER_QUERY_REJECTED/);
 for(const root of [null,undefined,0,'',[],Object.assign([],{data:f.order.data}),{data:[]},{data:null}])assert.throws(()=>parseOrderResponse(root,orderId),/ORDER_QUERY_REJECTED/);
 assert.equal(parseOrderResponse(f.order,orderId).id,orderId);assert.equal(parseOrderResponse({...f.order,errors:[]},orderId).id,orderId);
});
test('F06F HTTP order-reader error envelopes fail before canonical acceptance',async t=>{
 const f=await setup(t);for(const errors of [{},'',0,false,null,{length:0},[{message:'private'}]]){
  const read=createOrderReader({...config,enabled:true},{fetchImpl:async()=>response({...f.order,errors})});await assert.rejects(read(orderId),/ORDER_QUERY_REJECTED/);
 }
 assert.equal(f.store.orders.latest(orderId),null);
});
test('F06F durable intake ACK precedes slow canonical read and stores no raw body or secret',async t=>{
 const gate=deferred(),entered=deferred();const f=await runtime(t,{fetcher:async data=>{entered.resolve();await gate.promise;return response(data);}});
 const s=signal(orderId,{admin_graphql_api_id:orderId,email:'PRIVATE-PII-NOT-RETAINED',note:'secret message'});
 const start=Date.now(),res=await f.post(s);assert.equal(res.status,200);assert.ok(Date.now()-start<1000);
 const receipt=await res.json();assert.deepEqual(receipt,{received:true,durable:true,duplicate:false,processed:false,checkout_ready:false,fulfillment_authorized:false});
 await entered.promise;assert.equal(f.r.store.orders.latest(orderId),null);
 const d=new DatabaseSync(join(f.cfg.dataDir,'jobs.sqlite'));const rows=d.prepare('SELECT * FROM order_inbox').all();d.close();
 assert.equal(rows.length,1);assert.equal(rows[0].body_hash,hash(s.rawBody));assert.ok(!JSON.stringify(rows).includes('PRIVATE-PII'));assert.ok(!JSON.stringify(rows).includes(secret));assert.ok(!JSON.stringify(rows).includes('message'));
 gate.resolve();await until(()=>f.r.store.orderInbox.status(delivery(s)).state==='done');assert.equal(f.r.store.orders.latest(orderId).lines[0].physical_count,45);assert.ok(f.r.store.lifecycle.state().pending);
});
test('F06F public ingress is unmounted by default and disabled reader never performs fetch',async t=>{
 const off=await runtime(t,{orders:{}});assert.equal((await off.post(signal())).status,404);assert.equal(off.reads(),0);
 const f=await runtime(t,{orders:{ingress:true,worker:true}}),s=signal();assert.equal((await f.post(s)).status,200);await until(()=>f.r.store.orderInbox.status(delivery(s)).state==='held');
 assert.equal(f.reads(),0);assert.equal(f.r.store.orderInbox.status(delivery(s)).code,'ORDER_HANDOFF_DISABLED');
});
test('F06F intake rejects forged signatures, selector/encoding tampering, oversized and malformed JSON without retaining rows',async t=>{
 const f=await runtime(t,{orders:{ingress:true}}),s=signal();
 for(const [input,status] of [[{...s,rawBody:Buffer.concat([s.rawBody,Buffer.from(' ')])},401],
 [{...s,headers:{...s.headers,'x-shopify-topic':'orders/paid'}},400],[{...s,headers:{...s.headers,'content-encoding':'gzip'}},400],
 [{...s,rawBody:Buffer.alloc(262145)},413],[{...s,headers:{...s.headers,'x-shopify-shop-domain':'foreign.myshopify.com'}},400]])assert.equal((await f.post(input)).status,status);
 assert.deepEqual(f.r.store.orderInbox.counts(),{});assert.equal(f.reads(),0);
});
test('F06F conflicting delivery is rejected; exact duplicate receipt does not requeue a held signal',async t=>{
 const f=await runtime(t,{bound:false}),s=signal();assert.equal((await f.post(s)).status,200);await until(()=>f.r.store.orderInbox.status(delivery(s)).state==='held');
 const reads=f.reads();assert.equal((await (await f.post(s)).json()).duplicate,true);await sleep(300);assert.equal(f.reads(),reads);
 const changed=signal(orderId,{admin_graphql_api_id:orderId,note:'different'});changed.headers['x-shopify-webhook-id']=s.headers['x-shopify-webhook-id'];changed.headers['x-shopify-event-id']=s.headers['x-shopify-event-id'];
 assert.equal((await f.post(changed)).status,409);assert.equal(f.r.store.orderInbox.counts().held,1);
 // New delivery IDs for the same held order cannot create an automatic poll loop.
 assert.equal((await f.post(signal())).status,200);await sleep(300);assert.equal(f.reads(),reads);assert.equal(f.r.store.orderInbox.counts().held,2);
});
test('F06F queue capacity and failed persistence return failure rather than a false ACK',async t=>{
 const f=await runtime(t,{orders:{ingress:true}});const db=new DatabaseSync(join(f.cfg.dataDir,'jobs.sqlite'));
 db.exec("CREATE TRIGGER synthetic_fail BEFORE INSERT ON order_inbox BEGIN SELECT RAISE(ABORT,'private failure'); END");
 const bad=await f.post(signal());assert.equal(bad.status,503);assert.ok(!(await bad.text()).includes('private failure'));assert.deepEqual(f.r.store.orderInbox.counts(),{});db.exec('DROP TRIGGER synthetic_fail');
 const insert=db.prepare("INSERT INTO order_inbox(delivery_hash,order_id,event_hash,body_hash,state,next_at,received_at) VALUES (?,?,?,?,?,?,?)");
 db.exec('BEGIN');for(let i=0;i<1000;i++)insert.run(hash('row'+i),orderId,hash('event'),hash('body'),'held',0,0);db.exec('COMMIT');db.close();
 const full=await f.post(signal());assert.equal(full.status,503);assert.equal((await full.json()).code,'ORDER_INBOX_FULL');
});
test('F06F HTTP body deadline is bounded and aborted/slow bodies are not recorded',async t=>{
 const f=await runtime(t,{orders:{ingress:true}}),s=signal();const start=Date.now();
 const status=await new Promise((resolve,reject)=>{
  const req=httpRequest(f.url,{method:'POST',headers:{...s.headers,'content-length':100}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.write('{');
 });
 assert.equal(status,408);assert.ok(Date.now()-start<2500);assert.deepEqual(f.r.store.orderInbox.counts(),{});
});
test('F06F source-link absence is held once; explicit changed-prerequisite retry still uses canonical verification',async t=>{
 const f=await setup(t,{bound:false}),w=worker(f),s=f.signal;t.after(()=>w.stop());f.store.orderInbox.enqueue(s,secret);await w.run();
 const key=delivery(s);assert.equal(f.store.orderInbox.status(key).state,'held');assert.equal(f.store.orderInbox.status(key).code,'ORDER_SOURCE_LINK_UNPROVEN');
 await w.run();assert.equal(f.store.orderInbox.status(key).attempts,1);assert.throws(()=>f.store.orderInbox.retry(key,'verified=true'),/EVIDENCE/);
 f.seed();f.store.orderInbox.retry(key,hash('synthetic-prerequisite-change'));await w.run();assert.equal(f.store.orderInbox.status(key).state,'done');assert.equal(f.store.orders.latest(orderId).lines[0].physical_count,45);
});
test('F06F malformed canonical HTTP response moves authenticated intake to hold without consumption',async t=>{
 const f=await runtime(t,{fetcher:async data=>response({...data,errors:{}})}),s=signal();assert.equal((await f.post(s)).status,200);
 await until(()=>f.r.store.orderInbox.status(delivery(s)).state==='held');assert.equal(f.r.store.orderInbox.status(delivery(s)).code,'ORDER_QUERY_REJECTED');assert.equal(f.r.store.orders.latest(orderId),null);
});
test('F06F transient reads retry three times with durable backoff then hold; permissions and missing credentials hold immediately',async t=>{
 const f=await setup(t);const w=worker(f);t.after(()=>w.stop());f.store.orderInbox.enqueue(f.signal,secret);
 f.beforeOrderRead=()=>{throw Error('synthetic network outage');};const key=delivery(f.signal);
 for(let i=1;i<=3;i++){await w.run();assert.equal(f.store.orderInbox.status(key).attempts,i);if(i<3){assert.equal(f.store.orderInbox.status(key).state,'retry');await w.run();assert.equal(f.store.orderInbox.status(key).attempts,i);sql(f,d=>d.exec('UPDATE order_inbox SET next_at=0'));}}
 assert.equal(f.store.orderInbox.status(key).state,'held');await w.run();assert.equal(f.store.orderInbox.status(key).attempts,3);
 for(const [token,reply,code] of [[null,200,'ORDER_CREDENTIAL_REQUIRED'],[config.adminToken,403,'ORDER_ACCESS_DENIED']]){
  const g=await setup(t);g.store.orderInbox.enqueue(g.signal,secret);const h=createOrderHandoff({store:g.store,jobs:g.jobs,config:{...config,adminToken:token},enabled:true,secret,transport:{fetchImpl:async()=>response(g.order,{},reply)}});
  const worker2=createOrderWorker({inbox:g.store.orderInbox,handoff:h,enabled:true});await worker2.run();assert.equal(g.store.orderInbox.status(delivery(g.signal)).code,code);assert.equal(g.store.orderInbox.status(delivery(g.signal)).attempts,1);await worker2.stop();
 }
});
test('F06F persisted claim cannot be fabricated and stale claims cannot commit a delayed read',async t=>{
 const f=await setup(t);await assert.rejects(f.receive.processClaim({delivery_hash:hash('fake'),claim:'fake'}),/STALE/);assert.equal(f.requests.length,0);
 f.store.orderInbox.enqueue(f.signal,secret);const claim=f.store.orderInbox.claim(),gate=deferred();f.beforeOrderRead=()=>gate.promise;
 const attempt=f.receive.processClaim(claim);f.store.orderInbox.fail(claim,'ORDER_PROCESS_SHUTDOWN');gate.resolve();await assert.rejects(attempt,/STALE/);assert.equal(f.store.orders.latest(orderId),null);
});
test('F06F worker deadline fences an abort-ignoring reader and halts further reads',async t=>{
 const f=await setup(t),gate=deferred();f.beforeOrderRead=()=>gate.promise;f.store.orderInbox.enqueue(f.signal,secret);
 const w=createOrderWorker({inbox:f.store.orderInbox,handoff:f.receive,enabled:true,deadlineMs:20});await w.run();assert.equal(w.status().fault,'ORDER_PROCESS_TIMEOUT');assert.equal(f.store.orderInbox.status(delivery(f.signal)).state,'held');
 gate.resolve();await sleep(20);assert.equal(f.store.orders.latest(orderId),null);await w.run();assert.equal(f.requests.length,1);await w.stop();
});
test('F06F one worker claim at a time, even across two supervisors',async t=>{
 const f=await setup(t),gate=deferred();f.beforeOrderRead=()=>gate.promise;f.store.orderInbox.enqueue(f.signal,secret);f.store.orderInbox.enqueue(signal(),secret);
 const a=worker(f),b=worker(f),running=a.run();await b.run();assert.equal(f.requests.length,1);gate.resolve();await running;await b.run();assert.equal(f.requests.length,2);await a.stop();await b.stop();
});
test('F06F shutdown aborts in-flight processing, preserves intake and prevents late writes',async t=>{
 const gate=deferred(),entered=deferred(),f=await runtime(t,{fetcher:async data=>{entered.resolve();await gate.promise;return response(data);}}),s=signal();
 assert.equal((await f.post(s)).status,200);await entered.promise;await f.r.close();gate.resolve();await sleep(20);
 const storage=openDatabase(f.cfg);assert.equal(storage.store.orderInbox.status(delivery(s)).state,'held');assert.equal(storage.store.orders.latest(orderId),null);storage.close();
});
test('F06F restart holds stale processing claims but keeps queued receipts pending for normal work',async t=>{
 const cfg=c();cfg.databaseId=initializeDatabase(cfg);let storage=openDatabase(cfg),s=signal(),queued=signal('gid://shopify/Order/700000002');
 storage.store.orderInbox.enqueue(s,secret);const claim=storage.store.orderInbox.claim();storage.store.orderInbox.enqueue(queued,secret);storage.close();
 storage=openDatabase(cfg);assert.equal(storage.store.orderInbox.status(delivery(s)).code,'PROCESS_INTERRUPTED');assert.equal(storage.store.orderInbox.status(delivery(queued)).state,'queued');assert.throws(()=>storage.store.orderInbox.claimed(claim),/STALE/);storage.close();
});
test('F06F crash window after consumption before queue completion retries idempotently',async t=>{
 const f=await setup(t);f.store.orderInbox.enqueue(f.signal,secret);const claim=f.store.orderInbox.claim();await f.receive.processClaim(claim);const record=f.store.orders.latest(orderId),pending=f.store.lifecycle.state().pending;
 // Represents restart under exclusive lock after consumption committed but before finish.
 f.store.orderInbox.recover();const key=delivery(f.signal);assert.equal(f.store.orderInbox.status(key).state,'held');f.store.orderInbox.retry(key,hash('synthetic-recovery-reviewed'));
 const w=worker(f);await w.run();assert.equal(f.store.orderInbox.status(key).state,'done');assert.deepEqual(f.store.orders.latest(orderId),record);assert.equal(f.store.lifecycle.state().pending,pending);await w.stop();
});
test('F06F schema4 to5 migration preserves previous order/source/unknown state without an automatic backfill',async t=>{
 const cfg=c();cfg.databaseId=initializeDatabase(cfg);let s=openDatabase(cfg);s.store.lifecycle.event('migration-pending',{synthetic:true},()=>{});const operation=s.store.lifecycle.startRecovery();s.close();
 const path=join(cfg.dataDir,'jobs.sqlite');let db=new DatabaseSync(path),identity=JSON.parse(db.prepare('SELECT value FROM runtime_identity').get().value);db.exec('DROP TABLE order_inbox');db.prepare('UPDATE runtime_identity SET value=?').run(JSON.stringify({...identity,schema:4}));db.close();
 assert.throws(()=>openDatabase(cfg),/MIGRATION_REQUIRED/);assert.throws(()=>migrateOrderInbox({...cfg,databaseId:'other'}),/IDENTITY/);assert.equal(migrateOrderInbox(cfg).schema,5);assert.equal(migrateOrderInbox(cfg).already_migrated,true);
 s=openDatabase(cfg);assert.equal(s.store.lifecycle.state().operation.id,operation.id);assert.equal(s.store.lifecycle.state().pending,1);assert.deepEqual(s.store.orderInbox.counts(),{});assert.throws(()=>migrateOrderInbox(cfg),/LOCKED/);s.close();
 db=new DatabaseSync(path);db.exec('DROP TABLE order_inbox');db.close();assert.throws(()=>openDatabase(cfg),/SCHEMA_MISMATCH/);assert.throws(()=>migrateOrderInbox(cfg),/SCHEMA_MISMATCH/);
});
test('F06F retry rearm is evidence-distinct and has an absolute nine-attempt limit',async t=>{
 const f=await setup(t,{bound:false}),w=worker(f),key=delivery(f.signal);f.store.orderInbox.enqueue(f.signal,secret);
 for(let i=1;i<=9;i++){
  await w.run();assert.equal(f.store.orderInbox.status(key).attempts,i);assert.equal(f.store.orderInbox.status(key).state,'held');
  if(i<9){const evidence=hash('change-'+i);f.store.orderInbox.retry(key,evidence);await w.run();assert.equal(f.store.orderInbox.status(key).state,'held');assert.throws(()=>f.store.orderInbox.retry(key,evidence),/EVIDENCE|RETRY_UNAVAILABLE/);i++;if(i<9)f.store.orderInbox.retry(key,hash('change-'+i));}
 }
 assert.throws(()=>f.store.orderInbox.retry(key,hash('tenth-change')),/RETRY_UNAVAILABLE/);await w.stop();
});
test('F06F four concurrent slow bodies are bounded and the fifth is refused before buffering',async t=>{
 const f=await runtime(t,{orders:{ingress:true}}),s=signal();const requests=[];
 const open=()=>new Promise(resolve=>{const req=httpRequest(f.url,{method:'POST',headers:{...s.headers,'content-length':100}},res=>{res.resume();resolve(res.statusCode);});req.on('error',()=>resolve(0));req.write('{');requests.push(req);});
 const pending=Array.from({length:4},open);await sleep(100);assert.equal((await f.post(signal())).status,503);
 requests.forEach(req=>req.destroy());await Promise.all(pending);assert.deepEqual(f.r.store.orderInbox.counts(),{});
});
test('F06F lock contention cannot report a durable receipt when the insert did not commit',async t=>{
 const f=await runtime(t,{orders:{ingress:true}});const db=new DatabaseSync(join(f.cfg.dataDir,'jobs.sqlite'));db.exec('BEGIN IMMEDIATE');
 try{const start=Date.now(),res=await f.post(signal());assert.equal(res.status,503);assert.ok(Date.now()-start<1000);assert.equal((await res.json()).received,false);}finally{db.exec('ROLLBACK');db.close();}
 assert.deepEqual(f.r.store.orderInbox.counts(),{});
});
