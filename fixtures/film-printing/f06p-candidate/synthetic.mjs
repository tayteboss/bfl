// Generated offline data only. Never install these markers or publish these grants.
import {scenario as legacy,replaceAuthority} from '../f06a/synthetic.mjs';
import {createCheckoutProjector} from '../../../apps/film-printing-staging/checkout/projector.mjs';
export {replaceAuthority};
export async function scenario(options) {
 const s=await legacy(options);
 s.binding={marker:'a'.repeat(64),generation:1,get epoch(){return s.store.lifecycle.state().epoch;}};
 s.projector=createCheckoutProjector({jobs:s.jobs,resolveCart:async()=>s.cart,loadContext:async()=>s.context,binding:s.binding});
 s.prepared=await s.projector.prepare({});
 s.input.shop.authority.value=s.prepared.value;s.input.cart.binding={value:s.binding.marker};
 return s;
}
