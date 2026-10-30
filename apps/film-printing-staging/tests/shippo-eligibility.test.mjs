import test from 'node:test';
import assert from 'node:assert/strict';
import { createShippoTestEligibility } from '../shipping/shippo-eligibility.mjs';
import { runShippoTestQuote } from '../shipping/shippo-test-quote.mjs';
import { createShippoProvider } from '../shipping/shippo.mjs';
import { fixture,reviewFor,option } from '../../../fixtures/film-printing/f04d/synthetic.mjs';
import { reply } from '../../../fixtures/film-printing/f04b/synthetic.mjs';

const inspect = f => createShippoTestEligibility(f).inspect(f.shipment,option);
const rebind = f => {f.reviews=[reviewFor(f.shipment,f.inventory)];return f;};
const success = async (_url,{body}) => ({ok:true,status:201,json:async()=>reply(JSON.parse(body),[option])});
const run = (f,extra={}) => runShippoTestQuote({enabled:true,...f,readToken:async()=> 'shippo_test_SYNTHETIC',fetchImpl:success,...extra});

test('F04D: synthetic exact review allows USPS Ground Advantage without inventing owner/authentication',()=>{
  const f=fixture();assert.equal(inspect(f).eligible,true);
  assert.equal(f.inventory.accounts[0].owner_matches,null);assert.equal(f.inventory.accounts[0].authentication_status,'unverified');
  const checker=createShippoTestEligibility(f);f.reviews[0].physical.shape='tube';
  assert.equal(checker.inspect(f.shipment,option).eligible,true); // immutable private snapshot
  assert.equal(inspect(f).eligible,false);
});

test('F04D: available synthetic inventory cannot authorize any parcel or read a key without physical evidence',async()=>{
  const f=fixture();f.reviews=[];
  let reads=0,posts=0;
  const result=await run(f,{readToken:async()=>{reads++;},fetchImpl:async()=>{posts++;}});
  assert.equal(result.result.code,'CARRIER_INELIGIBLE');assert.equal(reads,0);assert.equal(posts,0);
  assert.ok(result.evidence.preflight[0].reasons.includes('EXACT_REVIEW_REQUIRED'));
  assert.ok(!result.evidence.preflight[0].reasons.includes('TEST_ACCOUNT_UNAVAILABLE'));
});

test('F04D: exact evidence cannot be replayed across jobs, versions, addresses, time, tender, parcels, accounts',()=>{
  for(const change of [
    f=>f.shipment.job.id='other',f=>f.shipment.job.revision='other',f=>f.shipment.config_version='other',
    f=>f.shipment.origin.address1='Other',f=>f.shipment.destination.postal_code='33128',
    f=>f.shipment.shipment_date='2026-10-23T18:00:00Z',f=>f.shipment.tender.method='scheduled_pickup',
    f=>f.shipment.parcels[0].weight_oz=4,f=>f.shipment.parcels[0].dimensions_in.width=11,
    f=>f.inventory.accounts[0].service_tokens.push('usps_priority'),f=>f.reviews.push(f.reviews[0]),
  ]){const f=fixture();change(f);assert.ok(inspect(f).reasons.includes('EXACT_REVIEW_REQUIRED'));}
  for(const key of ['connection','origin','destination','physical','packaging','tender']) {
    const f=fixture();delete f.reviews[0].references[key];assert.equal(inspect(f).eligible,false);
  }
  for(const change of [r=>r.expires_at='2026-10-21T12:00:00Z',r=>r.expires_at='2026-10-25T12:00:00Z',
    r=>r.reviewed_at='2026-10-21T13:00:00Z',r=>r.reviewed_at='2026-02-30T00:00:00Z']) {
    const f=fixture();change(f.reviews[0]);assert.ok(inspect(f).reasons.includes('REVIEW_EXPIRED_OR_INVALID'));
  }
});

