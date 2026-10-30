import {createNativeCases,NATIVE_REVISION} from './checkout-native-cases.js?v=03c7b842def96ded3a132e8e602b3662684ca5a36c2fa614a9b331faa982466e';
import './cart-locator.js?v=3d2c1f8ca0592299645532799b3716b5a81ce7155171c1c95f7e79b235896476';
import {createResourceSession} from './resource-session.js?v=90190222e995b96995a8f480d12210adc2bb0de3a5539687471aecebb1fbd839';
export const DIAGNOSTIC_REVISION='f06p-diagnostic-v3';
export {NATIVE_REVISION};
// Fixed compatibility evidence only, not downloaded-byte integrity or authority.
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
// Reconstruct only fixed preflight fields; observer/error objects never escape.
const preflightStages=new Set(['entry','native_methods','phase','native_guard','native_read','native_summary','locator','locator_availability','locator_read','locator_unavailable','continuity','capability','comparison_hash','final_guard']);
function readPreflightFailure(native){
 try{
  const value=native.preflightFailure();
  if(value===null)return Object.freeze({stage:'dispatch',reason:'unavailable'});
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['stage','reason','construction_methods','captured_methods','current_methods'].includes(k)))throw Error();
  const {stage,reason}=value;
  if(!preflightStages.has(stage)||!['unavailable','expired','cancelled'].includes(reason))throw Error();
  const result={stage,reason};
  for(const key of ['construction_methods','captured_methods','current_methods']){
   const flags=value[key];if(flags===undefined&&key!=='construction_methods')continue;
   if(!flags||typeof flags!=='object'||Array.isArray(flags)||Object.keys(flags).some(k=>!['observed','get_cart','update_cart'].includes(k)))throw Error();
   const {observed,get_cart,update_cart}=flags;
   if([observed,get_cart,update_cart].some(v=>typeof v!=='boolean')||(!observed&&(get_cart||update_cart)))throw Error();
   result[key]=Object.freeze({observed,get_cart,update_cart});
  }
  return Object.freeze(result);
 }catch{return Object.freeze({stage:'observer',reason:'unavailable'});}
}
// WebMCP stays the default. Keyboard is an explicit, finite role-B-only input;
// neither input accepts credentials, cart IDs, arbitrary commands or arguments.
export async function registerCheckoutDiagnostic({until,cleanupUntil,runId,role='A',controlContractSha256,preflightOnly=false,input='webmcp',options,onClose}={}){
 if(NATIVE_REVISION!=='f06p-native-preflight-v3')throw Error('DIAGNOSTIC_UNAVAILABLE');
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
 const failure=(message,detail)=>{const error=Error(message);error.preflight=detail;preflightError=error;return error;};
 const executeAction=async({action},{signal}={})=>{
  const preflight=action==='preflight'||action==='preflight_recheck',denied=Error('DIAGNOSTIC_CLOSED');
  try{
   if(!allowed.includes(action)||signal?.aborted||closed||(busy&&action!=='close')||!target()||spent.has(action)||
      (failed&&!['cleanup','close'].includes(action))||Date.now()>=(['cleanup','close'].includes(action)?cleanupUntil:until))throw denied;
  }catch(error){
   if(!preflight)throw error;
   throw failure(error===denied?'DIAGNOSTIC_CLOSED':'DIAGNOSTIC_UNAVAILABLE',Object.freeze({stage:'admission',reason:error===denied?'rejected':'unavailable'}));
  }
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
   failed=true;
   if(preflight)throw failure('DIAGNOSTIC_UNAVAILABLE',readPreflightFailure(native));
   throw Error('DIAGNOSTIC_UNAVAILABLE');
  }
  finally{busy=false;signal?.removeEventListener('abort',abort);}
 };
 // Preserve setup/finally state transitions, but never let their exceptions
 // bypass the fixed preflight error route. Unrelated actions keep their errors.
 const execute=async({action},context)=>{
  try{return await executeAction({action},context);}
  catch(error){
   if((action==='preflight'||action==='preflight_recheck')&&error!==preflightError)throw failure('DIAGNOSTIC_UNAVAILABLE',Object.freeze({stage:'dispatch',reason:'unavailable'}));
   throw error;
  }
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
