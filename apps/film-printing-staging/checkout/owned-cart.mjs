import {cartHash,bindCurrentCart} from './storefront.mjs';
import {createCartCapabilityAdapter,openCartCapability,capabilitySnapshot,CAPABILITY_ACTION} from './cart-capability.mjs';
import {STORE} from './authority.js';
import {need} from '../backend/config.mjs';

// Additive schema9: membership is inserted ONLY with a new resource issuance.
// No backfill/promotion. Same purpose, narrower permitted resources, same DB.
export function installOwnedCartSchema(db,{checkout=false}={}){
 const table=checkout?'checkout_owner_admissions':'cart_owner_admissions',prefix=checkout?'checkout_owner':'cart_owner';
 db.exec(`CREATE TABLE ${table} (owner TEXT PRIMARY KEY, created INTEGER NOT NULL,
  attempt_id TEXT UNIQUE, binding_id TEXT UNIQUE);
  CREATE TRIGGER ${prefix}_immutable BEFORE UPDATE OF owner,created ON ${table}
  BEGIN SELECT RAISE(ABORT,'CART_OWNER_IMMUTABLE'); END;
  CREATE TRIGGER ${prefix}_retained BEFORE DELETE ON ${table}
  BEGIN SELECT RAISE(ABORT,'CART_OWNER_RETAINED'); END;`);
 if(!checkout)for(const table of ['jobs','uploads','upload_intents'])for(const op of ['INSERT','UPDATE'])
  db.exec(`CREATE TRIGGER ${prefix}_${table}_${op.toLowerCase()} BEFORE ${op} ON ${table}
   WHEN EXISTS(SELECT 1 FROM cart_owner_admissions WHERE owner=NEW.owner)
   BEGIN SELECT RAISE(ABORT,'CART_OWNER_RESOURCE_CLOSED'); END;`);
}
export function createOwnedCartLedger(db,lifecycle,sessions,{checkout=false}={}){
 const table=checkout?'checkout_owner_admissions':'cart_owner_admissions',attempts=checkout?'checkout_capability_attempts':'cart_capability_attempts';
 const member=t=>{sessions.assert(t);const r=db.prepare(`SELECT * FROM ${table} WHERE owner=?`).get(t.owner);need(r,'CART_NEW_OWNER_REQUIRED');return r;};
 const attempt=r=>db.prepare(`SELECT * FROM ${attempts} WHERE id=?`).get(r.attempt_id);
 return Object.freeze({
  member,
  reserve(t,id){return lifecycle.transaction(()=>{
   const r=member(t);need(!r.attempt_id,'CART_OWNER_REPLAY');
   // One permanent send admission for this finite composition. No window/reset
   // option can erase a lost response or authorize a second attempt on restart.
   if(!checkout)need(!db.prepare(`SELECT 1 FROM ${table} WHERE attempt_id IS NOT NULL`).get(),'CART_OWNER_CAPACITY');
   const a=db.prepare(`SELECT * FROM ${attempts} WHERE id=?`).get(id);
   need(a?.state==='reading'&&a.owner_hash===cartHash(t.owner)&&a.session_generation===t.generation&&a.epoch===t.epoch,'CART_OWNER_REJECTED');
   db.prepare(`UPDATE ${table} SET attempt_id=? WHERE owner=?`).run(id,t.owner);
  });},
  complete(t,id){return lifecycle.transaction(()=>{
   const r=member(t),a=attempt(r);need(r.attempt_id===id&&!r.binding_id&&a?.state==='sending'&&a.session_generation===t.generation&&a.epoch===t.epoch,'CART_OWNER_REJECTED');
   const binding=id;db.prepare(`UPDATE ${table} SET binding_id=? WHERE owner=?`).run(binding,t.owner);
   return binding;
  });},
  bound(t){const r=member(t),a=attempt(r);need(r.binding_id&&a?.state==='capability_only'&&(checkout||a.epoch===t.epoch),'CART_OWNER_UNAVAILABLE');return {...a,binding_id:r.binding_id};},
 });
}
export function createOwnedCart({store,proofs,transport,custodySecret,resolveBuyerIp,now=Date.now,permit=()=>true}){
 const sessions=store.resourceSessions,ledger=store.ownedCart;
 need(ledger,'CART_OWNER_COMPOSITION');
 const adapter=createCartCapabilityAdapter({store,proofs,transport,custodySecret,resolveBuyerIp,now,permit,
  owned:{reserve:ledger.reserve,complete:ledger.complete}});
 return Object.freeze({
  async bind({request,proof,cart_id}){
   const ticket=sessions.authenticate(request);ledger.member(ticket);
   return adapter.bind({request,proof,cart_id});
  },
  async status({request,proof,cart_id}){
   const t=sessions.authenticate(request),r=ledger.bound(t);
   const e=proofs.observeFreshContext({request,proof,action:CAPABILITY_ACTION,ticket:t});sessions.assertCartContext(t,e);
   // Client must still possess the exact capability. Custody never becomes a
   // recovery endpoint or a key/locator oracle for another application owner.
   need(cart_id===openCartCapability(r.sealed_cart,custodySecret),'CART_OWNER_REJECTED');
   const guard=()=>{need(permit(),'CART_WINDOW_CLOSED');sessions.assertCartContext(t,e);ledger.bound(t);};
   const buyerIp=await resolveBuyerIp(request);guard();
   const current=await transport.read({cart_id,buyerIp});guard();
   need(current.parsed.customer_id===null,'CART_CUSTOMER_PROOF_UNAVAILABLE');
   need(capabilitySnapshot(current.raw)===r.snapshot_hash,'CART_CAPABILITY_CHANGED');
   // Status describes the durable relationship only. A read is not a repeated
   // capability mutation, atomic browser identity, or current checkout proof.
   return {binding_id:r.binding_id,owned:true,owner_kind:'application',generation:t.generation,
    observed_customer_account:'absent',cart_verified:false,checkout_ready:false};
  },
 });
}
// Concrete short-lived evidence consumed only by the strict existing binder.
// Never exported as a public verifier or installed on refresh/publication routes.
export async function bindOwnedObservation({cart,ticket,e,binding,now}){
 const observed=now();
 return bindCurrentCart({read:async()=>cart,request:null,owner:ticket.owner,cart_id:cart.id,now,
  verifyOwnership:async({owner,cart:seen})=>{
   need(owner===ticket.owner&&seen===cart&&cart.customer_id===null,'CART_OWNER_REJECTED');
   return {store:STORE,owner,cart_hash:cartHash(cart.id),customer_id:null,customer_context:'no_customer_account',
    capability:'verified',binding_id:binding,verified_at:observed,expires_at:Math.min(observed+30000,e.observedAt+30000),
    kind:'application_owner',ownership_basis:'new_application_owner_and_verified_capability'};
  }});
}
