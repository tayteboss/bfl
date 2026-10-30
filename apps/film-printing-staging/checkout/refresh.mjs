import {createCheckoutProjector} from './projector.mjs';
import {bindCurrentCart,printLine} from './storefront.mjs';
import {fingerprint} from '../jobs/lifecycle.mjs';
import {need} from '../backend/config.mjs';

// Trusted process composition only. The executable never supplies owner or
// Function-ID proofs, enables publication, or mounts this as an HTTP route.
export function createCartRefresh({store,jobs,admin,readCart,verifyOwnership,verifyFunctionIdentity,cartBinding,bindCurrent,guard=()=>{},onPrepared,sourceScope,
  publicationEnabled=false,replaceSettled=false,now=Date.now}) {
  const ledger=store.cartRefresh;
  need(ledger&&jobs.authorityLifecycle===store.lifecycle,'CART_REFRESH_STORE_REQUIRED');
  return async({request,owner,cart_id,request_key})=>{
    need(typeof verifyOwnership==='function'||typeof bindCurrent==='function','CART_OWNER_PROOF_UNAVAILABLE');
    const {ticket,replay}=ledger.begin(owner,cart_id,request_key,{replaceSettled});
    if(replay)return {...ledger.status(ticket),replay:true}; // Never blindly replay a write.
    const bound=()=>bindCurrent?bindCurrent({cleanReplacement:ticket.cleanReplacement===true}):bindCurrentCart({read:readCart,verifyOwnership,request,owner,cart_id,now});
    try {
      if(!ticket.cleanReplacement)await admin.reconcile(); // Recovery still requires exact CAS + remote readback.
      ledger.reading(ticket);
      const cart=await bound();guard();ledger.assertCurrent(ticket);
      need(!store.lifecycle.retired('owner',owner),'CART_OWNER_REJECTED');
      // Last-job removal (even with ordinary merchandise remaining) is explicit
      // verified revocation; it must not ask the projector to accept zero jobs.
      if(!cart.lines.some(printLine)){
        need(!ticket.cleanReplacement,'CART_REFRESH_CHANGED');
        return ledger.finish(ticket,'revoked');
      }
      const context=await admin.read();guard();ledger.assertCurrent(ticket);
      const binding=cartBinding?{...await cartBinding.observe(cart),generation:ticket.generation,epoch:store.lifecycle.state().epoch}:undefined;
      guard();ledger.assertCurrent(ticket);
      const projector=createCheckoutProjector({jobs,resolveCart:async()=>cart,loadContext:async()=>context,binding,guard,sourceScope});
      const prepared=await projector.prepare({});guard();ledger.assertCurrent(ticket);
      ledger.stage(ticket,cart,prepared.value);
      // Private finite diagnostic composition only. Ordinary serving supplies
      // no sink. The sink must implement the existing publication/expiry fences.
      if(onPrepared)return await onPrepared({ticket,cart,prepared,readCurrent:bound,guard});
      if(!publicationEnabled)return ledger.status(ticket);
      // V2 local preparation cannot reuse the old ID callback as an integration
      // proof. No runtime route/flag can activate this candidate publication.
      need(!cartBinding,'BINDING_INTEGRATION_UNPROVEN');
      need(typeof verifyFunctionIdentity==='function'&&await verifyFunctionIdentity(cart)===true,'FUNCTION_IDENTITY_UNPROVEN');
      const before=await bound();
      need(fingerprint(before)===fingerprint(cart),'CART_REFRESH_CHANGED');
      ledger.publishing(ticket,before,prepared.value);
      await admin.publish(prepared); // Existing lifecycle/source/fence CAS writer.
      ledger.assertCurrent(ticket);
      const after=await bound();
      need(fingerprint(after)===fingerprint(cart),'CART_REFRESH_CHANGED');
      // Equal reads are not a cart lock or a supported recalculation proof.
      return ledger.finish(ticket,'published_unverified');
    } catch(error) {
      ledger.fail(ticket);
      // Unknown publication remains durable until clearing succeeds, including
      // after restart. Recovery fences a delayed old remote request via F06D.
      if(store.lifecycle.state().pending||store.lifecycle.state().operation) {
        try {await admin.reconcile();ledger.recovered();}catch { /* Preserve pending state. */ }
      }
      throw error;
    }
  };
}
