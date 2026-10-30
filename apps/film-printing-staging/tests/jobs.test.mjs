import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import {createJobStore,createJobService} from '../jobs/service.mjs';
import {createJobHandler} from '../jobs/http.mjs';
import {active,syntheticRelease,input as shipmentInput} from '../../../fixtures/film-printing/f04/synthetic.mjs';
const asset=(id,state='complete')=>({id,state,verified:true,url:`https://example.invalid/f05/${id}.jpg`});
const selection=(extra={})=>({request_key:'request-0001',service:'Photo Prints',size:'4” × 6”',paper:'synthetic-paper',lab:'miami',copies:4,asset_ids:['asset-0001','asset-0002','asset-0003'],options:{},...extra});
function setup(t,{release=active,projection,catalogChange=()=>{}}={}){
  const dir=mkdtempSync(join(tmpdir(),'f05-'));const store=createJobStore(join(dir,'jobs.sqlite'));
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  for(let i=1;i<=3;i++)store.recordUpload('owner-a',asset(`asset-000${i}`));
  const catalog={version:'synthetic-price-v1',store:active.config.store,currency:'USD',rows:[{enabled:true,service:'photo',size:'4x6',paper:'synthetic-paper',lab:'miami',per_file_cents:40,variant_id:'67852705202287',physical:true,options:{}}]};catalogChange(catalog);
  let current=release;
  const service=createJobService({store,loader:{load:async()=>current},loadCatalog:async()=>catalog,secret:'synthetic-only-test-secret-32-characters',checkoutProjection:projection});
  return {store,service,catalog,dir,setRelease:r=>{current=r;}};
}
test('one physical job: copies are quantity; every completed asset is priced exactly once',async t=>{
 const {service}=setup(t);const p=await service.prepare('owner-a',selection({price:1,file_count:99,weight:1,package:'fake'}));
 assert.equal(p.item.quantity,4);assert.equal(p.unit_price_cents,120);assert.equal(p.file_count,3);assert.equal(p.checkout_ready,false);
 assert.equal(p.item.properties._role,undefined);assert.equal(p.item.properties._custom_price_cents,undefined);
 assert.equal(Object.keys(p.item.properties).filter(k=>k.startsWith('Uploaded File ')).length,3);
 const one=await service.prepare('owner-a',selection({request_key:'request-0002',asset_ids:['asset-0001']}));assert.equal(one.unit_price_cents,40);
});
test('unique jobs, immutable revisions and idempotent concurrent retries persist',async t=>{
 const {service,store,dir}=setup(t);const [a,b]=await Promise.all([service.prepare('owner-a',selection()),service.prepare('owner-a',selection())]);assert.deepEqual(a,b);
 const c=await service.prepare('owner-a',selection({request_key:'request-0002'}));assert.notEqual(a.reference.id,c.reference.id);
 await assert.rejects(service.prepare('owner-a',selection({copies:5})),/IDEMPOTENCY_CONFLICT/);
 const reopened=createJobStore(join(dir,'jobs.sqlite'));assert.equal(reopened.get(a.reference.id,'owner-a').unit_price_cents,120);reopened.close();
 assert.throws(()=>{store.get(a.reference.id,'owner-a').copies=9;});
});
test('pending, failed, removed, duplicate, missing and foreign upload references reject',async t=>{
 const {service,store}=setup(t);
 for(const state of ['pending','failed','removed']){store.recordUpload('owner-a',asset('asset-0001',state));await assert.rejects(service.prepare('owner-a',selection()),/UPLOAD_UNAVAILABLE/);}
 assert.throws(()=>store.recordUpload('owner-a',asset('asset-0001')),/UPLOAD_RETIRED/);
 for(const ids of [[],['asset-0001','asset-0001'],['foreign-0001']])await assert.rejects(service.prepare('owner-a',selection({asset_ids:ids})));
 await assert.rejects(service.prepare('owner-b',selection()),/UPLOAD_UNAVAILABLE/);
 assert.throws(()=>store.recordUpload('owner-a',{...asset('asset-0004'),verified:false}),/UNVERIFIED_UPLOAD/);
});
test('signed references enforce ownership/revision/version and revoke removed uploads',async t=>{
 const {service,store,setRelease}=setup(t);const {reference}=await service.prepare('owner-a',selection());
 await assert.rejects(service.resolve('owner-b',reference),/JOB_UNAVAILABLE/);
 await assert.rejects(service.resolve('owner-a',{...reference,signature:'0'.repeat(64)}),/UNAUTHENTICATED_JOB/);
 await assert.rejects(service.resolve('owner-a',{...reference,revision:'changed'}),/JOB_REVISION_MISMATCH/);
 store.recordUpload('owner-a',asset('asset-0001','removed'));await assert.rejects(service.resolve('owner-a',reference),/UPLOAD_UNAVAILABLE/);
 assert.throws(()=>store.recordUpload('owner-a',asset('asset-0001')),/UPLOAD_RETIRED/);setRelease(syntheticRelease());await assert.rejects(service.resolve('owner-a',reference),/VERSION_MISMATCH/);
});
test('exact server catalog owns price, paper, lab and option combinations',async t=>{
 const {service,catalog}=setup(t);
 for(const patch of [{paper:'Matte'},{lab:'all-labs'},{size:'Custom'},{service:'Darkroom Prints'},{copies:0},{copies:1.5},{options:{Turnaround:'Rush'}}])await assert.rejects(service.prepare('owner-a',selection(patch)));
 catalog.rows.push({...catalog.rows[0]});await assert.rejects(service.prepare('owner-a',selection()),/PRICE_UNAVAILABLE/);catalog.rows.pop();
 catalog.rows[0].physical=false;await assert.rejects(service.prepare('owner-a',selection()),/PRICE_UNAVAILABLE/);catalog.rows[0].physical=true;
 catalog.store='production.myshopify.com';await assert.rejects(service.prepare('owner-a',selection()),/PRICE_UNAVAILABLE/);
});
test('current verified cart quantity replaces original copies, never browser counts/groups',async t=>{
 const release=syntheticRelease();const {service}=setup(t,{release});const p=await service.prepare('owner-a',selection());let quantity=2;
 const actual=shipmentInput(release,[{id:p.reference.id,lab:'miami'}]);
 const quote=service.quoteService({resolveCart:async()=>({owner:'owner-a',lines:[{reference:p.reference,variant_id:p.item.id,quantity}],groups:actual.groups}),provider:{quote:async()=>({eligible:true,service:'FEDEX_2_DAY',rate_source:'bellows_own_account',currency:'USD',total_cents:1234})}});
 const result=await quote.quote({copies:999,groups:[]});assert.equal(result.status,'available');assert.equal(result.packing.groups[0].job.physical_count,6);
 quantity=5;assert.equal((await quote.quote({})).packing.groups[0].job.physical_count,15);
});
test('actual disabled snapshot returns unavailable and never calls provider',async t=>{
 const {service}=setup(t);const p=await service.prepare('owner-a',selection());let calls=0;
 const quote=service.quoteService({resolveCart:async()=>({owner:'owner-a',lines:[{reference:p.reference,variant_id:p.item.id,quantity:4}],groups:[]}),provider:{quote:async()=>{calls++;}}});
 assert.equal((await quote.quote({})).code,'RATE_ACCESS_UNAVAILABLE');assert.equal(calls,0);
});
test('legacy/unverified cart and variant/spec tampering fail closed in new quote path',async t=>{
 const {service}=setup(t,{release:syntheticRelease()});const p=await service.prepare('owner-a',selection());
 for(const line of [{quantity:1,reference:{}},{quantity:1,reference:p.reference,variant_id:'wrong'}]){
 const quote=service.quoteService({resolveCart:async()=>({owner:'owner-a',lines:[line],groups:[]}),provider:{quote:async()=>{throw Error('must not call');}}});assert.equal((await quote.quote({})).status,'unavailable');}
});
test('HTTP server rejects unauthenticated/body authority and serves prepared jobs over a real boundary',async t=>{
 const {service}=setup(t);const server=http.createServer(createJobHandler({service,authenticate:req=>req.headers.authorization==='Bearer synthetic-session'?'owner-a':null}));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const url=`http://127.0.0.1:${server.address().port}`;
 assert.equal((await fetch(url+'/jobs',{method:'POST',body:JSON.stringify(selection())})).status,401);
 const headers={'Content-Type':'application/json',Authorization:'Bearer synthetic-session'};
 const response=await fetch(url+'/jobs',{method:'POST',headers,body:JSON.stringify(selection())});assert.equal(response.status,200);assert.equal((await response.json()).unit_price_cents,120);
 const q=await fetch(url+'/quote',{method:'POST',headers,body:JSON.stringify({jobs:[{price:1}],groups:[]})});assert.equal((await q.json()).code,'VERIFIED_DELIVERY_CONTEXT_REQUIRED');
 assert.equal((await fetch(url+'/uploads/complete',{method:'POST',headers,body:'{}'})).status,404);
});
const source=readFileSync(new URL('../theme/film-printing-job.js',import.meta.url),'utf8');
test('same-origin session authenticates signature, expiry and CSRF origin',async()=>{
 const {createSessionAuth}=await import('../jobs/session.mjs');let now=1000;
 const auth=createSessionAuth({secret:'synthetic-only-test-secret-32-characters',origin:'https://staging.example.invalid',now:()=>now});
 const cookie=auth.issue('owner-a').split(';')[0];const req={headers:{cookie,origin:'https://staging.example.invalid'}};
 assert.equal(auth.authenticate(req),'owner-a');assert.equal(auth.authenticate({headers:{...req.headers,origin:'https://other.invalid'}}),null);
 assert.equal(auth.authenticate({headers:{...req.headers,cookie:cookie+'x'}}),null);now+=3600001;assert.equal(auth.authenticate(req),null);
});
test('private price catalog requires authenticated staging identity and no absent-data fallback',async()=>{
 const {createPriceCatalogLoader}=await import('../jobs/catalog.mjs');
 // Missing identity is rejected before any price fetch; no fallback to theme assets.
 await assert.rejects(createPriceCatalogLoader(async()=>({}))());
});

