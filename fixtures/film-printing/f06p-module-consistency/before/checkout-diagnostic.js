import {createNativeCases} from './checkout-native-cases.js';
import './cart-locator.js';
import {createResourceSession} from './resource-session.js';
// Explicit-call, nonvisual helper. Never loaded by the ordinary theme.
export function createCheckoutDiagnosticClient(options){
 const session=createResourceSession(options);
 const locate=async()=>{const c=await globalThis.BFLPrintCartLocator.locate();return c.cart_id;};
 return Object.freeze({issue:session.issue,renew:session.renew,revoke:session.revoke,
  act:action=>session.checkoutDiagnostic(action,locate),
  // Existing resource upload/job transport; no client-computed approval/pricing.
  resource:session.request,
 });
}
// One controller per document, including after close. Re-registration must not
// reset spent actions or silently extend the reviewed window.
const registered=new WeakSet();
const roleBKeys=Object.freeze({KeyP:'preflight',KeyR:'preflight_recheck',KeyI:'issue',KeyB:'bind',KeyU:'control_add',KeyD:'control_remove',KeyS:'inspect',KeyJ:'add_job',KeyH:'hostile_copy',KeyK:'cleanup',KeyE:'close'});
const target=()=>location.origin==='https://bellows-film-printing-staging.myshopify.com'&&
 globalThis.Shopify?.theme?.id===189196533871&&globalThis.Shopify?.theme?.role==='unpublished';
