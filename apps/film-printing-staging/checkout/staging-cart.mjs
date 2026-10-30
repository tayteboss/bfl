import {randomBytes,randomUUID} from 'node:crypto';
import {need} from '../backend/config.mjs';
import {cartHash,printLine,requireCartLocator} from './storefront.mjs';
import {fingerprint} from '../jobs/lifecycle.mjs';
import {preparedPolicy,preparedOwnerPolicy} from './prepared-limits.mjs';

export function installStagingCartSchema(db){
 db.exec(`CREATE TABLE staging_capability_attempts (
  id TEXT PRIMARY KEY, owner_hash TEXT NOT NULL UNIQUE, cart_hash TEXT NOT NULL,
  locator_hash TEXT NOT NULL, proof_hash TEXT NOT NULL UNIQUE,
  session_generation INTEGER NOT NULL, epoch INTEGER NOT NULL, created INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('reading','sending','unknown','rejected','capability_only')),
  sealed_cart TEXT NOT NULL, snapshot_hash TEXT);
 CREATE INDEX staging_capability_cart ON staging_capability_attempts(cart_hash);
 CREATE TABLE staging_cart_replacements (
  old_owner TEXT PRIMARY KEY, new_owner TEXT UNIQUE, cart_hash TEXT NOT NULL,
  old_marker TEXT NOT NULL, created INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('reserved','removed','issued')));
 CREATE TABLE staging_binding_history (
  marker TEXT PRIMARY KEY, cart_hash TEXT NOT NULL, owner_hash TEXT NOT NULL,
  identity_hash TEXT NOT NULL, state TEXT NOT NULL, retired_at INTEGER NOT NULL);
 CREATE TRIGGER staging_binding_history_update BEFORE UPDATE ON staging_binding_history
 BEGIN SELECT RAISE(ABORT,'STAGING_BINDING_HISTORY_RETAINED'); END;
 CREATE TRIGGER staging_binding_history_delete BEFORE DELETE ON staging_binding_history
 BEGIN SELECT RAISE(ABORT,'STAGING_BINDING_HISTORY_RETAINED'); END;`);
}

