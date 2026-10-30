import {randomBytes} from 'node:crypto';
import {need} from '../backend/config.mjs';
import {fingerprint} from '../jobs/lifecycle.mjs';
import {FULL_PRODUCT_ATTRIBUTES,inspectCart,isEligibilitySchema} from './authority.js';
import {cartHash,printLine} from './storefront.mjs';
import {leaseDeadline,leaseEnvelope} from './lease.mjs';
import {serializeAuthority} from './projector.mjs';
import {preparedPolicy} from './prepared-limits.mjs';
import {jobProperties} from '../jobs/properties.mjs';

const ticketKeys=['operation_id','job_id','owner_hash','cart_hash','generation','expires_at'];
const ticketFor=row=>Object.freeze(Object.fromEntries(ticketKeys.map(key=>[key,row[key]])));
const structure=cart=>{const {updated_at,...rest}=cart;return fingerprint({...rest,lines:cart.lines.map(({subtotal_cents,...line})=>line)});};
const selectionHash=job=>{const {id,revision,copies,...immutable}=job;return fingerprint(immutable);};
export function installStagingPreparedSchema(db){
 db.exec(`CREATE TABLE staging_prepared_references(operation_id TEXT PRIMARY KEY,owner TEXT NOT NULL,reference TEXT NOT NULL);
 CREATE TRIGGER staging_prepared_references_retained_update BEFORE UPDATE ON staging_prepared_references
 BEGIN SELECT RAISE(ABORT,'STAGING_PREPARED_HISTORY_RETAINED'); END;
 CREATE TRIGGER staging_prepared_references_retained_delete BEFORE DELETE ON staging_prepared_references
 BEGIN SELECT RAISE(ABORT,'STAGING_PREPARED_HISTORY_RETAINED'); END;`);
}