test('F04D: static constraints still reject freshly rebound unsupported evidence',()=>{
  for(const change of [f=>f.inventory.complete=false,f=>f.inventory.mode='live',f=>f.inventory.accounts.push(f.inventory.accounts[0]),
    f=>f.inventory.accounts[0].active=false,f=>f.inventory.accounts[0].test=false,
    f=>f.inventory.accounts[0].is_shippo_account=false,f=>f.inventory.accounts[0].owner_matches=false,
    f=>f.inventory.accounts[0].authentication_status='disconnected',f=>f.inventory.accounts[0].service_tokens=[],
    f=>f.shipment.policy.shippo.mode='live',f=>f.shipment.currency='CAD',
    f=>f.shipment.destination.province_code='PR',f=>f.shipment.destination.province_code='AA',
    f=>f.shipment.destination.country_code='CA',f=>f.shipment.destination.postal_code='unknown',
    f=>delete f.shipment.origin.name,f=>delete f.shipment.destination.residential,
    f=>f.shipment.shipment_date='2026-10-20T12:00:00Z',f=>f.shipment.shipment_date='2026-02-30T00:00:00Z',
    f=>f.shipment.tender.method='collection_box',f=>f.shipment.tender=null,
    f=>f.shipment.parcels=[],f=>f.shipment.parcels.push(f.shipment.parcels[0]),
    f=>f.shipment.parcels[0].weight_oz=0,f=>f.shipment.parcels[0].dimensions_in.height=0.12345,
  ]){const f=fixture();change(f);rebind(f);assert.equal(inspect(f).eligible,false);}
  for(const change of [p=>p.shape='tube',p=>p.packaging='usps_priority',p=>p.contents='unknown',p=>p.rigid=false,p=>p.labels_fit=false]) {
    const f=fixture();change(f.reviews[0].physical);assert.equal(inspect(f).eligible,false);
  }
  for(const candidate of [{carrier:'FedEx',service_token:'fedex_2_day'},{carrier:'UPS',service_token:'ups_ground'},
    {carrier:'DHL Express',service_token:'dhl_express_domestic_express_doc'},{carrier:'USPS',service_token:'usps_media_mail'}]) {
    const f=fixture();assert.ok(createShippoTestEligibility(f).inspect(f.shipment,{...option,...candidate}).reasons.includes('SERVICE_NOT_IMPLEMENTED'));
  }
});

test('F04D: USPS rectangular length/girth and weight limits use longest axis, retain PO boxes and Alaska/Hawaii',()=>{
  for(const [weight,length,expected] of [[1120,90,true],[1120.0001,90,false],[1120,90.0001,false]]) {
    const f=fixture();Object.assign(f.shipment.parcels[0],{weight_oz:weight,dimensions_in:{length:10,width:length,height:10}});
    rebind(f);assert.equal(inspect(f).eligible,expected);
  }
  for(const state of ['AK','HI','DC']) {
    const f=fixture();Object.assign(f.shipment.destination,{province_code:state,address1:'PO Box 123'});rebind(f);
    assert.equal(inspect(f).eligible,true); // actual address verification still requires exact review
  }
});

test('F04D: one bounded test POST produces redacted full parcel echoes and one whole-shipment total',async()=>{
  const f=fixture();let posts=0;
  const output=await run(f,{fetchImpl:async(url,options)=>{
    posts++;assert.equal(url,'https://api.goshippo.com/shipments/');assert.equal(options.method,'POST');
    assert.equal(options.headers.Authorization,'ShippoToken shippo_test_SYNTHETIC');return success(url,options);
  }});
  assert.equal(posts,1);assert.equal(output.result.status,'available');assert.equal(output.result.checkout_ready,false);
  assert.equal(output.result.options[0].total_cents,1234);assert.equal(output.evidence.shipment_requests,1);
  assert.deepEqual(output.evidence.request.parcels,[{length:'13',width:'10',height:'2',weight:'3.4',mass_unit:'oz',distance_unit:'in'}]);
  assert.deepEqual(output.evidence.response.parcels,output.evidence.request.parcels);assert.equal(output.evidence.http_status,201);
  const serialized=JSON.stringify(output);
  for(const privateValue of ['shippo_test_SYNTHETIC','Synthetic Origin','Synthetic Destination',f.shipment.origin.address1]) assert.ok(!serialized.includes(privateValue));
});

