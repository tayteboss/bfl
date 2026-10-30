import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,chmodSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {createJobStore} from '../jobs/service.mjs';
import {createAuthorityAdmin} from '../checkout/shopify.mjs';
import {createCartRefresh} from '../checkout/refresh.mjs';
import {initializeDatabase,openDatabase,migrateCartRefresh,migrateOrders,migrateOrderInbox} from '../backend/storage.mjs';
import {createRuntime} from '../backend/server.mjs';
import {createAdminTransport} from '../backend/admin.mjs';
import {STORE,APP,CLIENT} from '../configuration/schema.mjs';
import {INSTALLATION,SHOP} from '../backend/config.mjs';
import {id,owner,customer,proof,fixture,response,cartResponse,selection} from '../../../fixtures/film-printing/f06c-continuation/synthetic.mjs';
import {mockAdmin,now} from '../../../fixtures/film-printing/f06d/mock-admin.mjs';
const dirs=[];after(()=>dirs.forEach(d=>rmSync(d,{recursive:true,force:true})));
const directory=()=>{const d=mkdtempSync(join(tmpdir(),'bfl-cart-refresh-'));chmodSync(d,0o700);dirs.push(d);return d;};
const runtimeConfig=()=>({store:STORE,app:APP,clientId:CLIENT,installation:INSTALLATION,dataDir:directory(),origin:'http://127.0.0.1:6076',host:'127.0.0.1',port:0,
 mode:'reconcile-only',jobSecret:'synthetic-job-secret'.repeat(3),sessionSecret:'synthetic-session-secret'.repeat(3),adminToken:'synthetic-admin-token'.repeat(3)});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function setup(t,options){const f=await fixture(options);t.after(()=>f.store.close());return f;}
const mockApi=m=>async(q,v)=>q.includes('BflActiveConfiguration')?{shop:m.data.shop,currentAppInstallation:{...m.data.currentAppInstallation,metafield:m.data.currentAppInstallation.active}}:
 q.includes('F05PriceCatalog')?{currentAppInstallation:{metafield:m.data.currentAppInstallation.catalog}}:m.api(q,v);

