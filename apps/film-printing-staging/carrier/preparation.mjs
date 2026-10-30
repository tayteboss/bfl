import {freeze,verifyRelease} from '../configuration/config.mjs';
import {requireValue as need} from '../shipping/packing.mjs';
import {FULL_PRODUCT_ATTRIBUTES,claimValuesMatch,variantForLab} from '../checkout/authority.js';
import {jobProperties} from '../jobs/properties.mjs';
import {immutableSignature} from '../checkout/quantity-signature.js';

export const CALLBACK_GATES=Object.freeze([
  'CALLBACK_SOURCE_AUTHENTICATION_UNPROVEN','CALLBACK_OWNER_CART_BINDING_UNPROVEN',
  'CALLBACK_CURRENT_AUTHORITY_UNPROVEN','CALLBACK_COMPLETE_GROUP_ROUTING_UNPROVEN',
  'CALLBACK_PHYSICAL_CONTEXT_UNPROVEN','CALLBACK_CACHE_ACCEPTANCE_UNPROVEN',
]);
// Deliberately no positive production resolver or trusted=true escape hatch.
// Neither a signed job capability nor a matching address proves these facts.
export async function unavailableCallback() {
  return {status:'unavailable',code:CALLBACK_GATES[0],quotes:[]};
}

// Server-only reference preparation AFTER independent owner/source binding.
// Owner is an explicit internal argument, never read or inferred from properties.
// This checks stored capabilities and one provided verified release; it does NOT
// establish current authority, group completeness, routing, or request authenticity.
export async function resolveCarrierReferences({callback,owner,jobs,release,signal,sourceScope}) {
  need(typeof owner==='string'&&owner.length>0&&typeof jobs?.resolveForCheckout==='function','CALLBACK_OWNER_UNAVAILABLE');
  need(!signal?.aborted,'QUOTE_CANCELLED');
  verifyRelease(release,{sourceScope});
  const ticket=jobs.authorityLifecycle.state();
  need(!ticket.pending&&!ticket.operation,'AUTHORITY_PENDING');
  const resolved=await jobs.resolveForCheckout(owner,callback.items.map(i=>i.reference),release);
  need(!signal?.aborted,'QUOTE_CANCELLED');
  need(Array.isArray(resolved)&&resolved.length===callback.items.length&&resolved.every((job,i)=>job.id===callback.items[i].reference.id),'CALLBACK_INCOMPLETE_JOBS');
  const candidates=resolved.map((job,i)=>{
    const line=callback.items[i],p=line.properties;
    need(job.variant_id===line.variant_id,'VARIANT_MISMATCH');
    need(job.unit_price_cents===line.price&&job.unit_price_cents*line.quantity<=200000,'CALLBACK_PRICE_UNPROVEN');
    const expected=jobProperties(job,line.reference,{canonical:true}),claims=Object.fromEntries(Object.entries(FULL_PRODUCT_ATTRIBUTES).map(([alias,key])=>[alias,expected[key]??'']));
    need(claimValuesMatch(alias=>alias==='signature'?immutableSignature(p[FULL_PRODUCT_ATTRIBUTES[alias]],line.quantity):p[FULL_PRODUCT_ATTRIBUTES[alias]]??'',claims,Object.keys(FULL_PRODUCT_ATTRIBUTES),{display:variantForLab(job.lab)===`gid://shopify/ProductVariant/${job.variant_id}`}),'SPECIFICATION_MISMATCH');
    return {...job,copies:line.quantity};
  });
  need(candidates.reduce((sum,j)=>sum+j.unit_price_cents*j.copies,0)<=200000,'PRICE_LIMIT');
  // A quote must recheck the epoch after awaited provider work as well. Returning
  // this read-only epoch does not supersede preparations or publish any grant.
  need(jobs.authorityLifecycle.state().epoch===ticket.epoch&&!jobs.authorityLifecycle.state().pending&&!jobs.authorityLifecycle.state().operation,'AUTHORITY_FENCED');
  return freeze({jobs:candidates,release,ticket,checkout_ready:false,gates:CALLBACK_GATES});
}
