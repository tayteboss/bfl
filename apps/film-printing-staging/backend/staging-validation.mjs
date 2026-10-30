import {need} from './config.mjs';
import {canonical} from '../configuration/config.mjs';
import {cartHash,printLine} from '../checkout/storefront.mjs';
import {FULL_PRODUCT_ATTRIBUTES,PRODUCT,claimValuesMatch} from '../checkout/authority.js';
import {jobClaims,jobEligibility} from '../checkout/job-eligibility.mjs';

// Revalidate existing server custody without staging a second publication or
// extending a principal. New browser ownership still needs its signed proof.
export function createStagingOwnerValidator({db,store,jobs,transport,sourceScope,now=Date.now}){
 return async(entry,context)=>{
  const {ticket,bound,wire}=store.staging.wireFor(entry.owner),session=store.resourceSessions.assert(ticket);
  need(entry.originalUntil>now()&&entry.originalUntil<=session.expires&&entry.originalUntil<=session.deadline,'STAGING_OWNER_EXPIRED');
  const before=await transport.readBinding(wire);store.resourceSessions.assert(ticket);
  const cart=before.parsed,grant=entry.grant;
  need(cart.complete&&cart.id===wire.cart_id&&cart.customer_id===null&&grant.customer_id===null&&grant.cart===cartHash(cart.id)&&grant.owner===cartHash(entry.owner)&&grant.binding===before.marker,'STAGING_CART_CHANGED');
  store.cartBinding.observe({...cart,owner:entry.owner,binding_id:bound.binding_id},before.marker);
  const references=grant.lines.map(line=>{
   const claim=line.claims,reference={id:claim.job,revision:claim.revision,config_version:claim.config,signature:claim.signature};
   const rows=db.prepare('SELECT p.state,r.reference FROM staging_prepared_references r JOIN cart_prepared_jobs p USING(operation_id) WHERE r.owner=? AND p.job_id=?').all(entry.owner,claim.job);
   // A new candidate is resolved by the trusted projector before its first
   // publication reservation. Existing prepared history must match exactly.
   need(rows.length===0||rows.length===1&&['reserved','issued','confirmed'].includes(rows[0].state)&&canonical(JSON.parse(rows[0].reference))===canonical(reference),'STAGING_JOB_UNVERIFIED');return reference;
  });
  const resolved=await jobs.resolveForCheckout(entry.owner,references,context.release);store.resourceSessions.assert(ticket);
  const lines=resolved.map((job,i)=>{const eligible=jobEligibility(context.release,context.catalog,job,{sourceScope});return {
   variant_id:`gid://shopify/ProductVariant/${job.variant_id}`,unit_cents:job.unit_price_cents,file_count:job.completed_asset_ids.length,
   location_id:eligible.location_id,shipping_eligible:eligible.shipping_eligible,claims:jobClaims(job,references[i],{full:true})};});
  need(canonical(lines)===canonical(grant.lines),'STAGING_JOB_UNVERIFIED');
  const seen=new Set();let total=0;
  for(const actual of cart.lines.filter(printLine)){
   const approved=lines.find(line=>line.claims.job===actual.reference?.id);
   need(approved&&!seen.has(approved.claims.job)&&actual.variant_id===approved.variant_id&&actual.product_id===PRODUCT&&!actual.selling_plan&&Number.isSafeInteger(actual.quantity)&&actual.quantity>0&&actual.quantity<=10000,'STAGING_CART_CHANGED');
   need(claimValuesMatch(alias=>actual.properties?.[FULL_PRODUCT_ATTRIBUTES[alias]]??'',approved.claims,Object.keys(FULL_PRODUCT_ATTRIBUTES),{display:true,quantity:actual.quantity}),'STAGING_CART_CHANGED');
   seen.add(approved.claims.job);total+=approved.unit_cents*actual.quantity;
  }
  for(const job of resolved)if(!seen.has(job.id))total+=job.unit_price_cents*job.copies;
  need(Number.isSafeInteger(total)&&total<=200000,'PRICE_LIMIT');
  store.resourceSessions.assert(ticket);return true;
 };
}
