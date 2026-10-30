import test from 'node:test';
import assert from 'node:assert/strict';
import {shippoRelease,shippoInput,job,reply,services} from '../../../fixtures/film-printing/f04b/synthetic.mjs';
import {active,boundaries} from '../../../fixtures/film-printing/f04/synthetic.mjs';
import {makeRelease,verifyRelease,canonical} from '../configuration/config.mjs';
import {createConfigLoader,encodeRecord,decodeRecord} from '../configuration/shopify.mjs';
import {APP,STORE,definitions} from '../configuration/schema.mjs';
import {createQuoteService} from '../shipping/quote.mjs';
import {createShippoProvider,createShippoTransport} from '../shipping/shippo.mjs';
import {createJobStore,createJobService} from '../jobs/service.mjs';

const provider = (extra={}) => createShippoProvider({postShipment:async body=>reply(body),checkEligibility:async()=>true,...extra});
const service = (r,data=shippoInput(r),extra={}) => createQuoteService({loader:{load:async()=>r},resolveRequest:async()=>data,provider:provider(),...extra});

test('F04B: versioned optional policy round-trip preserves historical release, rejects secrets/duplicates/mismatched accounts',()=>{
  assert.equal(verifyRelease(active),active);
  assert.equal(makeRelease(active.config).sha256,active.sha256);
  const r=shippoRelease();assert.notEqual(r.version,active.version);assert.equal(verifyRelease(r),r);
  const policy=r.config.policies[0];
  assert.deepEqual(decodeRecord({handle:policy.id,fields:encodeRecord(policy)},definitions.find(d=>d.type==='bfl_print_policy')),policy);
  for (const change of [
    p=>p.shippo.token='do-not-store',p=>p.shippo.mode='auto',p=>p.shippo.services=[],
    p=>p.shippo.services.push(p.shippo.services[0]),p=>p.shippo.services[2].account_id='synthetic_ups',
    p=>p.shippo.services[0].service_token='usps_priority',p=>p.shippo.services[0].carrier='unverified',
    p=>p.markup_cents=1,p=>p.currency='CAD',p=>p.sharing='separate',p=>p.rate_access='unverified',
  ]) assert.throws(()=>shippoRelease(c=>change(c.policies[0])),{code:'INVALID_CONFIGURATION'});
  assert.doesNotThrow(()=>shippoRelease(c=>Object.assign(c.policies[0],{enabled:false,rate_access:'unverified',shippo:{mode:'test',services:[]}})));
});

test('F04B: all 52 existing packing boundary manifests map exact inches/ounces into synthetic Shippo rates',async()=>{
  const r=shippoRelease();
  for (const c of boundaries) {
    const rule=r.config.rules.find(x=>x.id===c.rule_id);let body;
    const data=shippoInput(r,[job(r,{service:rule.service,size:rule.size_key,copies:c.physical_count,completed_asset_ids:['one']})]);
    const result=await service(r,data,{provider:provider({postShipment:async b=>{body=b;return reply(b);}})}).quote({});
    assert.equal(result.status,'available',c.id);
    assert.deepEqual(result.packing.groups[0].parcels.map(p=>p.print_count),c.expected_package_print_counts);
    assert.equal(result.packing.groups[0].total_weight_oz,Number(c.expected_total_weight_oz));
    assert.deepEqual(body.parcels.map(p=>p.weight),result.packing.groups[0].parcels.map(p=>String(p.weight_oz)));
    assert.ok(body.parcels.every(p=>p.mass_unit==='oz' && p.distance_unit==='in'));
  }
});

