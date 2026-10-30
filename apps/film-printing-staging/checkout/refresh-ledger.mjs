import {cartHash,requireCartLocator} from './storefront.mjs';
import {fingerprint} from '../jobs/lifecycle.mjs';
import {need} from '../backend/config.mjs';

export const refreshTables=['cart_refresh_requests','cart_job_bindings'];
export function installRefreshSchema(db) {
  db.exec(`CREATE TABLE cart_refresh_requests (
    cart_hash TEXT NOT NULL, generation INTEGER NOT NULL, request_hash TEXT NOT NULL,
    owner_hash TEXT NOT NULL, epoch INTEGER NOT NULL, state TEXT NOT NULL,
    binding_hash TEXT, snapshot_hash TEXT, value_hash TEXT,
    PRIMARY KEY(cart_hash,generation), UNIQUE(cart_hash,request_hash));
    CREATE TABLE cart_job_bindings (job_id TEXT PRIMARY KEY, cart_hash TEXT NOT NULL, owner_hash TEXT NOT NULL);`);
}

// One database, the existing synchronous lifecycle transaction, no second lock.
// Capabilities, customer IDs, session IDs and full cart bodies are never persisted.
export function createRefreshLedger(db,lifecycle) {
  const row=t=>db.prepare('SELECT * FROM cart_refresh_requests WHERE cart_hash=? AND generation=?').get(t.cart_hash,t.generation);
  const latest=hash=>db.prepare('SELECT MAX(generation) AS n FROM cart_refresh_requests WHERE cart_hash=?').get(hash).n??0;
  const current=t=>{
    const r=row(t);need(r&&r.owner_hash===t.owner_hash&&r.generation===latest(t.cart_hash),'CART_REFRESH_STALE');return r;
  };
  const fresh=t=>{
    const r=current(t),s=lifecycle.state();
    need(r.epoch===s.epoch&&!s.pending&&!s.operation,'CART_REFRESH_FENCED');return r;
  };
  const receipt=r=>({generation:r.generation,state:r.state,checkout_ready:false});
  const recovered=()=>{
    const s=lifecycle.state();need(!s.pending&&!s.operation,'RECOVERY_REQUIRED');
    // Only an exact successful remote clearing advances recovery. No TTL unlock.
    db.prepare("UPDATE cart_refresh_requests SET state='revoked' WHERE epoch<? AND state!='invalidated'").run(s.epoch);
  };
  return {
    begin(owner,id,requestKey,{replaceSettled=false}={}) {return lifecycle.transaction(()=>{
      requireCartLocator(id);
      need(typeof owner==='string'&&owner.length>0&&owner.length<=200&&typeof requestKey==='string'&&/^[a-zA-Z0-9_-]{8,128}$/.test(requestKey),'CART_REQUEST_INVALID');
      need(!lifecycle.retired('owner',owner),'CART_OWNER_REJECTED');
      const hash=cartHash(id),ownerHash=cartHash(owner),requestHash=cartHash(requestKey);
      const prior=db.prepare('SELECT * FROM cart_refresh_requests WHERE cart_hash=? AND request_hash=?').get(hash,requestHash);
      if(prior){need(prior.owner_hash===ownerHash,'CART_REQUEST_CONFLICT');current(prior);return {ticket:prior,replay:true};}
      need(db.prepare('SELECT COUNT(*) AS n FROM cart_refresh_requests').get().n<10000,'CART_REFRESH_CAPACITY');
      const generation=latest(hash)+1;
      need(Number.isSafeInteger(generation),'CART_REFRESH_CAPACITY');
      const ticket={cart_hash:hash,generation,owner_hash:ownerHash};
      const state=lifecycle.state(),previous=db.prepare('SELECT * FROM cart_refresh_requests WHERE cart_hash=? ORDER BY generation DESC LIMIT 1').get(hash);
      const clean=replaceSettled&&!state.pending&&!state.operation&&
        !db.prepare("SELECT 1 FROM cart_refresh_requests WHERE state IN ('invalidating','reading','prepared','publishing') LIMIT 1").get()&&
        (!previous||previous.owner_hash===ownerHash&&previous.state==='published_unverified'&&previous.epoch===state.epoch);
      if(clean){
        db.prepare('INSERT INTO cart_refresh_requests VALUES (?,?,?,?,?,?,NULL,NULL,NULL)').run(hash,generation,requestHash,ownerHash,state.epoch,'reading');
        return {ticket:{...row(ticket),cleanReplacement:true},replay:false};
      }
      // Supersedes even a delayed/in-flight refresh. Conservatively clear the
      // bounded entire registry BEFORE reading/rebuilding any changed cart.
      lifecycle.event(`cart-refresh:${hash}:${generation}`,ticket,()=>{
        db.prepare('INSERT INTO cart_refresh_requests VALUES (?,?,?,?,?,?,NULL,NULL,NULL)').run(hash,generation,requestHash,ownerHash,lifecycle.state().epoch+1,'invalidating');
      });
      return {ticket:row(ticket),replay:false};
    });},
    recovered(){return lifecycle.transaction(recovered);},
    reading(ticket){return lifecycle.transaction(()=>{
      current(ticket);recovered();
      db.prepare("UPDATE cart_refresh_requests SET epoch=?,state='reading' WHERE cart_hash=? AND generation=?").run(lifecycle.state().epoch,ticket.cart_hash,ticket.generation);
      return row(ticket);
    });},
    assertCurrent:fresh,
    stage(ticket,cart,value){return lifecycle.transaction(()=>{
      need(fresh(ticket).state==='reading','CART_REFRESH_STALE');
      const binding=fingerprint({owner:cart.owner,customer:cart.customer_id,binding:cart.binding_id});
      const prior=db.prepare('SELECT binding_hash FROM cart_refresh_requests WHERE cart_hash=? AND owner_hash=? AND binding_hash IS NOT NULL ORDER BY generation DESC LIMIT 1').get(ticket.cart_hash,ticket.owner_hash);
      need(!prior||prior.binding_hash===binding,'CART_REBIND_REQUIRED');
      for(const line of cart.lines.filter(l=>l.reference)) {
        db.prepare('INSERT OR IGNORE INTO cart_job_bindings VALUES (?,?,?)').run(line.reference.id,ticket.cart_hash,ticket.owner_hash);
        const bound=db.prepare('SELECT * FROM cart_job_bindings WHERE job_id=?').get(line.reference.id);
        need(bound.cart_hash===ticket.cart_hash&&bound.owner_hash===ticket.owner_hash,'CART_JOB_REPLAY');
      }
      db.prepare("UPDATE cart_refresh_requests SET state='prepared',binding_hash=?,snapshot_hash=?,value_hash=? WHERE cart_hash=? AND generation=?")
        .run(binding,fingerprint(cart),fingerprint(value),ticket.cart_hash,ticket.generation);
      return row(ticket);
    });},
    publishing(ticket,cart,value){return lifecycle.transaction(()=>{
      const r=fresh(ticket);
      need(r.state==='prepared'&&r.snapshot_hash===fingerprint(cart)&&r.value_hash===fingerprint(value),'CART_REFRESH_CHANGED');
      db.prepare("UPDATE cart_refresh_requests SET state='publishing' WHERE cart_hash=? AND generation=?").run(ticket.cart_hash,ticket.generation);
    });},
    finish(ticket,state){return lifecycle.transaction(()=>{
      const r=fresh(ticket);
      need(state==='published_unverified'&&r.state==='publishing'||state==='revoked'&&r.state==='reading','CART_REFRESH_STALE');
      db.prepare('UPDATE cart_refresh_requests SET state=? WHERE cart_hash=? AND generation=?').run(state,ticket.cart_hash,ticket.generation);
      return receipt(row(ticket));
    });},
    fail(ticket){return lifecycle.transaction(()=>{
      const r=row(ticket);if(!r)return;
      if(r.state==='publishing'||ticket.cleanReplacement&&['reading','prepared'].includes(r.state)) {
        lifecycle.event(`cart-refresh-failed:${r.cart_hash}:${r.generation}`,{cart:r.cart_hash,generation:r.generation},()=>{
          db.prepare("UPDATE cart_refresh_requests SET state='invalidating' WHERE cart_hash=? AND generation=?").run(r.cart_hash,r.generation);
        });
      } else if(['reading','prepared'].includes(r.state))db.prepare("UPDATE cart_refresh_requests SET state='invalidated' WHERE cart_hash=? AND generation=?").run(r.cart_hash,r.generation);
      // invalidating stays pending; a failed recovery cannot acknowledge clearing.
    });},
    status(ticket){return receipt(current(ticket));},
  };
}
