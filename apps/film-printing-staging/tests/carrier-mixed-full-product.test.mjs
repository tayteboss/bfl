import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareEngineeringSources,createEngineeringScope,bindEngineeringCustomerJob} from '../configuration/engineering.mjs';
import {decodeCatalog} from '../checkout/shopify.mjs';
import {expandFullProductCatalog} from '../pricing/compact-catalog.mjs';
import {freeze} from '../configuration/config.mjs';
import {createJobStore,createJobService} from '../jobs/service.mjs';
import {jobEligibility} from '../checkout/job-eligibility.mjs';
import {quantitySignature} from '../checkout/quantity-signature.js';
import {createEngineeringCarrier,ENGINEERING_SERVICE,ENGINEERING_RATE_CODE} from '../carrier/engineering.mjs';
import {parseCarrierRequest,carrierRates} from '../carrier/contract.mjs';
import {resolveEngineeringPackingJob,packEngineeringCallback,ESTIMATED_PACKING_POLICY} from '../shipping/full-product.mjs';
import {mockAdmin} from '../../../fixtures/film-printing/f06d/mock-admin.mjs';

const standard='Standard (4-5 days)',border='Borderless (Edge-to-edge)';
const photo={service:'Photo Prints',size:'4” × 6”',paper:null,lab:'Chicago',options:{Turnaround:standard}};
const fine={service:'Fine Arts',size:'16” × 20”',paper:'Luster',lab:'Chicago',options:{Borders:border,Turnaround:standard}};
const dark=size=>({service:'Darkroom Prints',size,paper:'RC Matte',lab:'Chicago',options:{Process:'Color',Borders:border,Turnaround:standard,
  ...(['8x10','11x14'].includes(size)?{'Scanning Options':'Yes'}:{}),Negatives:'Mail In'}});
const address=a=>({country:a.country_code,postal_code:a.postal_code,province:a.province_code,city:a.city,address1:a.address1,address2:a.address2});
async function fixture(t){
 const read=name=>JSON.parse(readFileSync(new URL('../../../fixtures/film-printing/full-product-readiness-20261030/'+name,import.meta.url)));
 let time=1000;
 const prepared=prepareEngineeringSources({config:read('engineering-config-proposal.json'),catalog:read('engineering-catalog-proposal.json'),issuedAt:time,until:3601000});
 const sourceScope=createEngineeringScope({...prepared,identity:mockAdmin().data,now:()=>time}),release=JSON.parse(prepared.releaseValue),catalog=decodeCatalog(prepared.catalogValue);
 const dir=mkdtempSync(join(tmpdir(),'bfl-mixed-carrier-')),store=createJobStore(join(dir,'jobs.sqlite'));
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 for(let i=1;i<=3;i++)store.recordUpload('owner',{id:'synthetic-complete-'+i,state:'complete',verified:true,url:'https://fixture.invalid/nonpersonal-'+i+'.png'});
 const jobs=createJobService({store,loader:{load:async()=>release},loadCatalog:async()=>catalog,secret:'local-only-mixed-carrier-secret-32bytes',sourceScope,
  beforeSave:(owner,input,job)=>bindEngineeringCustomerJob(sourceScope,owner,input.asset_ids,input.copies,job,64)});
 const owners=new Map(),records=[],bodies=[];let sequence=0,mutate=()=>{},permit=true,resolution=(owner,refs,r)=>jobs.resolveForCheckout(owner,refs,r);
 const carrierJobs={authorityLifecycle:jobs.authorityLifecycle,resolveForCheckout:(...args)=>resolution(...args)};
 const process=createEngineeringCarrier({sourceScope,jobs:carrierJobs,resolveOwner:id=>owners.get(id),token:'shippo_test_unit',
  inventory:{mode:'test',complete:true,accounts:[{object_id:ENGINEERING_SERVICE.account_id,test:true,active:true,carrier:'usps',is_shippo_account:true,service_tokens:[ENGINEERING_SERVICE.service_token]}]},
  record:r=>records.push(r),permit:()=>permit,now:()=>time,fetchImpl:async(url,options)=>{
   assert.equal(url,'https://api.goshippo.com/shipments/');const body=JSON.parse(options.body);bodies.push(body);const n=bodies.length;
   const reply={status:'SUCCESS',object_id:'shipment-'+n,test:true,metadata:body.metadata,shipment_date:body.shipment_date,messages:[],carrier_accounts:body.carrier_accounts,
    address_from:{...body.address_from,is_complete:true},address_to:{...body.address_to,is_complete:true},parcels:structuredClone(body.parcels),rates:[{object_id:'rate-'+n,shipment:'shipment-'+n,
     carrier_account:ENGINEERING_SERVICE.account_id,provider:'USPS',servicelevel:{token:ENGINEERING_SERVICE.service_token},amount:n%2?'5.48':'8.19',currency:'USD',test:true,messages:[]}]};
   await mutate(reply,body,n);return Response.json(reply);
  }});
 return {sourceScope,release,catalog,jobs,owners,records,bodies,
  async add(selection,{files=1,copies=1}={}){
   const result=await jobs.prepare('owner',{...selection,copies,message:'',asset_ids:selection.service==='Darkroom Prints'?[]:Array.from({length:files},(_,i)=>'synthetic-complete-'+(i+1)),request_key:'mixed-carrier-'+(++sequence)});
   owners.set(result.reference.id,'owner');const job=await jobs.resolve('owner',result.reference);
   return {job,reference:result.reference,line:{product_id:15620086005871,variant_id:67852705202287,quantity:copies,price:job.unit_price_cents,requires_shipping:true,
     properties:{...result.item.properties,_bfl_signature:quantitySignature(result.reference.signature,copies)}}};
  },
  body(items,lab='chicago'){
   return {rate:{currency:'USD',origin:address(release.config.labs.find(l=>l.id===lab).origin),destination:{country:'US',postal_code:'60647',province:'IL',city:'Chicago',address1:'2047 N Milwaukee Avenue',address2:''},items:items.map(i=>structuredClone(i.line))}};
  },
  async run(body){return process({callback:parseCarrierRequest(Buffer.from(JSON.stringify(body)))},{signal:new AbortController().signal});},
  mutate(fn){mutate=fn;},expire(){time=3601000;},deny(){permit=false;},resolve(fn){resolution=fn;}
 };
}

