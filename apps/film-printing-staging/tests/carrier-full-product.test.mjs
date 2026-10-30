import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {extendProductCatalog} from '../pricing/product-catalog.mjs';
import {encodeFullProductCatalog} from '../pricing/compact-catalog.mjs';
import {resolveSelection} from '../jobs/selection.mjs';
import {jobProperties} from '../jobs/properties.mjs';
import {fixedEngineeringCarrierContext,quoteFixedEngineeringParcels,FULL_PRODUCT_CARRIER_LIMITS} from '../carrier/full-product.mjs';
import {ENGINEERING_SERVICE,ENGINEERING_RATE_CODE} from '../carrier/engineering.mjs';
import {parseCarrierRequest,carrierRates} from '../carrier/contract.mjs';
import {resolveCarrierReferences} from '../carrier/preparation.mjs';
import {active} from '../../../fixtures/film-printing/f04/synthetic.mjs';

const source=new URL('../../../fixtures/film-printing/f05a/',import.meta.url),form=readFileSync(new URL('metafield-value.json',source),'utf8');
const original=JSON.parse(readFileSync(new URL('proposed/price-catalog.proposed.json',source),'utf8'));
const labs=['Miami','Chicago','Orlando','Atlanta'];
const full=extendProductCatalog({...original,rows:labs.flatMap(label=>original.rows.map(row=>({...row,lab:label.toLowerCase(),lab_input:label})))},form);
const compact=encodeFullProductCatalog(full.catalog,form).catalog,priced={...full.catalog,version:full.version};
// Synthetic identifiers/addresses test only the pure context validator. They
// are never admitted, published, or represented as authenticated lab readback.
const config={labs:labs.map((label,i)=>({id:label.toLowerCase(),enabled:true,location_id:'gid://shopify/Location/999000'+i,
  origin:{address1:'Generated '+label,address2:'',city:label,province_code:i===1?'IL':i===3?'GA':'FL',country_code:'US',postal_code:'33127'}}))};
const destination={address1:'101 West Flagler Street',address2:'',city:'Miami',province_code:'FL',postal_code:'33130',country_code:'US'};
function selection(row,files=1,copies=1){
 const selected=resolveSelection(priced,{service:row.service,size:row.size,paper:row.paper_input,lab:row.lab_input,options:row.options,message:'',copies},{completedFileCount:files});
 return {...selected.spec,id:'full-product-job',revision:'a'.repeat(64),config_version:active.version,
   variant_id:selected.variant_id,unit_price_cents:selected.unit_price_cents,billing_basis:selected.billing_basis,
   completed_asset_ids:Array.from({length:files},(_,i)=>'asset-file-'+i)};
}
const context=job=>({catalog:priced,config,job,callback:{items:[{}],origin:structuredClone(config.labs.find(l=>l.id===job.lab).origin),destination}});
const photo=full.catalog.rows.find(r=>r.service==='photo'&&r.size==='4x6');

test('every fixed size, paper, turnaround and lab validates at file/copy boundaries with exact configured origin',()=>{
 let accepted=0;
 for(const row of full.catalog.rows.filter(r=>r.service!=='darkroom'))for(const [files,copies] of [[1,1],[3,2]]){
  if(row.per_file_cents*files*copies>200000)continue;
  const job=selection(row,files,copies),input=context(job);
  assert.equal(fixedEngineeringCarrierContext(input).id,job.lab);accepted++;
 }
 assert.equal(accepted,1764);
 const packed=context(selection(photo));packed.catalog=compact;assert.equal(fixedEngineeringCarrierContext(packed).id,packed.job.lab);
});

test('forged Custom or Darkroom specifications, prices, absent lab and inconsistent origins fail before quote work',()=>{
 for(const mutate of [x=>{x.job.size_mode='custom';x.job.custom_dimensions={width:4,height:6};},x=>{x.job.service='darkroom';x.job.completed_asset_ids=[];},
  x=>{x.callback.items=Array(21).fill({});},x=>{x.job.unit_price_cents=1;},x=>{x.job.paper='missing';},x=>{x.job.options.Turnaround='free';},
  x=>{x.callback.origin.address1='Other origin';},x=>{x.config.labs[0].enabled=false;},x=>{x.config.labs[0].location_id=x.config.labs[1].location_id;},
  x=>{x.callback.destination.country_code='CA';},x=>{x.callback.destination.province_code='AA';},x=>{x.callback.destination.postal_code='';},
  x=>{delete x.catalog.product_semantics;}]){
  const input=structuredClone(context(selection(photo)));mutate(input);assert.throws(()=>fixedEngineeringCarrierContext(input));
 }
});

function body(parcels=2){return {address_from:{street1:'Generated origin',city:'Miami',state:'FL',zip:'33127',country:'US'},
 address_to:{street1:'Generated destination',city:'Chicago',state:'IL',zip:'60647',country:'US'},shipment_date:'2026-10-31T00:00:00Z',
 carrier_accounts:[ENGINEERING_SERVICE.account_id],async:false,metadata:'bfl:'+'a'.repeat(64),
 parcels:Array.from({length:parcels},(_,i)=>({length:'13',width:'10',height:'2',distance_unit:'in',weight:String(3.5+i/10),mass_unit:'oz'}))};}