// New persistent owners only. Historical experimental admissions keep their
// original tables and permanent replay exclusions. A terminal replacement needs
// an exact authenticated empty-cart handoff, never merely an expired timestamp.
export function createStagingCartLedgers({db,store,sourceScope,now=Date.now}){
 need(preparedPolicy(sourceScope).clientPolicy==='bfl-persistent-staging-client-v1','STAGING_CART_POLICY');
 const lifecycle=store.lifecycle,sessions=store.resourceSessions,tx=lifecycle.transaction;
 const clean=()=>{const state=lifecycle.state();need(!state.pending&&!state.operation,'AUTHORITY_PENDING');return state;};
 const member=t=>{sessions.assert(t);need(preparedOwnerPolicy(db,t.owner,sourceScope).clientPolicy==='bfl-persistent-staging-client-v1','STAGING_CART_POLICY');
  const row=db.prepare('SELECT * FROM checkout_owner_admissions WHERE owner=?').get(t.owner);need(row,'CART_NEW_OWNER_REQUIRED');return row;};
 const attempt=id=>db.prepare('SELECT * FROM staging_capability_attempts WHERE id=?').get(id);
 // Every ancestor must be an actually issued same-cart terminal handoff.
 // Unbound intermediate owners have no attempt to repeat, but retain lineage.
 const replacementLineage=(current,cart)=>{
  const owners=new Set([current]),hashes=new Set();let row;
  while((row=db.prepare("SELECT * FROM staging_cart_replacements WHERE new_owner=? AND state='issued'").get(current))){
   need(row.cart_hash===cart&&!owners.has(row.old_owner),'CART_CAPABILITY_REPLAY');
   current=row.old_owner;owners.add(current);hashes.add(cartHash(current));
  }
  return hashes;
 };
 const owner={member,
  reserve(t,id){return tx(()=>{const row=member(t),a=attempt(id);need(!row.attempt_id&&a?.state==='reading'&&a.owner_hash===cartHash(t.owner)&&a.session_generation===t.generation&&a.epoch===t.epoch,'CART_OWNER_REPLAY');db.prepare('UPDATE checkout_owner_admissions SET attempt_id=? WHERE owner=?').run(id,t.owner);});},
  complete(t,id){return tx(()=>{const row=member(t),a=attempt(id);need(row.attempt_id===id&&!row.binding_id&&a?.state==='sending'&&a.owner_hash===cartHash(t.owner)&&a.session_generation===t.generation&&a.epoch===t.epoch,'CART_OWNER_REJECTED');db.prepare('UPDATE checkout_owner_admissions SET binding_id=? WHERE owner=?').run(id,t.owner);return id;});},
  bound(t){const row=member(t),a=attempt(row.attempt_id);need(row.binding_id===a?.id&&a?.state==='capability_only','CART_OWNER_UNAVAILABLE');return {...a,binding_id:row.binding_id};},
 };
 const capability={
  reserve({ticket,cart_id,proofId,created,sealed}){return tx(()=>{
   need(clean().epoch===ticket.epoch,'CART_CAPABILITY_FENCED');member(ticket);requireCartLocator(cart_id);
   const ownerHash=cartHash(ticket.owner),cart=cartHash(cart_id),locator=cartHash(cart_id.split('?')[0]);
   need(!db.prepare('SELECT 1 FROM staging_capability_attempts WHERE owner_hash=? OR proof_hash=?').get(ownerHash,cartHash(proofId)),'CART_CAPABILITY_REPLAY');
   for(const table of ['cart_capability_attempts','checkout_capability_attempts'])need(!db.prepare(`SELECT 1 FROM ${table} WHERE cart_hash=? OR locator_hash=?`).get(cart,locator),'CART_CAPABILITY_REPLAY');
   const prior=db.prepare('SELECT * FROM staging_capability_attempts WHERE cart_hash=? OR locator_hash=? ORDER BY created,id').all(cart,locator);
   const ancestors=replacementLineage(ticket.owner,cart);
   if(prior.length){
    need(ancestors.size>0&&prior.every(row=>row.cart_hash===cart&&row.state==='capability_only'&&ancestors.has(row.owner_hash)),'CART_CAPABILITY_REPLAY');
   }
   const id=randomUUID();db.prepare('INSERT INTO staging_capability_attempts VALUES (?,?,?,?,?,?,?,?,?,?,NULL)').run(id,ownerHash,cart,locator,cartHash(proofId),ticket.generation,ticket.epoch,created,'reading',sealed);return id;
  });},
  sending(id,snapshot){return tx(()=>{need(attempt(id)?.state==='reading','CART_CAPABILITY_REPLAY');db.prepare("UPDATE staging_capability_attempts SET state='sending',snapshot_hash=? WHERE id=?").run(snapshot,id);});},
  finish(id,state){return tx(()=>{need(['reading','sending'].includes(attempt(id)?.state)&&['rejected','unknown','capability_only'].includes(state),'CART_CAPABILITY_REPLAY');db.prepare('UPDATE staging_capability_attempts SET state=? WHERE id=?').run(state,id);});},
  status(id,ticket){const row=attempt(id);member(ticket);need(row?.owner_hash===cartHash(ticket.owner)&&row.session_generation===ticket.generation&&clean().epoch===ticket.epoch,'CART_CAPABILITY_FENCED');return {state:['reading','sending'].includes(row.state)?'unknown':row.state,cart_verified:false,checkout_ready:false};},
 };
 const identity=cart=>{
  requireCartLocator(cart.id);need(cart.complete===true&&typeof cart.owner==='string'&&typeof cart.binding_id==='string'&&cart.customer_id===null,'BINDING_OWNER_UNPROVEN');
  const ticket=sessions.ticketForOwner(cart.owner);need(owner.bound(ticket).binding_id===cart.binding_id,'BINDING_OWNER_UNPROVEN');
  return {cart_hash:cartHash(cart.id),owner_hash:cartHash(cart.owner),identity_hash:fingerprint({owner:cart.owner,binding:cart.binding_id,customer:cart.customer_id})};
 };
 const bindingRow=cart=>{const i=identity(cart),row=db.prepare('SELECT * FROM cart_checkout_bindings WHERE cart_hash=?').get(i.cart_hash);need(row&&row.owner_hash===i.owner_hash&&row.identity_hash===i.identity_hash,'BINDING_REBIND_FORBIDDEN');return row;};
 const binding={
  reserve(cart){return tx(()=>{clean();const i=identity(cart);need(!cart.lines.some(printLine),'BINDING_EXISTING_PRINTS');
   need(!db.prepare('SELECT 1 FROM cart_checkout_bindings WHERE cart_hash=? OR owner_hash=?').get(i.cart_hash,i.owner_hash),'BINDING_ATTEMPT_SPENT');
   const marker=randomBytes(32).toString('hex');db.prepare('INSERT INTO cart_checkout_bindings VALUES (?,?,?,?,?)').run(i.cart_hash,i.owner_hash,i.identity_hash,marker,'reserved');return marker;
  });},
  sending(cart,marker){return tx(()=>{const epoch=clean().epoch,row=bindingRow(cart);need(row.marker===marker&&row.state==='reserved','BINDING_ATTEMPT_SPENT');db.prepare("UPDATE cart_checkout_bindings SET state='sending' WHERE marker=?").run(marker);return epoch;});},
  confirm(cart,marker,epoch){return tx(()=>{need(clean().epoch===epoch,'BINDING_FENCED');const row=bindingRow(cart);need(row.marker===marker&&row.state==='sending','BINDING_ATTEMPT_SPENT');db.prepare("UPDATE cart_checkout_bindings SET state='confirmed' WHERE marker=?").run(marker);});},
  observe(cart,marker){clean();const row=bindingRow(cart);need(row.state==='confirmed'&&row.marker===marker,'BINDING_UNAVAILABLE');return {marker};},
  retire(marker){return tx(()=>{const row=db.prepare('SELECT * FROM cart_checkout_bindings WHERE marker=?').get(marker);need(row,'BINDING_UNAVAILABLE');db.prepare("UPDATE cart_checkout_bindings SET state='retired' WHERE marker=?").run(marker);});},
 };
 const replacements={
  original(terminal){
   need(terminal.expires<=now()&&terminal.deadline<=now()&&preparedOwnerPolicy(db,terminal.owner,sourceScope).clientPolicy==='bfl-persistent-staging-client-v1','RESOURCE_REJECTED');
   const admission=db.prepare('SELECT * FROM checkout_owner_admissions WHERE owner=?').get(terminal.owner),a=attempt(admission?.attempt_id);
   need(admission,'CART_OWNER_UNAVAILABLE');
   const ownerHash=cartHash(terminal.owner),binding=db.prepare('SELECT * FROM cart_checkout_bindings WHERE owner_hash=?').get(ownerHash);
   if(admission.attempt_id===null&&admission.binding_id===null&&!binding){
    need(!db.prepare('SELECT 1 FROM staging_capability_attempts WHERE owner_hash=?').get(ownerHash),'CART_OWNER_UNAVAILABLE');
    return {unbound:true,binding:null};
   }
   need(a?.state==='capability_only'&&a.owner_hash===ownerHash&&admission.binding_id===a.id,'CART_OWNER_UNAVAILABLE');
   return {...a,binding};
  },
  issueUnmarked(terminal,cart,evidence){return tx(()=>{
   need(clean().epoch===terminal.epoch,'RESOURCE_FENCED');const prior=replacements.original(terminal);
   requireCartLocator(cart.id);const ownerHash=cartHash(terminal.owner),hash=cartHash(cart.id),locator=cartHash(cart.id.split('?')[0]);
   need(!prior.binding&&cart.complete===true&&cart.customer_id===null&&!cart.lines.some(printLine)&&
    (prior.unbound===true||prior.cart_hash===hash),'STAGING_REPLACEMENT_REJECTED');
   need(!db.prepare('SELECT 1 FROM staging_cart_replacements WHERE old_owner=?').get(terminal.owner),'STAGING_REPLACEMENT_SPENT');
   need(!db.prepare('SELECT 1 FROM cart_checkout_bindings WHERE cart_hash=? OR owner_hash=?').get(hash,ownerHash),'STAGING_REPLACEMENT_REJECTED');
   for(const table of ['cart_capability_attempts','checkout_capability_attempts'])need(!db.prepare(`SELECT 1 FROM ${table} WHERE cart_hash=? OR locator_hash=?`).get(hash,locator),'CART_CAPABILITY_REPLAY');
   const attempts=db.prepare('SELECT * FROM staging_capability_attempts WHERE cart_hash=? OR locator_hash=?').all(hash,locator);
   const ancestors=replacementLineage(terminal.owner,hash);if(!prior.unbound)ancestors.add(ownerHash);
   need((prior.unbound===true||attempts.some(row=>row.id===prior.id))&&attempts.every(row=>row.cart_hash===hash&&row.state==='capability_only'&&ancestors.has(row.owner_hash)),'CART_CAPABILITY_REPLAY');
   // Initialization only: even cancelled/terminal resources or grant history
   // exclude this path. Nothing from the expired principal is transferred.
   for(const table of ['jobs','uploads','upload_intents','staging_resource_state','staging_upload_custody','staging_prepared_references','staging_grant_versions'])
    need(!db.prepare(`SELECT 1 FROM ${table} WHERE owner=?`).get(terminal.owner),'STAGING_REPLACEMENT_REJECTED');
   need(!db.prepare("SELECT 1 FROM resource_admissions WHERE owner=? AND kind IN ('jobs','uploads')").get(terminal.owner)&&
    !db.prepare('SELECT 1 FROM cart_prepared_jobs WHERE owner_hash=?').get(ownerHash),'STAGING_REPLACEMENT_REJECTED');
   // Empty old_marker explicitly means no marker ever reserved. This branch
   // has no native deletion and commits its one-shot receipt with issuance.
   db.prepare('INSERT INTO staging_cart_replacements VALUES (?,NULL,?,?,?,?)').run(terminal.owner,hash,'',now(),'removed');
   const receipt=sessions.issue(evidence,{ttlMs:preparedPolicy(sourceScope).ownerMs,sourceScope});
   const next=sessions.authenticate({headers:{origin:'https://bellows-film-printing-staging.myshopify.com',authorization:'Bearer '+receipt.token}});
   db.prepare("UPDATE staging_cart_replacements SET new_owner=?,state='issued' WHERE old_owner=?").run(next.owner,terminal.owner);
   return {...receipt,replaced:true};
  });},
  reserve(terminal,cart){return tx(()=>{
   clean();const prior=replacements.original(terminal);need(prior.cart_hash===cartHash(cart.id)&&cart.complete===true&&!cart.lines.some(printLine)&&prior.binding?.state==='confirmed','STAGING_REPLACEMENT_REJECTED');
   need(!db.prepare('SELECT 1 FROM staging_cart_replacements WHERE old_owner=?').get(terminal.owner),'STAGING_REPLACEMENT_SPENT');
   need(!db.prepare("SELECT 1 FROM cart_prepared_jobs WHERE owner_hash=? AND state IN ('reserved','uncertain')").get(cartHash(terminal.owner)),'PREPARED_UNCERTAIN');
   db.prepare('INSERT INTO staging_cart_replacements VALUES (?,NULL,?,?,?,?)').run(terminal.owner,prior.cart_hash,prior.binding.marker,now(),'reserved');return prior.binding.marker;
  });},
  removed(terminal){return tx(()=>{clean();const row=db.prepare('SELECT * FROM staging_cart_replacements WHERE old_owner=?').get(terminal.owner);need(row?.state==='reserved','STAGING_REPLACEMENT_SPENT');db.prepare("UPDATE staging_cart_replacements SET state='removed' WHERE old_owner=?").run(terminal.owner);});},
  issue(terminal,evidence){return tx(()=>{
   clean();const row=db.prepare('SELECT * FROM staging_cart_replacements WHERE old_owner=?').get(terminal.owner);need(row?.state==='removed','STAGING_REPLACEMENT_SPENT');
   const current=db.prepare('SELECT * FROM cart_checkout_bindings WHERE marker=?').get(row.old_marker);need(current?.owner_hash===cartHash(terminal.owner)&&current.cart_hash===row.cart_hash,'BINDING_REBIND_FORBIDDEN');
   db.prepare('INSERT INTO staging_binding_history VALUES (?,?,?,?,?,?)').run(current.marker,current.cart_hash,current.owner_hash,current.identity_hash,current.state,now());
   db.prepare('DELETE FROM cart_checkout_bindings WHERE marker=?').run(current.marker);
   const receipt=sessions.issue(evidence,{ttlMs:preparedPolicy(sourceScope).ownerMs,sourceScope});
   const next=sessions.authenticate({headers:{origin:'https://bellows-film-printing-staging.myshopify.com',authorization:'Bearer '+receipt.token}});
   db.prepare("UPDATE staging_cart_replacements SET new_owner=?,state='issued' WHERE old_owner=?").run(next.owner,terminal.owner);
   return {...receipt,replaced:true};
  });},
 };
 return {checkoutOwner:owner,checkoutCapability:capability,cartBinding:binding,replacements};
}