test('authenticated same-lab jobs retain separate capacity/asset/copy parcels and sum every actual quote',async t=>{
 const f=await fixture(t),a=await f.add(photo,{files:2,copies:2}),b=await f.add(fine,{files:1,copies:4});
 const body=f.body([a,b]);Object.assign(body.rate.items[0],{grams:99999,owner:'forged',weight:99999});
 const result=await f.run(body),wire=carrierRates(result);
 assert.equal(f.bodies.length,3);assert.deepEqual(f.bodies.map(b=>b.parcels[0].weight),['1.4','16','12']);
 assert.ok(f.bodies.every(b=>b.parcels.length===1));assert.equal(wire.rates[0].total_price,'1915');assert.equal(wire.rates[0].service_code,ENGINEERING_RATE_CODE);
 assert.equal(result.packing.groups.length,1);assert.equal(result.packing.parcel_groups.length,2);
 assert.deepEqual(result.packing.parcel_groups.map(g=>g.job.physical_count),[4,4]);
 assert.deepEqual(result.packing.groups[0].parcels.map(p=>[p.sequence,p.job_id,p.print_count]),[[1,a.job.id,4],[2,b.job.id,3],[3,b.job.id,1]]);
 assert.equal(result.quotes[0].options[0].parcel_quotes.length,3);
 await f.run(body);assert.equal(f.bodies.length,3);assert.equal(f.records.at(-1).event,'carrier_cache_hit');
 assert.ok(!JSON.stringify(f.records).includes('shippo_test_unit'));assert.ok(!JSON.stringify(f.records).includes(a.reference.signature));
 body.rate.items[0].quantity=3;body.rate.items[0].properties._bfl_signature=quantitySignature(a.reference.signature,3);
 const changed=await f.run(body);assert.equal(changed.packing.parcel_groups[0].job.physical_count,6);assert.equal(f.bodies[3].parcels[0].weight,'1.6');
});

test('each cross-lab callback quotes only its authenticated subset with that exact lab origin',async t=>{
 const f=await fixture(t),a=await f.add(photo),b=await f.add({...fine,lab:'Miami'});
 const chicago=await f.run(f.body([a],'chicago')),miami=await f.run(f.body([b],'miami'));
 assert.equal(chicago.quotes[0].lab,'chicago');assert.equal(miami.quotes[0].lab,'miami');assert.equal(f.bodies.length,2);
 assert.equal(f.bodies[0].address_from.street1,f.release.config.labs.find(l=>l.id==='chicago').origin.address1);
 assert.equal(f.bodies[1].address_from.street1,f.release.config.labs.find(l=>l.id==='miami').origin.address1);
 await assert.rejects(f.run(f.body([a,b],'chicago')),/CALLBACK_ORIGIN_MISMATCH/);
 await assert.rejects(f.run(f.body([a],'miami')),/CALLBACK_ORIGIN_MISMATCH/);assert.equal(f.bodies.length,2);
});