test('F04D: disabled, live token, cancellation, missing evidence and credential errors make zero network calls',async()=>{
  let posts=0,reads=0;
  const dependencies={readToken:async()=>{reads++;return 'shippo_test_SYNTHETIC';},fetchImpl:async()=>{posts++;}};
  assert.equal((await run(fixture(),{...dependencies,enabled:false})).result.code,'SHIPPO_DISABLED');
  assert.equal((await run({...fixture(),reviews:[]},dependencies)).result.code,'CARRIER_INELIGIBLE');
  const controller=new AbortController();controller.abort();
  assert.equal((await run(fixture(),{...dependencies,signal:controller.signal})).result.code,'QUOTE_CANCELLED');
  assert.equal(reads,0);assert.equal(posts,0);
  assert.equal((await run(fixture(),{...dependencies,readToken:async()=> 'shippo_live_SYNTHETIC'})).result.code,'SHIPPO_ACCESS_MISSING');
  assert.equal((await run(fixture(),{...dependencies,readToken:async()=>{throw Error('private credential detail');}})).result.code,'DEPENDENCY_FAILED');
  assert.equal(posts,0);
});

test('F04D: failed strict responses retain safe diagnostics, never rates or provider messages with private text',async()=>{
  for(const change of [r=>r.address_from.street1='wrong',r=>r.parcels[0].weight='999',r=>r.carrier_accounts=[],
    r=>r.messages=[{code:'warning',source:'USPS',text:'private contact shippo_test_SECRET'}],r=>r.test=false]) {
    const output=await run(fixture(),{fetchImpl:async(_url,{body})=>{
      const response=reply(JSON.parse(body),[option]);change(response);return {ok:true,status:201,json:async()=>response};
    }});
    assert.equal(output.result.status,'unavailable');assert.deepEqual(output.result.options,[]);
    assert.ok(output.evidence.response);assert.ok(!JSON.stringify(output).includes('private contact'));
    assert.ok(!JSON.stringify(output).includes('shippo_test_SECRET'));
  }
});

test('F04D: selected rate terms cannot silently select packaging-specific prices even when token is unique',async()=>{
  for(const terms of ['ONERATE','CUBIC',null]) {
    const f=fixture();
    const provider=createShippoProvider({checkEligibility:createShippoTestEligibility(f).checkEligibility,postShipment:async body=>{
      const response=reply(body,[option]);response.rates[0].servicelevel.terms=terms;return response;
    }});
    await assert.rejects(provider.quote(f.shipment,{signal:new AbortController().signal}),{code:'UNSUPPORTED_SHIPPO_TERMS'});
  }
});

test('F04D: overall timeout bounds key lookup and late network responses, with immutable returned evidence',async()=>{
  let posts=0,aborted=false;
  const output=await run(fixture(),{timeoutMs:10,readToken:async({signal})=>{
    await new Promise(r=>setTimeout(r,30));aborted=signal.aborted;return 'shippo_test_SYNTHETIC';
  },fetchImpl:async()=>{posts++;}});
  assert.equal(output.result.code,'QUOTE_TIMEOUT');
  await new Promise(r=>setTimeout(r,40));assert.equal(posts,0);assert.equal(aborted,true);
  const late=await run(fixture(),{timeoutMs:10,fetchImpl:async(...args)=>{await new Promise(r=>setTimeout(r,30));return success(...args);}});
  assert.equal(late.result.code,'QUOTE_TIMEOUT');const snapshot=JSON.stringify(late);
  await new Promise(r=>setTimeout(r,40));assert.equal(JSON.stringify(late),snapshot);
  const controller=new AbortController();
  const pending=run(fixture(),{signal:controller.signal,readToken:async()=>new Promise(()=>{})});
  controller.abort();assert.equal((await pending).result.code,'QUOTE_CANCELLED');
});