test('F04B: partial load includes tare; multiple services each quote the whole shipment once',async()=>{
  const r=shippoRelease();let body;
  const q=service(r,shippoInput(r,[job(r,{copies:41,completed_asset_ids:['one']})]),{provider:provider({postShipment:async b=>{body=b;return reply(b);}})});
  const result=await q.quote({price:0,file_count:999});
  assert.equal(result.status,'available');assert.equal(result.mode,'test');assert.equal(result.checkout_ready,false);
  assert.deepEqual(body.parcels.map(p=>p.weight),['5','1.1']);
  assert.deepEqual(body.parcels[0],{length:'11',width:'8.5',height:'0.5',distance_unit:'in',mass_unit:'oz',weight:'5'});
  assert.equal(body.async,false);assert.equal(body.shipment_date,'2026-10-21T15:00:00Z');
  assert.deepEqual(body.carrier_accounts,['synthetic_ups','synthetic_fedex']);
  assert.equal(result.quotes[0].options.length,3);
  assert.equal(result.quotes[0].options.find(o=>o.service==='ups_ground').total_cents,1234);
  assert.ok(Object.isFrozen(result.quotes[0].options));
  const next=await q.quote({});assert.deepEqual(next.quotes[0].options.map(o=>o.id),result.quotes[0].options.map(o=>o.id));
});

test('F04B: two actual lab groups produce separate requests and independent options; no cross-origin sum',async()=>{
  const r=shippoRelease();const calls=[];let loads=0;
  const data=shippoInput(r,[job(r),job(r,{id:'b',lab:'synthetic-second-lab',copies:41,completed_asset_ids:['one']})]);
  const result=await service(r,data,{loader:{load:async({expectedVersion})=>{loads++;assert.equal(expectedVersion,r.version);return r;}},
    provider:provider({postShipment:async b=>{calls.push(b);return reply(b);}})}).quote({groups:[]});
  assert.equal(result.status,'available');assert.equal(loads,1);assert.equal(calls.length,2);
  assert.notDeepEqual(calls[0].address_from,calls[1].address_from);assert.notEqual(calls[0].metadata,calls[1].metadata);
  assert.equal(result.quotes[0].options.length,4);assert.equal(result.quotes[1].options.length,3);
  assert.equal(result.total_cents,undefined);assert.equal(result.quotes[0].total_cents,undefined);
  assert.deepEqual(result.quotes.map(q=>q.location_id),data.groups.map(g=>g.location_id));
  const failed=await service(r,data,{provider:provider({postShipment:async b=>b.address_from.city==='Chicago'?{status:'WAITING'}:reply(b)})}).quote({});
  assert.equal(failed.status,'unavailable');assert.deepEqual(failed.quotes,[]);
});

test('F04B: parcel capabilities filter USPS/DHL, cap UPS at 50 and conservatively gate FedEx above 12',async()=>{
  const r=shippoRelease(c=>c.policies[0].shippo.services.push({carrier:'DHL Express',account_id:'synthetic_dhl',service_token:'dhl_express_worldwide'}));
  for (const [count,expected] of [[1,['synthetic_ups','synthetic_fedex','synthetic_usps','synthetic_dhl']],[2,['synthetic_ups','synthetic_fedex']],[12,['synthetic_ups','synthetic_fedex']],[13,['synthetic_ups']],[50,['synthetic_ups']],[51,[]]]) {
    let body;
    const data=shippoInput(r,[job(r,{copies:count*40,completed_asset_ids:['one']})]);
    const result=await service(r,data,{provider:provider({postShipment:async b=>{body=b;return reply(b,r.config.policies[0].shippo.services);}})}).quote({});
    if (count===51) {assert.equal(result.code,'CARRIER_INELIGIBLE');assert.equal(body,undefined);}
    else {assert.equal(result.status,'available');assert.deepEqual(body.carrier_accounts,expected);}
  }
});

test('F04B: explicit service eligibility receives exact origin/date/parcels; PO box is not globally rejected',async()=>{
  const r=shippoRelease();const data=shippoInput(r);data.groups[0].destination.address1='P.O. Box 1';const checks=[];
  const result=await service(r,data,{provider:provider({checkEligibility:async(s,o)=>{checks.push([s,o]);return o.carrier==='USPS';}})}).quote({});
  assert.equal(result.status,'available');assert.equal(result.quotes[0].options.length,1);
  assert.equal(result.quotes[0].options[0].carrier,'USPS');assert.equal(checks.length,4);
  assert.equal(checks[0][0].job.physical_count,12);assert.equal(checks[0][0].shipment_date,data.groups[0].shipment_date);
  let posts=0;
  for (const checkEligibility of [undefined,async()=>false,async()=>null]) {
    const result=await service(r,data,{provider:provider({checkEligibility,postShipment:async()=>{posts++;}})}).quote({});
    assert.equal(result.status,'unavailable');
  }
  assert.equal(posts,0);
});