function reply(b,index,amount){return {status:'SUCCESS',object_id:'shipment-'+index,test:true,metadata:b.metadata,shipment_date:b.shipment_date,messages:[],
 carrier_accounts:b.carrier_accounts,address_from:{...b.address_from,is_complete:true},address_to:{...b.address_to,is_complete:true},parcels:structuredClone(b.parcels),
 rates:[{object_id:'rate-'+index,shipment:'shipment-'+index,carrier_account:ENGINEERING_SERVICE.account_id,provider:'USPS',
  servicelevel:{token:'usps_ground_advantage'},amount,currency:'USD',test:true,messages:[]}]};}
const quote=(b,postShipment,signal=new AbortController().signal)=>quoteFixedEngineeringParcels({body:b,option:ENGINEERING_SERVICE,postShipment,signal});

test('each parcel gets its own TEST request; only all exact real-response amounts are summed with zero markup',async()=>{
 const b=body(),seen=[];
 const result=await quote(b,async(request,options)=>{seen.push(request);assert.equal(options.mode,'test');assert.equal(request.parcels.length,1);
  const i=Number(request.metadata.split(':p')[1]);return reply(request,i,i===1?'5.48':'8.19');});
 assert.equal(seen.length,2);assert.deepEqual(seen.map(s=>s.parcels[0]),b.parcels);
 assert.equal(result.options[0].total_cents,1367);assert.equal(result.options[0].parcel_quotes.length,2);
 assert.equal(result.options[0].rate_id,undefined);assert.equal(result.options[0].shipment_id,undefined);
 const group={id:'group',lab:'chicago',location_id:'gid://shopify/Location/999'};
 const mapped=carrierRates({status:'available',provider:'shippo',mode:'test',packing:{groups:[group]},quotes:[{group_id:group.id,lab:group.lab,location_id:group.location_id,...result}]});
 assert.equal(mapped.rates[0].total_price,'1367');assert.equal(mapped.rates[0].service_code,ENGINEERING_RATE_CODE);
});

test('partial, wrong-mode, wrong-parcel, wrong-service or duplicate responses never yield an aggregate rate',async()=>{
 for(const mutate of [r=>{r.status='WAITING';},r=>{r.test=false;},r=>{r.parcels[0]={...r.parcels[0],weight:'999'};},
   r=>{r.rates[0].servicelevel.token='usps_priority';},r=>{r.rates[0].amount='5.481';},r=>{r.metadata='other';},
   r=>{r.rates[0].carrier_account='other';},r=>{r.messages=[{code:'failure'}];}]){
  await assert.rejects(quote(body(),async request=>{const index=Number(request.metadata.split(':p')[1]),r=reply(request,index,'5.48');if(index===2)mutate(r);return r;}));
 }
 await assert.rejects(quote(body(),async request=>reply(request,1,'5.48')),/INVALID_SHIPPO_RATE/);
 await assert.rejects(quote(body(),async request=>{if(request.metadata.endsWith('p2'))throw Error('generated provider failure');return reply(request,1,'5.48');}));
});

test('per-parcel test bounds and external cancellation prevent success, without multiplying one rate',async()=>{
 let posts=0;const post=async request=>{posts++;return reply(request,posts,'0.01');};
 const result=await quote(body(FULL_PRODUCT_CARRIER_LIMITS.parcels),post);
 assert.equal(posts,8);assert.equal(result.options[0].total_cents,8);
 await assert.rejects(quote(body(9),post),/CALLBACK_PARCEL_LIMIT/);assert.equal(posts,8);
 const controller=new AbortController();controller.abort();await assert.rejects(quote(body(),post,controller.signal),/QUOTE_CANCELLED/);assert.equal(posts,8);
 const during=new AbortController();await assert.rejects(quote(body(),async request=>{during.abort();return reply(request,1,'5.48');},during.signal),/QUOTE_CANCELLED/);
});

test('schema4 fixed callback claims survive parser and stored-job comparison; extra or changed claims reject',async()=>{
 const job=selection(photo),signature='b'.repeat(64),reference={id:job.id,revision:job.revision,config_version:job.config_version,signature};
 const addr=a=>({country:a.country_code,postal_code:a.postal_code,province:a.province_code,city:a.city,address1:a.address1,address2:a.address2});
 const b={rate:{origin:addr(context(job).callback.origin),destination:addr(destination),currency:'USD',items:[{product_id:15620086005871,variant_id:67852705202287,
   requires_shipping:true,quantity:1,price:job.unit_price_cents,properties:jobProperties(job,reference)}]}};
 const jobs={authorityLifecycle:{state:()=>({epoch:1,pending:0,operation:null})},resolveForCheckout:async(owner,refs)=>{assert.equal(owner,'server-owner');assert.deepEqual(refs,[reference]);return [job];}};
 const run=value=>resolveCarrierReferences({callback:parseCarrierRequest(Buffer.from(JSON.stringify(value))),owner:'server-owner',jobs,release:active,signal:new AbortController().signal});
 assert.equal((await run(b)).jobs[0].size_mode,'fixed');
 for(const [key,value] of [['_bfl_size_mode','custom'],['Custom Width','4'],['Process','Color'],['Scanning Options','Yes'],['Negatives','Mail In']]){
  const changed=structuredClone(b);changed.rate.items[0].properties[key]=value;await assert.rejects(run(changed),/SPECIFICATION_MISMATCH/);
 }
 const unknown=structuredClone(b);unknown.rate.items[0].properties._bfl_trusted='yes';assert.throws(()=>parseCarrierRequest(Buffer.from(JSON.stringify(unknown))),/CALLBACK_REFERENCE/);
});
