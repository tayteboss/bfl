import test from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {connect} from 'node:net';
import {readFileSync} from 'node:fs';
import {parseCarrierRequest,carrierRates,MAX_BODY} from '../carrier/contract.mjs';
import {resolveCarrierReferences,unavailableCallback,CALLBACK_GATES} from '../carrier/preparation.mjs';
import {createCarrierServer} from '../carrier/http.mjs';
import {syntheticFixture} from '../../../fixtures/film-printing/f06g/synthetic.mjs';
import {shippoRelease,reply} from '../../../fixtures/film-printing/f04b/synthetic.mjs';
const empty={rates:[]};
const fixture=async t=>{const f=await syntheticFixture();t.after(()=>f.store.close());return f;};
async function server(t,options={}) {
 const s=createCarrierServer(options);await new Promise((resolve,reject)=>{s.server.once('error',reject);s.server.listen(0,'127.0.0.1',resolve);});
 t.after(()=>s.close());return {...s,port:s.server.address().port};
}
async function post(s,body,headers={},path='/carrier/rates') {
 const r=await fetch(`http://127.0.0.1:${s.port}${path}`,{method:'POST',headers:{'content-type':'application/json',...headers},body});
 return {status:r.status,body:await r.json()};
}
const inspect=(f,callback=parseCarrierRequest(f.raw()),extra={})=>resolveCarrierReferences({callback,owner:f.owner,jobs:f.jobs,release:f.release,...extra});
const run=f=>f.process({callback:parseCarrierRequest(f.raw())},{signal:new AbortController().signal});
const bytes=value=>Buffer.from(JSON.stringify(value));