test('Darkroom exact sizes use copies without fabricated uploads and mix with fixed jobs as separate parcels',async t=>{
 const f=await fixture(t),items=[];
 for(const [size,weight] of [['8x10',.4],['11x14',1.5],['16x20',2]]){
  const d=await f.add(dark(size),{copies:4});items.push(d);
  assert.deepEqual(d.job.completed_asset_ids,[]);assert.equal(jobEligibility(f.release,f.catalog,d.job,{sourceScope:f.sourceScope}).shipping_eligible,true);
  const p=resolveEngineeringPackingJob(f.release,d.job,{sourceScope:f.sourceScope});
  assert.equal(p.job.physical_count,4);assert.equal(p.job.file_count,0);assert.equal(p.rule.print_weight_oz,weight);
 }
 items.push(await f.add(photo));const result=await f.run(f.body(items));
 assert.deepEqual(result.packing.parcel_groups.map(g=>g.job.physical_count),[4,4,4,1]);
 assert.deepEqual(f.bodies.map(b=>b.parcels[0].weight),['1.1','4.6','9.5','6.5','16','12']);
 assert.equal(carrierRates(result).rates[0].total_price,'4101');
 assert.throws(()=>resolveEngineeringPackingJob(f.release,items[0].job),/ENGINEERING_SCOPE/);
});

test('approved Custom and12x16 estimates quote complete parcels while forged zero-upload claims still fail',async t=>{
 const f=await fixture(t),a=await f.add(photo),custom=await f.add({...fine,size:'Custom',size_mode:'custom',custom_dimensions:{width:16,height:20},paper:'Fibre Paper'}),d=await f.add(dark('12x16'));
 for(const [estimated,weight] of [[custom,'13.2'],[d,'12']]){
  assert.equal(jobEligibility(f.release,f.catalog,estimated.job,{sourceScope:f.sourceScope}).shipping_eligible,true);
  const result=await f.run(f.body([a,estimated]));assert.equal(carrierRates(result).rates[0].total_price,'1367');
  assert.equal(f.bodies.at(-1).parcels[0].weight,weight);
 }
 const known=await f.add(dark('8x10')),bad=f.body([a,known]);bad.rate.items[1].properties['Files Uploaded']='1';
 await assert.rejects(f.run(bad),/SPECIFICATION_MISMATCH/);assert.equal(f.bodies.length,4);
});

test('every mixed reference must retain owner, immutable claims, price, file count and quantity signature',async t=>{
 const f=await fixture(t),a=await f.add(photo,{files:2,copies:2}),b=await f.add(fine),base=f.body([a,b]);
 for(const change of [b=>b.rate.items[1].price=1,b=>b.rate.items[0].properties['Files Uploaded']='1',b=>b.rate.items[1].properties.Location='miami',
  b=>b.rate.items[0].quantity=3,b=>b.rate.items[1].properties._bfl_signature='c'.repeat(64)]){
  const bad=structuredClone(base);change(bad);await assert.rejects(f.run(bad));
 }
 f.owners.set(b.job.id,'other-owner');await assert.rejects(f.run(base),/CALLBACK_OWNER_UNAVAILABLE/);f.owners.set(b.job.id,'owner');
 f.resolve(()=>f.jobs.resolveForCheckout('other-owner',[a.reference,b.reference],f.release));await assert.rejects(f.run(base),/JOB_UNAVAILABLE/);
 assert.equal(f.bodies.length,0);
});

test('incomplete or reordered internal resolution cannot silently omit or misbind a callback job',async t=>{
 const f=await fixture(t),a=await f.add(photo),b=await f.add(fine),body=f.body([a,b]);
 for(const resolved of [[a.job],[b.job,a.job]]){
  f.resolve(async()=>resolved);await assert.rejects(f.run(body),/CALLBACK_INCOMPLETE_JOBS/);
 }
 assert.equal(f.bodies.length,0);
});

test('mixed parcel count and provider budget are reserved for the complete quote before any request',async t=>{
 const f=await fixture(t),a=await f.add(photo,{copies:161}),b=await f.add(photo,{copies:161});
 await assert.rejects(f.run(f.body([a,b])),/CALLBACK_PARCEL_LIMIT/);assert.equal(f.bodies.length,0);
 const c=await f.add(photo,{copies:141}),d=await f.add(photo,{copies:141});
 for(let i=0;i<4;i++){
  const body=f.body([c,d]);body.rate.destination.address2='Fixture '+i;
  assert.equal(carrierRates(await f.run(body)).rates.length,1);
 }
 assert.equal(f.bodies.length,32);const last=f.body([c,d]);last.rate.destination.address2='Budget exceeded';
 await assert.rejects(f.run(last),/CALLBACK_PROVIDER_LIMIT/);assert.equal(f.bodies.length,32);
});