// WebMCP stays the default. Keyboard is an explicit, finite role-B-only input;
// neither input accepts credentials, cart IDs, arbitrary commands or arguments.
export async function registerCheckoutDiagnostic({until,cleanupUntil,runId,role='A',controlContractSha256,preflightOnly=false,input='webmcp',options,onClose}={}){
 const keyboard=input==='keyboard';
 if(!target()||!['A','B'].includes(role)||!['webmcp','keyboard'].includes(input)||
    (keyboard?role!=='B'||!document.head||document.getElementById('bfl-f06p-role-b-result'):typeof document.modelContext?.registerTool!=='function')||
    runId!=='f06p-integrated-v1'||typeof preflightOnly!=='boolean'||(!preflightOnly&&!/^[a-f0-9]{64}$/.test(controlContractSha256))||
    !Number.isSafeInteger(until)||until<=Date.now()||until>Date.now()+1200000||cleanupUntil!==until+630000||registered.has(document)||
    (onClose!==undefined&&typeof onClose!=='function'))throw Error('DIAGNOSTIC_UNAVAILABLE');
 const client=createCheckoutDiagnosticClient(options),registration=new AbortController(),spent=new Set(),native=createNativeCases({client,role,until,cleanupUntil,controlContractSha256,fetchImpl:options?.fetchImpl,signal:registration.signal});
 const allowed=preflightOnly?['preflight','preflight_recheck','close']:role==='B'?Object.values(roleBKeys):['preflight','preflight_recheck','issue','bind','install','publish','observe','inspect','resources','close','control_add','control_remove','add_job','quantity_changed','quantity_restored','remove_job','readd_job','duplicate_add','duplicate_remove','cleanup','hostile_overwrite','hostile_delete'];
 let closed=false,busy=false,failed=false,timer,node,sequence=0,closing,preflightError;
 const close=()=>{
  if(closing)return closing;
  // Invalidate pending issuance too: resource-session disposes a late credential.
  closed=true;closing=client.revoke();registration.abort();
  // The bootstrap's inert readiness record must stop advertising a controller
  // as ready even if revocation is pending or ultimately unconfirmed.
  try{onClose?.();}catch{}
  if(keyboard)document.removeEventListener('keydown',onKey,true);else clearTimeout(timer);
  globalThis.removeEventListener?.('pagehide',onPageHide);return closing;
 };
 const dispose=async()=>{clearTimeout(timer);node?.remove();await close();};
 const onPageHide=()=>{void dispose().catch(()=>{});};
 const execute=async({action},{signal}={})=>{
  if(!allowed.includes(action)||signal?.aborted||closed||(busy&&action!=='close')||!target()||spent.has(action)||
     (failed&&!['cleanup','close'].includes(action))||Date.now()>=(['cleanup','close'].includes(action)?cleanupUntil:until))throw Error('DIAGNOSTIC_CLOSED');
  busy=true;if(!['inspect','observe'].includes(action))spent.add(action);
  const abort=()=>{void dispose().catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});
  try{
   let result;
   if(action==='close'){const revoked=await close();result={closed:true,local_cleared:revoked.local_cleared,remote_confirmed:revoked.remote_confirmed};}
   else if(action==='preflight'||action==='preflight_recheck')result=await native.preflight(action==='preflight'?'initial':'recheck');
   else if(action==='resources')result=await native.resources();
   else if(action==='inspect')result=await native.inspect();
   else if(action.startsWith('hostile_'))result=await native.hostile(action.slice(8));
   else if(!['issue','bind','install','publish','observe'].includes(action))result=await native.native(action);
   else{
    const value=action==='issue'?await client.issue():await client.act(action);
    result={complete:true,action,installed:value.installed===true,owned:value.owned===true,marker_present:typeof value.binding_value==='string'};
   }
   if(action!=='close'&&(closed||!target()||Date.now()>=(action==='cleanup'?cleanupUntil:until)))throw Error('DIAGNOSTIC_CLOSED');
   return JSON.stringify({...result,cart_verified:false,checkout_ready:false});
  }catch{
   failed=true;const error=Error('DIAGNOSTIC_UNAVAILABLE');
   if(action==='preflight'||action==='preflight_recheck'){
    error.preflight=native.preflightFailure()??Object.freeze({stage:'dispatch',reason:registration.signal.aborted?'cancelled':Date.now()>=until?'expired':'unavailable'});
    preflightError=error;
   }
   throw error;
  }
  finally{busy=false;signal?.removeEventListener('abort',abort);}
 };
 const write=(seq,action,status,result,preflight)=>{
  if(node?.isConnected&&seq===sequence)node.textContent=JSON.stringify({sequence:seq,action,status,...(result?{result}:{}),...(preflight?{preflight}:{}),cart_verified:false,checkout_ready:false});
 };
 function onKey(event){
  const action=Object.hasOwn(roleBKeys,event.code)?roleBKeys[event.code]:null;
  if(event.isTrusted!==true||event.repeat||event.isComposing||event.defaultPrevented||!event.ctrlKey||!event.altKey||!event.shiftKey||event.metaKey||!action||
     event.composedPath().some(e=>e.isContentEditable||['INPUT','TEXTAREA','SELECT'].includes(e.tagName)))return;
  event.preventDefault();
  // A second key must not replace the pending receipt. It never queues work.
  if((busy&&action!=='close')||closed)return;
  const seq=++sequence;write(seq,action,'pending');
  void execute({action}).then(result=>write(seq,action,'complete',JSON.parse(result)),error=>write(seq,action,error.message==='DIAGNOSTIC_CLOSED'?'rejected':'unknown',undefined,error===preflightError?error.preflight:undefined));
 }
 registered.add(document);
 try{
  // Install cancellation before awaiting a page-provided registration promise.
  // A late registration must never revive a page-hidden or expired controller.
  globalThis.addEventListener?.('pagehide',onPageHide,{once:true});
  timer=setTimeout(()=>{void dispose().catch(()=>{});},Math.max(1,cleanupUntil-Date.now()));
  if(keyboard){
   node=document.createElement('script');node.id='bfl-f06p-role-b-result';node.type='application/json';document.head.append(node);
   write(0,null,'ready');document.addEventListener('keydown',onKey,true);
  }else await document.modelContext.registerTool({
   name:'bfl_f06p_checkout_diagnostic',description:'Run one bounded staging Film Printing diagnostic action; returns sanitized status only.',
   inputSchema:{type:'object',properties:{action:{type:'string',enum:allowed}},required:['action'],additionalProperties:false},
   execute,annotations:{readOnlyHint:preflightOnly,untrustedContentHint:true},
  },{signal:registration.signal});
  if(closed||!target()||Date.now()>=until)throw Error('DIAGNOSTIC_UNAVAILABLE');
  return {close:dispose};
 }catch{await dispose().catch(()=>{});throw Error('DIAGNOSTIC_UNAVAILABLE');}
}
