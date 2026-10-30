// Disabled local V2 candidate. No HTTP transport, runtime mount or migration.
// The existing job DB/transaction/outbox owns this single durable send journal.
import {randomBytes} from 'node:crypto';
import {cartHash,requireCartLocator} from './storefront.mjs';
import {fingerprint} from '../jobs/lifecycle.mjs';
import {need} from '../backend/config.mjs';

export function installCartBindingSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS cart_checkout_bindings (
    cart_hash TEXT PRIMARY KEY, owner_hash TEXT NOT NULL UNIQUE,
    identity_hash TEXT NOT NULL UNIQUE, marker TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK(state IN ('reserved','sending','confirmed','retired')));`);
}
export function createCartBindingLedger(db,lifecycle) {
  const identity=cart=>{
    requireCartLocator(cart.id);
    need(cart.complete===true && typeof cart.owner==='string' && cart.owner && typeof cart.binding_id==='string' && cart.binding_id.length>=8,'BINDING_OWNER_UNPROVEN');
    need(cart.customer_id===null || /^gid:\/\/shopify\/Customer\/\d+$/.test(cart.customer_id),'BINDING_OWNER_UNPROVEN');
    need(!lifecycle.retired('owner',cart.owner),'OWNER_REVOKED');
    return {cart_hash:cartHash(cart.id),owner_hash:cartHash(cart.owner),identity_hash:fingerprint({owner:cart.owner,binding:cart.binding_id,customer:cart.customer_id})};
  };
  const row=cart=>{
    const i=identity(cart),r=db.prepare('SELECT * FROM cart_checkout_bindings WHERE cart_hash=?').get(i.cart_hash);
    need(r&&r.owner_hash===i.owner_hash&&r.identity_hash===i.identity_hash,'BINDING_REBIND_FORBIDDEN');return r;
  };
  const clear=()=>{const s=lifecycle.state();need(!s.pending&&!s.operation,'AUTHORITY_PENDING');return s;};
  return Object.freeze({
    reserve(cart){return lifecycle.transaction(()=>{
      clear();const i=identity(cart);
      need(!db.prepare('SELECT 1 FROM cart_checkout_bindings WHERE cart_hash=? OR owner_hash=?').get(i.cart_hash,i.owner_hash),'BINDING_ATTEMPT_SPENT');
      need(db.prepare('SELECT COUNT(*) AS n FROM cart_checkout_bindings').get().n<256,'BINDING_CAPACITY');
      const marker=randomBytes(32).toString('hex');
      lifecycle.event(`binding-install:${marker}`,i,()=>db.prepare('INSERT INTO cart_checkout_bindings VALUES (?,?,?,?,?)').run(i.cart_hash,i.owner_hash,i.identity_hash,marker,'reserved'));
      return marker;
    });},
    sending(cart,marker){return lifecycle.transaction(()=>{
      const epoch=clear().epoch,r=row(cart);need(r.marker===marker&&r.state==='reserved','BINDING_ATTEMPT_SPENT');
      db.prepare("UPDATE cart_checkout_bindings SET state='sending' WHERE marker=?").run(marker);return epoch;
    });},
    confirm(cart,marker,epoch){return lifecycle.transaction(()=>{
      need(clear().epoch===epoch,'BINDING_FENCED');const r=row(cart);need(r.marker===marker&&r.state==='sending','BINDING_ATTEMPT_SPENT');
      db.prepare("UPDATE cart_checkout_bindings SET state='confirmed' WHERE marker=?").run(marker);
    });},
    observe(cart,value){const r=row(cart);clear();need(r.state==='confirmed'&&r.marker===value,'BINDING_UNAVAILABLE');return {marker:r.marker};},
    retire(marker){return lifecycle.transaction(()=>{
      const r=db.prepare('SELECT * FROM cart_checkout_bindings WHERE marker=?').get(marker);need(r,'BINDING_UNAVAILABLE');
      return lifecycle.event(`binding-retire:${marker}`,{marker},()=>db.prepare("UPDATE cart_checkout_bindings SET state='retired' WHERE marker=?").run(marker));
    });},
  });
}

// Dependencies are trusted process composition only; none are client proof flags.
// A bindCurrentCart observation is required on every call. Actual ownership,
// same-app writer isolation and Function propagation remain separate gates.
export function createCartBinding({ledger,bindCurrent,readMarker,writeMarker,admin,afterClear,guard=()=>{},enabled=false,clearBeforeInstall=true}) {
  const bound=async request=>{need(enabled===true,'CART_BINDING_DISABLED');return bindCurrent(request);};
  // Marker installation can change updatedAt. Compare the complete remaining
  // bound content, not that timestamp; equal reads still do not constitute a lock.
  const content=cart=>{const {updated_at,...rest}=cart;return fingerprint(rest);};
  return Object.freeze({
    async install(request) {
      const cart=await bound(request);guard();const marker=ledger.reserve(cart);
      try {
        if(clearBeforeInstall){
          await admin.reconcile(); // Clear old grants/fence before any marker write.
          if(afterClear)await afterClear(); // Acquire a new signed proof in the cleared epoch.
        }
        guard();
        need(await readMarker(cart)===null,'BINDING_ALREADY_PRESENT');
        guard();const current=await bound(request);guard();
        need(content(current)===content(cart),'BINDING_CART_CHANGED');
        const epoch=ledger.sending(current,marker); // Durable BEFORE send; never retry.
        await writeMarker(current,marker);guard();
        const after=await bound(request);guard();
        need(content(after)===content(cart),'BINDING_CART_CHANGED');
        need(await readMarker(after)===marker,'BINDING_READBACK_CHANGED');
        guard();
        ledger.confirm(after,marker,epoch);
        return {installed:true,cart_verified:false,checkout_ready:false};
      } catch(error) {
        // A late remote write cannot reactivate this marker. No path resets a
        // retired/reserved/sending row or creates another marker for this owner.
        ledger.retire(marker);
        if(clearBeforeInstall)try{await admin.reconcile();}catch{/* Pending retirement remains durable. */}
        throw error;
      }
    },
    async observe(cart) {need(enabled===true,'CART_BINDING_DISABLED');return ledger.observe(cart,await readMarker(cart));},
  });
}
