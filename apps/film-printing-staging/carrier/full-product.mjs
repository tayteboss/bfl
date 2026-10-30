// Pure helpers for the finite, privately source-pinned engineering carrier.
// Neither helper authenticates a callback or creates an admitted source scope.
import {canonical,freeze} from '../configuration/config.mjs';
import {engineeringJobSpecification} from '../configuration/engineering-job.mjs';
import {isFullProductCatalog} from '../jobs/selection.mjs';
import {requireValue as need} from '../shipping/packing.mjs';
import {decodeShippoResponse} from '../shipping/shippo.mjs';

// Resource bounds for a finite staging test, not merchant packing policy.
export const FULL_PRODUCT_CARRIER_LIMITS=Object.freeze({requests:64,provider_calls:32,parcels:8});
const labs=['miami','chicago','orlando','atlanta'];
const states=new Set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' '));
export function fixedEngineeringCarrierContext({catalog,config,callback,job}){
  need(isFullProductCatalog(catalog)&&callback.items.length>0&&callback.items.length<=20&&
    ['photo','fine_art','darkroom'].includes(job.service)&&
    (job.size_mode==='fixed'&&job.custom_dimensions===null||job.size_mode==='custom'&&job.service==='fine_art')&&
    (job.service==='darkroom'?['8x10','11x14','12x16','16x20'].includes(job.size)&&job.billing_basis==='specification'&&job.completed_asset_ids.length===0:job.billing_basis==='completed_files'),'ENGINEERING_SHIPPING_UNAVAILABLE');
  engineeringJobSpecification(catalog,job,job.completed_asset_ids.length,{requireBillingBasis:true});
  need(config.labs.length===4&&labs.every(id=>config.labs.filter(l=>l.id===id&&l.enabled).length===1)&&
    new Set(config.labs.map(l=>l.location_id)).size===4,'CALLBACK_ORIGIN_MISMATCH');
  const lab=config.labs.find(l=>l.id===job.lab);
  // The private exact config pin establishes which observed location/origin is
  // permitted. A callback address only checks consistency; it cannot select one.
  need(lab&&/^gid:\/\/shopify\/Location\/[1-9]\d*$/.test(lab.location_id)&&
    canonical(callback.origin)===canonical(lab.origin),'CALLBACK_ORIGIN_MISMATCH');
  const d=callback.destination;
  need(d?.country_code==='US'&&states.has(d.province_code)&&/^\d{5}(?:-\d{4})?$/.test(d.postal_code)&&
    ['address1','city'].every(k=>typeof d[k]==='string'&&d[k].trim().length>0)&&typeof d.address2==='string','ENGINEERING_DESTINATION');
  return lab;
}

// USPS has no multi-piece shipment rates. Quote every actual packed parcel;
// never extrapolate a rate or combine different services. Caller supplies the
// authenticated transport with its session budget and epoch/expiry checks.
export async function quoteFixedEngineeringParcels({body,option,postShipment,signal}){
  need(Array.isArray(body.parcels)&&body.parcels.length>0&&body.parcels.length<=FULL_PRODUCT_CARRIER_LIMITS.parcels,'CALLBACK_PARCEL_LIMIT');
  need(option.carrier==='USPS'&&option.service_token==='usps_ground_advantage'&&typeof postShipment==='function','ENGINEERING_TEST_ACCOUNT');
  need(!signal.aborted,'QUOTE_CANCELLED');
  const child=new AbortController(),combined=AbortSignal.any([signal,child.signal]);
  const results=await Promise.allSettled(body.parcels.map(async(parcel,index)=>{
    const request={...body,metadata:body.metadata+':p'+(index+1),parcels:[parcel]};
    try{
      need(!combined.aborted,'QUOTE_CANCELLED');
      const response=await postShipment(request,{signal:combined,mode:'test'});
      need(!combined.aborted,'QUOTE_CANCELLED');
      const decoded=decodeShippoResponse(response,{body:request,eligible:[option],mode:'test'});
      need(decoded.options.length===1,'INCOMPLETE_SHIPPO_RESPONSE');
      return {parcel:index+1,...decoded.options[0]};
    }catch(error){child.abort();throw error;}
  }));
  const failed=results.find(r=>r.status==='rejected');if(failed)throw failed.reason;
  need(!signal.aborted,'QUOTE_CANCELLED');
  const quotes=results.map(r=>r.value),first=quotes[0];
  need(quotes.every(q=>q.id===first.id&&q.currency==='USD')&&
    new Set(quotes.map(q=>q.shipment_id)).size===quotes.length&&new Set(quotes.map(q=>q.rate_id)).size===quotes.length,'INVALID_SHIPPO_RATE');
  const total=quotes.reduce((sum,q)=>sum+BigInt(q.total_cents),0n);
  need(total>0n&&total<=BigInt(Number.MAX_SAFE_INTEGER),'INVALID_SHIPPO_AMOUNT');
  return freeze({options:[{id:first.id,carrier:first.carrier,account_id:first.account_id,service:first.service,currency:'USD',
    total_cents:Number(total),parcel_quotes:quotes}]});
}