test('F04B: incomplete/status/echo/address/parcel/account responses never produce partial options',async()=>{
  const r=shippoRelease();
  for (const mutate of [
    x=>x.status='WAITING',x=>x.status='QUEUED',x=>x.status='ERROR',x=>delete x.status,
    x=>x.test=false,x=>delete x.test,x=>x.metadata='wrong',x=>x.shipment_date='2026-10-22T15:00:00Z',
    x=>x.messages=[{code:'carrier_timeout'}],x=>delete x.messages,x=>x.rates=[],x=>delete x.rates,
    x=>x.parcels=[],x=>x.parcels[0].weight='999',x=>x.parcels[0].mass_unit='lb',
    x=>x.address_from.street1='Default sender',x=>x.address_to.zip='99999',x=>x.address_from.is_complete=false,
    x=>x.address_to.validation_results={is_valid:false},x=>x.carrier_accounts=['wrong'],
    x=>x.rates=x.rates.filter(rate=>rate.carrier_account!=='synthetic_fedex'),
  ]) {
    const result=await service(r,shippoInput(r),{provider:provider({postShipment:async b=>{const x=reply(b);mutate(x);return x;}})}).quote({});
    assert.equal(result.status,'unavailable');assert.deepEqual(result.quotes,[]);
  }
});

test('F04B: duplicate, foreign account, mismatched service/carrier/currency/mode and malformed rates fail closed',async()=>{
  const r=shippoRelease();
  for (const mutate of [
    x=>x.rates.push({...x.rates[0],object_id:'different_rate'}),x=>x.rates.push(x.rates[0]),
    x=>x.rates[0].carrier_account='foreign',x=>x.rates[0].provider='USPS',x=>x.rates[0].shipment='wrong',
    x=>x.rates[0].test=false,x=>x.rates[0].currency='CAD',x=>x.rates[0].messages=[{code:'error'}],
    x=>delete x.rates[0].servicelevel,x=>x.rates[0].object_id=null,
    ...['0','-1','12.345','NaN','1e2',' 12.34','999999999999999999999',12.34,null].map(value=>x=>x.rates[0].amount=value),
  ]) assert.equal((await service(r,shippoInput(r),{provider:provider({postShipment:async b=>{const x=reply(b);mutate(x);return x;}})}).quote({})).status,'unavailable');
});

test('F04B: unselected services are omitted, never substituted; exact cents use amount rather than amount_local',async()=>{
  const r=shippoRelease();
  const result=await service(r,shippoInput(r),{provider:provider({postShipment:async b=>{
    const x=reply(b);x.rates[0].amount='0.01';x.rates[0].amount_local='999';
    x.rates.push({...x.rates[0],object_id:'unselected',servicelevel:{token:'ups_next_day_air'}});return x;
  }})}).quote({});
  assert.equal(result.status,'available');assert.equal(result.quotes[0].options.length,4);
  assert.equal(result.quotes[0].options.find(o=>o.service==='ups_ground').total_cents,1);
  const unavailable=await service(r,shippoInput(r),{provider:provider({postShipment:async b=>{
    const x=reply(b);x.rates=x.rates.map(rate=>({...rate,servicelevel:{token:'unselected'}}));return x;
  }})}).quote({});assert.equal(unavailable.status,'unavailable');
});

