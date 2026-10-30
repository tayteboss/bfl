import { APP, STORE } from '../configuration/schema.mjs';
import { requireValue } from '../shipping/packing.mjs';

// Internal contract, not a public route or webhook verifier. verify MUST verify
// provider/session/order authenticity AND resource ownership, returning canonical
// data from that authenticated evidence (never echo browser claims). Order lines
// must be resolved against immutable references from the authenticated order.
export function createLifecycleReceiver({store,jobs,verify,kind}) {
  requireValue(store?.lifecycle && jobs && typeof verify==='function' && ['upload','job','owner','order'].includes(kind),'MISSING_EVENT_VERIFIER');
  return async input => {
    const e=structuredClone(await verify(input));
    requireValue(e?.store===STORE && e.app===APP && typeof e.id==='string' && /^[a-zA-Z0-9:_-]{8,200}$/.test(e.id) &&
      typeof e.owner==='string' && e.owner.length>0 && e.kind===kind,'UNAUTHENTICATED_EVENT');
    if(e.kind==='upload') {
      requireValue(e.scope==='upload:invalidate' && ['removed','failed'].includes(e.state) && typeof e.asset_id==='string','EVENT_SCOPE');
    } else if(e.kind==='owner')requireValue(e.scope==='owner:revoke','EVENT_SCOPE');
    else {
      requireValue(e.scope===(e.kind==='order'?'order:consume':'job:revoke') && Array.isArray(e.references) &&
        e.references.length>0 && e.references.length<=8 && new Set(e.references.map(r=>r.id)).size===e.references.length,'EVENT_SCOPE');
      if(e.kind==='order')requireValue(/^gid:\/\/shopify\/Order\/\d+$/.test(e.order_id),'EVENT_SCOPE');
    }
    // Event IDs are namespaced by the configured verifier's authenticated source.
    // A duplicate ID with a different body never changes state.
    const prior=store.lifecycle.eventResult(e.id,e); if(prior)return prior;
    if(e.kind==='upload') {
      // Persist the provider event identity and the upload transition in one DB
      // transaction by using the store's event-aware invalidation method.
      return store.invalidateUpload(e);
    }
    if(e.kind!=='owner')for(const reference of e.references) {
      // Signature/revision/owner checked before any invalidation. Already-retired
      // jobs in a different authenticated delivery are handled by the same check.
      await jobs.verifyRevocation(e.owner,reference);
    }
    return store.revoke(e);
  };
}
