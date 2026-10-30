import test from 'node:test';
import assert from 'node:assert/strict';
import { active, boundaries, syntheticRelease, job, input, fedexReply } from '../../../fixtures/film-printing/f04/synthetic.mjs';
import { packDeliveryGroups, normalizeJob, normalizeSize } from '../shipping/packing.mjs';
import { createQuoteService } from '../shipping/quote.mjs';
import { createFedexProvider } from '../shipping/fedex.mjs';
const pack = (r,i=input(r)) => packDeliveryGroups(r,i);
const validRate = {eligible:true,service:'FEDEX_2_DAY',rate_source:'bellows_own_account',currency:'USD',total_cents:1234};
function service(r, data=input(r), overrides={}) {
  return createQuoteService({loader:{load:async()=>r},resolveRequest:async()=>data,provider:{quote:async()=>validRate},...overrides});
}

test('F04: all 52 inherited boundaries: exact loads, tare+prints, six dimensions and partial final parcel', () => {
  const r=syntheticRelease();
  for(const c of boundaries) {
    const rule=r.config.rules.find(x=>x.id===c.rule_id);
    const pkg=r.config.packages.find(x=>x.id===rule.package_id);
    const j=job(r,{service:rule.service,size:rule.size_key,copies:c.physical_count,completed_asset_ids:['one']});
    const g=pack(r,input(r,[j])).groups[0];
    assert.deepEqual(g.parcels.map(p=>p.print_count),c.expected_package_print_counts,c.id);
    assert.equal(g.total_weight_oz,Number(c.expected_total_weight_oz),c.id);
    for(const p of g.parcels) assert.deepEqual(p.dimensions_in,{length:pkg.length_in,width:pkg.width_in,height:pkg.height_in});
  }
});
test('F04: copies multiply completed assets once; client counts/prices/packages do not affect physical manifest', () => {
  const r=syntheticRelease(); const j=job(r,{file_count:999,physical_count:999,price:1,package_id:'fake'});
  assert.equal(pack(r,input(r,[j])).groups[0].job.physical_count,12);
  assert.equal(pack(r).groups[0].total_weight_oz,2.2);
  assert.equal(normalizeSize('6” X 4"'),'4x6');
  for(const change of [{copies:0},{copies:1.5},{copies:'4'},{copies:Number.MAX_SAFE_INTEGER},{completed_asset_ids:[]},{completed_asset_ids:['a','a']},{completed_asset_ids:[null]},{size:'4x6 cm'},{size:'Custom Size'},{service:'Darkroom Prints'},{paper:null},{lab:null}]) assert.throws(()=>normalizeJob({...j,...change}));
});
test('F04: matching uses exact service/size/paper/lab and explicit disabled local override', () => {
  let r=syntheticRelease(c=>c.rules.push({...c.rules.find(x=>x.size_key==='4x6'),id:'synthetic-local',lab:'miami',capacity:2}));
  assert.equal(pack(r).groups[0].parcels.length,6);
  r=syntheticRelease(c=>c.rules.push({...c.rules.find(x=>x.size_key==='4x6'),id:'synthetic-denial',lab:'miami',enabled:false,disabled_reason:'Test denial'}));
  assert.throws(()=>pack(r),{code:'UNAVAILABLE_RULE'});
  r=syntheticRelease();
  for(const change of [{paper:'unknown'},{service:'fine_art'},{size:'7x9'},{lab:'all_labs'},{lab:'staging-alternate'}]) assert.throws(()=>pack(r,input(r,[job(r,change)])));
});
test('F04: mixed jobs in same group denied; explicit distinct groups retain origins and jobs', () => {
  const r=syntheticRelease(); const a=job(r),b=job(r,{id:'job-b',size:'11x14',service:'fine_art',lab:'synthetic-second-lab'});
  const i=input(r,[a,b]); const packed=pack(r,i);
  assert.equal(packed.groups.length,2); assert.notDeepEqual(packed.groups[0].origin,packed.groups[1].origin);
  for(const second of [job(r,{id:'job-b'}),job(r,{id:'job-b',size:'8x10'})]) {
    const mixed=input(r,[a,second]);mixed.groups=[{...mixed.groups[0],job_ids:['job-a','job-b']}];
    assert.throws(()=>pack(r,mixed),{code:'SHARING_UNAVAILABLE'});
  }
  i.groups=[{...i.groups[0],job_ids:['job-a','job-b']}];assert.throws(()=>pack(r,i),{code:'CROSS_LAB_GROUP'});
});
test('F04: assignment, location, version, tampering and parcel budgets fail closed', () => {
  const r=syntheticRelease();
  for(const mutate of [i=>i.groups[0].location_id='wrong',i=>i.jobs[0].config_version=active.version,i=>i.groups.push({...i.groups[0],id:'duplicate-assignment'}),i=>i.jobs.push(job(r,{id:'unassigned'})),i=>i.groups[0].job_ids=['unknown'],i=>i.jobs[0].copies=1000000]) {
    const i=input(r);mutate(i);assert.throws(()=>pack(r,i));
  }
  const bad=structuredClone(r);bad.config.packages[0].empty_weight_oz++;assert.throws(()=>pack(bad));
  assert.throws(()=>pack(active,input(active))); // Real disabled snapshot remains unavailable.
});
test('F04: quote resolves trusted jobs and loads exactly one snapshot for all groups/parcels', async()=>{
  const r=syntheticRelease(); const i=input(r,[job(r,{copies:81}),job(r,{id:'b',lab:'synthetic-second-lab'})]);
  let loads=0;const calls=[];
  const q=service(r,i,{loader:{load:async({expectedVersion})=>{loads++;assert.equal(expectedVersion,r.version);return r;}},provider:{quote:async(s)=>{calls.push(s);return validRate;}}});
  const result=await q.quote({price:0,files:999});
  assert.equal(result.status,'available');assert.equal(loads,1);assert.equal(calls.length,2);
  assert.equal(calls[0].parcels.length,7);assert.equal(calls[1].parcels.length,1);
  assert.equal(result.quotes[0].total_cents,1234);assert.equal(result.config_version,r.version);
  assert.ok(Object.isFrozen(result.packing.groups[0]));
});
test('F04: unavailable policy/configuration, destination, currency, date, residential and tender data block provider',async()=>{
  const r=syntheticRelease();let calls=0;const provider={quote:async()=>{calls++;return validRate;}};
  for(const mutate of [i=>i.currency='CAD',i=>i.groups[0].destination.country_code='CA',i=>i.groups[0].destination.address1='P.O. Box 1',i=>delete i.groups[0].destination.residential,i=>i.groups[0].ship_date='2026-02-30',i=>delete i.groups[0].pickup_type]) {
    const i=input(r);mutate(i);assert.equal((await service(r,i,{provider}).quote({})).status,'unavailable');
  }
  assert.equal((await service(active,input(active),{provider}).quote({})).code,'RATE_ACCESS_UNAVAILABLE');
  assert.equal((await service(r,input(r),{loader:{load:async()=>active},provider}).quote({})).code,'VERSION_MISMATCH');
  assert.equal(calls,0);
});
test('F04: provider failure, malformed/list/currency/service/zero amounts yield no fallback or partial result',async()=>{
  const r=syntheticRelease();
  for(const rate of [null,{...validRate,total_cents:0},{...validRate,total_cents:1.1},{...validRate,eligible:false},{...validRate,rate_source:'list'},{...validRate,service:'FEDEX_GROUND'},{...validRate,currency:'CAD'}]) assert.deepEqual((await service(r,input(r),{provider:{quote:async()=>rate}}).quote({})).quotes,[]);
  const i=input(r,[job(r),job(r,{id:'b',lab:'synthetic-second-lab'})]);
  const result=await service(r,i,{provider:{quote:async(s)=>{if(s.lab==='miami')return validRate;throw Error('secret-body');}}}).quote({});
  assert.deepEqual(result,{status:'unavailable',code:'DEPENDENCY_FAILED',quotes:[]});
});
test('F04: total deadline covers resolver/config/provider, aborts and handles ignored abort',async()=>{
  const r=syntheticRelease();let signal;
  const result=await service(r,input(r),{timeoutMs:20,provider:{quote:async(s,o)=>{signal=o.signal;return new Promise(()=>{});}}}).quote({});
  assert.equal(result.code,'QUOTE_TIMEOUT');assert.ok(signal.aborted);
  assert.equal((await service(r,input(r),{timeoutMs:20,resolveRequest:async()=>new Promise(()=>{})}).quote({})).code,'QUOTE_TIMEOUT');
});
test('F04: FedEx contract sends all parcels once, correct origins/destination/account/service, no markup',async()=>{
  const r=syntheticRelease();const i=input(r,[job(r,{copies:41,completed_asset_ids:['one']})]);let request,eligibility;
  const provider=createFedexProvider({accountNumber:'000000000',checkEligibility:async(s)=>{eligibility=s;return true;},postRate:async body=>{request=body;return fedexReply();}});
  const result=await service(r,i,{provider}).quote({});assert.equal(result.status,'available');assert.equal(result.quotes[0].total_cents,1234);
  const s=request.requestedShipment;
  assert.deepEqual(s.rateRequestType,['ACCOUNT']);assert.equal(s.serviceType,'FEDEX_2_DAY');assert.equal(s.packagingType,'YOUR_PACKAGING');assert.equal(s.preferredCurrency,'USD');
  assert.equal(s.totalPackageCount,2);assert.deepEqual(s.requestedPackageLineItems.map(p=>p.weight.value),[5/16,1.1/16]);
  assert.deepEqual(s.requestedPackageLineItems[0].dimensions,{units:'IN',length:11,width:9,height:1});
  assert.equal(eligibility.parcels[0].dimensions_in.height,0.5);assert.equal(s.shipper.address.postalCode,'33127');assert.equal(s.recipient.address.residential,false);assert.equal(request.accountNumber.value,'000000000');
});
test('F04: FedEx missing access/eligibility, wrong or ambiguous account response and errors unavailable',async()=>{
  const r=syntheticRelease();let posts=0;
  for(const eligible of [false,null]) {
    const p=createFedexProvider({accountNumber:'000000000',checkEligibility:async()=>eligible,postRate:async()=>{posts++;return fedexReply();}});
    assert.equal((await service(r,input(r),{provider:p}).quote({})).code,'CARRIER_INELIGIBLE');
  }
  assert.equal(posts,0);
  assert.equal((await service(r,input(r),{provider:createFedexProvider({})}).quote({})).code,'FEDEX_ACCESS_MISSING');
  const responses=[{errors:[{message:'private'}]},fedexReply(0),fedexReply(-1),fedexReply('12.345'),fedexReply('NaN')];
  const list=fedexReply();list.output.rateReplyDetails[0].ratedShipmentDetails[0].rateType='LIST';responses.push(list);
  const duplicate=fedexReply();duplicate.output.rateReplyDetails.push(duplicate.output.rateReplyDetails[0]);responses.push(duplicate);
  for(const response of responses) {
    const p=createFedexProvider({accountNumber:'000000000',checkEligibility:async()=>true,postRate:async()=>response});
    assert.equal((await service(r,input(r),{provider:p}).quote({})).status,'unavailable');
  }
});
