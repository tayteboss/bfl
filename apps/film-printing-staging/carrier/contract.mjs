import {createHash} from 'node:crypto';
import {freeze} from '../configuration/config.mjs';
import {requireValue as need} from '../shipping/packing.mjs';
import {immutableSignature} from '../checkout/quantity-signature.js';
import {VARIANTS_BY_LAB,VARIANT} from '../checkout/authority.js';

export const MAX_BODY=65536;
export const PRODUCT_ID=15620086005871, VARIANT_ID=67852705202287;
const callbackVariants=new Set([VARIANT,...Object.values(VARIANTS_BY_LAB)]);
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const text=(v,max=200)=>typeof v==='string'&&v.length<=max&&!/[\u0000-\u001f\u007f]/.test(v);
const integer=v=>Number.isSafeInteger(v)&&v>=0;

// JSON.parse alone silently accepts duplicate members. Scan the valid JSON token
// stream first, including escaped member names, with a fixed nesting limit.
function uniqueJson(source) {
  const value=JSON.parse(source);
  const tokens=source.match(/"(?:[^"\\]|\\.)*"|[{}\[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g);
  let at=0;
  function walk(depth) {
    need(depth<=16,'CALLBACK_DEPTH');
    const token=tokens[at++];
    if(token==='{') {
      const seen=new Set();
      if(tokens[at]==='}') {at++;return;}
      do {
        const key=JSON.parse(tokens[at++]);
        need(!seen.has(key)&&!['__proto__','constructor','prototype'].includes(key),'CALLBACK_DUPLICATE_MEMBER');
        seen.add(key);at++;walk(depth+1);
      } while(tokens[at++]===',');
    } else if(token==='[') {
      if(tokens[at]===']'){at++;return;}
      do {walk(depth+1);} while(tokens[at++]===',');
    }
  }
  walk(0);return value;
}
function address(value) {
  need(object(value),'CALLBACK_ADDRESS');
  need(['country','postal_code','province','city','address1'].every(k=>text(value[k])&&value[k].trim().length>0),'CALLBACK_ADDRESS');
  need(/^[A-Z]{2}$/.test(value.country),'CALLBACK_ADDRESS');
  need(value.address2===undefined||value.address2===null||text(value.address2),'CALLBACK_ADDRESS');
  // No inference from address_type/contact fields; residential and validation are absent.
  return {country_code:value.country,postal_code:value.postal_code,province_code:value.province,
    city:value.city,address1:value.address1,address2:value.address2??''};
}
export function parseCarrierRequest(rawBody) {
  need(Buffer.isBuffer(rawBody)&&rawBody.length>0&&rawBody.length<=MAX_BODY,'CALLBACK_BODY_LIMIT');
  let body;try {body=uniqueJson(new TextDecoder('utf-8',{fatal:true}).decode(rawBody));}
  catch(error){if(error.code)throw error;need(false,'CALLBACK_JSON');}
  need(object(body)&&object(body.rate),'CALLBACK_ENVELOPE');
  const r=body.rate;
  need(r.currency==='USD','UNSUPPORTED_CURRENCY');
  // Project only quote inputs from Shopify's extensible callback envelope.
  // Unused metadata (including item weights and contact/trust fields) grants
  // no authority. Packing and authorization come from the signed stored job.
  // The whole body still has byte, nesting and duplicate-member limits.
  need(Array.isArray(r.items)&&r.items.length>0&&r.items.length<=20,'CALLBACK_ITEMS');
  const items=r.items.map(item=>{
    need(object(item),'CALLBACK_ITEM');
    need(Number.isSafeInteger(item.quantity)&&item.quantity>0&&item.quantity<=10000&&integer(item.price),'CALLBACK_QUANTITY');
    need(item.product_id===PRODUCT_ID&&Number.isSafeInteger(item.variant_id)&&callbackVariants.has(`gid://shopify/ProductVariant/${item.variant_id}`)&&item.requires_shipping===true,'CALLBACK_PRODUCT');
    const p=item.properties;
    need(object(p)&&Object.keys(p).length<=80&&Object.entries(p).every(([k,v])=>text(k)&&k.length>0&&text(v,2048)),'CALLBACK_PROPERTIES');
    need(p._bfl_flow==='f05'&&typeof p._bfl_job==='string'&&/^[a-zA-Z0-9_-]{8,100}$/.test(p._bfl_job)&&
      /^[a-f0-9]{64}$/.test(p._bfl_revision)&&/^f03-[a-f0-9]{24}$/.test(p._bfl_config)&&immutableSignature(p._bfl_signature,item.quantity),'CALLBACK_REFERENCE');
    need(Object.keys(p).filter(k=>k.startsWith('_bfl_')).every(k=>['_bfl_flow','_bfl_job','_bfl_revision','_bfl_config','_bfl_signature','_bfl_size_mode'].includes(k)),'CALLBACK_REFERENCE');
    return {variant_id:String(item.variant_id),quantity:item.quantity,price:item.price,properties:p,
      reference:{id:p._bfl_job,revision:p._bfl_revision,config_version:p._bfl_config,signature:immutableSignature(p._bfl_signature,item.quantity)}};
  });
  need(new Set(items.map(i=>i.reference.id)).size===items.length,'CALLBACK_DUPLICATE_JOB');
  return freeze({currency:'USD',origin:address(r.origin),destination:address(r.destination),items,
    body_sha256:createHash('sha256').update(rawBody).digest('hex')});
}

// Pure wire mapping, NOT source/owner/group authorization. Caller must already
// have established one complete shipping group for exactly this callback subset.
// Do not sum groups or manufacture combinations of independently priced options.
export function carrierRates(result) {
  need(result?.status==='available'&&result.provider==='shippo'&&['test','live'].includes(result.mode)&&
    result.packing?.groups?.length===1&&result.quotes?.length===1,'CALLBACK_QUOTE');
  const group=result.packing.groups[0],quote=result.quotes[0];
  need(quote.group_id===group.id&&quote.lab===group.lab&&quote.location_id===group.location_id&&
    Array.isArray(quote.options)&&quote.options.length>0&&quote.options.length<=20,'CALLBACK_GROUP');
  const ids=new Set();
  const rates=quote.options.map(o=>{
    need(['UPS','FedEx','USPS','DHL Express'].includes(o.carrier)&&/^[a-zA-Z0-9_-]{1,100}$/.test(o.account_id)&&
      /^[a-z0-9_]{1,100}$/.test(o.service)&&o.id===`shippo:${result.mode}:${o.account_id}:${o.service}`&&
      !ids.has(o.id)&&o.currency==='USD'&&Number.isSafeInteger(o.total_cents)&&o.total_cents>0,'CALLBACK_RATE');
    ids.add(o.id);
    // Only provider mode/account/service identity, never quote, job, session,
    // request timestamp or config version. No account IDs exposed to checkout.
    const code='BFL_SHIPPO_'+createHash('sha256').update(o.id).digest('hex');
    const name=o.carrier==='USPS'&&o.service==='usps_ground_advantage'?'USPS Ground Advantage':`${o.carrier} ${o.service}`;
    return {service_name:name,service_code:code,
      description:'Carrier-calculated shipping',currency:'USD',total_price:String(o.total_cents)};
  });
  return freeze({rates:rates.sort((a,b)=>a.service_code.localeCompare(b.service_code))});
}