test('F06C complete refresh composes actual reader/job/projector/CAS and never claims checkout readiness',async t=>{
 const f=await setup(t);const result=await f.run();assert.deepEqual(result,{generation:1,state:'published_unverified',checkout_ready:false});
 const line=f.grants()[0].lines[0];assert.equal(line.quantity,4);assert.equal(line.file_count,3);assert.equal(line.unit_cents,120);
 assert.equal(line.id,f.data.data.cart.lines.nodes[0].id);assert.equal(f.m.writes.length,2); // empty revocation + exact grant
 const writes=f.m.writes.length,reads=f.reads;assert.equal((await f.run()).replay,true);assert.equal(f.m.writes.length,writes);assert.equal(f.reads,reads);
});
test('F06C preparation defaults unpublished and Function identity proof cannot be skipped for publication',async t=>{
 const f=await setup(t,{publicationEnabled:false});assert.equal((await f.run()).state,'prepared');assert.equal(f.grants().length,0);
 const g=await setup(t);g.verifyFunction=async()=>false;await assert.rejects(g.run(),/FUNCTION_IDENTITY_UNPROVEN/);assert.equal(g.grants().length,0);
});
test('F06C current copies, removed/re-added IDs and immutable original revision are respected',async t=>{
 const f=await setup(t);await f.run();const revision=f.prepared.reference.revision;f.quantity(5);
 assert.equal((await f.run('refresh-request-0002')).generation,2);assert.equal(f.grants()[0].lines[0].quantity,5);
 assert.equal(f.grants()[0].lines[0].unit_cents,120);assert.equal(f.store.get(f.prepared.reference.id,owner).copies,4);
 f.data.data.cart.lines.nodes[0].id='gid://shopify/CartLine/readded?cart=unchanged-opaque';await f.run('refresh-request-0003');
 assert.equal(f.grants()[0].lines[0].id,f.data.data.cart.lines.nodes[0].id);assert.equal(f.store.get(f.prepared.reference.id,owner).revision,revision);
 await assert.rejects(f.run('refresh-request-0001'),/STALE/);
});
test('F06C last-print removal clears authority with an ordinary remaining line or a completely empty cart',async t=>{
 const f=await setup(t);await f.run();const l=f.data.data.cart.lines.nodes[0];l.attributes=[];l.merchandise.id='gid://shopify/ProductVariant/5';l.merchandise.product.id='gid://shopify/Product/6';
 assert.equal((await f.run('refresh-request-0002')).state,'revoked');assert.equal(f.grants().length,0);
 f.data.data.cart.lines.nodes=[];f.data.data.cart.totalQuantity=0;
 assert.equal((await f.run('refresh-request-0003')).state,'revoked');
});
test('F06C specification edit needs a distinct immutable job; exact replacement grants only the new revision',async t=>{
 const f=await setup(t);await f.run();const original=f.store.get(f.prepared.reference.id,owner);
 const changed=await f.jobs.prepare(owner,{...selection,request_key:'synthetic-job-0002',message:'changed specification'});
 f.data=cartResponse(changed);await f.run('refresh-request-0002');
 const line=f.grants()[0].lines[0];assert.equal(line.claims.job,changed.reference.id);assert.equal(line.claims.revision,changed.reference.revision);
 assert.notEqual(line.claims.revision,original.revision);assert.deepEqual(f.store.get(original.id,owner),original);
});
test('F06C specification tampering, duplicate jobs and foreign-owner references invalidate before any new grant',async t=>{
 for(const mode of ['specification','duplicate','owner']){
  const f=await setup(t);await f.run();
  if(mode==='specification')f.data.data.cart.lines.nodes[0].attributes.find(a=>a.key==='Sizes').value='8x10';
  if(mode==='duplicate'){const l=structuredClone(f.data.data.cart.lines.nodes[0]);l.id='gid://shopify/CartLine/duplicate';f.data.data.cart.lines.nodes.push(l);f.data.data.cart.totalQuantity=8;}
  await assert.rejects(f.run('refresh-request-0002',mode==='owner'?{owner:'foreign-owner'}:{}));assert.equal(f.grants().length,0);
 }
});
test('F06C durable job/cart binding rejects cross-cart replay after clearing grants, without changing identifiers',async t=>{
 const f=await setup(t);await f.run();const other=id.replace('synthetic-cart','other-cart');f.data.data.cart.id=other;
 await assert.rejects(f.run('refresh-request-0002',{cart_id:other}),/CART_JOB_REPLAY/);assert.equal(f.grants().length,0);
});
test('F06C guest/customer or session-binding switch requires fresh owner binding, not silent reuse',async t=>{
 const f=await setup(t);await f.run();f.data.data.cart.buyerIdentity.customer={id:customer};
 await assert.rejects(f.run('refresh-request-0002'),/CART_REBIND_REQUIRED/);assert.equal(f.grants().length,0);
 f.data.data.cart.buyerIdentity.customer=null;f.verify=x=>({...proof(x),binding_id:'another-binding-0002'});
 await assert.rejects(f.run('refresh-request-0003'),/CART_REBIND_REQUIRED/);
});
test('F06C slow old read cannot publish after a newer generation completes',async t=>{
 const f=await setup(t),entered=deferred(),release=deferred();
 f.beforeRead=async()=>{if(f.reads===1){entered.resolve();await release.promise;}};
 const old=f.run();const rejected=assert.rejects(old,/STALE|FENCED/);await entered.promise;
 f.quantity(7);assert.equal((await f.run('refresh-request-0002')).generation,2);release.resolve();await rejected;
 assert.equal(f.grants()[0].lines[0].quantity,7);
});
test('F06C delayed old Admin mutation is fenced by newer refresh recovery, even if authority bytes repeat',async t=>{
 const f=await setup(t),entered=deferred(),release=deferred();let held=false;
 f.m.beforeWrite=async fields=>{if(!held&&JSON.parse(fields.find(x=>x.key==='authority').value).grants.length){held=true;entered.resolve();await release.promise;}};
 const old=f.run();const rejected=assert.rejects(old);await entered.promise;f.quantity(6);
 await f.run('refresh-request-0002');release.resolve();await rejected;
 // Conservative old-failure recovery may clear the newer grant; it can never
 // restore the old one or report readiness from the delayed successful response.
 assert.ok(f.grants().length===0||f.grants()[0].lines[0].quantity===6);
 assert.equal(f.store.lifecycle.state().operation,null);
});
test('F06C source cutover or upload invalidation during read prevents stale preparation',async t=>{
 for(const cause of ['source','upload']){
  const f=await setup(t);let once=false;
  f.beforeRead=async()=>{if(once)return;once=true;
   if(cause==='upload')f.store.recordUpload(owner,{id:'asset-0001',state:'removed'});
   else {const context=await f.admin.read();await f.admin.cutover({context,catalogValue:JSON.stringify({...f.m.catalog,rows:f.m.catalog.rows.map(r=>({...r,per_file_cents:80}))})});}
  };
  await assert.rejects(f.run(),/FENCED/);assert.equal(f.grants().length,0);
 }
});
test('F06C cart changes between prepublication reads and after readback cause invalidation and guarded clearing',async t=>{
 for(const at of [2,3]){
  const f=await setup(t);f.beforeRead=async()=>{if(f.reads===at)f.quantity(9);};
  await assert.rejects(f.run(),/CHANGED/);assert.equal(f.grants().length,0);assert.equal(f.store.lifecycle.state().pending,0);
 }
});
test('F06C successful-but-lost publication and unavailable recovery stay durable until actual guarded readback',async t=>{
 const f=await setup(t);let outage=false;
 f.m.afterWrite=async fields=>{if(JSON.parse(fields.find(x=>x.key==='authority').value).grants.length){outage=true;throw Error('synthetic-lost-response');}};
 f.m.beforeRead=async()=>{if(outage)throw Error('synthetic-offline');};
 await assert.rejects(f.run());assert.equal(f.grants().length,1);assert.ok(f.store.lifecycle.state().operation);assert.ok(f.store.lifecycle.state().pending);
 const writes=f.m.writes.length;const duplicate=await f.run();assert.equal(duplicate.state,'invalidating');assert.equal(f.m.writes.length,writes);
 outage=false;await f.admin.reconcile();f.store.cartRefresh.recovered();assert.equal(f.grants().length,0);assert.equal((await f.run()).state,'revoked');
});
test('F06C crash/reopen preserves pending generation, replay history and job binding; recovery cannot resend unknown publication',async()=>{
 const path=join(directory(),'jobs.sqlite'),f=await fixture({path});await f.run();
 const ticket=f.store.cartRefresh.begin(owner,id,'refresh-request-0002').ticket;f.store.lifecycle.startRecovery();f.store.close();
 const store=createJobStore(path);assert.equal(store.cartRefresh.status(ticket).state,'invalidating');assert.ok(store.lifecycle.state().operation);
 const admin=createAuthorityAdmin(f.m.api,{writesEnabled:true,lifecycle:store.lifecycle,now});await admin.reconcile();store.cartRefresh.recovered();
 assert.equal(store.cartRefresh.status(ticket).state,'revoked');assert.equal(store.cartRefresh.begin(owner,id,'refresh-request-0002').replay,true);
 assert.throws(()=>store.cartRefresh.begin(owner,id,'refresh-request-0001'),/STALE/);store.close();
 const db=new DatabaseSync(path,{readOnly:true}),rows=db.prepare('SELECT * FROM cart_refresh_requests').all();
 assert.equal(rows.length,2);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cart_job_bindings').get().n,1);
 assert.ok(!JSON.stringify(rows).includes(id));assert.ok(!JSON.stringify(rows).includes(owner));db.close();
});
test('F06C schema2 -> schema3 migration is explicit, additive, identity/lock checked and preserves uncertain state',()=>{
 const c=runtimeConfig();c.databaseId=initializeDatabase(c);let s=openDatabase(c);
 s.store.lifecycle.event('synthetic-pending',{test:true},()=>{});s.store.lifecycle.startRecovery();
 s.store.recordUpload(owner,{id:'legacy-asset',state:'complete',verified:true,url:'https://example.invalid/a'});s.close();
 let db=new DatabaseSync(join(c.dataDir,'jobs.sqlite'));const row=JSON.parse(db.prepare('SELECT value FROM runtime_identity').get().value);
 db.exec('DROP TABLE cart_refresh_requests; DROP TABLE cart_job_bindings; DROP TABLE order_job_snapshots; DROP TABLE order_source_bindings; DROP TABLE order_deliveries; DROP TABLE order_observations; DROP TABLE order_consumptions; DROP TABLE order_inbox');db.prepare('UPDATE runtime_identity SET value=?').run(JSON.stringify({...row,schema:2}));db.close();
 assert.throws(()=>openDatabase(c),/MIGRATION_REQUIRED/);assert.throws(()=>migrateCartRefresh({...c,databaseId:'wrong'}),/IDENTITY/);
 assert.equal(migrateCartRefresh(c).schema,3);assert.equal(migrateCartRefresh(c).already_migrated,true);assert.equal(migrateOrders(c).schema,4);assert.equal(migrateOrderInbox(c).schema,5);
 s=openDatabase(c);assert.equal(s.store.uploads(owner,['legacy-asset']).length,1);assert.equal(s.store.lifecycle.state().pending,1);assert.ok(s.store.lifecycle.state().operation);
 assert.throws(()=>migrateCartRefresh(c),/LOCKED/);s.close();
 db=new DatabaseSync(join(c.dataDir,'jobs.sqlite'));db.exec('DROP TABLE cart_job_bindings');db.close();
 assert.throws(()=>openDatabase(c),/SCHEMA_MISMATCH/);assert.throws(()=>migrateCartRefresh(c),/SCHEMA_MISMATCH/);
});
test('F06C runtime HTTP stays closed; internal authenticated refresh uses concrete reader but publication remains disabled',async t=>{
 const c=runtimeConfig();c.databaseId=initializeDatabase(c);const m=mockAdmin();let reads=0;
 const r=createRuntime(c,{api:mockApi(m),now,adapters:{resolveOwner:async({sessionOwner})=>sessionOwner,verifyCartOwnership:proof,resolveBuyerIp:()=> '127.0.0.1'},
  storefront:{enabled:true,privateToken:'synthetic-only-token'.repeat(3),transport:{fetchImpl:async()=>{reads++;return response(cartResponse());}}}});
 t.after(()=>r.close());await r.start();await r.refresh();
 const request={headers:{origin:c.origin,cookie:r.session.issue(owner).split(';')[0]}};
 await assert.rejects(r.refreshAuthority({headers:{}},{cart_id:id,request_key:'refresh-request-0001',owner}),/OWNER_REJECTED/);
 assert.equal(reads,0);
 const result=await r.refreshAuthority(request,{cart_id:id,request_key:'refresh-request-0001',owner:'forged',complete:true});
 assert.equal(result.state,'revoked');assert.equal(result.checkout_ready,false);
 const base=`http://127.0.0.1:${r.server.address().port}`;
 for(const path of ['/bootstrap','/refresh','/publish','/session','/cart'])assert.equal((await fetch(base+path,{method:'POST',headers:request.headers,body:'{}'})).status,404);
 assert.equal((await fetch(base+'/readyz')).status,503);
});
test('F06C runtime startup clears a prior acknowledged grant and invalidates its persisted receipt even without a pending operation',async t=>{
 const c=runtimeConfig();c.databaseId=initializeDatabase(c);const f=await fixture({path:join(c.dataDir,'jobs.sqlite')});
 await f.run();assert.equal(f.grants().length,1);assert.equal(f.store.lifecycle.state().operation,null);f.store.close();
 const r=createRuntime(c,{api:mockApi(f.m),now});t.after(()=>r.close());await r.refresh();
 assert.equal(f.grants().length,0);const replay=r.store.cartRefresh.begin(owner,id,'refresh-request-0001');
 assert.equal(replay.replay,true);assert.equal(replay.ticket.state,'revoked');assert.equal(r.status().ready,false);
});
test('F06C executable cannot create a positive owner resolver and reconcile-only transport cannot publish a grant',async t=>{
 const c=runtimeConfig();c.databaseId=initializeDatabase(c);const m=mockAdmin(),r=createRuntime(c,{api:mockApi(m),now});t.after(()=>r.close());
 await assert.rejects(r.refreshAuthority({headers:{origin:c.origin,cookie:r.session.issue(owner).split(';')[0]}},{cart_id:id,request_key:'refresh-request-0001'}),/OWNER_RESOLVER_UNAVAILABLE/);
 const f=await setup(t);await f.run();let calls=0;
 await assert.rejects(createAdminTransport(c,{fetchImpl:async()=>{calls++;}})('mutation F06DCommitAuthority($fields:[MetafieldsSetInput!]!) {}',{fields:f.m.writes.at(-1)}),/OPERATION_REJECTED/);assert.equal(calls,0);
});

