import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {authenticateOrderSignal,parseOrderResponse,createOrderReader,hash,ORDER_QUERY} from '../orders/shopify.mjs';
import {createOrderHandoff} from '../orders/service.mjs';
import {createJobStore,createJobService} from '../jobs/service.mjs';
import {initializeDatabase,openDatabase,migrateOrders,migrateOrderInbox} from '../backend/storage.mjs';
import {createRuntime} from '../backend/server.mjs';
import {orderTables} from '../orders/ledger.mjs';
import {makeRelease} from '../configuration/config.mjs';
import {fixture,signal,secret,config,orderId,owner,customer,id,response,connection} from '../../../fixtures/film-printing/f06f/synthetic.mjs';
import {selection} from '../../../fixtures/film-printing/f06c-continuation/synthetic.mjs';
import {now} from '../../../fixtures/film-printing/f06d/mock-admin.mjs';
const directory=t=>{const d=mkdtempSync(join(tmpdir(),'bfl-order-'));chmodSync(d,0o700);t.after(()=>rmSync(d,{recursive:true,force:true}));return d;};
const setup=async(t,options)=>{const f=await fixture(join(directory(t),'jobs.sqlite'),options);t.after(()=>f.store.close());return f;};
const sql=(f,run)=>{const db=new DatabaseSync(f.path);try{return run(db);}finally{db.close();}};
const line=f=>f.order.data.order.lineItems.nodes[0];
const group=f=>f.order.data.order.fulfillmentOrders.nodes[0];
const reader=(fetchImpl,extra={})=>createOrderReader({...config,enabled:true},{fetchImpl,...extra});