test('unchanged Send Rolls guard adds/retains its separate physical Return Shipping companion',async()=>{
 const source=readFileSync(new URL('../../../.staging/film-printing-f00-20261019/theme-work/assets/cart.js',import.meta.url),'utf8');
 const definitions=new Map(),calls=[];
 const context={HTMLElement:class{},customElements:{define:(n,c)=>definitions.set(n,c),get:n=>definitions.get(n)},window:{globalReturnShippingVariantId:123,routes:{cart_add_url:'/cart/add.js',cart_update_url:'/cart/update.js'}},fetchConfig:()=>({}),fetch:(url,options)=>{calls.push({url,...JSON.parse(options.body)});return Promise.resolve({json:async()=>({})});},console};
 vm.runInNewContext(source,context);const instance=Object.create(definitions.get('cart-items').prototype);instance.refreshCart=()=>{};
 const send={handle:'send-rolls',properties:{_return_shipping_required:'true'}};
 instance._runGuardLogic({items:[send]});await Promise.resolve();assert.equal(calls[0].items[0].properties._role,'return_shipping');assert.equal(calls[0].items[0].quantity,1);
 calls.length=0;instance._runGuardLogic({items:[send,{id:123,quantity:1,key:'return'}]});assert.equal(calls.length,0);
 instance._runGuardLogic({items:[send,{id:123,quantity:5,key:'return'}]});assert.equal(calls[0].updates.return,1);
 assert.equal(instance._collectSizeShippingOrphans({items:[send,{id:123,quantity:1,properties:{_role:'return_shipping'}}]}),null);
 const old={handle:'film-printing',properties:{_timestamp:'old'}};const companion={handle:'print-shipping',key:'pack',properties:{_role:'shipping_size',_parent_timestamp:'old'}};
 assert.equal(instance._collectSizeShippingOrphans({items:[old,companion]}),null);
 assert.equal(instance._collectSizeShippingOrphans({items:[companion]}).pack,0);
});

