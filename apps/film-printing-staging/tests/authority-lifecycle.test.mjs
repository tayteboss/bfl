import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createJobStore,createJobService} from '../jobs/service.mjs';
import {createLifecycleReceiver} from '../jobs/events.mjs';
import {createCheckoutProjector} from '../checkout/projector.mjs';
import {createAuthorityAdmin} from '../checkout/shopify.mjs';
import {publishDrafts} from '../configuration/shopify.mjs';
import {publishPriceCatalog} from '../jobs/catalog.mjs';
import {APP,STORE} from '../configuration/schema.mjs';
import {PRODUCT,VARIANT,ATTRIBUTES,inspectCart} from '../checkout/authority.js';
import {mockAdmin,now} from '../../../fixtures/film-printing/f06d/mock-admin.mjs';
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const selection={request_key:'offline-request-01',copies:4,service:'Photo Prints',size:'4x6',paper:'synthetic-paper',lab:'miami',asset_ids:['asset-0001','asset-0002','asset-0003'],options:{}};
async function fixture(t,{path=':memory:',mock=mockAdmin()}={}) {
 const store=createJobStore(path);let closed=false;const close=()=>{if(!closed){store.close();closed=true;}};t.after(close);
 const options={writesEnabled:true,lifecycle:store.lifecycle,now};
 const admin=createAuthorityAdmin(mock.api,options);
 const jobs=createJobService({store,loader:{load:async()=>(await admin.read()).release},loadCatalog:async()=>(await admin.read()).catalog,secret:'synthetic-f06d-only-not-a-real-credential'});
 for(const id of selection.asset_ids)store.recordUpload('owner-a',{id,state:'complete',verified:true,url:`https://example.invalid/${id}`});
 const p=await jobs.prepare('owner-a',selection);
 const cart={id:'gid://shopify/Cart/synthetic-a',store:STORE,owner:'owner-a',customer_id:null,complete:true,lines:[{id:'gid://shopify/CartLine/synthetic-a',variant_id:VARIANT,product_id:PRODUCT,quantity:4,reference:p.reference,properties:p.item.properties}]};
 const projector=createCheckoutProjector({jobs,resolveCart:async()=>cart,loadContext:admin.read,binding:{marker:"a".repeat(64),generation:1,get epoch(){return store.lifecycle.state().epoch;}}});
 // The identity verifier here is an explicit MOCK of an authenticated host adapter.
 const receivers=Object.fromEntries(['upload','job','owner','order'].map(kind=>[kind,createLifecycleReceiver({store,jobs,kind,verify:async evidence=>evidence})]));
 const receive=evidence=>receivers[evidence.kind](evidence);
 return {store,close,admin,jobs,p,cart,projector,mock,options,receive,
  event:(kind,extra={})=>({id:`synthetic-${kind}-event`,kind,owner:'owner-a',store:STORE,app:APP,scope:{upload:'upload:invalidate',job:'job:revoke',owner:'owner:revoke',order:'order:consume'}[kind],references:[p.reference],...extra})};
}
async function published(f) {const p=await f.projector.prepare({});await f.admin.publish(p);return p;}
const grants=f=>JSON.parse(f.mock.data.shop.authority.value).grants;
function validAtFunction(f) {
 const input={shop:{authority:f.mock.data.shop.authority,localTime:{date:'2026-10-21'}},cart:{binding:{value:"a".repeat(64)},buyerIdentity:{isAuthenticated:false,customer:null},lines:f.cart.lines.map(l=>({id:l.id,quantity:l.quantity,merchandise:{id:l.variant_id,product:{id:l.product_id}},cost:{amountPerQuantity:{currencyCode:'USD'}},...Object.fromEntries(Object.entries(ATTRIBUTES).map(([a,k])=>[a,{value:l.properties[k]??''}]))}))}};
 return inspectCart(input).valid;
}