test('F06F defaults disabled before credential use or I/O; no public runtime order ingress',async t=>{
 let calls=0;const read=createOrderReader(config,{fetchImpl:async()=>{calls++;}});await assert.rejects(read(orderId),/DISABLED/);assert.equal(calls,0);
 const f=await setup(t);await assert.rejects(createOrderHandoff({store:f.store,jobs:f.jobs,config})(f.signal),/DISABLED/);
 const c={...config,dataDir:directory(t),jobSecret:secret,sessionSecret:secret+'session',origin:'http://127.0.0.1:6076',host:'127.0.0.1',port:0,mode:'disabled'};
 c.databaseId=initializeDatabase(c);const r=createRuntime(c,{api:async()=>{throw Error('synthetic unavailable');}});
 await assert.rejects(r.receiveOrder(f.signal),/DISABLED/);assert.equal(r.status().ready,false);await r.close();
});
test('F06F verifies exact raw bytes, strict HMAC, headers, case and resource identity',()=>{
 const good=signal();assert.equal(authenticateOrderSignal(good,secret).order_id,orderId);
 const caps={rawBody:good.rawBody,headers:Object.fromEntries(Object.entries(good.headers).map(([k,v])=>[k.toUpperCase(),v]))};assert.equal(authenticateOrderSignal(caps,secret).order_id,orderId);
 for(const changed of [ {...good,rawBody:Buffer.concat([good.rawBody,Buffer.from(' ')])},
  {...good,headers:{...good.headers,'x-shopify-hmac-sha256':'a'.repeat(44)}},
  {...good,headers:{...good.headers,'X-Shopify-Topic':'orders/create'}},
  {...good,headers:{...good.headers,'x-shopify-topic':'orders/paid'}},
  {...good,headers:{...good.headers,'x-shopify-shop-domain':'1jukgy-dc.myshopify.com'}},
  {...good,headers:{...good.headers,'x-shopify-api-version':'2026-07'}},
  {...good,headers:{...good.headers,'x-shopify-event-id':undefined}},
  {...good,headers:{...good.headers,'content-encoding':'gzip'}},
  {...good,rawBody:Buffer.alloc(262145)},signal(orderId,{admin_graphql_api_id:orderId,id:1}),signal(orderId,{id:700000001}),
  signal(orderId,{admin_graphql_api_id:orderId,id:9007199254740993})])assert.throws(()=>authenticateOrderSignal(changed,secret));
});
test('F06F signed signal properties and owner headers cannot establish canonical order ownership',async t=>{
 const f=await setup(t,{bound:false});const s=signal(orderId,{admin_graphql_api_id:orderId,owner,cart_token:'synthetic-order-cart-token',line_items:[{quantity:999}]},{'x-owner':owner});
 const r=await f.receive(s);assert.equal(r.state,'pending');assert.ok(r.unresolved.includes('ORDER_SOURCE_LINK_UNPROVEN'));
 assert.equal(f.store.orders.consumed(f.prepared.reference.id),undefined);assert.ok(f.store.lifecycle.state().pending);assert.equal(r.revoked,false);
 assert.deepEqual(f.requests[0].body,{query:ORDER_QUERY,variables:{id:orderId}});assert.match(f.requests[0].url,/^https:\/\/bellows-film-printing-staging\.myshopify\.com\/admin\/api\/2026-10\/graphql.json$/);
});
test('F06F complete canonical order uses stored historical job and ordered copies with per-parcel tare',async t=>{
 const f=await setup(t);line(f).customAttributes.push({key:'Package',value:'forged'}, {key:'owner',value:'someone-else'});
 line(f).customAttributes.find(x=>x.key==='Location').value='forged lab';
 const r=await f.receive(f.signal);assert.equal(r.state,'recorded');assert.equal(r.revoked,false);assert.equal(r.fulfillment_authorized,false);
 const record=f.store.orders.latest(orderId),l=record.lines[0];assert.equal(l.ordered_copies,15);assert.equal(l.original_copies,4);assert.equal(l.file_count,3);assert.equal(l.physical_count,45);
 assert.deepEqual(record.packing.groups[0].parcels.map(x=>x.print_count),[40,5]);assert.equal(record.packing.groups[0].total_weight_oz,6.5);
 assert.equal(l.lab,'miami');assert.equal(f.store.getForRevocation(l.job_id,owner).copies,4);assert.throws(()=>f.store.get(l.job_id,owner),/REVOKED/);
 assert.ok(!JSON.stringify(record).includes('example.invalid'));assert.ok(!JSON.stringify(record).includes(customer));assert.ok(!JSON.stringify(record).includes('synthetic-order-cart-token'));
});
test('F06F rejects foreign, redacted, absent, partial and oversized canonical resources',async t=>{
 const f=await setup(t),original=structuredClone(f.order);
 const edits=[x=>x.data.shop.id='gid://shopify/Shop/1',x=>x.data.currentAppInstallation.app.apiKey='foreign',x=>x.data.currentAppInstallation.accessScopes.pop(),
 x=>x.data.order=null,x=>x.data.order.id='gid://shopify/Order/1',x=>delete x.data.order.customer,
 x=>x.data.order.lineItems.pageInfo.hasNextPage=true,x=>delete x.data.order.lineItems.pageInfo.hasPreviousPage,
 x=>x.data.order.fulfillmentOrders.pageInfo.hasNextPage=true,x=>x.data.order.fulfillmentOrders.nodes[0].lineItems.pageInfo.hasNextPage=true,
 x=>x.errors=[{message:'redacted private data'}],x=>x.data.order.lineItems.nodes[0].customAttributes.push({key:'_bfl_job',value:'duplicate'}),
 x=>x.data.order.lineItems.nodes[0].product=null,x=>x.data.order.lineItems.nodes[0].requiresShipping=false,
 x=>x.data.order.lineItems.nodes[0].sellingPlan={name:'unsupported'},x=>x.data.order.lineItems.nodes[0].currentQuantity=undefined,
 x=>x.data.order.lineItems.nodes=Array.from({length:21},(_,i)=>({...x.data.order.lineItems.nodes[0],id:`gid://shopify/LineItem/${i+1}`}))];
 for(const edit of edits){const x=structuredClone(original);edit(x);assert.throws(()=>parseOrderResponse(x,orderId));}
 assert.equal(f.store.orders.latest(orderId),null);
});
test('F06F narrow read transport refuses status, redirects, fallback version, invalid bytes and over-limit responses',async t=>{
 const f=await setup(t);
 for(const fetcher of [async()=>response(f.order,{},403),async()=>response(f.order,{'x-shopify-api-version':'2026-07'}),async()=>response(f.order,{'content-type':'text/plain'}),
 async()=>response(f.order,{'content-encoding':'gzip'}),async()=>new Response(new Uint8Array([255]),{headers:{'content-type':'application/json','x-shopify-api-version':'2026-10'}}),
 async()=>({status:200,redirected:true}),async()=>{throw Error('private token');}])await assert.rejects(reader(fetcher)(orderId),e=>!e.message.includes('private token'));
 await assert.rejects(reader(async()=>response(f.order),{maxBytes:10})(orderId),/LIMIT/);
 let calls=0;await assert.rejects(reader(async(_u,r)=>{calls++;return await new Promise((_res,rej)=>r.signal.addEventListener('abort',()=>rej(Error('private timeout'))));},{timeoutMs:10})(orderId),/UNAVAILABLE/);assert.equal(calls,1);
});
test('F06F bad signature/revision, owner, source token, buyer and missing cart binding remain unconsumed',async t=>{
 for(const mode of ['signature','revision','owner','token','customer','guest','cart']){
  const f=await setup(t);if(mode==='signature')line(f).customAttributes.find(a=>a.key==='_bfl_signature').value='a'.repeat(64);
  if(mode==='revision')line(f).customAttributes.find(a=>a.key==='_bfl_revision').value='b'.repeat(64);
  if(mode==='owner')sql(f,db=>db.prepare('UPDATE cart_job_bindings SET owner_hash=?').run(hash('wrong')));
  if(mode==='token')f.order.data.order.cartToken='different-cart';if(mode==='customer')f.order.data.order.customer.id='gid://shopify/Customer/999';
  if(mode==='guest')f.order.data.order.customer=null;if(mode==='cart')sql(f,db=>db.exec('DELETE FROM cart_job_bindings'));
  assert.equal((await f.receive(f.signal)).state,'pending',mode);assert.equal(f.store.orders.consumed(f.prepared.reference.id),undefined);
 }
});
test('F06F duplicate deliveries and changed delivery IDs do not consume twice; conflicts cannot mutate receipts',async t=>{
 const f=await setup(t);await f.receive(f.signal);const state=f.store.lifecycle.state(),record=f.store.orders.latest(orderId);
 assert.equal((await f.receive(f.signal)).state,'recorded');assert.equal((await f.receive(signal())).state,'recorded');assert.equal(f.store.lifecycle.state().pending,state.pending);
 assert.deepEqual(f.store.orders.latest(orderId),record);
 const changed=signal(orderId,{admin_graphql_api_id:orderId,extra:'different'},f.signal.headers);changed.headers['x-shopify-hmac-sha256']=signal(orderId,{admin_graphql_api_id:orderId,extra:'different'}).headers['x-shopify-hmac-sha256'];
 await assert.rejects(f.receive(changed),/DELIVERY_CONFLICT/);assert.deepEqual(f.store.orders.latest(orderId),record);
 await f.admin.reconcile();assert.equal((await f.receive(f.signal)).revoked,true);
});
test('F06F missing source binding can be retried after independently established synthetic evidence',async t=>{
 const f=await setup(t,{bound:false});assert.equal((await f.receive(f.signal)).state,'pending');f.seed();assert.equal((await f.receive(f.signal)).state,'recorded');
 assert.equal(sql(f,db=>db.prepare('SELECT count(*) n FROM order_observations').get().n),2);
});
test('F06F canonical changes after consumption retain old packing and create a durable conflict hold',async t=>{
 const f=await setup(t);await f.receive(f.signal);const old=f.store.orders.latest(orderId);
 line(f).quantity=16;line(f).currentQuantity=16;group(f).lineItems.nodes[0].totalQuantity=16;group(f).lineItems.nodes[0].remainingQuantity=16;
 assert.equal((await f.receive(signal())).state,'conflict');assert.equal(f.store.orders.latest(orderId).packing,null);
 const records=sql(f,db=>db.prepare('SELECT value FROM order_observations ORDER BY sequence').all().map(r=>JSON.parse(r.value)));
 assert.deepEqual(records[0],old);assert.equal(records[0].lines[0].physical_count,45);
});
test('F06F edited, cancelled, refunded and retired jobs are pending with no partial consumption',async t=>{
 for(const mode of ['edited','cancelled','refund','job','owner']){
  const f=await setup(t);if(mode==='edited')f.order.data.order.edited=true;if(mode==='cancelled')f.order.data.order.cancelledAt=now().toISOString();if(mode==='refund')line(f).currentQuantity=14;
  if(mode==='job')f.store.revoke({kind:'job',owner,id:'prior-job-revoke',references:[f.prepared.reference]});
  if(mode==='owner')f.store.revoke({kind:'owner',owner,id:'prior-owner-revoke'});
  assert.equal((await f.receive(f.signal)).state,'pending',mode);assert.equal(f.store.orders.consumed(f.prepared.reference.id),undefined);
 }
});
test('F06F replay of a consumed job into a different real-order resource remains pending',async t=>{
 const f=await setup(t);await f.receive(f.signal);const other='gid://shopify/Order/700000002';f.order.data.order.id=other;f.order.data.order.legacyResourceId='700000002';
 assert.equal((await f.receive(signal(other))).state,'pending');assert.equal(f.store.orders.consumed(f.prepared.reference.id).order_id,orderId);
});
test('F06F new current prices/config cannot rewrite historical snapshot or ordered price',async t=>{
 const f=await setup(t),version=f.prepared.reference.config_version;
 const changed=structuredClone(f.m.release.config);changed.packages[0].empty_weight_oz=100;f.m.release=makeRelease(changed);f.m.catalog.rows[0].per_file_cents=999;
 assert.equal((await f.receive(f.signal)).state,'recorded');assert.equal(f.store.orders.latest(orderId).packing.config_version,version);assert.equal(f.store.orders.latest(orderId).lines[0].unit_price_cents,120);
});
test('F06F migration cannot backfill an old job with current snapshots',async t=>{
 const f=await setup(t);sql(f,db=>db.exec('DELETE FROM order_job_snapshots'));
 assert.equal((await f.receive(f.signal)).state,'pending');assert.ok(f.store.orders.latest(orderId).unresolved.includes('ORDER_HISTORICAL_SNAPSHOT_MISSING'));
});
test('F06F missing/partial/split/pickup/rerouted grouping never becomes an enabled manifest',async t=>{
 for(const mode of ['missing','partial','split','pickup','location','closed','extra']){
  const f=await setup(t);if(mode==='missing')f.order.data.order.fulfillmentOrders.nodes=[];
  if(mode==='partial')group(f).lineItems.nodes[0].remainingQuantity=14;
  if(mode==='split'){group(f).lineItems.nodes[0].totalQuantity=7;group(f).lineItems.nodes[0].remainingQuantity=7;}
  if(mode==='pickup')group(f).deliveryMethod.methodType='PICK_UP';if(mode==='location')group(f).assignedLocation.location.id='gid://shopify/Location/92446294127';if(mode==='closed')group(f).status='CLOSED';
  if(mode==='extra'){const g=structuredClone(group(f));g.id='gid://shopify/FulfillmentOrder/900000002';f.order.data.order.fulfillmentOrders.nodes.push(g);}
  const r=await f.receive(f.signal);assert.equal(r.state,'packing_pending',mode);assert.equal(f.store.orders.latest(orderId).packing,null);assert.ok(f.store.orders.consumed(f.prepared.reference.id));
 }
});
test('F06F assets removed during canonical read remain historically listed but cannot be packed or resurrected',async t=>{
 const f=await setup(t);f.beforeOrderRead=()=>f.store.recordUpload(owner,{id:selection.asset_ids[0],state:'removed'});
 const r=await f.receive(f.signal);assert.equal(r.state,'packing_pending');assert.deepEqual(r.unresolved,['ORDER_ASSETS_UNAVAILABLE']);
 assert.equal(f.store.orders.latest(orderId).lines[0].assets_available_at_recording,false);assert.equal(f.store.orders.latest(orderId).lines[0].file_count,3);
});
test('F06F disabled historical physical rules remain disabled even with verified grouping',async t=>{
 const f=await setup(t); // Prepare a distinct job against a disabled but valid historical release.
 const cfg=structuredClone(f.m.release.config);for(const p of cfg.packages){p.enabled=false;p.disabled_reason='synthetic unresolved';}
 for(const r of cfg.rules){r.enabled=false;r.disabled_reason='synthetic unresolved';}
 const release=makeRelease(cfg);const jobs=createJobService({store:f.store,loader:{load:async()=>release},loadCatalog:async()=>f.store.orders.snapshot(f.prepared.reference.id).catalog,secret:'synthetic-job-signature-only'.repeat(3)});
 const prepared=await jobs.prepare(owner,{...selection,request_key:'new-disabled-job'});const old=f.prepared.reference.id;
 sql(f,db=>{db.prepare('UPDATE cart_job_bindings SET job_id=? WHERE job_id=?').run(prepared.reference.id,old);});
 line(f).customAttributes=Object.entries(prepared.item.properties).map(([key,value])=>({key,value}));
 assert.equal((await f.receive(f.signal)).state,'packing_pending');assert.equal(f.store.orders.latest(orderId).packing,null);
});
test('F06F transaction failure rolls back retirement, delivery, packing and invalidation together',async t=>{
 const f=await setup(t);const before=f.store.lifecycle.state();sql(f,db=>db.exec("CREATE TRIGGER synthetic_failure BEFORE INSERT ON order_observations BEGIN SELECT RAISE(ABORT,'synthetic crash window'); END"));
 await assert.rejects(f.receive(f.signal),/synthetic crash window/);assert.deepEqual(f.store.lifecycle.state(),before);assert.equal(f.store.orders.latest(orderId),null);assert.equal(f.store.orders.consumed(f.prepared.reference.id),undefined);assert.ok(f.store.get(f.prepared.reference.id,owner));
 assert.equal(sql(f,db=>db.prepare('SELECT count(*) n FROM order_deliveries').get().n),0);sql(f,db=>db.exec('DROP TRIGGER synthetic_failure'));assert.equal((await f.receive(f.signal)).state,'recorded');
});
test('F06F an event during remote clearing fences recovery and leaves order invalidation pending',async t=>{
 const f=await setup(t);const operation=f.store.lifecycle.startRecovery();await f.receive(f.signal);assert.throws(()=>f.store.lifecycle.finish(operation),/FENCED/);
 assert.ok(f.store.lifecycle.state().operation);assert.ok(f.store.lifecycle.state().pending);f.m.reject=true;await assert.rejects(f.admin.reconcile());
 assert.equal((await f.receive(f.signal)).revoked,false);f.m.reject=false;await f.admin.reconcile();assert.equal((await f.receive(f.signal)).revoked,true);
});
test('F06F schema3 to4 is explicit/additive and preserves identity, pending operation, tombstones and cart bindings',async t=>{
 const c={...config,dataDir:directory(t),jobSecret:secret,sessionSecret:secret+'session'};c.databaseId=initializeDatabase(c);
 let s=openDatabase(c);s.store.lifecycle.event('synthetic-event',{v:1},()=>s.store.lifecycle.retire('owner','retired'));const op=s.store.lifecycle.startRecovery();s.close();
 let db=new DatabaseSync(join(c.dataDir,'jobs.sqlite'));const identity=JSON.parse(db.prepare('SELECT value FROM runtime_identity').get().value);for(const table of [...orderTables,'order_inbox'])db.exec(`DROP TABLE ${table}`);
 db.prepare('UPDATE runtime_identity SET value=?').run(JSON.stringify({...identity,schema:3}));db.close();
 assert.throws(()=>openDatabase(c),/MIGRATION_REQUIRED/);assert.throws(()=>migrateOrders({...c,databaseId:'other'}),/IDENTITY/);
 assert.equal(migrateOrders(c).schema,4);assert.equal(migrateOrders(c).already_migrated,true);assert.equal(migrateOrderInbox(c).schema,5);s=openDatabase(c);assert.equal(s.store.lifecycle.state().operation.id,op.id);assert.equal(s.store.lifecycle.state().pending,1);assert.equal(s.store.lifecycle.retired('owner','retired'),true);
 assert.throws(()=>migrateOrders(c),/LOCKED/);s.close();db=new DatabaseSync(join(c.dataDir,'jobs.sqlite'));db.exec('DROP TABLE order_consumptions; DROP TABLE order_inbox');db.close();assert.throws(()=>openDatabase(c),/SCHEMA_MISMATCH/);assert.throws(()=>migrateOrders(c),/SCHEMA_MISMATCH/);
});
test('F06F close/reopen retains exact records and pending remote clearing',async t=>{
 const d=directory(t),f=await fixture(join(d,'jobs.sqlite'));await f.receive(f.signal);const before=f.store.orders.latest(orderId),state=f.store.lifecycle.state();f.store.close();
 const reopened=createJobStore(f.path);t.after(()=>reopened.close());assert.deepEqual(reopened.orders.latest(orderId),before);assert.deepEqual(reopened.lifecycle.state(),state);assert.equal(reopened.orders.consumed(f.prepared.reference.id).order_id,orderId);
});
test('F06F routing arriving after order consumption completes pending packing with the retained snapshot',async t=>{
 const f=await setup(t),groups=f.order.data.order.fulfillmentOrders.nodes;f.order.data.order.fulfillmentOrders.nodes=[];
 assert.equal((await f.receive(f.signal)).state,'packing_pending');const consumed=f.store.orders.consumed(f.prepared.reference.id);
 f.order.data.order.fulfillmentOrders.nodes=groups;assert.equal((await f.receive(signal())).state,'recorded');assert.deepEqual(f.store.orders.consumed(f.prepared.reference.id),consumed);
 assert.deepEqual(f.store.orders.latest(orderId).packing.groups[0].parcels.map(p=>p.print_count),[40,5]);
});
test('F06F two real separate fulfillment groups stay separate; a shared group or cross-lab route stays unavailable',async t=>{
 for(const mode of ['separate','shared','wronglab']){
  const f=await setup(t);const prepared=await f.jobs.prepare(owner,{...selection,request_key:'second-order-job'});
  sql(f,db=>db.prepare('INSERT INTO cart_job_bindings VALUES (?,?,?)').run(prepared.reference.id,hash(id),hash(owner)));
  const second={...structuredClone(line(f)),id:'gid://shopify/LineItem/800000002',customAttributes:Object.entries(prepared.item.properties).map(([key,value])=>({key,value}))};f.order.data.order.lineItems.nodes.push(second);
  const secondGroup=structuredClone(group(f));secondGroup.id='gid://shopify/FulfillmentOrder/900000002';secondGroup.lineItems.nodes[0].id='gid://shopify/FulfillmentOrderLineItem/910000002';secondGroup.lineItems.nodes[0].lineItem.id=second.id;
  if(mode==='shared')group(f).lineItems.nodes.push(secondGroup.lineItems.nodes[0]);else f.order.data.order.fulfillmentOrders.nodes.push(secondGroup);
  if(mode==='wronglab')secondGroup.assignedLocation.location.id='gid://shopify/Location/92446294127';
  const r=await f.receive(f.signal);assert.equal(r.state,mode==='separate'?'recorded':'packing_pending');
  if(mode==='separate'){const packing=f.store.orders.latest(orderId).packing;assert.equal(packing.groups.length,2);assert.deepEqual(packing.groups.map(g=>g.total_weight_oz),[6.5,6.5]);}
 }
});
test('F06F one invalid job in a multi-job order cannot partially retire a valid sibling',async t=>{
 const f=await setup(t),second=structuredClone(line(f));second.id='gid://shopify/LineItem/800000002';second.customAttributes.find(a=>a.key==='_bfl_job').value='missing-job-id';f.order.data.order.lineItems.nodes.push(second);
 assert.equal((await f.receive(f.signal)).state,'pending');assert.equal(f.store.orders.consumed(f.prepared.reference.id),undefined);assert.ok(f.store.get(f.prepared.reference.id,owner));
});
test('F06F an old delayed canonical read cannot overwrite a newer conflict record',async t=>{
 const f=await setup(t);await f.receive(f.signal);const old=structuredClone(f.order);
 line(f).quantity=16;line(f).currentQuantity=16;await f.receive(signal());const conflict=f.store.orders.latest(orderId);f.order=old;
 assert.equal((await f.receive(signal())).state,'conflict');assert.equal(f.store.orders.latest(orderId).state,'conflict');assert.equal(conflict.state,'conflict');
});
test('F06F generic runtime order verifier cannot bypass the concrete canonical adapter',async()=>{
 assert.throws(()=>createRuntime(config,{adapters:{eventVerifiers:{order:async x=>x}}}),/EVENT_VERIFIER_UNAVAILABLE/);
});
test('F06F incorrect ordered price and unsupported resource counts cannot create packing',async t=>{
 const f=await setup(t);line(f).originalUnitPriceSet.shopMoney.amount='9.99';assert.equal((await f.receive(f.signal)).state,'pending');assert.equal(f.store.orders.consumed(f.prepared.reference.id),undefined);
 const o=structuredClone(f.order);o.data.order.lineItems.nodes=Array.from({length:9},(_,i)=>({...line(f),id:`gid://shopify/LineItem/${i+1}`}));assert.throws(()=>parseOrderResponse(o,orderId),/JOB_LIMIT/);
});
test('F06F simultaneous duplicate readers recheck durable consumption inside one transaction',async t=>{
 const f=await setup(t);const results=await Promise.all([f.receive(f.signal),f.receive(signal())]);assert.ok(results.every(r=>r.state==='recorded'));
 assert.equal(sql(f,db=>db.prepare('SELECT COUNT(*) n FROM order_consumptions').get().n),1);assert.equal(sql(f,db=>db.prepare('SELECT COUNT(*) n FROM order_observations').get().n),1);
});
