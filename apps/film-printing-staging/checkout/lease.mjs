import {requireValue as need} from '../shipping/packing.mjs';
import {canonical} from '../configuration/config.mjs';
import {APP} from '../configuration/schema.mjs';
import {preparedPolicy} from './prepared-limits.mjs';
import {decodeAuthority,boundedAuthorityJSON,MAX_BYTES,NAMESPACE,isEligibilitySchema,isFullProductSchema} from './authority.js';

export const LEASE_KEY='lease_v3';
export const EXPIRED_DEADLINE='1970-01-01T00:00:00';
export const LEASE_OWNERS=Object.freeze([
  {alias:'leasePricing',id:'gid://shopify/CartTransform/143032431',functionId:'01a151d2-387e-7051-9d71-70e053bdc17f',handle:'f02-print-pricing'},
  {alias:'leaseValidation',id:'gid://shopify/Validation/176095343',functionId:'01a151d2-387e-7221-b100-bcda6c1184d8',handle:'f02-print-validation'},
  {alias:'leaseLab',id:'gid://shopify/FulfillmentConstraintRule/93913199',functionId:'01a151d2-387e-7b09-8922-99bf5b6970ab',handle:'f02-print-lab'},
  {alias:'leaseDelivery',id:'gid://shopify/DeliveryCustomization/388071535',functionId:'01a151d2-387e-749c-899d-d47b4fae84a3',handle:'f02-print-delivery'},
]);
export function leaseOwners(specificationOwner=null) {
  if (specificationOwner===null) return LEASE_OWNERS;
  need(specificationOwner&&Object.keys(specificationOwner).length===2&&
    /^gid:\/\/shopify\/Validation\/[1-9]\d*$/.test(specificationOwner.id)&&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(specificationOwner.functionId)&&
    !LEASE_OWNERS.some(owner=>owner.id===specificationOwner.id||owner.functionId===specificationOwner.functionId),'SPECIFICATION_OWNER_REQUIRED');
  return [...LEASE_OWNERS,{alias:'leaseValidation',id:specificationOwner.id,functionId:specificationOwner.functionId,handle:'full-product-specification'}];
}
const field='lease:metafield(namespace:"$app:bfl-checkout",key:"lease_v3"){namespace key type value compareDigest}';
export const LEASE_QUERY_FIELDS=`
  leasePricing:cartTransforms(first:10){nodes{id functionId blockOnFailure ${field}} pageInfo{hasNextPage hasPreviousPage}}
  leaseValidation:validations(first:10){nodes{id enabled blockOnFailure shopifyFunction{id} ${field}} pageInfo{hasNextPage hasPreviousPage}}
  leaseLab:fulfillmentConstraintRules{id deliveryMethodTypes function{id} ${field}}
  leaseDelivery:deliveryCustomizations(first:10){nodes{id enabled shopifyFunction{id} ${field}} pageInfo{hasNextPage hasPreviousPage}}
  leaseFunctions:shopifyFunctions(first:10){nodes{id handle apiVersion app{id}} pageInfo{hasNextPage hasPreviousPage}}
`;
const connection=value=>{
  need(value?.pageInfo?.hasNextPage===false&&value.pageInfo.hasPreviousPage===false&&Array.isArray(value.nodes),'FUNCTION_OWNERS_INCOMPLETE');
  return value.nodes;
};
export function readFunctionOwners(data,{specificationOwner=null}={}) {
  const functions=connection(data.leaseFunctions);
  const expectedOwners=leaseOwners(specificationOwner);
  return expectedOwners.map(expected=>{
    const rows=expected.alias==='leaseLab'?data[expected.alias]:connection(data[expected.alias]);
    const peers=expectedOwners.filter(o=>o.alias===expected.alias);
    need(Array.isArray(rows)&&rows.length===peers.length&&new Set(rows.map(row=>row.id)).size===rows.length&&rows.every(row=>peers.some(peer=>peer.id===row.id)),'FUNCTION_OWNER_CHANGED');
    const owner=rows.find(row=>row.id===expected.id),id=owner.functionId??owner.shopifyFunction?.id??owner.function?.id;
    const fn=functions.filter(f=>f.id===id);
    need(owner.id===expected.id&&id===expected.functionId&&fn.length===1&&fn[0].handle===expected.handle&&
      fn[0].apiVersion==='2026-07'&&fn[0].app?.id===APP,'FUNCTION_OWNER_CHANGED');
    if(['leasePricing','leaseValidation'].includes(expected.alias))need(owner.blockOnFailure===true,'FUNCTION_OWNER_UNPROTECTED');
    if(['leaseValidation','leaseDelivery'].includes(expected.alias))need(owner.enabled===true,'FUNCTION_OWNER_DISABLED');
    if(expected.alias==='leaseLab')need(canonical([...owner.deliveryMethodTypes].sort())===canonical(['PICK_UP','SHIPPING']),'FUNCTION_OWNER_CHANGED');
    const value=owner.lease??null;
    if(value)need(value.namespace===`app--${APP.split('/').at(-1)}--bfl-checkout`&&value.key===LEASE_KEY&&value.type==='json'&&
      typeof value.value==='string'&&typeof value.compareDigest==='string'&&value.compareDigest.length>0,'FUNCTION_LEASE_UNPROTECTED');
    return {id:owner.id,field:value};
  });
}
export function leaseEnvelope(value) {
  const authority=decodeAuthority(value);need(authority&&(!authority.grants.length||isEligibilitySchema(authority.schema)),'LEASE_AUTHORITY_REQUIRED');
  return JSON.stringify({deadline:authority.grants.length?authority.lease.deadline:EXPIRED_DEADLINE,authority})
    .replace(/[\u007f-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
}
export function leaseFields(owners,value,{specificationOwner=null}={}) {
  const expected=leaseOwners(specificationOwner);
  need(Array.isArray(owners)&&owners.length===expected.length&&owners.every((o,i)=>o.id===expected[i].id),'FUNCTION_OWNERS_REQUIRED');
  need(!isFullProductSchema(decodeAuthority(value)?.schema)||specificationOwner!==null,'SPECIFICATION_OWNER_REQUIRED');
  return owners.map(({id,field})=>({ownerId:id,namespace:NAMESPACE,key:LEASE_KEY,type:'json',value:leaseEnvelope(value),compareDigest:field?.compareDigest??null}));
}
const parsedValue=raw=>{const value=boundedAuthorityJSON(raw,MAX_BYTES+128);if(value===null)return null;try{return JSON.parse(value);}catch{return null;}};
export function sameAuthorityValue(a,b) {
  const left=decodeAuthority(a),right=decodeAuthority(b);return !!left&&!!right&&canonical(left)===canonical(right);
}
export function sameLeaseValue(a,b) {
  const left=parsedValue(a),right=parsedValue(b);return !!left&&!!right&&canonical(left)===canonical(right);
}
export function sameLeaseContext(a,b) {
  const normalize=owners=>(owners??null)?.map(owner=>({...owner,...(owner.field?{field:{...owner.field,value:parsedValue(owner.field.value)??owner.field.value}}:{})}));
  return a.timezone===b?.timezone&&canonical(normalize(a.functionOwners))===canonical(normalize(b?.functionOwners));
}
export function leaseDeadline(originalUntil,nowMs,timezone,{sourceScope}={}) {
  const policy=preparedPolicy(sourceScope);
  need(Number.isSafeInteger(originalUntil)&&Number.isSafeInteger(nowMs)&&originalUntil>nowMs&&originalUntil-nowMs<=policy.leaseMs,'LEASE_WINDOW');
  const formatter=new Intl.DateTimeFormat('en-GB-u-ca-iso8601-nu-latn',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  const local=ms=>{const p=Object.fromEntries(formatter.formatToParts(ms).map(x=>[x.type,x.value]));return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;};
  const offset=ms=>Date.parse(local(ms)+'Z')-Math.floor(ms/1000)*1000,expected=offset(nowMs);
  // A repeated shop-clock hour must never reactivate expired eligibility.
  let end=Math.floor(originalUntil/1000)*1000;const today=local(nowMs).slice(0,10);
  if(policy.clientPolicy==='bfl-persistent-staging-client-v1'){
    // A deadline outside a repeated local-clock interval remains monotonic,
    // even when the session spans a DST transition. An ambiguous deadline is
    // shortened to the first start of the repeated interval, never extended.
    for(let t=end-172800000;t<=end+86400000;t+=3600000){
      const before=offset(t),after=offset(t+3600000);if(after>=before)continue;
      let low=t,high=t+3600000;
      while(high-low>1000){const mid=Math.floor((low+high)/2000)*1000;if(offset(mid)===before)low=mid;else high=mid;}
      const first=high-(before-after),last=high+(before-after);
      if(end>first&&end<last)end=first;
    }
  }else for(let t=nowMs-86400000;t<=originalUntil+86400000;t+=3600000)need(offset(t)===expected,'LEASE_TIMEZONE_TRANSITION');
  // Exact full-product sources already authorize this finite interval. Their
  // eligibility uses the absolute lease deadline, not a daily price table.
  // Historical ordinary/fixture leases keep their original midnight clamp.
  if(!policy.clientPolicy&&local(end).slice(0,10)!==today){
    let low=Math.floor(nowMs/1000)*1000,high=end;
    while(high-low>1000){const middle=Math.floor((low+high)/2000)*1000;if(local(middle).slice(0,10)===today)low=middle;else high=middle;}
    end=high;
  }
  need(end>nowMs,'LEASE_WINDOW');return {deadline:local(end),expires_at:end};
}
