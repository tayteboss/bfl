// Finite TEST-only composition. No production route or merchant eligibility claim.
import {createHash} from 'node:crypto';
import {canonical,digest,freeze} from '../configuration/config.mjs';
import {assertEngineeringScope} from '../configuration/engineering.mjs';
import {packDeliveryGroups,requireValue as need} from '../shipping/packing.mjs';
import {packEngineeringCallback} from '../shipping/full-product.mjs';
import {createShippoTransport,decodeShippoResponse} from '../shipping/shippo.mjs';
import {resolveCarrierReferences} from './preparation.mjs';
import {isFullProductCatalog} from '../jobs/selection.mjs';
import {FULL_PRODUCT_CARRIER_LIMITS,fixedEngineeringCarrierContext,quoteFixedEngineeringParcels} from './full-product.mjs';

export const ENGINEERING_SERVICE=Object.freeze({carrier:'USPS',account_id:'37bdc04ea36c4731a2ff2917b1fa836b',service_token:'usps_ground_advantage'});
export const ENGINEERING_RATE_CODE='BFL_SHIPPO_'+createHash('sha256').update('shippo:test:'+ENGINEERING_SERVICE.account_id+':'+ENGINEERING_SERVICE.service_token).digest('hex');
const address=a=>({street1:a.address1,street2:a.address2,city:a.city,state:a.province_code,zip:a.postal_code,country:a.country_code});
// D1 is an approved nonpersonal engineering destination, not a shipment order.
const destination={address1:'101 West Flagler Street',address2:'',city:'Miami',province_code:'FL',postal_code:'33130',country_code:'US'};
export function createEngineeringCarrier({sourceScope,jobs,resolveOwner,token,inventory,record,permit,now=Date.now,fetchImpl=fetch}) {
 const admitted=assertEngineeringScope(sourceScope),fullProduct=isFullProductCatalog(admitted.catalog);
 const persistent=admitted.contract.kind==='persistent_staging';
 const limits=fullProduct?FULL_PRODUCT_CARRIER_LIMITS:{requests:12,provider_calls:2};
 const option=ENGINEERING_SERVICE;
 need(inventory?.mode==='test'&&inventory.complete===true&&inventory.accounts.some(a=>a.object_id===option.account_id&&a.test===true&&a.active===true&&a.carrier==='usps'&&a.is_shippo_account===true&&a.service_tokens.includes(option.service_token)),'ENGINEERING_TEST_ACCOUNT');
 need(typeof record==='function'&&typeof permit==='function'&&typeof resolveOwner==='function','CALLBACK_DEPENDENCY');
 const transport=createShippoTransport({enabled:true,mode:'test',token,fetchImpl});
 const cache=new Map();let calls=0,requests=0,windowStarted=now();
 return async({callback},{signal})=>{
  need(!signal.aborted&&permit(),'ENGINEERING_EXPIRED');
  const {release,catalog}=assertEngineeringScope(sourceScope),ticket=jobs.authorityLifecycle.state();
  if(persistent&&now()-windowStarted>=60000){calls=0;requests=0;windowStarted=now();}
  if(persistent)for(const [key,row] of cache)if(row.expires<=now())cache.delete(key);
  need(!ticket.pending&&!ticket.operation&&++requests<=limits.requests,'CALLBACK_LIMIT');
  if(fullProduct)need(callback.items.length>0&&callback.items.length<=20,'ENGINEERING_SHIPPING_UNAVAILABLE');
  else need(callback.items.length===1&&canonical(callback.destination)===canonical(destination),'ENGINEERING_DESTINATION');
  const owner=resolveOwner(callback.items[0].reference.id);
  if(fullProduct)need(typeof owner==='string'&&owner.length>0&&callback.items.every(item=>resolveOwner(item.reference.id)===owner),'CALLBACK_OWNER_UNAVAILABLE');
  const resolved=await resolveCarrierReferences({callback,owner,jobs,release,signal,sourceScope});
  const job=resolved.jobs[0],lab=fullProduct?fixedEngineeringCarrierContext({catalog,config:release.config,callback,job}):release.config.labs.find(l=>l.id===job.lab);
  // Location comes from immutable job/config and Function routing. Address equality
  // is only a consistency check and never identifies a location.
  if(!fullProduct){
   need(lab?.id==='miami'&&lab.location_id==='gid://shopify/Location/92443803759'&&canonical(callback.origin)===canonical(lab.origin),'CALLBACK_ORIGIN_MISMATCH');
   need(job.copies===2&&job.completed_asset_ids.length===1,'ENGINEERING_COPIES');
  }
  if(fullProduct)for(const item of resolved.jobs.slice(1)){
   const itemLab=fixedEngineeringCarrierContext({catalog,config:release.config,callback,job:item});
   need(itemLab.id===lab.id&&itemLab.location_id===lab.location_id,'CALLBACK_ORIGIN_MISMATCH');
  }
  const group={id:'quote-'+callback.body_sha256.slice(0,24),lab:job.lab,location_id:lab.location_id,job_ids:[job.id]};
  const packing=fullProduct?packEngineeringCallback(release,{jobs:resolved.jobs,group:{...group,job_ids:resolved.jobs.map(j=>j.id)}},{sourceScope}):
   packDeliveryGroups(release,{jobs:[job],groups:[group]},{sourceScope});
  const current=jobs.authorityLifecycle.state();
  need(!signal.aborted&&permit()&&current.epoch===ticket.epoch&&!current.pending&&!current.operation,'AUTHORITY_FENCED');
  const key=digest({epoch:ticket.epoch,origin:callback.origin,destination:callback.destination,items:callback.items});
  if(cache.has(key)){record({event:'carrier_cache_hit',request_sha256:callback.body_sha256,quote_key:key,epoch:ticket.epoch});return persistent?cache.get(key).result:cache.get(key);}
  const shipment=packing.groups[0],postCount=fullProduct?shipment.parcels.length:1;
  need(!fullProduct||postCount<=limits.parcels,'CALLBACK_PARCEL_LIMIT');
  need(calls+postCount<=limits.provider_calls,'CALLBACK_PROVIDER_LIMIT');
  calls+=postCount; // Reserve the complete all-or-nothing quote before any await.
  const body={address_from:{...address(callback.origin),name:'F06P Engineering Test'},address_to:{...address(callback.destination),name:'F06P Engineering Test'},
   shipment_date:new Date(now()+86400000).toISOString().replace(/\.\d{3}Z$/,'Z'),carrier_accounts:[option.account_id],async:false,
   metadata:'bfl:'+key,parcels:shipment.parcels.map(p=>({length:String(p.dimensions_in.length),width:String(p.dimensions_in.width),height:String(p.dimensions_in.height),distance_unit:'in',weight:String(p.weight_oz),mass_unit:'oz'}))};
  record({event:'carrier_provider_started',request_sha256:callback.body_sha256,quote_key:key,epoch:ticket.epoch,group:group.id,lab:job.lab,location_id:lab.location_id,config_version:job.config_version,...(resolved.jobs.length===1?{job_sha256:digest(job.id),copies:job.copies,file_count:job.completed_asset_ids.length,physical_count:shipment.job.physical_count}:{jobs:packing.parcel_groups.map(g=>({job_sha256:digest(g.job.id),copies:g.job.copies,file_count:g.job.file_count,physical_count:g.job.physical_count}))}),parcels:body.parcels,destination:fullProduct?'US_TEST':'D1',application_bearer:true,shopify_body_signature:false,test:true});
  let response,rate;
  if(fullProduct){
   rate=await quoteFixedEngineeringParcels({body,option,signal,postShipment:async(request,options)=>{
    const current=jobs.authorityLifecycle.state();
    need(permit()&&current.epoch===ticket.epoch&&!current.pending&&!current.operation,'AUTHORITY_FENCED');
    assertEngineeringScope(sourceScope);
    return transport(request,options);
   }});
  }else{response=await transport(body,{signal,mode:'test'});rate=decodeShippoResponse(response,{body,eligible:[option],mode:'test'});}
  const after=jobs.authorityLifecycle.state();
  need(!signal.aborted&&permit()&&after.epoch===ticket.epoch&&!after.pending&&!after.operation,'AUTHORITY_FENCED');assertEngineeringScope(sourceScope);
  const result=freeze({status:'available',provider:'shippo',mode:'test',packing,quotes:[{group_id:group.id,lab:job.lab,location_id:lab.location_id,options:rate.options}],checkout_ready:false});
  if(persistent&&cache.size>=256)cache.delete(cache.keys().next().value);
  cache.set(key,persistent?{result,expires:now()+300000}:result);
  record({event:'carrier_provider_complete',request_sha256:callback.body_sha256,quote_key:key,test:true,status:'SUCCESS',...(fullProduct?{parcel_quotes:rate.options[0].parcel_quotes.map(q=>({parcel:q.parcel,shipment_id:q.shipment_id,rate_id:q.rate_id,total_cents:q.total_cents}))}:{shipment_id:response.object_id}),rates:rate.options.map(o=>({service:o.service,total_cents:o.total_cents,currency:o.currency,...(o.rate_id?{rate_id:o.rate_id}:{})})),service_code:ENGINEERING_RATE_CODE});
  return result;
 };
}