test('F04B: missing access, disabled snapshot, old version, foreign geography, date and unsupported measurements block',async()=>{
  const r=shippoRelease();let posts=0;const p=provider({postShipment:async b=>{posts++;return reply(b);}});
  assert.equal((await service(active,shippoInput(active),{provider:p}).quote({})).code,'RATE_ACCESS_UNAVAILABLE');
  assert.equal((await service(r,shippoInput(r),{loader:{load:async()=>active},provider:p}).quote({})).code,'VERSION_MISMATCH');
  for(const mutate of [i=>i.groups[0].destination.country_code='CA',i=>delete i.groups[0].shipment_date,i=>i.groups[0].shipment_date='2026-02-30T00:00:00Z',i=>i.groups[0].location_id='wrong']) {
    const i=shippoInput(r);mutate(i);assert.equal((await service(r,i,{provider:p}).quote({})).status,'unavailable');
  }
  const precision=shippoRelease(c=>c.packages[0].height_in=0.12345);
  assert.equal((await service(precision,shippoInput(precision),{provider:p}).quote({})).code,'UNSUPPORTED_SHIPPO_MEASUREMENT');
  assert.equal((await service(r,shippoInput(r),{provider:createShippoProvider()}).quote({})).code,'SHIPPO_ACCESS_MISSING');
  assert.equal(posts,0);
});

test('F04B: deadlines and cancellation abort resolver/eligibility/transport; ignored abort cannot return success',async()=>{
  const r=shippoRelease();let captured;
  for (const extra of [
    {resolveRequest:async(req,{signal})=>{captured=signal;return new Promise(()=>{});}},
    {provider:provider({checkEligibility:async(s,o,{signal})=>{captured=signal;return new Promise(()=>{});}})},
    {provider:provider({postShipment:async(b,{signal})=>{captured=signal;await new Promise(resolve=>setTimeout(resolve,40));return reply(b);}})},
  ]) {const result=await service(r,shippoInput(r),{...extra,timeoutMs:10}).quote({});assert.equal(result.code,'QUOTE_TIMEOUT');assert.ok(captured.aborted);}
  const controller=new AbortController();const pending=service(r,shippoInput(r),{resolveRequest:async(req,{signal})=>{captured=signal;return new Promise(()=>{});}}).quote({},{signal:controller.signal});
  controller.abort();assert.equal((await pending).code,'QUOTE_CANCELLED');assert.ok(captured.aborted);
  assert.equal((await service(r).quote({},{signal:controller.signal})).code,'QUOTE_CANCELLED');
  const result=await service(r,shippoInput(r),{provider:provider({postShipment:async()=>{throw Error('secret response');}})}).quote({});
  assert.deepEqual(result,{status:'unavailable',code:'DEPENDENCY_FAILED',quotes:[]});
});

test('F04B: server transport defaults disabled, enforces token mode and only POSTs shipments with bounded cancellation',async()=>{
  const signal=new AbortController().signal;let calls=0;
  const fake=async(url,options)=>{calls++;assert.equal(url,'https://api.goshippo.com/shipments/');assert.equal(options.method,'POST');assert.equal(options.redirect,'error');
    assert.equal(options.headers['Shippo-API-Version'],'2018-02-08');assert.equal(options.headers.Authorization,'ShippoToken shippo_test_SYNTHETIC');return {ok:true,json:async()=>({status:'SUCCESS'})};};
  for(const config of [{},{enabled:true},{enabled:true,token:'shippo_live_SYNTHETIC'}]) await assert.rejects(createShippoTransport({...config,fetchImpl:fake})({},{signal,mode:'test'}));
  assert.equal(calls,0);
  await assert.rejects(createShippoTransport({enabled:true,mode:'live',token:'shippo_live_SYNTHETIC',fetchImpl:fake})({},{signal,mode:'test'}));
  assert.equal(calls,0);
  assert.deepEqual(await createShippoTransport({enabled:true,token:'shippo_test_SYNTHETIC',fetchImpl:fake})({},{signal,mode:'test'}),{status:'SUCCESS'});
  assert.equal(calls,1);
  await assert.rejects(createShippoTransport({enabled:true,token:'shippo_test_SYNTHETIC',timeoutMs:5,fetchImpl:async(url,{signal})=>{await new Promise(resolve=>setTimeout(resolve,20));assert.ok(signal.aborted);return {ok:true,json:async()=>({})};}})({},{signal,mode:'test'}),{code:'QUOTE_TIMEOUT'});
  for(const status of [401,403,429,500,503]) await assert.rejects(createShippoTransport({enabled:true,token:'shippo_test_SYNTHETIC',fetchImpl:async()=>({ok:false,status})})({},{signal,mode:'test'}),{code:'SHIPPO_HTTP_ERROR'});
  await assert.rejects(createShippoTransport({enabled:true,token:'shippo_test_SYNTHETIC',fetchImpl:async()=>({ok:true,json:async()=>{throw Error('invalid JSON');}})})({},{signal,mode:'test'}));
  const controller=new AbortController();controller.abort();await assert.rejects(createShippoTransport({enabled:true,token:'shippo_test_SYNTHETIC',fetchImpl:fake})({},{signal:controller.signal,mode:'test'}));
  const result=await service(shippoRelease(),undefined,{provider:provider({postShipment:createShippoTransport()})}).quote({});assert.equal(result.code,'SHIPPO_DISABLED');
});