// Persistent staging keeps only durable facts. Native add/change/remove remain
// the browser's single-attempt operations; observing a cart never retries them.
export function createStagingPreparedPublication({db,store,jobs,admin,registry,prepareAuthority,sourceScope,
 now=Date.now,enabled=false,permit=()=>false,record=()=>{}}){
 const policy=preparedPolicy(sourceScope),ledger=store.preparedCart;
 need(db&&ledger&&registry&&typeof prepareAuthority==='function'&&policy.clientPolicy==='bfl-persistent-staging-client-v1','STAGING_PREPARED_REQUIRED');
 const gate=()=>need(enabled===true&&permit(),'STAGING_SERVICE_CLOSED');
 const clean=()=>{const state=store.lifecycle.state();need(!state.pending&&!state.operation&&!registry.status().uncertain,'PREPARED_UNCERTAIN');};
 const rows=owner=>db.prepare(`SELECT p.*,r.reference FROM staging_prepared_references r JOIN cart_prepared_jobs p USING(operation_id)
 WHERE r.owner=? ORDER BY p.generation`).all(owner).map(row=>({...row,ticket:ticketFor(row),reference:JSON.parse(row.reference)}));
 const authenticated=(ticket,cart,marker)=>{
  gate();const session=store.resourceSessions.assert(ticket);
  need(store.resourceSessions.clientPolicy(ticket,sourceScope)===policy.clientPolicy&&cart.owner===ticket.owner,'PREPARED_CLIENT_OWNER_REQUIRED');
  store.cartBinding.observe(cart,marker);return session;
 };
 const originalExpiry=(ticket,context)=>{
  const session=store.resourceSessions.assert(ticket),held=rows(ticket.owner),owned=registry.owned(ticket.owner);
  const previous=held[0]?.expires_at??owned?.originalUntil;
  if(previous!==undefined){need(previous>now()&&previous<=session.expires&&previous<=session.deadline,'PREPARED_EXPIRED');return previous;}
  return leaseDeadline(Math.min(session.expires,session.deadline,now()+policy.leaseMs),now(),context.timezone,{sourceScope}).expires_at;
 };
 const verify=(ticket,cart,marker,{confirm=true,prices=true}={})=>{
  authenticated(ticket,cart,marker);clean();const selected=cart.lines.filter(printLine),owned=registry.owned(ticket.owner),authority=registry.authority();
  if(!selected.length){if(owned)need(owned.state!=='retired'&&owned.originalUntil>now(),'PREPARED_EXPIRED');return;}
  need(owned?.state==='active'&&owned.originalUntil>now()&&isEligibilitySchema(authority?.schema)&&authority.lease.expires_at>now(),'CHECKOUT_RESUME_REJECTED');
  const grant=authority.grants.find(g=>g.binding===marker);
  need(grant&&grant.cart===cartHash(cart.id)&&grant.owner===cartHash(ticket.owner)&&grant.customer_id===cart.customer_id,'CHECKOUT_RESUME_REJECTED');
  const result=inspectCart({leaseOwner:{lease:{value:leaseEnvelope(serializeAuthority(authority))}},shop:{localTime:{beforeDeadline:true}},cart:{binding:{value:marker},buyerIdentity:{isAuthenticated:cart.customer_id!==null,customer:cart.customer_id?{id:cart.customer_id}:null},
   lines:cart.lines.map(line=>({id:line.id,quantity:line.quantity,merchandise:{id:line.variant_id,product:{id:line.product_id}},sellingPlanAllocation:line.selling_plan?{}:null,cost:{amountPerQuantity:{currencyCode:'USD'}},...Object.fromEntries(Object.entries(FULL_PRODUCT_ATTRIBUTES).map(([alias,key])=>[alias,{value:line.properties[key]??''}]))}))}});
  need(result.valid,'CHECKOUT_RESUME_REJECTED');
  if(prices)for(const approved of result.lines){const actual=cart.lines.find(line=>line.id===approved.id);need(actual.subtotal_cents===approved.unit_cents*actual.quantity,'CART_PRICE_UNVERIFIED');}
  if(confirm)for(const row of rows(ticket.owner))if(selected.some(line=>line.reference?.id===row.job_id)){
   need(['issued','confirmed'].includes(row.state),'CHECKOUT_RESUME_REJECTED');
   if(row.state==='issued')ledger.confirm(row.ticket,fingerprint(cart.lines));
  }
 };
 const held=(ticket,cart,reservation)=>{
  const row=rows(ticket.owner).find(row=>row.operation_id===reservation?.operation_id);
  need(row&&fingerprint(row.ticket)===fingerprint(reservation)&&row.owner_hash===cartHash(ticket.owner)&&row.cart_hash===cartHash(cart.id),'PREPARED_OPERATION_CHANGED');return row;
 };
 const fixedLease=(expiry,context)=>({token:randomBytes(32).toString('hex'),...leaseDeadline(expiry,now(),context.timezone,{sourceScope})});
 const observe=async({resourceTicket,cart,marker,readCurrent,guard=()=>{},guardPublication=()=>{}})=>{
  guard();verify(resourceTicket,cart,marker);const owned=registry.owned(resourceTicket.owner);if(owned?.state!=='active')return;
  const history=rows(resourceTicket.owner),present=new Set(cart.lines.filter(printLine).map(line=>line.reference?.id));
  need(!history.some(row=>['reserved','uncertain'].includes(row.state)),'PREPARED_UNCERTAIN');
  const references=history.filter(row=>row.state==='issued'||row.state==='confirmed'&&present.has(row.job_id)).map(row=>row.reference);
  need([...present].every(id=>references.some(reference=>reference.id===id)),'CHECKOUT_RESUME_REJECTED');
  if(fingerprint(references.map(r=>r.id).sort())===fingerprint(owned.grant.lines.map(line=>line.claims.job).sort()))return;
  const assertSame=async()=>{const current=await readCurrent();guard();need(structure(current)===structure(cart),'CART_REFRESH_CHANGED');};
  await assertSame();
  if(!references.length){await registry.release(resourceTicket.owner,{guard,guardPublication});guard();return;}
  await registry.update({owner:resourceTicket.owner,originalUntil:owned.originalUntil,guard,guardPublication,prepare:async context=>{
   await assertSame();return prepareAuthority({cart,context,binding:{marker,generation:Math.max(...history.map(row=>row.generation)),epoch:resourceTicket.epoch},lease:fixedLease(owned.originalUntil,context),references,guard});
  }});guard();await assertSame();verify(resourceTicket,cart,marker);
 };
 return Object.freeze({
  references(owner,{includeCancelled=false}={}){return rows(owner).filter(row=>includeCancelled||['issued','confirmed'].includes(row.state)).map(row=>({...row.reference}));},
  async diagnosePreparation({resourceTicket,cart,marker,readCurrent,guard=()=>{}}){
   // An absent issued grant is not proof that Add never happened. Return only
   // its exact cancellation ticket; cancellation keeps its existing one-shot
   // journal, fresh proof, clear and reconciliation protocol.
   guard();verify(resourceTicket,cart,marker,{confirm:false});
   const history=rows(resourceTicket.owner),issued=history.filter(row=>row.state==='issued');
   need(history.every(row=>['issued','confirmed','cancelled'].includes(row.state)),'PREPARED_UNCERTAIN');
   if(!issued.length){
    // Last-file removal can leave pending/null browser custody with no draft.
    // Read only the authenticated current state; never infer or replay a write.
    const session=store.resourceSessions.assert(resourceTicket),owner=resourceTicket.owner;
    const expiry=history[0]?.expires_at??Math.min(session.expires,session.deadline);
    need(expiry>now()&&expiry<=session.expires&&expiry<=session.deadline&&history.every(row=>
     row.owner_hash===cartHash(owner)&&row.cart_hash===cartHash(cart.id)&&row.expires_at===expiry),'CHECKOUT_RESUME_REJECTED');
    need(db.prepare('SELECT count(*) AS n FROM cart_prepared_jobs WHERE owner_hash=?').get(cartHash(owner)).n===history.length,'PREPARED_UNCERTAIN');
    const settledResources=()=>{
     const intents=db.prepare('SELECT * FROM upload_intents WHERE owner=? ORDER BY id').all(owner);
     const custody=db.prepare('SELECT * FROM staging_upload_custody WHERE owner=? ORDER BY intent').all(owner);
     const saved=db.prepare('SELECT * FROM staging_resource_state WHERE owner=?').get(owner),state=saved?JSON.parse(saved.body):null;
     need(intents.every(row=>['complete','failed','removed'].includes(row.state))&&custody.every(row=>{const intent=intents.find(item=>item.id===row.intent);
      return intent&&row.binding===intent.binding&&typeof row.asset==='string'&&row.asset===intent.asset&&
       (['known','deleted'].includes(row.state)||row.state==='queued'&&['failed','removed'].includes(intent.state));
     }),'PREPARED_UNCERTAIN');
     need(!intents.length&&!state||state?.owner===owner&&Array.isArray(state.intents)&&state.intents.length===intents.length&&new Set(state.intents.map(row=>row.id)).size===intents.length,'PREPARED_UNCERTAIN');
     for(const row of state?.intents??[]){const intent=intents.find(item=>item.id===row.id);
      need(intent&&row.owner===owner&&(row.removed===true||!row.sourcePending&&!row.verifying&&!row.cropPending)&&
       (intent.state!=='complete'||!row.removed&&row.asset===intent.asset&&row.digest===intent.digest),'PREPARED_UNCERTAIN');
     }
     return fingerprint({intents,custody,saved});
    };
    const resources=settledResources(),current=await readCurrent();guard();
    const stable=value=>{const {updated_at,...rest}=value;return fingerprint(rest);};
    need(stable(current)===stable(cart),'CART_REFRESH_CHANGED');verify(resourceTicket,current,marker,{confirm:false});
    need(fingerprint(rows(owner))===fingerprint(history)&&settledResources()===resources,'PREPARED_OPERATION_CHANGED');
    return {recovery:'known-current-v1',expires_at:expiry};
   }
   need(issued.length===1,'PREPARED_UNCERTAIN');
   const row=issued[0],session=store.resourceSessions.assert(resourceTicket);
   need(row.owner_hash===cartHash(resourceTicket.owner)&&row.cart_hash===cartHash(cart.id)&&
    row.expires_at>now()&&row.expires_at<=session.expires&&row.expires_at<=session.deadline&&
    !cart.lines.some(line=>line.reference?.id===row.job_id),'CHECKOUT_RESUME_REJECTED');
   const current=await readCurrent();guard();need(structure(current)===structure(cart),'CART_REFRESH_CHANGED');
   verify(resourceTicket,current,marker,{confirm:false});
   need(fingerprint(rows(resourceTicket.owner))===fingerprint(history),'PREPARED_OPERATION_CHANGED');
   return {recovery:'cancel-issued-absent-v1',reservation:row.ticket,expires_at:row.expires_at};
  },
  async eligible(input){
   const {resourceTicket,cart,marker,reference,generation,readCurrent,guard,guardPublication}=input;
   guard();authenticated(resourceTicket,cart,marker);clean();verify(resourceTicket,cart,marker);
   const history=rows(resourceTicket.owner),present=cart.lines.filter(printLine).map(line=>line.reference?.id);
   need(!history.some(row=>['reserved','uncertain'].includes(row.state)||row.state==='issued'&&!present.includes(row.job_id)),'PREPARED_UNCERTAIN');
   need(!present.includes(reference?.id),'PREPARED_JOB_PRESENT');let reservation,job,expiry;
   try{
    const result=await registry.update({owner:resourceTicket.owner,originalUntil:await (async()=>{const context=await admin.read();guard();return originalExpiry(resourceTicket,context);})(),guard,guardPublication,
     prepare:async context=>{
      authenticated(resourceTicket,cart,marker);expiry=originalExpiry(resourceTicket,context);
      [job]=await jobs.resolveForCheckout(cart.owner,[reference],context.release);guard();
      const before=await readCurrent();guard();need(structure(before)===structure(cart),'CART_REFRESH_CHANGED');
      const prepared=await prepareAuthority({cart,context,binding:{marker,generation,epoch:resourceTicket.epoch},lease:fixedLease(expiry,context),references:[...cart.lines.filter(printLine).map(line=>line.reference),reference],guard});guard();
      return prepared;
     },beforeReserve:async()=>{
      const before=await readCurrent();guard();need(structure(before)===structure(cart),'CART_REFRESH_CHANGED');
      reservation=store.lifecycle.transaction(()=>{
       const entry=ledger.reserve(cart.owner,cart,marker,reference,selectionHash(job),generation,expiry,{sourceScope});need(!entry.replay,'PREPARED_SEND_ALREADY_RESERVED');
       db.prepare('INSERT INTO staging_prepared_references VALUES (?,?,?)').run(entry.ticket.operation_id,cart.owner,JSON.stringify(reference));return entry.ticket;
      });
     }});
    guard();const after=await readCurrent();guard();need(structure(after)===structure(cart),'CART_REFRESH_CHANGED');verify(resourceTicket,after,marker);
    const issued=ledger.issue(reservation,fingerprint(serializeAuthority(result.authority)));
    record({event:'staging_eligibility_published',expires:expiry,checkout_ready:false});
    return {prepared:true,reference,item:{id:job.variant_id,quantity:job.copies,properties:jobProperties(job,reference)},unit_price_cents:job.unit_price_cents,file_count:job.completed_asset_ids.length,reservation:issued.ticket,expires_at:expiry,generation,cart_verified:false,checkout_ready:false};
   }catch(error){if(reservation)try{ledger.uncertain(reservation);}catch{}throw error;}
  },
  async cancel({resourceTicket,cart,marker,reservation,guard,afterClear}){
   guard();authenticated(resourceTicket,cart,marker);clean();const row=held(resourceTicket,cart,reservation);
   need(!cart.lines.some(line=>line.properties?._bfl_job===row.job_id),'PREPARED_JOB_PRESENT');verify(resourceTicket,cart,marker);
   need(typeof afterClear==='function','PREPARED_RESTORE_UNAVAILABLE');ledger.cancel(row.ticket);let fresh;
   await registry.reconcileKnown({excludeJobs:[row.job_id],authorizeInvalidations:events=>events.length===1&&events[0].id==='prepared-cancel:'+row.operation_id,
    afterClear:async()=>{fresh=await afterClear();fresh.guard();authenticated(fresh.resourceTicket,fresh.cart,fresh.marker);need(fresh.resourceTicket.owner===resourceTicket.owner&&fresh.marker===marker&&structure(fresh.cart)===structure(cart),'CART_REFRESH_CHANGED');},
    guard:()=>{need(fresh,'CURRENT_CONTEXT_REQUIRED');fresh.guard();},guardPublication:op=>fresh.guardPublication(op)});
   fresh.guard();const restored=await fresh.readCurrent();fresh.guard();need(structure(restored)===structure(fresh.cart),'CART_REFRESH_CHANGED');
   verify(fresh.resourceTicket,restored,marker);return {cancelled:true,revoked:true,expires_at:row.expires_at,cart_verified:false,checkout_ready:false};
  },
  observeCurrent:observe,
  async recoverResume({resourceTicket,cart,marker,operation,readCurrent,guard=()=>{},guardPublication=()=>{}}){
   const owned=registry.owned(resourceTicket.owner),selected=cart.lines.filter(printLine);
   if(owned?.state!=='suspended'||!selected.length)return;
   guard();const session=authenticated(resourceTicket,cart,marker);clean();
   // An unknown publication suspends every possible owner. Only this owner's
   // new proof may restore its already confirmed, unchanged set of jobs. This
   // never retries a native mutation or authorizes an uncertain preparation.
   need(operation===undefined,'CHECKOUT_RESUME_REJECTED');const history=rows(resourceTicket.owner);
   need(history.length>0&&history.every(row=>['confirmed','cancelled'].includes(row.state)),'PREPARED_UNCERTAIN');
   need(owned.originalUntil===history[0].expires_at&&owned.originalUntil>now()&&owned.originalUntil<=session.expires&&owned.originalUntil<=session.deadline,'PREPARED_EXPIRED');
   need(owned.grant.cart===cartHash(cart.id)&&owned.grant.owner===cartHash(resourceTicket.owner)&&owned.grant.binding===marker&&owned.grant.customer_id===cart.customer_id,'CHECKOUT_RESUME_REJECTED');
   const ids=owned.grant.lines.map(line=>line.claims.job);
   need(fingerprint(selected.map(line=>line.reference?.id).sort())===fingerprint([...ids].sort()),'CHECKOUT_RESUME_REJECTED');
   const references=ids.map(id=>{const row=history.find(row=>row.job_id===id);need(row?.state==='confirmed','CHECKOUT_RESUME_REJECTED');return row.reference;});
   const readSame=async()=>{const current=await readCurrent();guard();need(structure(current)===structure(cart),'CART_REFRESH_CHANGED');return current;};
   await readSame();
   await registry.update({owner:resourceTicket.owner,originalUntil:owned.originalUntil,guard,guardPublication,prepare:async context=>{
    await readSame();const prepared=await prepareAuthority({cart,context,binding:{marker,generation:owned.grant.generation,epoch:resourceTicket.epoch},lease:fixedLease(owned.originalUntil,context),references,guard});guard();
    need(fingerprint(prepared.authority.grants[0].lines)===fingerprint(owned.grant.lines),'CHECKOUT_RESUME_REJECTED');return prepared;
   }});guard();const current=await readSame();verify(resourceTicket,current,marker);
   record({event:'staging_confirmed_cart_restored',expires:owned.originalUntil,checkout_ready:false});return current;
  },
  assertUploadResume(ticket,cart,marker){
   verify(ticket,cart,marker);const history=rows(ticket.owner);need(history.every(row=>['confirmed','cancelled'].includes(row.state)),'UPLOAD_RECOVERY_UNAVAILABLE');const excluded=new Set();
   for(const row of history)if(row.state==='confirmed')for(const id of store.getForRevocation(row.job_id,ticket.owner).completed_asset_ids)excluded.add(id);
   return {excluded_asset_ids:[...excluded].sort(),...(history.length?{expires_at:history[0].expires_at}:{})};
  },
  assertResume(ticket,cart,marker,operation){
   verify(ticket,cart,marker);const history=rows(ticket.owner),expiry=history[0]?.expires_at;
   need(!history.some(row=>['reserved','uncertain'].includes(row.state)),'PREPARED_UNCERTAIN');if(expiry!==undefined)need(expiry>now(),'PREPARED_EXPIRED');
   if(operation&&['prepared','cancel_preparation'].includes(operation.kind)){
    const row=history.find(row=>row.operation_id===operation.operation_id);
    need(row&&row.job_id===operation.job&&row.generation===operation.generation&&row.cart_hash===cartHash(cart.id)&&!cart.lines.some(line=>line.reference?.id===row.job_id),'CHECKOUT_RESUME_REJECTED');
    need(operation.kind==='cancel_preparation'?row.state==='cancelled':['issued','cancelled'].includes(row.state),'CHECKOUT_RESUME_REJECTED');
    return {expires_at:expiry,prepared_recovery:{reservation:row.ticket,state:row.state}};
   }
   if(operation){
    need(['add','change','remove'].includes(operation.kind)&&typeof operation.operation_id==='string'&&typeof operation.job==='string','CHECKOUT_RESUME_REJECTED');
    const row=history.find(row=>row.job_id===operation.job),actual=cart.lines.filter(line=>line.reference?.id===operation.job);need(row,'CHECKOUT_RESUME_REJECTED');
    if(operation.kind==='add')need(row.operation_id===operation.operation_id,'CHECKOUT_RESUME_REJECTED');
    need(operation.kind==='remove'?actual.length===0:actual.length===1&&actual[0].quantity===operation.quantity,'CHECKOUT_RESUME_REJECTED');
   }
   return expiry===undefined?{}:{expires_at:expiry};
  },
 });
}