test('F06D real projector/store/publisher use durable tickets, four CAS fields and exact readback',async t=>{
 const f=await fixture(t);assert.equal(f.p.checkout_ready,false);
 const before=f.store.get(f.p.reference.id,'owner-a');await published(f);
 assert.equal(validAtFunction(f),true);assert.equal(grants(f)[0].lines[0].unit_cents,120);
 assert.equal(grants(f)[0].lines[0].quantity,4);assert.equal(grants(f)[0].lines[0].file_count,3);
 assert.equal(f.mock.writes[0].length,4);assert.ok(f.mock.writes[0].every(v=>v.compareDigest));
 assert.deepEqual(f.store.get(f.p.reference.id,'owner-a'),before);
});
test('F06D config publisher atomically clears grants, guards catalog/fence and preserves immutable archives',async t=>{
 const f=await fixture(t);const stale=await published(f);
 f.mock.drafts.rules[0].label+=' offline revision';
 const result=await publishDrafts(f.mock.api,f.options);
 assert.equal(result.checkout_ready,false);assert.equal(grants(f).length,0);assert.equal(validAtFunction(f),false);
 const fields=f.mock.writes.at(-1);assert.equal(fields.length,5);
 assert.equal(fields.find(v=>v.key.startsWith('release_')).compareDigest,null);
 const archives=structuredClone([...f.mock.archives]);
 await publishDrafts(f.mock.api,f.options);assert.deepEqual([...f.mock.archives],archives);
 await assert.rejects(f.admin.publish(stale),/AUTHORITY_CHANGED|AUTHORITY_FENCED/);
});
test('F06D catalog price change clears grants; initial missing catalog is guarded with null CAS',async t=>{
 const f=await fixture(t);const old=await published(f);
 f.mock.catalog.rows[0].per_file_cents=41;
 await publishPriceCatalog(f.mock.api,JSON.stringify(f.mock.catalog),f.options);
 assert.equal(grants(f).length,0);await assert.rejects(f.admin.publish(old),/AUTHORITY_CHANGED/);
 await assert.rejects(f.projector.prepare({}),/PRICE_VERSION_MISMATCH/);
 f.mock.data.currentAppInstallation.catalog=null;
 await publishPriceCatalog(f.mock.api,JSON.stringify(f.mock.catalog),f.options);
 assert.equal(f.mock.writes.at(-1).find(v=>v.key==='price_catalog').compareDigest,null);
});
test('F06D source cutover detects changing drafts, archive conflicts, source/fence CAS and exact archive readback',async t=>{
 for(const mode of ['draft','archive','source','fence','readback']) {
  const f=await fixture(t);await published(f);const n=f.mock.writes.length;
  if(mode==='draft')f.mock.changeDrafts=true;
  if(mode==='archive')f.mock.archives.set(`release_${f.mock.release.sha256.slice(0,24)}`,{type:'json',value:'{}',compareDigest:'conflict'});
  if(mode==='source' || mode==='fence')f.mock.beforeWrite=async()=>{f.mock.beforeWrite=null;f.mock.replace(mode==='source'?'catalog':'fence',mode==='source'?JSON.stringify({...f.mock.catalog,extra:'race'}):'00000000-0000-0000-0000-000000000001');};
  if(mode==='readback')f.mock.afterWrite=async fields=>{const a=fields.find(v=>v.key.startsWith('release_'));if(a)f.mock.archives.get(a.key).value='{}';};
  await assert.rejects(publishDrafts(f.mock.api,f.options));
  if(['draft','archive'].includes(mode))assert.equal(f.mock.writes.length,n);
  else assert.ok(f.store.lifecycle.state().operation);
 }
});
test('F06D upload removal/failure after publication remains pending until actual projection is cleared',async t=>{
 for(const state of ['removed','failed','pending']) {
  const f=await fixture(t);const old=await published(f);
  const receipt=f.store.recordUpload('owner-a',{id:'asset-0001',state});
  assert.equal(receipt.revoked,false);assert.equal(validAtFunction(f),true); // explicit two-system window
  await assert.rejects(f.projector.prepare({}),/AUTHORITY_PENDING/);
  assert.throws(()=>f.store.recordUpload('owner-a',{id:'asset-0001',state:'complete',verified:true,url:'https://example.invalid/asset-0001'}),/UPLOAD_RETIRED/);
  assert.deepEqual(await f.admin.reconcile(),{revoked:true,checkout_ready:false});
  assert.equal(validAtFunction(f),false);assert.equal(f.store.lifecycle.state().pending,0);
  await assert.rejects(f.admin.publish(old));await assert.rejects(f.jobs.resolve('owner-a',f.p.reference),/UPLOAD_UNAVAILABLE/);
 }
});
test('F06D authenticated upload events are idempotent, owner-scoped and cannot resurrect on late completion',async t=>{
 const f=await fixture(t);await published(f);const e=f.event('upload',{asset_id:'asset-0001',state:'removed'});
 await assert.rejects(f.receive({...e,owner:'owner-b'}),/UPLOAD_UNAVAILABLE/);assert.equal(f.store.lifecycle.state().pending,0);
 assert.equal((await f.receive(e)).revoked,false);assert.equal((await f.receive(e)).revoked,false);
 assert.equal(f.store.lifecycle.state().pending,1);await f.admin.reconcile();assert.equal((await f.receive(e)).revoked,true);
 await assert.rejects(f.receive({...e,state:'failed'}),/EVENT_ID_CONFLICT/);
 await f.receive({...e,id:'later-out-of-order-failure',state:'failed'});await f.admin.reconcile();
 assert.throws(()=>f.store.recordUpload('owner-a',{id:'asset-0001',state:'complete',verified:true,url:'https://example.invalid/x'}),/UPLOAD_RETIRED/);
});
test('F06D job/owner/order revocation persists separate tombstones and keeps immutable job bodies',async t=>{
 for(const kind of ['job','owner','order']) {
  const f=await fixture(t);await published(f);const old=f.store.getForRevocation(f.p.reference.id,'owner-a');
  const e=f.event(kind,kind==='order'?{order_id:'gid://shopify/Order/123'}:{});
  assert.equal((await f.receive(e)).revoked,false);await assert.rejects(f.jobs.resolve('owner-a',f.p.reference),/REVOKED/);
  assert.deepEqual(f.store.getForRevocation(f.p.reference.id,'owner-a'),old);
  await f.admin.reconcile();assert.equal((await f.receive(e)).revoked,true);assert.equal(grants(f).length,0);
  if(kind!=='owner')await f.receive({...e,id:`out-of-order-${kind}`}); // another valid delivery, no unrevocation
 }
});
test('F06D event verifier, shop/app/scope/event ID/order identity and signed job ownership required',async t=>{
 const f=await fixture(t);const e=f.event('order',{order_id:'gid://shopify/Order/123'});
 for(const patch of [{store:'1jukgy-dc.myshopify.com'},{app:'wrong'},{scope:'job:revoke'},{id:''},{order_id:'123'},{owner:'owner-b'},{references:[{...f.p.reference,signature:'f'.repeat(64)}]},{references:[{...f.p.reference,revision:'x'}]}])await assert.rejects(f.receive({...e,...patch}));
 const denied=createLifecycleReceiver({store:f.store,jobs:f.jobs,kind:'order',verify:async()=>{throw Error('invalid authentication');}});
 await assert.rejects(denied(e),/authentication/);assert.equal(f.store.lifecycle.state().pending,0);
 assert.throws(()=>createLifecycleReceiver({store:f.store,jobs:f.jobs}),/VERIFIER/);
 const uploader=createLifecycleReceiver({store:f.store,jobs:f.jobs,kind:'upload',verify:async()=>e});
 await assert.rejects(uploader(e),/UNAUTHENTICATED_EVENT/);assert.equal(f.store.lifecycle.state().pending,0);
});
test('F06D unrelated owner assets/jobs survive conservative shop-wide clearing and can reauthorize',async t=>{
 const f=await fixture(t);for(const id of selection.asset_ids)f.store.recordUpload('owner-b',{id,state:'complete',verified:true,url:`https://example.invalid/b/${id}`});
 const b=await f.jobs.prepare('owner-b',selection);await published(f);
 await f.receive(f.event('owner'));await f.admin.reconcile();
 assert.equal((await f.jobs.resolve('owner-b',b.reference)).id,b.reference.id);
 f.cart.owner='owner-b';f.cart.id='gid://shopify/Cart/synthetic-b';f.cart.lines[0]={...f.cart.lines[0],id:'gid://shopify/CartLine/synthetic-b',reference:b.reference,properties:b.item.properties};
 await published(f);assert.equal(validAtFunction(f),true);
});
test('F06D newer preparation supersedes older delayed cart read and publication tickets',async t=>{
 const f=await fixture(t);const held=defer(),entered=defer();
 const slow=createCheckoutProjector({jobs:f.jobs,loadContext:f.admin.read,resolveCart:async()=>{entered.resolve();await held.promise;return f.cart;}});
 const old=slow.prepare({});const rejected=assert.rejects(old,/AUTHORITY_FENCED/);await entered.promise;
 const fresh=await f.projector.prepare({});held.resolve();await rejected;await f.admin.publish(fresh);
 await assert.rejects(f.admin.publish(fresh),/AUTHORITY_CHANGED|AUTHORITY_FENCED/);
});
test('F06D overlapping publishers serialize through shared SQLite, never an in-memory lock',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'bfl-f06d-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const f=await fixture(t,{path:join(dir,'jobs.sqlite')});const second=createJobStore(join(dir,'jobs.sqlite'));t.after(()=>second.close());
 const old=await f.projector.prepare({}),held=defer(),entered=defer();
 f.mock.beforeWrite=async()=>{f.mock.beforeWrite=null;entered.resolve();await held.promise;};
 const running=f.admin.publish(old);await entered.promise;
 assert.throws(()=>second.lifecycle.beginPreparation(),/AUTHORITY_PENDING/);
 await assert.rejects(createAuthorityAdmin(f.mock.api,{...f.options,lifecycle:second.lifecycle}).publish(old),/AUTHORITY_PENDING/);
 held.resolve();await running;
});
test('F06D revocation during publication prevents acknowledgment; recovery fences delayed writes even with identical JSON',async t=>{
 const f=await fixture(t);const p=await f.projector.prepare({}),held=defer(),entered=defer();
 f.mock.beforeWrite=async()=>{f.mock.beforeWrite=null;entered.resolve();await held.promise;};
 const running=f.admin.publish(p);const rejected=assert.rejects(running,/AUTHORITY_WRITE_REJECTED|AUTHORITY_FENCED|AUTHORITY_READBACK_CHANGED/);await entered.promise;
 f.store.recordUpload('owner-a',{id:'asset-0001',state:'removed'});
 await f.admin.reconcile();assert.equal(f.store.lifecycle.state().pending,0);
 held.resolve();await rejected;assert.equal(grants(f).length,0);
});
test('F06D write succeeds before revocation: no local-only acknowledgment, eventual CAS clearing',async t=>{
 const f=await fixture(t);f.mock.afterWrite=async()=>{f.mock.afterWrite=null;f.store.recordUpload('owner-a',{id:'asset-0001',state:'failed'});};
 await assert.rejects(published(f),/AUTHORITY_FENCED/);assert.equal(grants(f).length,1);
 assert.ok(f.store.lifecycle.state().operation);await f.admin.reconcile();assert.equal(grants(f).length,0);
});
test('F06D lost response/timeouts/rejected writes stay pending until explicit read-CAS-read recovery',async t=>{
 for(const mode of ['lost','timeout','rejected','readback']) {
  const f=await fixture(t);
  if(mode==='lost')f.mock.afterWrite=async()=>{f.mock.afterWrite=null;throw Error('lost response');};
  if(mode==='timeout')f.mock.beforeWrite=async()=>{f.mock.beforeWrite=null;throw Error('timeout');};
  if(mode==='rejected')f.mock.reject=true;
  if(mode==='readback')f.mock.afterWrite=async()=>{f.mock.afterWrite=null;f.mock.beforeRead=async()=>{f.mock.beforeRead=null;throw Error('readback offline');};};
  await assert.rejects(published(f));assert.ok(f.store.lifecycle.state().operation);
  await assert.rejects(f.projector.prepare({}),/AUTHORITY_PENDING/);
  f.mock.reject=false;await f.admin.reconcile();assert.equal(grants(f).length,0);assert.equal(f.store.lifecycle.state().operation,null);
 }
});
test('F06D crash/reopen reconciles unknown write and durable revocation without losing job revision',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'bfl-f06d-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const f=await fixture(t,{path:join(dir,'jobs.sqlite')});const body=f.store.getForRevocation(f.p.reference.id,'owner-a');
 f.mock.afterWrite=async()=>{f.mock.afterWrite=null;throw Error('process lost response');};await assert.rejects(published(f));
 f.store.recordUpload('owner-a',{id:'asset-0001',state:'removed'});
 f.close();
 const reopened=createJobStore(join(dir,'jobs.sqlite'));t.after(()=>reopened.close());
 assert.ok(reopened.lifecycle.state().operation);assert.equal(reopened.lifecycle.state().pending,1);
 const admin=createAuthorityAdmin(f.mock.api,{...f.options,lifecycle:reopened.lifecycle});await admin.reconcile();
 assert.equal(grants(f).length,0);assert.deepEqual(reopened.getForRevocation(body.id,'owner-a'),body);
 assert.throws(()=>reopened.uploads('owner-a',['asset-0001']),/UPLOAD_UNAVAILABLE/);
});
test('F06D event arriving during recovery stays pending; duplicate recoveries cannot acknowledge a superseded write',async t=>{
 const f=await fixture(t);await published(f);await f.receive(f.event('job'));
 f.mock.afterWrite=async()=>{f.mock.afterWrite=null;await f.receive(f.event('owner'));};
 await assert.rejects(f.admin.reconcile(),/AUTHORITY_FENCED/);assert.equal(f.store.lifecycle.state().pending,2);
 await f.admin.reconcile();assert.equal(f.store.lifecycle.state().pending,0);
 const held=defer(),entered=defer();f.mock.beforeWrite=async()=>{f.mock.beforeWrite=null;entered.resolve();await held.promise;};
 const first=f.admin.reconcile(),rejected=assert.rejects(first,/AUTHORITY_WRITE_REJECTED|AUTHORITY_FENCED|AUTHORITY_READBACK_CHANGED/);
 await entered.promise;await f.admin.reconcile();held.resolve();await rejected;assert.equal(grants(f).length,0);
});
test('F06D missing definition/fence, permission drift and foreign identity never write or acknowledge revocation',async t=>{
 for(const kind of ['definition','fence','permissions','store','app']) {
  const f=await fixture(t);await published(f);await f.receive(f.event('job'));const n=f.mock.writes.length;
  if(kind==='definition')f.mock.data.shop.authority=null;
  if(kind==='fence')f.mock.data.currentAppInstallation.fence=null;
  if(kind==='permissions')f.mock.data.shop.authority.definition.access.admin='MERCHANT_READ_WRITE';
  if(kind==='store')f.mock.data.shop.myshopifyDomain='1jukgy-dc.myshopify.com';
  if(kind==='app')f.mock.data.currentAppInstallation.app.id='gid://shopify/App/1';
  await assert.rejects(f.admin.reconcile());assert.equal(f.mock.writes.length,n);assert.equal(f.store.lifecycle.state().pending,1);
 }
});
test('F06D source unknown outcomes require reconciliation; delayed source writes cannot reappear after recovery',async t=>{
 const f=await fixture(t);await published(f);const prior=f.mock.data.currentAppInstallation.active.value;
 f.mock.drafts.rules[0].label+=' intended change';const held=defer(),entered=defer();
 f.mock.beforeWrite=async()=>{f.mock.beforeWrite=null;entered.resolve();await held.promise;};
 const publishing=publishDrafts(f.mock.api,f.options),rejected=assert.rejects(publishing,/AUTHORITY_WRITE_REJECTED|AUTHORITY_FENCED/);await entered.promise;
 await f.admin.reconcile();held.resolve();await rejected;assert.equal(f.mock.data.currentAppInstallation.active.value,prior);
 assert.equal(grants(f).length,0);assert.equal(f.mock.archives.size,0);
 await publishDrafts(f.mock.api,f.options);assert.notEqual(f.mock.data.currentAppInstallation.active.value,prior);
});
test('F06D default writers and historical CLI transport fail closed without remote operations',async t=>{
 const f=await fixture(t),p=await f.projector.prepare({});let calls=0;const api=async()=>{calls++;throw Error('no network');};
 await assert.rejects(createAuthorityAdmin(api).publish(p),/WRITES_DISABLED/);
 await assert.rejects(createAuthorityAdmin(api).reconcile(),/WRITES_DISABLED/);
 await assert.rejects(publishDrafts(api),/WRITES_DISABLED/);
 await assert.rejects(publishPriceCatalog(api,JSON.stringify(f.mock.catalog)),/WRITES_DISABLED/);
 await assert.rejects(createAuthorityAdmin(api,{writesEnabled:true}).publish(p),/LIFECYCLE_REQUIRED/);
 const {graphql}=await import('../configuration/cli.mjs');await assert.rejects(graphql('mutation Dangerous { shop { id } }'),/REMOTE_MUTATIONS_DISABLED/);
 assert.equal(calls,0);
});