test('settled replacement crash cannot leave an unfinished row eligible for another clean replacement',async()=>{
 for(const state of ['reading','prepared']){
  const path=join(directory(),'jobs.sqlite'),f=await fixture({path});await f.run();
  const epoch=f.store.lifecycle.state().epoch;
  const {ticket}=f.store.cartRefresh.begin(owner,id,'clean-replacement-0002',{replaceSettled:true});
  assert.equal(ticket.cleanReplacement,true);assert.equal(f.store.lifecycle.state().epoch,epoch);
  assert.equal(f.store.lifecycle.state().pending,0);f.store.close();
  if(state==='prepared'){const db=new DatabaseSync(path);db.prepare("UPDATE cart_refresh_requests SET state='prepared' WHERE generation=2").run();db.close();}
  const store=createJobStore(path);
  const next=store.cartRefresh.begin(owner,id,'clean-replacement-0003',{replaceSettled:true});
  assert.equal(next.ticket.cleanReplacement,undefined);assert.ok(store.lifecycle.state().pending>0);
  const admin=createAuthorityAdmin(f.m.api,{writesEnabled:true,lifecycle:store.lifecycle,now});
  await admin.reconcile();store.cartRefresh.recovered();assert.deepEqual(JSON.parse(f.m.data.shop.authority.value).grants,[]);store.close();
 }
});

test('failure before a clean replacement send still invalidates and clears the prior grant',async t=>{
 const f=await setup(t);await f.run();
 const {ticket}=f.store.cartRefresh.begin(owner,id,'clean-replacement-failure',{replaceSettled:true});
 f.store.cartRefresh.fail(ticket);assert.ok(f.store.lifecycle.state().pending>0);
 await f.admin.reconcile();f.store.cartRefresh.recovered();assert.deepEqual(f.grants(),[]);
 assert.equal(f.store.cartRefresh.status(ticket).state,'revoked');
});
