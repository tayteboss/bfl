import {randomBytes} from 'node:crypto';
import {need} from '../backend/config.mjs';
import {fingerprint} from '../jobs/lifecycle.mjs';
import {FULL_PRODUCT_ATTRIBUTES,inspectCart,decodeAuthority,isEligibilitySchema} from './authority.js';
import {cartHash,printLine} from './storefront.mjs';
import {leaseDeadline,leaseEnvelope} from './lease.mjs';
import {serializeAuthority} from './projector.mjs';
import {PREPARED_LIMITS,preparedPolicy} from './prepared-limits.mjs';
import {jobProperties} from '../jobs/properties.mjs';
const samePrincipal=(a,b)=>a&&b&&['owner','verifier','generation'].every(k=>a[k]===b[k]);
const structure=cart=>{const {updated_at,...rest}=cart;return fingerprint({...rest,lines:cart.lines.map(({subtotal_cents,...line})=>line)});};
const selectionHash=job=>{const {id,revision,copies,...immutable}=job;return fingerprint(immutable);};
const itemFor=(job,reference)=>({id:job.variant_id,quantity:job.copies,properties:jobProperties(job,reference)});

export function createPreparedPublication({store,jobs,admin,prepareAuthority,currentOwner,now=Date.now,until,publicationLimit=4,enabled=false,permit=()=>false,record=()=>{},armPublication,sourceScope}){
 const policy=preparedPolicy(sourceScope);
 need(store.preparedCart&&typeof prepareAuthority==='function'&&typeof currentOwner==='function'&&typeof armPublication==='function'&&([1,2,4,PREPARED_LIMITS.publications].includes(publicationLimit)||policy.clientPolicy&&publicationLimit===policy.publications),'PREPARED_PUBLICATION_REQUIRED');
 const ledger=store.preparedCart,rows=new Map();
 let lease=null,authority=null,historical=null,spent=0,uncertain=false,clearing=null,cleared=false;
 const gate=()=>need(enabled===true&&permit()&&!cleared&&!clearing&&now()<until,'DIAGNOSTIC_CLOSED');
 const owner=()=>{const t=currentOwner();need(t&&(!lease||samePrincipal(t,lease.ticket)),'RESOURCE_FENCED');return t;};
 const assertLease=(ticket,marker)=>{gate();store.resourceSessions.assert(ticket);need(lease&&samePrincipal(ticket,lease.ticket)&&marker===lease.marker&&now()<lease.expires,'DIAGNOSTIC_LEASE_CHANGED');};
 const verify=(cart,marker,a,{prices=true}={})=>{
  need(isEligibilitySchema(a?.schema)&&lease&&now()<lease.expires&&a.lease.token===lease.value.token&&a.lease.deadline===lease.value.deadline&&a.lease.expires_at===lease.expires,'CHECKOUT_RESUME_REJECTED');
  const grant=a.grants.find(g=>g.binding===marker);need(grant&&grant.cart===cartHash(cart.id)&&grant.owner===cartHash(cart.owner)&&grant.customer_id===cart.customer_id,'CHECKOUT_RESUME_REJECTED');
  const result=inspectCart({leaseOwner:{lease:{value:leaseEnvelope(serializeAuthority(a))}},shop:{localTime:{beforeDeadline:true}},cart:{binding:{value:marker},buyerIdentity:{isAuthenticated:cart.customer_id!==null,customer:cart.customer_id?{id:cart.customer_id}:null},
   lines:cart.lines.map(line=>({id:line.id,quantity:line.quantity,merchandise:{id:line.variant_id,product:{id:line.product_id}},sellingPlanAllocation:line.selling_plan?{}:null,cost:{amountPerQuantity:{currencyCode:'USD'}},...Object.fromEntries(Object.entries(FULL_PRODUCT_ATTRIBUTES).map(([alias,key])=>[alias,{value:line.properties[key]??''}]))}))}});
  need(result.valid,'CHECKOUT_RESUME_REJECTED');
  if(prices){
   for(const approved of result.lines){const actual=cart.lines.find(l=>l.id===approved.id);need(actual.subtotal_cents===approved.unit_cents*actual.quantity,'CART_PRICE_UNVERIFIED');}
   // Record actual server-observed additions before preparing another job.
   // Confirmed jobs keep their slot even when later removed from the bag.
   for(const row of rows.values())if(cart.lines.some(l=>l.reference?.id===row.ticket.job_id)&&ledger.status(row.ticket).state==='issued')ledger.confirm(row.ticket,fingerprint(cart.lines));
  }
  return result;
 };
 const knownEvents=t=>{
  const s=store.lifecycle.state();if(s.operation||uncertain)return false;
  return store.lifecycle.pendingEvents().every(event=>{
   if(event.id.startsWith('uc:terminal:')){const row=store.uploadLedger.read(event.id.slice('uc:terminal:'.length));return row?.owner===t.owner&&['removed','failed'].includes(row.state);}
   if(event.id.startsWith('prepared-cancel:')){const row=rows.get(event.id.slice('prepared-cancel:'.length));return row&&row.ticket.owner_hash===cartHash(t.owner)&&ledger.status(row.ticket).state==='cancelled';}return false;
  });
 };
 const clearKnown=async()=>{
  gate();const t=owner();need(knownEvents(t),'PREPARED_UNCERTAIN');await admin.reconcile();need(samePrincipal(t,owner()),'RESOURCE_FENCED');
  if(authority)historical=authority;authority=null;if(lease){need(now()<lease.expires,'PREPARED_EXPIRED');lease.ticket=owner();}
  record({event:'prepared_resources_reconciled',checkout_ready:false});
 };
 const retire=async()=>{
  need(enabled===true,'DIAGNOSTIC_CLOSED');if(clearing)return clearing;if(cleared&&!store.lifecycle.state().pending&&!store.lifecycle.state().operation)return;
  clearing=(async()=>{if(lease){store.revoke({id:`diagnostic-owner:${lease.ticket.owner}`,kind:'owner',owner:lease.ticket.owner});store.cartBinding.retire(lease.marker);}store.resourceSessions.retireExpiredCartOwners();await admin.reconcile();authority=null;historical=null;cleared=true;record({event:'authority_cleared',checkout_ready:false});})();
  try{await clearing;}finally{clearing=null;}
 };
 return Object.freeze({
  async eligible({resourceTicket,cart,marker,reference,generation,readCurrent,guard,guardPublication}){
   gate();guard();need(!uncertain&&spent<publicationLimit,'DIAGNOSTIC_PUBLICATION_SPENT');const session=store.resourceSessions.assert(resourceTicket);
   need(!policy.clientPolicy||store.resourceSessions.clientPolicy(resourceTicket,sourceScope)===policy.clientPolicy,'PREPARED_CLIENT_OWNER_REQUIRED');
   store.cartBinding.observe(cart,marker);need(samePrincipal(resourceTicket,owner()),'RESOURCE_FENCED');
   const context=await admin.read();guard();gate();
   if(!lease){const expiry=leaseDeadline(Math.min(session.expires,session.deadline,until,now()+policy.leaseMs),now(),context.timezone,{sourceScope});lease={ticket:resourceTicket,marker,expires:expiry.expires_at,value:{token:randomBytes(32).toString('hex'),...expiry}};}
   assertLease(resourceTicket,marker);const prior=context.field?.value==null?null:decodeAuthority(context.field.value);need(prior,'INVALID_PRIOR_AUTHORITY');
   if(authority)need(fingerprint(prior)===fingerprint(authority),'PREPARED_AUTHORITY_CHANGED');else need(prior.grants.length===0,'PREPARED_AUTHORITY_CHANGED');
   const selected=cart.lines.filter(printLine);if(selected.length)verify(cart,marker,authority??historical,{prices:!!authority});
   const references=selected.map(line=>line.reference);need(!references.some(r=>r.id===reference?.id),'PREPARED_JOB_PRESENT');
   const [job]=await jobs.resolveForCheckout(cart.owner,[reference],context.release);guard();gate();
   const prepared=await prepareAuthority({cart,context,binding:{marker,generation,epoch:resourceTicket.epoch},lease:lease.value,references:[...references,reference],guard});
   guard();gate();assertLease(resourceTicket,marker);const before=await readCurrent();guard();gate();need(structure(before)===structure(cart),'CART_REFRESH_CHANGED');
   const reservation=ledger.reserve(cart.owner,cart,marker,reference,selectionHash(job),generation,lease.expires,{sourceScope});need(!reservation.replay,'PREPARED_SEND_ALREADY_RESERVED');
   rows.set(reservation.ticket.operation_id,{ticket:reservation.ticket,reference});
   record({event:'publication_reserved',expires:lease.expires,checkout_ready:false});
   try{
    armPublication(prepared,guardPublication);spent++;await admin.publish(prepared);guard();gate();
    const after=await readCurrent();guard();gate();need(structure(after)===structure(cart),'CART_REFRESH_CHANGED');verify(after,marker,prepared.authority);
    const issued=ledger.issue(reservation.ticket,fingerprint(prepared.value));authority=prepared.authority;historical=authority;
    record({event:'eligibility_published',expires:lease.expires,checkout_ready:false});
    return {prepared:true,reference,item:itemFor(job,reference),unit_price_cents:job.unit_price_cents,file_count:job.completed_asset_ids.length,reservation:issued.ticket,expires_at:lease.expires,generation,cart_verified:false,checkout_ready:false};
   }catch(error){uncertain=true;try{ledger.uncertain(reservation.ticket);}catch{}try{await retire();}catch{}throw error;}
  },
  async cancel({resourceTicket,cart,marker,reservation,guard,afterClear}){
   gate();guard();assertLease(resourceTicket,marker);store.cartBinding.observe(cart,marker);const held=rows.get(reservation?.operation_id);
   need(held&&fingerprint(held.ticket)===fingerprint(reservation)&&held.ticket.owner_hash===cartHash(resourceTicket.owner)&&held.ticket.cart_hash===cartHash(cart.id),'PREPARED_OPERATION_CHANGED');
   need(!cart.lines.some(l=>l.properties?._bfl_job===held.ticket.job_id),'PREPARED_JOB_PRESENT');ledger.cancel(held.ticket);
   if(store.lifecycle.state().pending)await clearKnown();
   // Clearing the discarded candidate must not strand accepted surviving jobs.
   // Rebuild those actual jobs only, with a new post-clear proof and SAME lease.
   if(cart.lines.some(printLine)){
    need(typeof afterClear==='function'&&spent<publicationLimit,'PREPARED_RESTORE_UNAVAILABLE');
    try{
     const fresh=await afterClear();fresh.guard();gate();assertLease(fresh.resourceTicket,fresh.marker);
     need(fresh.marker===marker&&structure(fresh.cart)===structure(cart),'CART_REFRESH_CHANGED');
     verify(fresh.cart,marker,historical,{prices:false});
     const context=await admin.read();fresh.guard();gate();need(decodeAuthority(context.field.value)?.grants.length===0,'PREPARED_AUTHORITY_CHANGED');
     const prepared=await prepareAuthority({cart:fresh.cart,context,binding:{marker,generation:reservation.generation,epoch:fresh.resourceTicket.epoch},lease:lease.value,references:fresh.cart.lines.filter(printLine).map(l=>l.reference),guard:fresh.guard});
     fresh.guard();gate();const before=await fresh.readCurrent();fresh.guard();need(structure(before)===structure(cart),'CART_REFRESH_CHANGED');
     armPublication(prepared,fresh.guardPublication);spent++;await admin.publish(prepared);fresh.guard();gate();
     const after=await fresh.readCurrent();fresh.guard();need(structure(after)===structure(cart),'CART_REFRESH_CHANGED');verify(after,marker,prepared.authority);
     authority=prepared.authority;historical=authority;record({event:'surviving_eligibility_restored',expires:lease.expires,checkout_ready:false});
    }catch(error){uncertain=true;try{await retire();}catch{}throw error;}
   }
   return {cancelled:true,revoked:true,expires_at:lease.expires,cart_verified:false,checkout_ready:false};
  },
  async reconcileUnpublished(){const s=store.lifecycle.state();if(!s.pending||s.operation||uncertain||clearing||cleared)return;let t;try{t=owner();}catch{return;}if(knownEvents(t))await clearKnown();},
  assertUploadResume(ticket,cart,marker){
   gate();need(policy.clientPolicy&&store.resourceSessions.clientPolicy(ticket,sourceScope)===policy.clientPolicy,'UPLOAD_RECOVERY_UNAVAILABLE');
   store.resourceSessions.assert(ticket);need(samePrincipal(ticket,owner())&&cart.owner===ticket.owner,'RESOURCE_FENCED');store.cartBinding.observe(cart,marker);
   const state=store.lifecycle.state();need(!uncertain&&!state.pending&&!state.operation,'PREPARED_UNCERTAIN');
   if(lease){assertLease(ticket,marker);if(authority)verify(cart,marker,authority);else need(!cart.lines.some(printLine),'CHECKOUT_RESUME_REJECTED');}
   else need(rows.size===0&&!cart.lines.some(printLine),'CHECKOUT_RESUME_REJECTED');
   const excluded=new Set();
   for(const row of rows.values()){
    const status=ledger.status(row.ticket).state;need(['confirmed','cancelled'].includes(status),'UPLOAD_RECOVERY_UNAVAILABLE');
    // Accepted jobs remain immutable history after removal. Their assets must
    // never reappear as an uncommitted selection, even when the bag is empty.
    if(status==='confirmed')for(const id of store.getForRevocation(row.ticket.job_id,ticket.owner).completed_asset_ids)excluded.add(id);
   }
   return {excluded_asset_ids:[...excluded].sort(),...(lease?{expires_at:lease.expires}:{})};
  },
  assertResume(ticket,cart,marker,operation){
   assertLease(ticket,marker);
   if(policy.clientPolicy&&['prepared','cancel_preparation'].includes(operation?.kind)){
    const state=store.lifecycle.state();need(!uncertain&&!state.pending&&!state.operation,'PREPARED_UNCERTAIN');
    const held=rows.get(operation.operation_id);
    need(held&&held.ticket.job_id===operation.job&&held.ticket.generation===operation.generation&&held.ticket.owner_hash===cartHash(ticket.owner)&&held.ticket.cart_hash===cartHash(cart.id),'CHECKOUT_RESUME_REJECTED');
    need(!cart.lines.some(l=>l.properties?._bfl_job===held.ticket.job_id),'PREPARED_JOB_PRESENT');
    const status=ledger.status(held.ticket).state;
    need(operation.kind==='cancel_preparation'?status==='cancelled':['issued','cancelled'].includes(status),'CHECKOUT_RESUME_REJECTED');
    // A reload only observes cancellation. It never retries an unknown send.
    // Cancelled empty carts have a definitively cleared authority; survivors
    // still require the exact restored signed authority and original lease.
    if(authority)verify(cart,marker,authority);
    else need(status==='cancelled'&&!cart.lines.some(printLine),'CHECKOUT_RESUME_REJECTED');
    return {expires_at:lease.expires,prepared_recovery:{reservation:held.ticket,state:status}};
   }
   need(authority&&!uncertain,'CHECKOUT_RESUME_REJECTED');verify(cart,marker,authority);
   if(operation){
    need(['add','change','remove','prepared'].includes(operation.kind)&&typeof operation.operation_id==='string'&&typeof operation.job==='string','CHECKOUT_RESUME_REJECTED');
    const actual=cart.lines.filter(l=>l.reference?.id===operation.job);
    const held=[...rows.values()].find(r=>r.ticket.job_id===operation.job);need(held,'CHECKOUT_RESUME_REJECTED');
    if(['add','prepared'].includes(operation.kind))need(held.ticket.operation_id===operation.operation_id,'CHECKOUT_RESUME_REJECTED');
    if(operation.kind==='remove'||operation.kind==='prepared')need(actual.length===0,'CHECKOUT_RESUME_REJECTED');
    else need(actual.length===1&&actual[0].quantity===operation.quantity,'CHECKOUT_RESUME_REJECTED');
   }
   for(const row of rows.values())if(cart.lines.some(l=>l.reference?.id===row.ticket.job_id)){
    const state=ledger.status(row.ticket).state;if(state==='issued')ledger.confirm(row.ticket,fingerprint(cart.lines));else need(state==='confirmed','CHECKOUT_RESUME_REJECTED');
   }
   return {expires_at:lease.expires};
  },
  retirementDue({busy=false}={}){
   if(enabled!==true||cleared)return false;if(uncertain||now()>=until||lease&&now()>=lease.expires)return true;
   if(lease&&store.lifecycle.retired('owner',lease.ticket.owner))return true;
   if(!busy){try{const t=currentOwner();if(t)store.resourceSessions.assert(t);else if(lease)return true;}catch{return true;}const s=store.lifecycle.state();return !!(s.pending||s.operation);}return false;
  },
  retire,
  status:()=>({publication_spent:spent>=publicationLimit,lease_active:!!lease&&!cleared,expires:lease?.expires??null,checkout_ready:false}),
 });
}
