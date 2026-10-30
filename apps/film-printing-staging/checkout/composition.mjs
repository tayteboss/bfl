// Local process composition only. No executable route, flag or publication path.
// freshContext is a trusted client's next signed proof exchange, not a verifier:
// its returned request/proof is authenticated again by the real proof service.
import {createCartCapabilityAdapter,openCartCapability,CAPABILITY_ACTION} from './cart-capability.mjs';
import {bindOwnedObservation} from './owned-cart.mjs';
import {createCartBinding} from './cart-binding.mjs';
import {createCartRefresh} from './refresh.mjs';
import {fingerprint} from '../jobs/lifecycle.mjs';
import {need} from '../backend/config.mjs';
import {printLine} from './storefront.mjs';
import {preparedPolicy} from './prepared-limits.mjs';

const content=cart=>{const {updated_at,...rest}=cart;return fingerprint(rest);};
export function createCheckoutComposition({store,jobs,admin,proofs,transport,custodySecret,resolveBuyerIp,now=Date.now,enabled=false,permit=()=>true,onPrepared,onEligible,onCancel,onCurrent,onResume,diagnosePreparation,assertResume,assertUploadResume,resumeUploads,rememberCart,rememberMarker,sourceScope,replaceSettled=false,persistentStaging=false}) {
 const sessions=store.resourceSessions,owners=store.checkoutOwner;
 const gate=()=>need(enabled===true&&permit(),'CHECKOUT_COMPOSITION_DISABLED');
 need(sessions&&owners&&store.checkoutCapability&&store.cartBinding,'CHECKOUT_COMPOSITION_REQUIRED');
 need(!persistentStaging||preparedPolicy(sourceScope).clientPolicy==='bfl-persistent-staging-client-v1','STAGING_CART_POLICY');
 const adapter=createCartCapabilityAdapter({store:{...store,cartCapability:store.checkoutCapability},proofs,transport,custodySecret,resolveBuyerIp,now,
  permit:()=>enabled===true&&permit(),owned:owners});
 const observation=async(input,expected)=>{
  gate();const {request,proof,cart_id}=input,t=sessions.authenticate(request),r=owners.bound(t);
  if(expected)need(t.owner===expected.owner&&t.verifier===expected.verifier&&t.generation===expected.generation,'RESOURCE_FENCED');
  const e=proofs.observeFreshContext({request,proof,action:CAPABILITY_ACTION,ticket:t});
  sessions.assertCartContext(t,e);
  need(cart_id===openCartCapability(r.sealed_cart,custodySecret),'CART_OWNER_REJECTED');
  const guard=()=>{gate();sessions.assertCartContext(t,e);owners.bound(t);};
  const buyerIp=await resolveBuyerIp(request);guard();const wire={cart_id,buyerIp};
  const bind=async parsed=>{
   const cart=await bindOwnedObservation({cart:parsed,ticket:t,e,binding:r.binding_id,now});guard();return cart;
  };
  let selected=null,selectedMarker=null;
  return {
   ticket:t,guard,marker:null,
   get selected(){return selected;},
   guardPublication(op){
    gate();const fresh=sessions.authenticate(request);store.lifecycle.assertOperation(op);
    need(op.kind==='publish'&&fresh.epoch===t.epoch&&['owner','verifier','generation'].every(k=>fresh[k]===t[k])&&
      now()>=e.observedAt&&now()<e.observedAt+30000,'RESOURCE_FENCED');
   },
   async read(){
    guard();const c=await transport.readBinding(wire);guard();
    selected=await bind(c.parsed);selectedMarker=c.marker;return selected;
   },
   async readMarker(cart){
    guard();
    if(cart===selected){this.marker=selectedMarker;return selectedMarker;}
    const c=await transport.readBinding(wire);guard();const current=await bind(c.parsed);guard();
    need(content(current)===content(cart),'BINDING_CART_CHANGED');this.marker=c.marker;return c.marker;
   },
   async writeMarker(cart,marker){guard();need(cart.owner===t.owner&&cart.id===cart_id,'CART_OWNER_REJECTED');await transport.writeBinding(wire,marker);guard();},
  };
 };
 const next=async(input,initial,freshContext)=>{
  need(typeof freshContext==='function','CURRENT_CONTEXT_REQUIRED');
  // The old epoch ticket is deliberately never asserted or reused after clear.
  const fresh=await freshContext();
  need(fresh?.cart_id===input.cart_id,'CART_OWNER_REJECTED');
  return observation(fresh,initial.ticket);
 };
 return Object.freeze({
  async bind(input){
   gate();const ticket=sessions.authenticate(input.request);owners.member(ticket);const result=await adapter.bind(input);sessions.assert(ticket);gate();
   if(rememberCart)await rememberCart({...input,ticket});sessions.assert(ticket);gate();return result;
  },
  async observe(input){
   const o=await observation(input);o.guard();const cart=await o.read();o.guard();const marker=await o.readMarker(cart);o.guard();
   store.cartBinding.observe(cart,marker);
   return {owned:true,owner_kind:'application',cart_verified:false,checkout_ready:false};
  },
  async inspect(input){
   const o=await observation(input);o.guard();const cart=await o.read();o.guard();
   const marker=await o.readMarker(cart);o.guard();
   return {binding_value:marker,cart_verified:false,checkout_ready:false};
  },
  async current(input){
   const o=await observation(input);o.guard();const cart=await o.read();o.guard();
   const marker=await o.readMarker(cart);o.guard();store.cartBinding.observe(cart,marker);
   if(onCurrent){await onCurrent({resourceTicket:o.ticket,cart,marker,readCurrent:()=>o.read(),guard:o.guard,guardPublication:o.guardPublication});o.guard();}
   // A crash may commit ownership before saving its private peer. A fresh
   // authenticated current observation repairs that gap without a cart write.
   if(persistentStaging&&rememberCart){await rememberCart({...input,ticket:o.ticket});o.guard();}
   // Return actual selected line fields, never the private cart capability,
   // customer context, owner, or app-owned binding marker.
   return {items:cart.lines.map(line=>({id:line.id,variant_id:line.variant_id.split('/').at(-1),
    quantity:line.quantity,properties:{...line.properties},subtotal_cents:line.subtotal_cents})),
    cart_verified:false,checkout_ready:false};
  },
  async resume(input){
   need(typeof assertResume==='function','CHECKOUT_RESUME_REJECTED');
   const o=await observation(input);o.guard();let cart=await o.read();o.guard();
   const marker=await o.readMarker(cart);o.guard();store.cartBinding.observe(cart,marker);
   if(input.operation?.kind==='recover_preparation'){
    need(persistentStaging&&typeof diagnosePreparation==='function'&&Object.keys(input.operation).length===1,'CHECKOUT_RESUME_REJECTED');
    const recovery=await diagnosePreparation({resourceTicket:o.ticket,cart,marker,readCurrent:()=>o.read(),guard:o.guard});o.guard();
    need(await o.readMarker(o.selected)===marker,'CART_REFRESH_CHANGED');o.guard();store.cartBinding.observe(o.selected,marker);
    return {resumed:true,...recovery,items:cart.lines.map(line=>({id:line.id,variant_id:line.variant_id.split('/').at(-1),
     quantity:line.quantity,properties:{...line.properties},subtotal_cents:line.subtotal_cents})),cart_verified:false,checkout_ready:false};
   }
   if(onResume){
    cart=await onResume({resourceTicket:o.ticket,cart,marker,operation:input.operation,readCurrent:()=>o.read(),guard:o.guard,guardPublication:o.guardPublication})??cart;o.guard();
    need(await o.readMarker(cart)===marker,'CART_REFRESH_CHANGED');o.guard();store.cartBinding.observe(cart,marker);
   }
   const resumed=assertResume(o.ticket,cart,marker,input.operation);o.guard();
   if(onCurrent){await onCurrent({resourceTicket:o.ticket,cart,marker,readCurrent:()=>o.read(),guard:o.guard,guardPublication:o.guardPublication});o.guard();}
   return {resumed:true,items:cart.lines.map(line=>({id:line.id,variant_id:line.variant_id.split('/').at(-1),
    quantity:line.quantity,properties:{...line.properties},subtotal_cents:line.subtotal_cents})),...(resumed??{}),cart_verified:false,checkout_ready:false};
  },
  async eligible(input){
   need(typeof onEligible==='function','PREPARED_PUBLICATION_REQUIRED');
   const o=await observation(input);o.guard();const cart=await o.read();o.guard();
   const marker=await o.readMarker(cart);o.guard();store.cartBinding.observe(cart,marker);
   const result=await onEligible({resourceTicket:o.ticket,cart,marker,reference:input.reference,generation:input.generation,readCurrent:()=>o.read(),guard:o.guard,guardPublication:o.guardPublication});
   o.guard();return result;
  },
  async cancel_preparation(input,{freshContext}={}){
   need(typeof onCancel==='function','PREPARED_PUBLICATION_REQUIRED');
   const o=await observation(input);o.guard();const cart=await o.read();o.guard();const marker=await o.readMarker(cart);o.guard();store.cartBinding.observe(cart,marker);
   return onCancel({resourceTicket:o.ticket,cart,marker,reservation:input.reservation,guard:o.guard,afterClear:async()=>{
    const fresh=await next(input,o,freshContext),current=await fresh.read();fresh.guard();const binding=await fresh.readMarker(current);fresh.guard();store.cartBinding.observe(current,binding);
    return {resourceTicket:fresh.ticket,cart:current,marker:binding,readCurrent:()=>fresh.read(),guard:fresh.guard,guardPublication:fresh.guardPublication};
   }});
  },
  async resume_uploads(input){
   need(typeof resumeUploads==='function','UPLOAD_RECOVERY_UNAVAILABLE');
   const o=await observation(input);o.guard();const cart=await o.read();o.guard();
   const exact=input.selection!==undefined;
   need(exact?typeof assertUploadResume==='function':!cart.lines.some(printLine),'UPLOAD_RECOVERY_CART_CHANGED');
   const marker=await o.readMarker(cart);o.guard();store.cartBinding.observe(cart,marker);
   const recovery=exact?assertUploadResume(o.ticket,cart,marker):null;o.guard();
   const uploads=await resumeUploads({ticket:o.ticket,guard:o.guard,...(exact?{selection:input.selection,excludedAssetIds:recovery.excluded_asset_ids}:{})});o.guard();
   const after=await o.read();o.guard();need(content(after)===content(cart),'UPLOAD_RECOVERY_CART_CHANGED');
   need(await o.readMarker(after)===marker,'UPLOAD_RECOVERY_CART_CHANGED');o.guard();
   if(exact)need(fingerprint(assertUploadResume(o.ticket,after,marker))===fingerprint(recovery),'UPLOAD_RECOVERY_CART_CHANGED');o.guard();
   return {resumed_uploads:true,uploads,items:cart.lines.map(line=>({id:line.id,variant_id:line.variant_id.split('/').at(-1),
    quantity:line.quantity,properties:{...line.properties},subtotal_cents:line.subtotal_cents})),
    ...(recovery?.expires_at!==undefined?{expires_at:recovery.expires_at}:{}),cart_verified:false,checkout_ready:false};
  },
  async resources(input,work){
   need(typeof work==='function','DIAGNOSTIC_RESOURCES_UNAVAILABLE');
   const o=await observation(input);o.guard();await o.read();o.guard();
   const result=await work({owner:o.ticket.owner,ticket:o.ticket,guard:o.guard});o.guard();return result;
  },
  async install(input,{freshContext}={}){
   const initial=await observation(input);initial.guard();let current=initial;
   const result=await createCartBinding({ledger:store.cartBinding,enabled:true,admin,clearBeforeInstall:!persistentStaging,guard:()=>current.guard(),
    bindCurrent:()=>current.read(),readMarker:cart=>current.readMarker(cart),writeMarker:(cart,marker)=>current.writeMarker(cart,marker),
    afterClear:async()=>{current=await next(input,initial,freshContext);},
   }).install();current.guard();if(rememberMarker)rememberMarker(current.marker);return result;
  },
  async prepare(input,{request_key,freshContext}={}){
   const initial=await observation(input);initial.guard();const observed=await initial.read();initial.guard();let current;
   // Only an authenticated, confirmed nonempty printing cart can replace a
   // settled grant. Empty removal, uncertainty and pending events still clear.
   const cleanCandidate=replaceSettled&&observed.lines.some(printLine);
   if(cleanCandidate)store.cartBinding.observe(observed,await initial.readMarker(observed));
   const refresh=createCartRefresh({store,jobs,admin,now,sourceScope,publicationEnabled:false,replaceSettled:cleanCandidate,
    bindCurrent:async({cleanReplacement})=>{if(!current)current=cleanReplacement?initial:await next(input,initial,freshContext);return current.read();},
    guard:()=>current.guard(),
    onPrepared:onPrepared?value=>onPrepared({...value,resourceTicket:current.ticket,guardPublication:current.guardPublication}):undefined,
    cartBinding:{observe:async cart=>{const marker=await current.readMarker(cart);current.guard();return store.cartBinding.observe(cart,marker);}},
   });
   const result=await refresh({owner:initial.ticket.owner,cart_id:input.cart_id,request_key});
   // Replay has no fresh post-clear observer; authenticate its current caller too.
   if(current)current.guard();else initial.guard();
   return {...result,...(current?.selected?{items:current.selected.lines.map(line=>({id:line.id,variant_id:line.variant_id.split('/').at(-1),quantity:line.quantity,properties:{...line.properties},subtotal_cents:line.subtotal_cents}))}:{}),cart_verified:false,checkout_ready:false};
  },
 });
}
