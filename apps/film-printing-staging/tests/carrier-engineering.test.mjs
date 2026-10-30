import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createEngineeringScope,prepareEngineeringSources} from '../configuration/engineering.mjs';
import {createEngineeringCarrier,ENGINEERING_RATE_CODE} from '../carrier/engineering.mjs';
import {createCarrierServer} from '../carrier/http.mjs';
import {parseCarrierRequest,carrierRates} from '../carrier/contract.mjs';
const material=new URL('../../../.staging/discovery-price-refresh-20261027/material/',import.meta.url);
function fixture(){
 const now=Date.now(),config=JSON.parse(readFileSync(new URL('engineering-config-proposal.json',material))),catalog=JSON.parse(readFileSync(new URL('engineering-catalog-proposal.json',material)));
 const prepared=prepareEngineeringSources({config,catalog,issuedAt:now-1000,until:now+60000});
 const identity={shop:{id:'gid://shopify/Shop/81566597231',myshopifyDomain:'bellows-film-printing-staging.myshopify.com'},currentAppInstallation:{id:'gid://shopify/AppInstallation/1073784553583',app:{id:'gid://shopify/App/436988772353',apiKey:'002722c8effe5d2e3243467181b45833'}}};
 const sourceScope=createEngineeringScope({...prepared,identity,now:()=>now});
 const release=JSON.parse(prepared.releaseValue),signature='b'.repeat(64),job={id:'engineering-job-1',revision:'a'.repeat(64),config_version:release.version,variant_id:'67852705202287',unit_price_cents:40,completed_asset_ids:['asset-1'],copies:2,service:'photo',size:'4x6',paper:'engineering-f06p-paper',lab:'miami',message:'',options:{}};
 const properties={_bfl_flow:'f05',_bfl_job:job.id,_bfl_revision:job.revision,_bfl_config:job.config_version,_bfl_signature:signature,Service:job.service,Sizes:job.size,Paper:job.paper,Location:job.lab,Message:'','Files Uploaded':'1'};
 const origin={country:'US',postal_code:'33127',province:'FL',city:'Miami',address1:'2051 NW 2nd Ave',address2:''};
 const body={rate:{origin,destination:{country:'US',postal_code:'33130',province:'FL',city:'Miami',address1:'101 West Flagler Street',address2:''},items:[{product_id:15620086005871,variant_id:67852705202287,quantity:2,grams:0,price:40,requires_shipping:true,properties}],currency:'USD'}};
 let epoch=1,posts=0;const records=[],bodies=[];
 const jobs={authorityLifecycle:{state:()=>({epoch,pending:0,operation:null})},resolveForCheckout:async(owner,refs)=>{assert.equal(owner,'owner');assert.equal(refs[0].signature,signature);return [job];}};
 const inventory={mode:'test',complete:true,accounts:[{object_id:'37bdc04ea36c4731a2ff2917b1fa836b',test:true,active:true,carrier:'usps',is_shippo_account:true,service_tokens:['usps_ground_advantage']}]};
 let invalidate=false;
 const processCallback=createEngineeringCarrier({sourceScope,jobs,resolveOwner:id=>{assert.equal(id,job.id);return 'owner';},token:'shippo_test_unit',inventory,record:r=>records.push(r),permit:()=>true,now:()=>now,
  fetchImpl:async(url,options)=>{posts++;assert.equal(url,'https://api.goshippo.com/shipments/');const b=JSON.parse(options.body);bodies.push(b);if(invalidate)epoch++;
   return Response.json({status:'SUCCESS',object_id:'shipment1',test:true,metadata:b.metadata,shipment_date:b.shipment_date,messages:[],carrier_accounts:b.carrier_accounts,address_from:{...b.address_from,is_complete:true},address_to:{...b.address_to,is_complete:true},parcels:b.parcels,rates:[{object_id:'rate1',shipment:'shipment1',carrier_account:b.carrier_accounts[0],provider:'USPS',servicelevel:{token:'usps_ground_advantage'},amount:'5.48',currency:'USD',test:true,messages:[]}]});}});
 return {body,records,bodies,processCallback,run:()=>processCallback({callback:parseCarrierRequest(Buffer.from(JSON.stringify(body)))},{signal:new AbortController().signal}),get posts(){return posts;},invalidate(){invalidate=true;}};
}
test('engineering callback uses exact job copies and packing, strict TEST response, and distinguishes its cache',async()=>{
 const f=fixture();const result=await f.run(),wire=carrierRates(result);
 assert.equal(result.packing.groups[0].job.physical_count,2);assert.equal(f.bodies[0].parcels[0].weight,'3.6');assert.equal(f.bodies[0].parcels[0].length,'13');
 assert.equal(wire.rates[0].total_price,'548');assert.equal(wire.rates[0].service_code,ENGINEERING_RATE_CODE);
 await f.run();assert.equal(f.posts,1);assert.equal(f.records.at(-1).event,'carrier_cache_hit');
 assert.ok(!JSON.stringify(f.records).includes('shippo_test_unit'));assert.ok(!JSON.stringify(f.records).includes('_bfl_signature'));
});
test('extra callback metadata cannot override stored packing, price, owner or origin',async()=>{
 const f=fixture();Object.assign(f.body.rate,{trusted:true,owner:'forged',cart_id:'forged',groups:[]});
 Object.assign(f.body.rate.items[0],{sku:null,vendor:null,grams:99999,weight:99999,unit_price:1,owner:'forged'});
 await f.run();assert.equal(f.posts,1);assert.equal(f.bodies[0].parcels[0].weight,'3.6');
 const bad=fixture();bad.body.rate.items[0].price=1;bad.body.rate.items[0].unit_price=40;await assert.rejects(bad.run());assert.equal(bad.posts,0);
});
test('engineering callback rejects wrong destination, origin, copies, reference and price before provider work',async()=>{
 for(const change of [f=>f.body.rate.origin.address1='other',f=>f.body.rate.destination.postal_code='33131',f=>f.body.rate.items[0].quantity=3,f=>f.body.rate.items[0].properties._bfl_signature='c'.repeat(64),f=>f.body.rate.items[0].price=1]){
  const f=fixture();change(f);await assert.rejects(f.run());assert.equal(f.posts,0);
 }
});
test('engineering callback rejects authority invalidation during awaited provider work',async()=>{
 const f=fixture();f.invalidate();await assert.rejects(f.run(),/AUTHORITY_FENCED/);assert.equal(f.records.some(r=>r.event==='carrier_provider_complete'),false);
});
test('private carrier path rejects unauthenticated requests before parsing/provider work',async t=>{
 const f=fixture(),path='/carrier/rates/'+'d'.repeat(64),s=createCarrierServer({enabled:true,callbackPath:path,processCallback:f.processCallback});
 await new Promise(resolve=>s.server.listen(0,'127.0.0.1',resolve));t.after(()=>s.close());const base='http://127.0.0.1:'+s.server.address().port;
 const post=p=>fetch(base+p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(f.body)});
 assert.equal((await post('/carrier/rates')).status,404);assert.equal(f.posts,0);
 const response=await post(path);assert.equal(response.status,200);assert.equal((await response.json()).rates[0].total_price,'548');assert.equal(f.posts,1);
});
