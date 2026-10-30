// Local preparation for a finite private operator. Ordinary main never imports
// this module. A one-shot operator latch is also required by the executable.
import {randomBytes,createHash} from 'node:crypto';
import {need,safeCode,RuntimeError,SHOP,INSTALLATION} from './config.mjs';
import {STORE,APP,CLIENT} from '../configuration/schema.mjs';
import {STOREFRONT_ORIGIN} from './storefront-session.mjs';
import {createResourceProof} from './resource-proof.mjs';
import {RESOURCE_BOUNDS} from './resource-session.mjs';
import {createResourceProofHttp} from './resource-proof-http.mjs';
import {createResourceSessionHttp} from './resource-session-http.mjs';
import {createCheckoutComposition} from '../checkout/composition.mjs';
import {createDiagnosticPublication} from '../checkout/diagnostic-publication.mjs';
import {createPreparedPublication} from '../checkout/prepared-publication.mjs';
import {preparedPolicy} from '../checkout/prepared-limits.mjs';
import {createEligibilityProjector} from '../checkout/eligibility-projector.mjs';
import {assertEngineeringScope,revokeEngineeringScope} from '../configuration/engineering.mjs';

const hash=s=>createHash('sha256').update(s).digest('hex');
export const DIAGNOSTIC_LIMITS=Object.freeze({issue:2,bind:2,install:1,publish:1,observe:4,inspect:10,resources:1,copy_item:1,control:2});
export function createCheckoutDiagnostic({config,store,jobs,admin,transport,resolveBuyerIp,now=Date.now,enabled=false,record=()=>{},armPublication,prepareResources,rememberCart,rememberMarker,sourceScope,readControl,customerFlow=false,customerJobs=1,customerEdits=false,eligibility=false,resourceHandler,resumeUploads}){
 const policy=preparedPolicy(sourceScope);
 const started=now(),until=config.diagnosticUntil;
 need(config.store===STORE&&config.app===APP&&config.clientId===CLIENT&&config.installation===INSTALLATION,'DIAGNOSTIC_TARGET');
 need(enabled!==true||Number.isSafeInteger(until)&&until>started&&until<=started+policy.windowMs,'DIAGNOSTIC_WINDOW');
 // The finite customer acceptance mode exposes the same authenticated protocol
 // without fixture/copy/control actions. Ordinary serving never mounts it.
 need([1,2].includes(customerJobs)&&(customerFlow||customerJobs===1),'CUSTOMER_JOB_LIMIT');
 need(!customerEdits||customerFlow&&customerJobs===2,'CUSTOMER_EDIT_MODE');
 need(!eligibility||customerEdits&&store.preparedCart,'CUSTOMER_ELIGIBILITY_MODE');
 // Final empty-cart preparation clears authority without publishing a grant.
 // Reserve its request separately; the publisher keeps its positive-grant cap.
 const limits=customerFlow?{issue:1,bind:1,install:1,publish:customerEdits?5:customerJobs+1,resume:4,resume_uploads:4,current:customerEdits?48:12*customerJobs}:DIAGNOSTIC_LIMITS;
 if(eligibility){if(policy.clientPolicy)limits.resume_uploads=policy.resumes;limits.current=policy.current;delete limits.publish;limits.eligible=policy.preparations;limits.cancel_preparation=policy.cancellations;limits.resume=policy.resumes;}
 const raw=store.resourceSessions,issued=new Set(),counts=Object.fromEntries(Object.keys(limits).map(k=>[k,0]));
 let customerCredential=null;
 let closing=false,retiring=false,retirement=null,retiredAt=null,active=null,timer,fixtureItem=null,testMarker=null;const installedMarkers=new Set();
 const permit=()=>enabled===true&&!closing&&!retiring&&now()<until;
 const take=action=>{need(permit()&&counts[action]<limits[action],'DIAGNOSTIC_LIMIT');counts[action]++;record({event:'admitted',action,count:counts[action]});};
 const sessions={...raw,
  authenticate(req){const t=raw.authenticate(req);need(issued.has(t.owner),'DIAGNOSTIC_NEW_OWNER_REQUIRED');return t;},
  issue(e){take('issue');const result=raw.issue(e,{ttlMs:eligibility?policy.ownerMs:RESOURCE_BOUNDS.ttlMs,...(eligibility?{sourceScope}:{})}),request={headers:{origin:STOREFRONT_ORIGIN,authorization:'Bearer '+result.token}};
   const t=raw.authenticate(request);if(customerFlow)customerCredential={request,ticket:t};
   issued.add(t.owner);record({event:'issued_owner',owner:t.owner});return result;},
 };
 const localStore={...store,resourceSessions:sessions};
 const proofs=createResourceProof({secret:config.appSecret,sessions,now,cartCapability:true});
 const proofHttp=createResourceProofHttp(proofs),sessionHttp=createResourceSessionHttp({sessions,observeFreshContext:proofs.observeFreshContext});
 const currentOwner=()=>{
  if(!customerCredential)return null;
  const t=raw.authenticate(customerCredential.request);need(['owner','verifier','generation'].every(k=>t[k]===customerCredential.ticket[k]),'RESOURCE_FENCED');return t;
 };
 const publisher=(eligibility?createPreparedPublication:createDiagnosticPublication)({store:localStore,jobs,admin,now,until,enabled,permit,record,armPublication,publicationLimit:eligibility?policy.publications:customerEdits?4:customerJobs,
  ...(eligibility?{sourceScope,currentOwner,prepareAuthority:createEligibilityProjector({jobs,sourceScope}).prepare}:{}),
  unpublishedOwner:customerFlow?()=>{
   need(customerCredential,'RESOURCE_REJECTED');const t=raw.authenticate(customerCredential.request);
   need(['owner','verifier','generation'].every(k=>t[k]===customerCredential.ticket[k]),'RESOURCE_FENCED');
  }:undefined,
 });
 const composition=createCheckoutComposition({store:localStore,jobs,admin,proofs,transport,custodySecret:config.sessionSecret,resolveBuyerIp,now,enabled,permit,onPrepared:publisher.publish,onEligible:publisher.eligible,onCancel:publisher.cancel,replaceSettled:customerFlow,resumeUploads:async args=>{const exact=eligibility&&policy.clientPolicy&&args.selection!==undefined;need(!active&&(exact||(eligibility?counts.eligible===0:counts.publish===0))&&typeof resumeUploads==='function','UPLOAD_RECOVERY_UNAVAILABLE');return resumeUploads({...args,guard:()=>{need(!active&&(exact||(eligibility?counts.eligible===0:counts.publish===0)),'DIAGNOSTIC_BUSY');args.guard();}});},...(eligibility&&policy.clientPolicy?{assertUploadResume:(...args)=>{need(!active,'DIAGNOSTIC_BUSY');return publisher.assertUploadResume(...args);}}:{}),assertResume:(...args)=>{need(!active,'DIAGNOSTIC_BUSY');return publisher.assertResume(...args);},rememberCart,sourceScope,
  rememberMarker:marker=>{installedMarkers.add(marker);rememberMarker?.(marker);},
 });
 const send=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(body));};
 const failActive=code=>{if(active?.reject){active.reject(new RuntimeError(code));active.reject=null;}};
 const start=async(action,input)=>{
  need(!active,'DIAGNOSTIC_BUSY');take(action);const principal=sessions.authenticate(input.request);sessions.assert(principal);
  let notify;const waiting=new Promise(r=>{notify=r;}),op={principal,receipt:null,resolve:null,reject:null,done:null};active=op;
  const freshContext=()=>new Promise((resolve,reject)=>{
   need(permit()&&active===op,'DIAGNOSTIC_CLOSED');
   const receipt=randomBytes(32).toString('base64url');op.receipt=hash(receipt);op.resolve=resolve;op.reject=reject;op.expires=Math.min(until,now()+30000);
   timer=setTimeout(()=>failActive('DIAGNOSTIC_CONTINUATION_EXPIRED'),Math.max(1,op.expires-now()));timer.unref();
   notify({continuation:receipt,expires_in:Math.max(0,Math.floor((op.expires-now())/1000)),cart_verified:false,checkout_ready:false});
  });
  op.done=(async()=>{
   try{return await (action==='install'?composition.install(input,{freshContext}):['eligible','cancel_preparation'].includes(action)?composition[action](input,{freshContext}):composition.prepare(input,{request_key:`f06p-integrated-refresh-v${counts.publish}`,freshContext}));}
   finally{clearTimeout(timer);if(active===op)active=null;}
  })();
  // Rejections are observed even when the original client disconnects.
  const complete=op.done.then(result=>({result}),error=>({error}));
  const result=await Promise.race([waiting,complete]);
  if(result.error)throw result.error;
  return result.result??result;
 };
 const resume=async(input)=>{
  const op=active;need(op?.resolve&&typeof input.continuation==='string'&&hash(input.continuation)===op.receipt&&now()<op.expires,'DIAGNOSTIC_CONTINUATION_REJECTED');
  const t=sessions.authenticate(input.request);sessions.assert(t);
  need(['owner','verifier','generation'].every(k=>t[k]===op.principal[k]),'DIAGNOSTIC_CONTINUATION_REJECTED');
  // Burn before handing proof to real composition. Wrong/replayed proof is not
  // replaceable; disconnect, restart or timeout never recreates a continuation.
  const resolve=op.resolve;op.resolve=null;op.receipt=null;op.reject=null;clearTimeout(timer);
  resolve({request:input.request,proof:input.proof,cart_id:input.cart_id});return op.done;
 };
 const retire=()=>{
  if(retirement)return retirement;retiring=true;customerCredential=null;failActive('DIAGNOSTIC_CLOSED');proofs.close();
  record({event:'retirement_started',at:now(),clear_deadline:now()+60000});
  if(sourceScope)revokeEngineeringScope(sourceScope);
  for(const owner of issued)store.revoke({id:`diagnostic-close:${owner}`,kind:'owner',owner});
  for(const marker of installedMarkers)store.cartBinding.retire(marker);
  retirement=(async()=>{
   if(enabled===true)await publisher.retire();
   retiredAt=now();record({event:'retirement_cleared',at:retiredAt,observation_until:retiredAt+90000,cleanup_deadline:Math.min(until+630000,retiredAt+570000)});
  })();return retirement;
 };
 return Object.freeze({
  async handle(req,res){
   const path=req.url?.split('?')[0],prefix=customerFlow?'/checkout/':'/diagnostic/checkout/';
   const resource=customerFlow&&(path==='/jobs'||path?.startsWith('/uploads/'));
   if(!resource&&!path?.startsWith(prefix)&&!path?.startsWith('/resource-')&&path!=='/proxy/resource-proof')return false;
   if(!permit()){send(res,404,{code:'NOT_FOUND'});return true;}
   let failedAction=null;
   try{
    if(await proofHttp(req,res))return true;
    if(await sessionHttp(req,res))return true;
    if(resource){need(typeof resourceHandler==='function','CUSTOMER_RESOURCES_CLOSED');return await resourceHandler(req,res,sessions);}
    const action=path.slice(prefix.length);
    need(path.startsWith(prefix)&&[...Object.keys(limits).filter(k=>k!=='issue'),'continue'].includes(action)&&req.url===path,'DIAGNOSTIC_PATH');
    failedAction=action;
    need(req.headers.origin===STOREFRONT_ORIGIN&&req.headers.cookie===undefined,'RESOURCE_ORIGIN');
    res.setHeader('Access-Control-Allow-Origin',STOREFRONT_ORIGIN);res.setHeader('Vary','Origin');
    if(req.method==='OPTIONS'){
     const headers=(req.headers['access-control-request-headers']??'').toLowerCase().split(',').map(s=>s.trim()).filter(Boolean);
     need(req.headers['access-control-request-method']==='POST'&&headers.every(x=>['content-type','authorization'].includes(x)),'DIAGNOSTIC_BODY');
     res.writeHead(204,{'Access-Control-Max-Age':'300','Access-Control-Allow-Methods':'POST','Access-Control-Allow-Headers':'Content-Type, Authorization'});res.end();return true;
    }
    need(req.method==='POST'&&req.headers['content-type']==='application/json'&&!req.headers['content-encoding'],'DIAGNOSTIC_BODY');
    sessions.assert(sessions.authenticate(req));
    let bytes=0;const chunks=[];for await(const c of req){bytes+=c.length;need(bytes<=(eligibility&&policy.clientPolicy&&action==='resume_uploads'?65536:8192),'DIAGNOSTIC_BODY');chunks.push(c);}
    let body;try{body=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{need(false,'DIAGNOSTIC_BODY');}
    const exactRecovery=eligibility&&policy.clientPolicy&&action==='resume_uploads'&&Object.hasOwn(body??{},'selection');
    const keys=exactRecovery?['proof','cart_id','selection']:action==='continue'?['proof','cart_id','continuation']:eligibility&&action==='eligible'?['proof','cart_id','reference','generation']:eligibility&&action==='cancel_preparation'?['proof','cart_id','reservation']:eligibility&&action==='resume'&&Object.hasOwn(body??{},'operation')?['proof','cart_id','operation']:['proof','cart_id'];
    need(body&&!Array.isArray(body)&&Object.keys(body).length===keys.length&&keys.every(k=>Object.hasOwn(body,k))&&typeof body.cart_id==='string'&&(action!=='continue'||typeof body.continuation==='string'),'DIAGNOSTIC_BODY');
    if(exactRecovery)need(body.selection&&typeof body.selection==='object'&&!Array.isArray(body.selection)&&Object.keys(body.selection).sort().join(',')==='intent_ids,version'&&body.selection.version==='uncommitted-v1'&&Array.isArray(body.selection.intent_ids)&&body.selection.intent_ids.length>0&&body.selection.intent_ids.length<=1000&&new Set(body.selection.intent_ids).size===body.selection.intent_ids.length&&body.selection.intent_ids.every(id=>typeof id==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)),'DIAGNOSTIC_BODY');
    if(action==='eligible')need(Number.isSafeInteger(body.generation)&&body.generation>0&&body.reference&&Object.keys(body.reference).sort().join(',')==='config_version,id,revision,signature'&&Object.values(body.reference).every(v=>typeof v==='string'&&v.length<=200),'DIAGNOSTIC_BODY');
    if(action==='cancel_preparation')need(body.reservation&&Object.keys(body.reservation).sort().join(',')==='cart_hash,expires_at,generation,job_id,operation_id,owner_hash'&&Number.isSafeInteger(body.reservation.generation)&&Number.isSafeInteger(body.reservation.expires_at),'DIAGNOSTIC_BODY');
    if(Object.hasOwn(body,'operation'))need(body.operation===null||body.operation&&typeof body.operation==='object'&&!Array.isArray(body.operation)&&Object.keys(body.operation).every(k=>['operation_id','kind','request_key','job','quantity','generation','reservation_id'].includes(k)),'DIAGNOSTIC_BODY');
    if(customerFlow&&body.proof&&typeof body.proof==='object'){
     const evidence=body.proof,fields=['challenge','verifier','ticket'];
     need(!Array.isArray(evidence)&&Object.keys(evidence).length===fields.length&&fields.every(k=>typeof evidence[k]==='string'),'DIAGNOSTIC_BODY');
     // Same proof service and one-use evidence as /resource-proof/exchange;
     // never accept a client-selected action or relax owner/epoch/expiry checks.
     body.proof=proofs.exchange(req,{...evidence,action:'cart-capability'}).proof;
    }
    need(typeof body.proof==='string','DIAGNOSTIC_BODY');
    need(permit()&&!res.destroyed,'DIAGNOSTIC_CLOSED');const input={...body,request:req};let result;
    if(action==='continue')result=await resume(input);
    else if(['install','publish','eligible','cancel_preparation'].includes(action))result=await start(action,input);
    else {
     take(action);
     if(action==='resources'){
      // Private in-memory custody of this already authenticated credential only.
      // Background provider checks reauthenticate it without extending expiry.
      const request={headers:{origin:req.headers.origin,authorization:req.headers.authorization}};
      result=await composition.resources(input,args=>prepareResources({...args,authenticate:()=>sessions.authenticate(request)}));fixtureItem=result.item;
     }
     else if(action==='control')result=await composition.resources(input,async()=>{need(typeof readControl==='function','CONTROL_UNAVAILABLE');return {control:await readControl(),cart_verified:false,checkout_ready:false};});
     else if(action==='copy_item')result=await composition.resources(input,async()=>{need(fixtureItem,'DIAGNOSTIC_FIXTURE_REQUIRED');return {item:fixtureItem,cart_verified:false,checkout_ready:false};});
     else result=await composition[action](input);
     if(action==='inspect'){if(result.binding_value)testMarker=result.binding_value;result={...result,test_marker:testMarker};}
    }
    if(eligibility&&policy.clientPolicy&&['current','resume','resume_uploads'].includes(action))result={...result,upload_recovery:'uncommitted-v1'};
    need(permit()&&!res.destroyed,'DIAGNOSTIC_CLOSED');send(res,result.continuation?202:200,result);
   }catch(error){
    const code=safeCode(error);
    if(failedAction)record({event:'action_failed',action:failedAction,code});
    if(!res.headersSent&&!res.destroyed)send(res,403,{code,checkout_ready:false});else res.destroy();
   }
   return true;
  },
  async maintenance({busy=false}={}){
   if(active&&now()>=active.expires)failActive('DIAGNOSTIC_CONTINUATION_EXPIRED');
   let expired=false;if(sourceScope)try{assertEngineeringScope(sourceScope);}catch{expired=true;}
   if(retirement)return retirement;
   if(!expired&&!busy&&!active)await publisher.reconcileUnpublished();
   if(expired||publisher.retirementDue({busy:busy||!!active}))await retire();
  },
  retire,
  async close(){
   if(closing)return;closing=true;
   let failure;try{await retire();}catch(e){failure=e;}
   if(active)await Promise.allSettled([active.done]);clearTimeout(timer);
   // A late failed resource may add an invalidation after the initial clear.
   if(enabled===true)await publisher.retire();
   if(failure)throw failure;
  },
  status:()=>({counts:{...counts},operation_pending:!!active,continuation_pending:!!active?.resolve,admissions_closed:retiring,retired_at:retiredAt,...publisher.status(),checkout_ready:false}),
 });
}