test('F06D lost revocation response keeps durable events pending until another exact remote reconciliation',async t=>{
 const f=await fixture(t);await published(f);const e=f.event('job');await f.receive(e);
 f.mock.afterWrite=async()=>{f.mock.afterWrite=null;throw Error('lost revocation response');};
 await assert.rejects(f.admin.reconcile(),/lost revocation/);
 assert.equal(grants(f).length,0);assert.equal((await f.receive(e)).revoked,false);
 await f.admin.reconcile();assert.equal((await f.receive(e)).revoked,true);
});
test('F06D lost successful source response recovers actual changed source and preserves its archive',async t=>{
 const f=await fixture(t);await published(f);const prior=f.mock.data.currentAppInstallation.active.value;
 f.mock.drafts.rules[0].label+=' changed source';f.mock.afterWrite=async()=>{f.mock.afterWrite=null;throw Error('lost source response');};
 await assert.rejects(publishDrafts(f.mock.api,f.options),/lost source/);
 const actual=f.mock.data.currentAppInstallation.active.value;assert.notEqual(actual,prior);assert.ok(f.store.lifecycle.state().operation);
 await f.admin.reconcile();assert.equal(f.mock.data.currentAppInstallation.active.value,actual);
 assert.equal(f.mock.archives.size,1);assert.equal(grants(f).length,0);
});
test('F06D permission drift during write cannot acknowledge publication or revocation until repaired',async t=>{
 const f=await fixture(t);f.mock.afterWrite=async()=>{f.mock.afterWrite=null;f.mock.data.shop.authority.definition.access.storefront='PUBLIC_READ';};
 await assert.rejects(published(f),/UNPROTECTED_AUTHORITY/);assert.ok(f.store.lifecycle.state().operation);
 await assert.rejects(f.admin.reconcile(),/UNPROTECTED_AUTHORITY/);
 f.mock.data.shop.authority.definition.access.storefront='NONE';await f.admin.reconcile();assert.equal(grants(f).length,0);
});
test('F06D identical source ABA and a forged/tampered prepared body cannot reuse an older ticket',async t=>{
 const f=await fixture(t);const p=await f.projector.prepare({}),oldFence=f.mock.data.currentAppInstallation.fence.value;
 await publishDrafts(f.mock.api,f.options);assert.notEqual(f.mock.data.currentAppInstallation.fence.value,oldFence);
 await assert.rejects(f.admin.publish(p),/AUTHORITY_CHANGED/);
 const fresh=await f.projector.prepare({});const changed=JSON.parse(fresh.value);changed.grants[0].lines[0].unit_cents=121;
 await assert.rejects(f.admin.publish({...fresh,value:JSON.stringify(changed)}),/AUTHORITY_FENCED/);
 await f.admin.publish(fresh);
});
test('F06D aborted event transaction rolls back partial job tombstones and outbox; upload pending can complete before retirement',async t=>{
 const f=await fixture(t);
 assert.throws(()=>f.store.revoke(f.event('job',{references:[f.p.reference,{id:'missing-job',revision:'unknown'}]})),/JOB_UNAVAILABLE/);
 assert.equal(f.store.lifecycle.state().pending,0);assert.equal((await f.jobs.resolve('owner-a',f.p.reference)).id,f.p.reference.id);
 f.store.recordUpload('owner-a',{id:'pending-asset',state:'pending'});
 f.store.recordUpload('owner-a',{id:'pending-asset',state:'complete',verified:true,url:'https://example.invalid/pending'});
 assert.equal(f.store.uploads('owner-a',['pending-asset']).length,1);
});
test('F06D no public upload/order/revocation route accepts browser authority',async t=>{
 const f=await fixture(t);const {createJobHandler}=await import('../jobs/http.mjs');
 let authenticated=0;const handle=createJobHandler({service:f.jobs,authenticate:()=>{authenticated++;return 'owner-a';}});
 for(const url of ['/uploads','/order','/revoke','/publish','/webhooks/orders']) {
  let status;await handle({method:'POST',url},{writeHead:n=>{status=n;},end:()=>{}});assert.equal(status,404);
 }
 assert.equal(authenticated,0);assert.equal(f.store.lifecycle.state().pending,0);
});