test('form reader preserves actual Turnaround/Message controls and rejects incomplete upload lifecycle',()=>{
 const scope={};vm.runInNewContext(source,scope);const values={'[name="service"]:checked':'Photo Prints','[name="location"]:checked':'Miami','[name="quantity"]':'4','[name="properties[Turnaround]"]:checked':'Rush (1 Day)','[name="properties[Message]"]':'Keep centered'};
 const form={querySelector:s=>values[s]==null?null:{value:values[s]},querySelectorAll:s=>s.includes('Sizes')?[{value:'4” × 6”',disabled:false,closest:()=>({style:{display:''}})}]:[]};
 const reader=scope.BFLPrintJob.readSelection;
 const good={snapshot:()=>({pending:false,failed:false,completedAssetIds:['asset-0001']})};
 const result=reader(form,good);assert.equal(result.options.Turnaround,'Rush (1 Day)');assert.equal(result.message,'Keep centered');assert.equal(result.paper,null);
 for(const value of [{pending:true,completedAssetIds:['asset-0001']},{failed:true,completedAssetIds:['asset-0001']},{completedAssetIds:[]},{completedAssetIds:['asset-0001','asset-0001']}])assert.throws(()=>reader(form,{snapshot:()=>value}));
 assert.throws(()=>reader(form,null));
});