test('F06G captured F02 headers are evidence of names only; callback lacks cart/location/group IDs',()=>{
 const records=JSON.parse(readFileSync(new URL('../../../fixtures/film-printing/f02/callback-header-shapes.json',import.meta.url),'utf8'));
 const observed=records.filter(r=>r.headerNames.includes('x-shopify-hmac-sha256'));
 assert.ok(observed.length>0);
 for(const r of observed){assert.ok(!r.requestKeys.some(k=>/cart|location|group/i.test(k)));assert.equal(r.rawBody,undefined);assert.equal(r.headers,undefined);}
});
test('F06G default boundary has no positive binding, even with forged trust/header/owner metadata',async t=>{
 const f=await fixture(t),s=await server(t,{enabled:true});
 assert.equal(CALLBACK_GATES.length,6);
 assert.equal((await unavailableCallback({trusted:true})).status,'unavailable');
 assert.deepEqual(await post(s,f.raw(),{'x-shopify-hmac-sha256':'forged','x-shopify-shop-domain':'bellows-film-printing-staging.myshopify.com'}),{status:200,body:empty});
 assert.equal(f.posts.length,0);
 const disabled=await server(t);assert.equal((await post(disabled,f.raw())).status,404);
});
test('F06G parser keeps exact callback subset, decimal identities and references; discards customer/contact authority',async t=>{
 const f=await fixture(t);f.body.rate.customer={id:123,tags:['VIP']};f.body.rate.destination.address_type='residential';
 f.body.rate.order_totals={subtotal_price:80,total_price:null,additional_metadata:{ignored:true}};
 const c=parseCarrierRequest(f.raw());assert.equal(c.items[0].variant_id,'67852705202287');assert.equal(c.items[0].quantity,15);
 assert.equal(c.customer,undefined);assert.equal(c.destination.residential,undefined);assert.equal(c.cart_id,undefined);assert.equal(c.groups,undefined);assert.ok(Object.isFrozen(c.items[0]));
});
test('F06G parser projects quote fields and ignores nullable or added Shopify metadata without granting authority',async t=>{
 const f=await fixture(t),baseline=parseCarrierRequest(f.raw());
 f.body.trusted=true;Object.assign(f.body.rate,{locale:null,cart_token:'forged',groups:[{trusted:true}],owner:'forged'});
 Object.assign(f.body.rate.origin,{location_id:'forged',coordinates:[0,0],phone:null});
 Object.assign(f.body.rate.destination,{residential:true,validation:{valid:true},name:null});
 Object.assign(f.body.rate.items[0],{sku:null,vendor:null,name:null,fulfillment_service:null,taxable:null,grams:-1,
  unit_price:1,weight:{value:999},trusted:true,shipping_group:{location_id:'forged'}});
 const result=parseCarrierRequest(f.raw());
 assert.deepEqual(result.items,baseline.items);assert.deepEqual(result.origin,baseline.origin);assert.deepEqual(result.destination,baseline.destination);
 assert.deepEqual(Object.keys(result).sort(),['body_sha256','currency','destination','items','origin']);
 for(const change of [i=>i.quantity='15',i=>i.price='120',i=>i.price=-1,i=>i.price=1.1,i=>delete i.price,i=>i.requires_shipping=null,i=>i.properties._bfl_signature=null]){
  const b=structuredClone(f.body);change(b.rate.items[0]);assert.throws(()=>parseCarrierRequest(bytes(b)));
 }
});
test('F06G malformed UTF8/JSON, nested escaped duplicates, poison members, nesting and oversize reject',async t=>{
 const f=await fixture(t),raw=f.raw().toString();
 for(const b of [Buffer.from([0xc0,0xaf]),Buffer.from('{'),Buffer.alloc(MAX_BODY+1),Buffer.from(raw.replace('"rate":','"rate":{},"rate":')),
   Buffer.from(raw.replace('"quantity":15','"quantity":1,"quant\\u0069ty":15')),Buffer.from(raw.replace('"properties":{','"properties":{"__proto__":"x",')),
   Buffer.from('{"rate":'+ '['.repeat(18)+'0'+']'.repeat(18)+'}')])assert.throws(()=>parseCarrierRequest(b));
});
test('F06G parser rejects wrong product/variant, unsafe IDs, null/array properties, missing/legacy refs and bad counts',async t=>{
 const f=await fixture(t);
 for(const change of [i=>i.product_id=1,i=>i.variant_id=1,i=>i.variant_id='67852705202287',i=>i.variant_id=Number.MAX_SAFE_INTEGER+1,
  i=>i.requires_shipping=false,i=>i.properties=null,i=>i.properties=[],i=>delete i.properties._bfl_job,i=>i.properties._bfl_signature='bad',
  i=>i.quantity=0,i=>i.quantity=1.5,i=>i.quantity=10001,i=>i.price=NaN]) {
  const b=structuredClone(f.body);change(b.rate.items[0]);assert.throws(()=>parseCarrierRequest(bytes(b)));
 }
});
test('F06G parser rejects non-USD/incomplete or malformed required addresses',async t=>{
 const f=await fixture(t);
 for(const change of [r=>r.currency='CAD',r=>r.destination.postal_code='',r=>r.origin=null,r=>r.destination.address1=42,r=>r.destination.address2=[],r=>r.destination.country='USA']) {
  const b=structuredClone(f.body);change(b.rate);assert.throws(()=>parseCarrierRequest(bytes(b)));
 }
});
test('F06G multiple same-variant jobs remain separate; duplicate jobs and unrelated/mixed items reject',async t=>{
 const f=await fixture(t),b=structuredClone(f.body),other=structuredClone(b.rate.items[0]);other.properties._bfl_job='different-job-reference';b.rate.items.push(other);
 assert.equal(parseCarrierRequest(bytes(b)).items.length,2);
 b.rate.items[1].properties._bfl_job=b.rate.items[0].properties._bfl_job;assert.throws(()=>parseCarrierRequest(bytes(b)),{code:'CALLBACK_DUPLICATE_JOB'});
 b.rate.items[1].product_id=9;assert.throws(()=>parseCarrierRequest(bytes(b)),{code:'CALLBACK_PRODUCT'});
});
test('F06G exact immutable signatures, revision, config and current copies with one snapshot; no lifecycle preparation writes',async t=>{
 const f=await fixture(t),before=f.store.lifecycle.state(),p=await inspect(f);
 assert.equal(p.jobs[0].copies,15);assert.equal(p.jobs[0].completed_asset_ids.length,3);assert.equal(f.store.get(f.prepared.reference.id,f.owner).copies,4);
 assert.deepEqual(f.store.lifecycle.state(),before);assert.equal(p.checkout_ready,false);assert.equal(f.posts.length,0);
 for(const [key,value] of [['_bfl_job','unknown-job-id'],['_bfl_revision','0'.repeat(64)],['_bfl_signature','0'.repeat(64)],['_bfl_config','f03-'+ '0'.repeat(24)]]){
  const b=structuredClone(f.body);b.rate.items[0].properties[key]=value;await assert.rejects(inspect(f,parseCarrierRequest(bytes(b))));
 }
 await assert.rejects(inspect(f,undefined,{owner:'different-owner'}));await assert.rejects(inspect(f,undefined,{owner:undefined}));
 await assert.rejects(inspect(f,undefined,{release:shippoRelease(c=>c.packages[0].height_in=0.6)}));
});
test('F06G stored variant/spec/price, completed upload removal, retired job/owner and pending recovery deny references',async t=>{
 for(const change of [f=>f.body.rate.items[0].properties.Location='synthetic-second-lab',f=>f.body.rate.items[0].price=1,
  f=>f.store.recordUpload(f.owner,{id:'asset-0001',state:'removed'}),
  f=>f.store.lifecycle.retire('job',f.owner,f.prepared.reference.id),f=>f.store.lifecycle.retire('owner',f.owner),f=>f.store.lifecycle.startRecovery()]){
  const f=await fixture(t);change(f);await assert.rejects(inspect(f));assert.equal(f.posts.length,0);
 }
 const f=await fixture(t),jobs={...f.jobs,resolveForCheckout:async(...args)=>(await f.jobs.resolveForCheckout(...args)).map(j=>({...j,variant_id:'1'}))};
 await assert.rejects(inspect(f,undefined,{jobs}),{code:'VARIANT_MISMATCH'});
});
test('F06G actual local HTTP → parser → stored jobs → packing → Shippo → stable integer-cent responses',async t=>{
 const f=await fixture(t),s=await server(t,{enabled:true,processCallback:f.process});
 const a=await post(s,f.raw());assert.equal(a.status,200);assert.equal(a.body.rates.length,3);assert.equal(f.reads,1);assert.equal(f.posts.length,1);
 assert.deepEqual(f.posts[0].parcels.map(p=>p.weight),['5','1.5']);assert.equal(f.posts[0].parcels.length,2);
 assert.equal(a.body.rates.find(r=>r.service_name==='UPS ups_ground').total_price,'1234');
 assert.ok(a.body.rates.every(r=>/^[1-9]\d*$/.test(r.total_price)&&r.currency==='USD'&&!('min_delivery_date' in r)));
 f.post=async b=>{const r=reply(b);r.object_id='different_shipment';r.rates.forEach((x,i)=>{x.shipment=r.object_id;x.object_id='new_'+i;});return r;};
 const b=await post(s,f.raw());assert.deepEqual(b.body,a.body);assert.equal(f.reads,2);
});
test('F06G positive fixture requires independent current owner/cart/authority, shipping and complete routing',async t=>{
 for(const change of [f=>f.source=false,f=>f.complete=false,f=>f.mode='pickup',f=>f.cart.lines[0].quantity=14,
  f=>f.authority=null,f=>f.owner='wrong-owner',f=>f.group.location_id='gid://shopify/Location/92446294127',
  f=>f.group.job_ids=[],f=>f.group.lab='synthetic-second-lab',f=>f.body.rate.origin.address1='other street',
  f=>f.body.rate.destination.postal_code='00000',f=>f.cart.lines.push({...f.cart.lines[0],id:'unrelated-line'}),
  f=>{const a=JSON.parse(f.authority);a.grants[0].lines[0].quantity=14;f.authority=JSON.stringify(a);},
  f=>{const a=JSON.parse(f.authority);a.valid_on='2026-10-20';f.authority=JSON.stringify(a);}]){
  const f=await fixture(t);change(f);const s=await server(t,{enabled:true,processCallback:f.process});
  assert.deepEqual((await post(s,f.raw())).body,empty);assert.equal(f.posts.length,0);
 }
});
test('F06G physical/address/tender facts and unsupported destinations stay unavailable before transport',async t=>{
 for(const change of [f=>delete f.group.shipment_date,f=>delete f.group.destination.residential,f=>f.eligibility=async()=>false,
  f=>{f.group.destination.country_code='CA';f.body.rate.destination.country='CA';},
  f=>f.release=shippoRelease(c=>c.rules.forEach(r=>r.enabled=false))]){
  const f=await fixture(t);change(f);const s=await server(t,{enabled:true,processCallback:f.process});
  assert.deepEqual((await post(s,f.raw())).body,empty);assert.equal(f.posts.length,0);
 }
});
test('F06G provider error/partial/invalid price/mode/rate responses return empty and leak no detail',async t=>{
 for(const change of [r=>r.status='ERROR',r=>r.rates=r.rates.filter(x=>x.provider!=='FedEx'),r=>r.rates[0].amount='12.345',r=>r.test=false,r=>r.rates.push(r.rates[0])]){
  const f=await fixture(t);f.post=async b=>{const r=reply(b);change(r);return r;};const s=await server(t,{enabled:true,processCallback:f.process});
  assert.deepEqual((await post(s,f.raw())).body,empty);
 }
 const f=await fixture(t);f.post=async()=>{throw Error('secret provider body');};const s=await server(t,{enabled:true,processCallback:f.process});assert.deepEqual((await post(s,f.raw())).body,empty);
});
test('F06G response mapping refuses multiple/partial groups, wrong identities, duplicate and malformed options',async t=>{
 const f=await fixture(t),result=await run(f);
 for(const change of [r=>r.quotes.push(r.quotes[0]),r=>r.packing.groups.push(r.packing.groups[0]),r=>r.quotes[0].group_id='other',
  r=>r.quotes[0].options[0].total_cents=1.1,r=>r.quotes[0].options[0].id='bad',r=>r.quotes[0].options.push(r.quotes[0].options[0]),r=>r.quotes[0].options=[]]){
  const r=structuredClone(result);change(r);assert.throws(()=>carrierRates(r));
 }
});
test('F06G upload removal during provider work fences the result; no stale positive escapes HTTP',async t=>{
 const f=await fixture(t);f.post=async b=>{f.store.recordUpload(f.owner,{id:'asset-0001',state:'removed'});return reply(b);};
 const s=await server(t,{enabled:true,processCallback:f.process});assert.deepEqual((await post(s,f.raw())).body,empty);
});
test('F06G HTTP passes original bytes and headers without treating them as authentication',async t=>{
 const f=await fixture(t),raw=Buffer.from(' \n'+f.raw()+'\n');let seen;
 const s=await server(t,{enabled:true,processCallback:async input=>{seen=input;return unavailableCallback();}});
 await post(s,raw,{'x-shopify-hmac-sha256':'unverified'});assert.deepEqual(seen.rawBody,raw);assert.equal(seen.headers['x-shopify-hmac-sha256'],'unverified');assert.ok(seen.rawHeaders.length);
});
test('F06G HTTP malformed/oversize/compressed/duplicate headers fail empty before any dependency',async t=>{
 const f=await fixture(t);let calls=0;const s=await server(t,{enabled:true,processCallback:async()=>{calls++;}});
 for(const [body,h] of [[Buffer.alloc(MAX_BODY+1),{}],['{',{}],[f.raw(),{'content-encoding':'gzip'}],[f.raw(),{'content-type':'text/plain'}]])assert.deepEqual((await post(s,body,h)).body,empty);
 const duplicate=await new Promise((resolve,reject)=>{
  const q=request({host:'127.0.0.1',port:s.port,path:'/carrier/rates',method:'POST',headers:['Host','localhost','Content-Type','application/json','Content-Length',String(f.raw().length),'X-Duplicate','one','x-duplicate','two']},r=>{let body='';r.on('data',c=>body+=c);r.on('end',()=>resolve(JSON.parse(body)));});q.on('error',reject);q.end(f.raw());
 });assert.deepEqual(duplicate,empty);assert.equal(calls,0);
});
test('F06G slow body deadline returns empty without waiting for end of input',async t=>{
 const s=await server(t,{enabled:true,deadlineMs:40});
 const raw=await new Promise((resolve,reject)=>{const sock=connect(s.port,'127.0.0.1',()=>sock.write('POST /carrier/rates HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{'));let data='';sock.on('data',c=>data+=c);sock.on('end',()=>resolve(data));sock.on('error',reject);});
 assert.match(raw,/HTTP\/1.1 200/);assert.match(raw,/\{"rates":\[\]\}/);assert.equal(s.status().active,0);
});
test('F06G deadline aborts provider work and ignores late success',async t=>{
 const f=await fixture(t);let signal;
 f.post=async(b,options)=>{signal=options.signal;await new Promise(r=>setTimeout(r,80));return reply(b);};
 const s=await server(t,{enabled:true,deadlineMs:30,processCallback:f.process});assert.deepEqual((await post(s,f.raw())).body,empty);assert.ok(signal.aborted);
 await new Promise(r=>setTimeout(r,100));assert.equal(s.status().active,0);
});
test('F06G concurrency cap retains slots for abort-ignoring callbacks until actual settlement',async t=>{
 const f=await fixture(t),releases=[];let calls=0;
 const s=await server(t,{enabled:true,deadlineMs:30,processCallback:async()=>{calls++;await new Promise(r=>releases.push(r));return unavailableCallback();}});
 const responses=await Promise.all(Array.from({length:6},()=>post(s,f.raw())));assert.ok(responses.every(r=>r.status===200&&r.body.rates.length===0));
 assert.equal(calls,4);assert.equal(s.status().active,4);assert.deepEqual((await post(s,f.raw())).body,empty);assert.equal(calls,4);
 releases.forEach(r=>r());await new Promise(r=>setImmediate(r));assert.equal(s.status().active,0);
});
test('F06G two stored same-variant lines resolve independently without merging; sharing remains unavailable',async t=>{
 const f=await fixture(t);
 const second=await f.jobs.prepare(f.owner,{request_key:'second-same-variant',copies:2,service:'photo',size:'4x6',paper:'synthetic-paper',lab:'miami',options:{},asset_ids:['asset-0001']});
 f.body.rate.items.push({...f.body.rate.items[0],quantity:2,price:40,properties:second.item.properties});
 const c=parseCarrierRequest(f.raw()),p=await inspect(f,c);
 assert.deepEqual(p.jobs.map(j=>j.copies*j.completed_asset_ids.length),[45,2]);assert.notEqual(p.jobs[0].id,p.jobs[1].id);
 assert.equal(f.posts.length,0);
 // No production group resolver exists; callback subset is not a complete cart.
 const s=await server(t,{enabled:true,processCallback:f.process});assert.deepEqual((await post(s,f.raw())).body,empty);
});
test('default executable excludes callback activation; private diagnostic operator mounts it explicitly',()=>{
 const main=readFileSync(new URL('../backend/main.mjs',import.meta.url),'utf8'),runtime=readFileSync(new URL('../backend/server.mjs',import.meta.url),'utf8');
 const docker=readFileSync(new URL('../backend/Dockerfile',import.meta.url),'utf8');
 assert.ok(!main.includes('carrier/')&&!runtime.includes('carrier/'));
 assert.ok(docker.includes('COPY carrier'));
 const operator=readFileSync(new URL('../backend/diagnostic-operator.mjs',import.meta.url),'utf8');
 assert.ok(operator.includes('if(plan.shipping===true)')&&operator.includes('CALLBACK_AUTH_REQUIRED'));
 assert.ok(!main.includes('f06g/synthetic')&&!runtime.includes('f06g/synthetic'));
});
