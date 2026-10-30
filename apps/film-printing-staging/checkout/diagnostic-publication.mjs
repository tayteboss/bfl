// Bounded private diagnostic publication. Not mounted by backend/main or serving.
// A remote grant has no TTL in the Function contract: expiry requires verified
// clearing. A crash/partition can delay that clearing; readiness is never true.
import {need} from '../backend/config.mjs';
import {fingerprint} from '../jobs/lifecycle.mjs';

export function createDiagnosticPublication({store,admin,now=Date.now,until,publicationLimit=1,enabled=false,permit=()=>false,record=()=>{},armPublication,unpublishedOwner}){
 need([1,2,4].includes(publicationLimit),'DIAGNOSTIC_PUBLICATION_LIMIT');
 let accepted=null,spent=0,lease=null,clearing=null,cleared=false;
 const gate=()=>need(enabled===true&&permit()&&now()<until,'DIAGNOSTIC_CLOSED');
 const retire=async()=>{
  need(enabled===true,'DIAGNOSTIC_CLOSED');
  if(clearing)return clearing;
  if(cleared&&!store.lifecycle.state().pending&&!store.lifecycle.state().operation)return;
  clearing=(async()=>{
   if(lease){
    store.revoke({id:`diagnostic-owner:${lease.ticket.owner}`,kind:'owner',owner:lease.ticket.owner});
    store.cartBinding.retire(lease.marker);
   }
   store.resourceSessions.retireExpiredCartOwners();
   await admin.reconcile();
   record({event:'authority_cleared',checkout_ready:false});lease=null;cleared=true;
  })();
  try{await clearing;}finally{clearing=null;}
 };
 return Object.freeze({
  async reconcileUnpublished(){
   const s=store.lifecycle.state();
   if(!unpublishedOwner||spent||lease||clearing||cleared||!s.pending||s.operation)return;
   // A file can be removed before any authority is published. Clear its
   // revocation durably, retaining only the same still-live original owner.
   // Unknown publication, expiry and every post-publication event still retire.
   gate();unpublishedOwner();await admin.reconcile();unpublishedOwner();gate();
   record({event:'unpublished_resources_reconciled',checkout_ready:false});
  },
  async publish({ticket,cart,prepared,readCurrent,guard,resourceTicket,guardPublication}){
   accepted=null;gate();need(spent<publicationLimit&&!cleared&&!clearing,'DIAGNOSTIC_PUBLICATION_SPENT');spent++;
   const session=store.resourceSessions.assert(resourceTicket);
   const grant=prepared.authority.grants.find(g=>g.binding);
   need(prepared.authority.schema===2&&prepared.authority.grants.length===1&&grant,'DIAGNOSTIC_GRANT_REQUIRED');
   if(lease)need(lease.ticket.owner===resourceTicket.owner&&lease.ticket.verifier===resourceTicket.verifier&&lease.ticket.generation===resourceTicket.generation&&lease.marker===grant.binding&&now()<lease.expires,'DIAGNOSTIC_LEASE_CHANGED');
   lease={ticket:resourceTicket,marker:grant.binding,expires:lease?.expires??Math.min(session.expires,session.deadline,until,now()+240000)};
   record({event:'publication_reserved',expires:lease.expires,checkout_ready:false});
   const before=await readCurrent();guard();gate();
   need(fingerprint(before)===fingerprint(cart),'CART_REFRESH_CHANGED');
   store.cartRefresh.publishing(ticket,before,prepared.value);
   need(typeof armPublication==='function','DIAGNOSTIC_TRANSPORT_REQUIRED');
   armPublication(prepared,guardPublication);
   await admin.publish(prepared);guard();gate();
   const after=await readCurrent();guard();gate();
   need(fingerprint(after)===fingerprint(cart),'CART_REFRESH_CHANGED');
   const result=store.cartRefresh.finish(ticket,'published_unverified');
   accepted={owner:resourceTicket.owner,marker:grant.binding,lines:cart.lines.map(line=>{
    const approved=grant.lines.find(l=>l.claims.job===line.properties._bfl_job);
    need(approved&&approved.quantity===line.quantity,'CHECKOUT_RESUME_REJECTED');
    return {...line,subtotal_cents:approved.unit_cents*line.quantity};
   })};
   record({event:'published_unverified',expires:lease.expires,checkout_ready:false});
   return {...result,cart_verified:false};
  },
  assertResume(ticket,cart,marker){
   gate();store.resourceSessions.assert(ticket);
   need(accepted&&lease&&!cleared&&!clearing&&now()<lease.expires&&accepted.owner===ticket.owner&&
    ['owner','verifier','generation'].every(k=>lease.ticket[k]===ticket[k])&&accepted.marker===marker&&
    cart.lines.length>0&&fingerprint(cart.lines)===fingerprint(accepted.lines),'CHECKOUT_RESUME_REJECTED');
  },
  async maintenance(){
   if(enabled!==true)return;
   store.resourceSessions.retireExpiredCartOwners();
   let invalid=now()>=until;
   if(lease){try{store.resourceSessions.assert(lease.ticket);}catch{invalid=true;}invalid||=now()>=lease.expires;}
   if(invalid&&!cleared||store.lifecycle.state().pending||store.lifecycle.state().operation)await retire();
  },
  retirementDue({busy=false}={}){
   if(enabled!==true||cleared)return false;
   if(now()>=until||lease&&now()>=lease.expires)return true;
   if(lease&&store.lifecycle.retired('owner',lease.ticket.owner))return true;
   if(!busy){
    if(lease)try{store.resourceSessions.assert(lease.ticket);}catch{return true;}
    const s=store.lifecycle.state();return !!(s.pending||s.operation);
   }
   return false;
  },
  retire,
  status:()=>({publication_spent:spent>=publicationLimit,lease_active:!!lease,expires:lease?.expires??null,checkout_ready:false}),
 });
}
