import {randomBytes} from 'node:crypto';
import {canonical,freeze,resolveRule} from '../configuration/config.mjs';
import {assertEngineeringConfig,assertEngineeringScope} from '../configuration/engineering.mjs';
import {need} from '../backend/config.mjs';
import {ATTRIBUTES,FULL_PRODUCT_ATTRIBUTES,ELIGIBILITY_SCHEMA,LAB_VARIANT_SCHEMA,variantForLab,STORE,VARIANT,PRODUCT,decodeAuthority,claimValuesMatch} from './authority.js';
import {isFullProductCatalog,isLabVariantCatalog} from '../jobs/selection.mjs';
import {jobEligibility,jobClaims} from './job-eligibility.mjs';
import {emptyAuthority,serializeAuthority} from './projector.mjs';
import {cartHash,printLine} from './storefront.mjs';
import {preparedPolicy} from './prepared-limits.mjs';

// Receives an actual authenticated cart plus immutable server references. It
// projects eligibility separately; no invented cart lines or prices prove a cart.
export function createEligibilityProjector({jobs,sourceScope}){
  return {async prepare({cart,context,binding,lease,references,guard=()=>{}}){
    guard();need(jobs.authorityLifecycle&&cart?.store===STORE&&cart.complete===true&&Array.isArray(cart.lines)&&cart.lines.length<=20&&Array.isArray(references)&&references.length>0&&references.length<=preparedPolicy(sourceScope).cartLines,'UNVERIFIED_CART');
    need(new Set(references.map(r=>r.id)).size===references.length,'DUPLICATE_JOB');
    const ticket=jobs.authorityLifecycle.beginPreparation();need(binding.epoch===ticket.epoch,'BINDING_EPOCH_MISMATCH');
    const {release,catalog,shopDate}=context,next=emptyAuthority(release,catalog,shopDate,{sourceScope});
    const full=isFullProductCatalog(catalog),routed=isLabVariantCatalog(catalog),attributes=full?FULL_PRODUCT_ATTRIBUTES:ATTRIBUTES;
    next.schema=routed?LAB_VARIANT_SCHEMA:full?ELIGIBILITY_SCHEMA:3;next.lease={token:lease.token??randomBytes(32).toString('hex'),deadline:lease.deadline,expires_at:lease.expires_at};
    const resolved=await jobs.resolveForCheckout(cart.owner,references,release);guard();
    const lines=resolved.map((job,i)=>{
      need(`gid://shopify/ProductVariant/${job.variant_id}`===(routed?variantForLab(job.lab):VARIANT)&&job.price_version===catalog.version,'PRICE_VERSION_MISMATCH');
      const eligible=jobEligibility(release,catalog,job,{sourceScope});
      return {...(routed?{variant_id:`gid://shopify/ProductVariant/${job.variant_id}`} : {}),unit_cents:job.unit_price_cents,file_count:job.completed_asset_ids.length,location_id:eligible.location_id,
        ...(full?{shipping_eligible:eligible.shipping_eligible}:{}),claims:jobClaims(job,references[i],{full})};
    });
    let total=0;const selected=new Set();
    for(const actual of cart.lines.filter(printLine)){
      const approved=lines.find(l=>l.claims.job===actual.reference?.id);need(approved&&!selected.has(approved.claims.job),'UNRECOGNIZED_CART_JOB');selected.add(approved.claims.job);
      need(actual.variant_id===(routed?approved.variant_id:VARIANT)&&actual.product_id===PRODUCT&&!actual.selling_plan&&Number.isSafeInteger(actual.quantity)&&actual.quantity>0&&actual.quantity<=10000,'VARIANT_MISMATCH');
      need(claimValuesMatch(alias=>actual.properties?.[attributes[alias]]??'',approved.claims,Object.keys(attributes),{display:routed,quantity:actual.quantity}),'SPECIFICATION_MISMATCH');
      total+=approved.unit_cents*actual.quantity;need(total<=200000,'PRICE_LIMIT');
    }
    for(const job of resolved)if(!selected.has(job.id)){need(Number.isSafeInteger(job.copies)&&job.copies>0&&job.copies<=10000,'INVALID_COPIES');total+=job.unit_price_cents*job.copies;need(total<=200000,'PRICE_LIMIT');}
    next.grants=[{cart:cartHash(cart.id),owner:cartHash(cart.owner),customer_id:cart.customer_id,lines,binding:binding.marker,generation:binding.generation,epoch:binding.epoch}];
    const value=serializeAuthority(next);need(decodeAuthority(value),'INVALID_AUTHORITY');if(sourceScope)assertEngineeringScope(sourceScope);guard();jobs.authorityLifecycle.stage(ticket,value);
    return freeze({authority:next,value,context,ticket,cart_hash:cartHash(cart.id),checkout_ready:false});
  }};
}