test('any parcel failure, source expiry or authority change prevents a complete mixed rate and cache entry',async t=>{
 for(const failure of ['provider','expiry','authority']){
  const f=await fixture(t),a=await f.add(photo),b=await f.add(fine);
  f.mutate(async(reply,body,n)=>{
   if(n===2){if(failure==='provider')reply.rates[0].servicelevel.token='usps_priority';
    if(failure==='expiry')f.expire();if(failure==='authority')f.jobs.authorityLifecycle.startRecovery();}
  });
  await assert.rejects(f.run(f.body([a,b])));assert.equal(f.bodies.length,2);
  assert.equal(f.records.some(r=>r.event==='carrier_provider_complete'||r.event==='carrier_cache_hit'),false);
 }
});


test('only deeply frozen verified compact catalogs reuse expansion; mutable descendants are revalidated',()=>{
 const source=JSON.parse(readFileSync(new URL('../../../fixtures/film-printing/full-product-readiness-20261030/engineering-catalog-proposal.json',import.meta.url)));
 const immutable=freeze(structuredClone(source));assert.strictEqual(expandFullProductCatalog(immutable),expandFullProductCatalog(immutable));
 const shallow=Object.freeze(structuredClone(source));expandFullProductCatalog(shallow);shallow.labs[0].lab='forged';
 assert.throws(()=>expandFullProductCatalog(shallow),/PRICE_UNAVAILABLE/);
 const mutable=structuredClone(source);assert.notStrictEqual(expandFullProductCatalog(mutable),expandFullProductCatalog(mutable));
 mutable.expanded_sha256='0'.repeat(64);assert.throws(()=>expandFullProductCatalog(mutable),/CATALOG_EXPANSION_MISMATCH/);
});

const custom=(width,height)=>({...fine,size:'Custom',size_mode:'custom',custom_dimensions:{width,height},paper:'Fibre Paper'});
const packed=(f,items)=>packEngineeringCallback(f.release,{jobs:items.map(item=>item.job),group:{id:'packing-test',lab:'chicago',location_id:f.release.config.labs.find(l=>l.id==='chicago').location_id,job_ids:items.map(item=>item.job.id)}},{sourceScope:f.sourceScope});

test('every fixed size keeps its exact observed per-print weight, package and full-package count',async t=>{
 const f=await fixture(t);
 const rows=[['3.5x5',.1,40,'pkg-1'],['4x6',.1,40,'pkg-1'],['5x7',.3,40,'pkg-1'],['8x10',.4,20,'pkg-2'],['8x12',.5,20,'pkg-2'],
  ['11x14',1.5,3,'pkg-3'],['16x20',2,3,'pkg-4'],['20x24',3,3,'pkg-4'],['20x30',4,3,'pkg-4'],['24x30',4.5,3,'pkg-5'],['30x40',6,3,'pkg-5'],['40x50',12,4,'pkg-6'],['44x60',16,4,'pkg-6']];
 const gross={'pkg-1':13,'pkg-2':13,'pkg-3':9.5,'pkg-4':22,'pkg-5':34,'pkg-6':128};
 for(const [size,weight,capacity,packageId] of rows){
  const selection={...(packageId==='pkg-1'||packageId==='pkg-2'?photo:{...fine,paper:'Fibre Paper'}),size};
  const item=await f.add(selection,{copies:capacity+1}),selected=resolveEngineeringPackingJob(f.release,item.job,{sourceScope:f.sourceScope}),result=packed(f,[item]);
  assert.equal(selected.rule.print_weight_oz,weight,size);assert.equal(selected.rule.capacity,capacity,size);assert.equal(selected.pkg.id,packageId,size);
  assert.deepEqual(result.groups[0].parcels.map(p=>p.print_count),[capacity,1],size);
  assert.ok(result.groups[0].parcels.every(p=>p.print_weight_oz===weight&&p.max_packed_weight_oz===gross[packageId]),size);
 }
});