test('F04B: real immutable job store + signed references + verified loader feed Shippo using current trusted copies',async t=>{
  const r=shippoRelease();let reads=0;
  const loader=createConfigLoader(async()=>{reads++;return {shop:{myshopifyDomain:STORE},currentAppInstallation:{app:{id:APP},metafield:{value:canonical(r)}}};});
  const store=createJobStore(':memory:');t.after(()=>store.close());
  for(const id of ['asset-0001','asset-0002','asset-0003'])store.recordUpload('owner',{id,state:'complete',verified:true,url:`https://example.invalid/${id}`});
  const jobs=createJobService({store,loader,secret:'synthetic-f04b-secret-longer-than-32-characters',loadCatalog:async()=>({version:'synthetic',store:STORE,currency:'USD',rows:[{enabled:true,service:'photo',size:'4x6',paper:'synthetic-paper',lab:'miami',per_file_cents:40,variant_id:'67852705202287',physical:true,options:{}}]})});
  const prepared=await jobs.prepare('owner',{request_key:'f04b-request',service:'photo',size:'4x6',paper:'synthetic-paper',lab:'miami',copies:4,asset_ids:['asset-0001','asset-0002','asset-0003'],options:{}});
  assert.equal(prepared.unit_price_cents,120);assert.equal(prepared.checkout_ready,false);
  const groups=shippoInput(r,[job(r,{id:prepared.reference.id})]).groups;let quantity=14,owner='owner';const requests=[];
  const quote=jobs.quoteService({resolveCart:async(req,{signal})=>{assert.ok(signal);return {owner,lines:[{reference:prepared.reference,variant_id:prepared.item.id,quantity}],groups};},provider:provider({postShipment:async b=>{requests.push(b);return reply(b);}})});
  const result=await quote.quote({quantity:999,groups:[]});assert.equal(result.status,'available');
  assert.equal(result.packing.groups[0].job.physical_count,42);assert.deepEqual(requests[0].parcels.map(p=>p.weight),['5','1.2']);
  assert.equal(reads,1);assert.equal(store.get(prepared.reference.id,'owner').copies,4);
  quantity=1;assert.equal((await quote.quote({})).packing.groups[0].job.physical_count,3);
  owner='other-owner';assert.equal((await quote.quote({})).status,'unavailable');assert.equal(requests.length,2);
});

test('F04B: unchanged sharing guard rejects mixed jobs instead of inventing extra shipments',async()=>{
  const r=shippoRelease();const data=shippoInput(r,[job(r),job(r,{id:'b'})]);
  data.groups=[{...data.groups[0],job_ids:['job-a','b']}];let posts=0;
  assert.equal((await service(r,data,{provider:provider({postShipment:async()=>{posts++;}})}).quote({})).code,'SHARING_UNAVAILABLE');assert.equal(posts,0);
});