test('missing weights round upward and preserve entered width through promotion into existing tubes',async t=>{
 const f=await fixture(t);
 const rows=[[1,300,3,'pkg-4'],[1,301,3.1,'pkg-4'],[24,1,.3,'pkg-4'],[25,1,.3,'pkg-5'],[36,1,.4,'pkg-5'],[37,1,.4,'pkg-6'],
  [24,60,14.4,'pkg-5'],[36,60,21.6,'pkg-6'],[44,60,26.4,'pkg-6'],[44,145,63.8,'pkg-6']];
 for(const [width,height,weight,packageId] of rows){
  const item=await f.add(custom(width,height)),selected=resolveEngineeringPackingJob(f.release,item.job,{sourceScope:f.sourceScope});
  assert.equal(selected.rule.print_weight_oz,weight,`${width}x${height}`);assert.equal(selected.pkg.id,packageId,`${width}x${height}`);assert.equal(selected.rule.weight_status,'estimated');
  assert.equal(selected.rule.estimate_policy,ESTIMATED_PACKING_POLICY);assert.equal(jobEligibility(f.release,f.catalog,item.job,{sourceScope:f.sourceScope}).shipping_eligible,true);
 }
 const item=await f.add(custom(44,146));assert.equal(jobEligibility(f.release,f.catalog,item.job,{sourceScope:f.sourceScope}).shipping_eligible,false);
 await assert.rejects(f.run(f.body([item])),/ENGINEERING_PRINT_TOO_HEAVY/);assert.equal(f.bodies.length,0);
 const invalid={...item.job,custom_dimensions:{width:45,height:146}};assert.throws(()=>resolveEngineeringPackingJob(f.release,invalid,{sourceScope:f.sourceScope}));
});

test('same-package different jobs and Darkroom share one tare with an exact complete constituent manifest',async t=>{
 const f=await fixture(t),a=await f.add(fine),b=await f.add({...fine,size:'20x24'}),d=await f.add(dark('12x16'));
 const result=await f.run(f.body([a,b,d])),parcel=result.packing.groups[0].parcels[0];
 assert.equal(f.bodies.length,1);assert.equal(f.bodies[0].parcels[0].weight,'17');assert.equal(parcel.print_count,3);assert.equal(parcel.tare_weight_oz,10);
 assert.equal(carrierRates(result).rates[0].total_price,'548');assert.equal(result.packing.estimate_policy,ESTIMATED_PACKING_POLICY);
 assert.deepEqual(new Map(parcel.contents.map(c=>[c.job_id,c.print_count])),new Map([[a.job.id,1],[b.job.id,1],[d.job.id,1]]));
 assert.equal(d.job.completed_asset_ids.length,0);assert.deepEqual(result.packing.parcel_groups.map(g=>g.parcel_sequences),[[1],[1],[1]]);
 assert.deepEqual(packed(f,[d,b,a]).groups[0].parcels,result.packing.groups[0].parcels);
});

test('combined count limit splits across jobs without changing any physical count or adding a second tare prematurely',async t=>{
 const f=await fixture(t),a=await f.add(fine,{copies:2}),b=await f.add(dark('12x16'),{copies:2});
 const result=await f.run(f.body([a,b])),parcels=result.packing.groups[0].parcels;
 assert.deepEqual(parcels.map(p=>[p.print_count,p.weight_oz]),[[3,16],[1,12]]);
 for(const item of [a,b])assert.equal(parcels.flatMap(p=>p.contents).filter(c=>c.job_id===item.job.id).reduce((sum,c)=>sum+c.print_count,0),2);
 assert.equal(f.bodies.length,2);assert.equal(carrierRates(result).rates[0].total_price,'1367');
});

test('weight ceiling splits below the count limit and never divides an individual Custom print',async t=>{
 const f=await fixture(t),a=await f.add(custom(24,48)),b=await f.add(fine,{copies:2});
 const mixed=await f.run(f.body([a,b]));assert.deepEqual(mixed.packing.groups[0].parcels.map(p=>[p.print_count,p.weight_oz]),[[1,21.6],[2,14]]);
 const large=await f.add(custom(44,60),{copies:3});const result=await f.run(f.body([large]));
 assert.deepEqual(result.packing.groups[0].parcels.map(p=>[p.print_count,p.weight_oz]),[[2,116.8],[1,90.4]]);
 assert.ok(result.packing.groups[0].parcels.every(p=>p.dimensions_in.length===60&&p.max_packed_weight_oz===128));
 assert.equal(f.bodies.length,4);
});

test('same-package small photos combine across sizes and preserve files times copies',async t=>{
 const f=await fixture(t),a=await f.add({...photo,size:'3.5x5'},{files:2,copies:10}),b=await f.add({...photo,size:'5x7'},{copies:20});
 const result=await f.run(f.body([a,b]));assert.equal(f.bodies.length,1);assert.equal(f.bodies[0].parcels[0].weight,'9');
 assert.equal(result.packing.groups[0].parcels[0].print_count,40);assert.deepEqual(result.packing.parcel_groups.map(g=>g.job.physical_count),[20,20]);
});
