import {createHash,randomBytes} from 'node:crypto';
import {need,safeCode,RuntimeError} from './config.mjs';
import {STOREFRONT_ORIGIN} from './storefront-session.mjs';
import {createResourceProof} from './resource-proof.mjs';
import {createResourceProofHttp} from './resource-proof-http.mjs';
import {createResourceSessionHttp} from './resource-session-http.mjs';
import {createCheckoutComposition} from '../checkout/composition.mjs';
import {preparedPolicy} from '../checkout/prepared-limits.mjs';
import {openCartCapability} from '../checkout/cart-capability.mjs';
import {printLine} from '../checkout/storefront.mjs';
import {fingerprint} from '../jobs/lifecycle.mjs';

const digest=value=>createHash('sha256').update(value).digest('hex');
const actions=new Set(['bind','install','current','resume','resume_uploads','eligible','cancel_preparation','continue','replace_session']);
const structure=cart=>{const {updated_at,...rest}=cart;return fingerprint(rest);};
export function createStagingCheckoutHttp({config,store,admin,transport,sourceScope,resourcesFor,publisher,registry,resolveBuyerIp,now=Date.now,permit=()=>false,record=()=>{}}){
 const policy=preparedPolicy(sourceScope);need(policy.clientPolicy==='bfl-persistent-staging-client-v1','STAGING_CHECKOUT_POLICY');
 const raw=store.resourceSessions,sessions={...raw,issue:e=>raw.issue(e,{ttlMs:policy.ownerMs,sourceScope})};
 const proofs=createResourceProof({secret:config.appSecret,sessions,now,cartCapability:true});
 const proofHttp=createResourceProofHttp(proofs),sessionHttp=createResourceSessionHttp({sessions,observeFreshContext:proofs.observeFreshContext});
 const active=new Map(),resourceWork=new Map(),compositions=new Map();let closed=false;
 const gate=()=>need(!closed&&permit(),'STAGING_SERVICE_CLOSED');
 const authenticated=req=>{const ticket=sessions.authenticate(req);sessions.assert(ticket);need(sessions.clientPolicy(ticket,sourceScope)===policy.clientPolicy,'STAGING_CHECKOUT_POLICY');return ticket;};
 const composition=owner=>{
  if(compositions.has(owner))return compositions.get(owner);
  const resources=resourcesFor(owner);
  const value=createCheckoutComposition({store,jobs:resources.jobs,admin,proofs,transport,custodySecret:config.sessionSecret,resolveBuyerIp,sourceScope,now,enabled:true,permit:()=>!closed&&permit(),persistentStaging:true,
   onEligible:publisher.eligible,onCancel:publisher.cancel,onCurrent:publisher.observeCurrent,onResume:publisher.recoverResume,diagnosePreparation:publisher.diagnosePreparation,assertResume:publisher.assertResume,assertUploadResume:publisher.assertUploadResume,resumeUploads:resources.resumeUploads,
   rememberCart:async({ticket,request})=>store.staging.rememberPeer(ticket,await resolveBuyerIp(request))});
  compositions.set(owner,value);return value;
 };
 const send=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(body));};
 const start=async(action,input)=>{
  const ticket=authenticated(input.request);need(!active.has(ticket.owner)&&!resourceWork.get(ticket.owner),'STAGING_CART_BUSY');
  let notify;const waiting=new Promise(resolve=>{notify=resolve;}),op={ticket,resolve:null,reject:null,receipt:null,timer:null,done:null};active.set(ticket.owner,op);
  const freshContext=()=>new Promise((resolve,reject)=>{
   gate();need(active.get(ticket.owner)===op,'STAGING_CART_BUSY');const receipt=randomBytes(32).toString('base64url');
   op.receipt=digest(receipt);op.resolve=resolve;op.reject=reject;op.expires=now()+30000;
   op.timer=setTimeout(()=>{op.reject?.(new RuntimeError('DIAGNOSTIC_CONTINUATION_EXPIRED'));op.reject=null;},30000);op.timer.unref();
   notify({continuation:receipt,expires_in:30,cart_verified:false,checkout_ready:false});
  });
  op.done=Promise.resolve().then(()=>composition(ticket.owner)[action](input,{freshContext})).finally(()=>{clearTimeout(op.timer);if(active.get(ticket.owner)===op)active.delete(ticket.owner);});
  const result=await Promise.race([waiting,op.done.then(result=>({result}),error=>({error}))]);if(result.error)throw result.error;return result.result??result;
 };
 const resume=async input=>{
  const ticket=authenticated(input.request),op=active.get(ticket.owner);
  need(op?.resolve&&typeof input.continuation==='string'&&digest(input.continuation)===op.receipt&&now()<op.expires&&['owner','verifier','generation'].every(key=>ticket[key]===op.ticket[key]),'DIAGNOSTIC_CONTINUATION_REJECTED');
  const resolve=op.resolve;op.resolve=null;op.reject=null;op.receipt=null;clearTimeout(op.timer);resolve({request:input.request,proof:input.proof,cart_id:input.cart_id});return op.done;
 };
 const replace=async input=>{
  const terminal=raw.authenticateTerminal(input.request);need(!active.has(terminal.owner)&&!resourceWork.get(terminal.owner),'STAGING_CART_BUSY');
  const replacement={done:null};active.set(terminal.owner,replacement);
  replacement.done=(async()=>{
  const original=store.replacements.original(terminal);
  if(!original.unbound)need(input.cart_id===openCartCapability(original.sealed_cart,config.sessionSecret),'CART_OWNER_REJECTED');
  const proofRequest={headers:{origin:STOREFRONT_ORIGIN}};
  const evidence=proofs.observeFreshContext({request:proofRequest,proof:input.proof,action:'issue',ticket:null});
  need(evidence.customerId===null&&evidence.epoch===terminal.epoch,'CART_CUSTOMER_PROOF_UNAVAILABLE');
  const guard=()=>{gate();need(now()<evidence.observedAt+30000&&store.lifecycle.state().epoch===evidence.epoch&&!store.lifecycle.state().pending&&!store.lifecycle.state().operation,'RESOURCE_FENCED');};
  const wire={cart_id:input.cart_id,buyerIp:await resolveBuyerIp(input.request)};guard();
  // Pruning preserves every unrelated cart; expired grants are never extended.
  await registry.prune();guard();
  const first=await transport.readBinding(wire);guard();need(first.parsed.customer_id===null&&!first.parsed.lines.some(printLine)&&first.marker===(original.binding?.marker??null),'STAGING_REPLACEMENT_REJECTED');
  const second=await transport.readBinding(wire);guard();need(second.marker===first.marker&&structure(second.parsed)===structure(first.parsed),'CART_REFRESH_CHANGED');
  if(!original.binding)return store.replacements.issueUnmarked(terminal,second.parsed,evidence);
  const marker=store.replacements.reserve(terminal,second.parsed);need(marker===first.marker,'STAGING_REPLACEMENT_REJECTED');
  // One durable reservation precedes the only remote marker deletion. A lost
  // response remains spent; it never issues a replacement credential by guess.
  await transport.deleteBinding(wire);guard();const after=await transport.readBinding(wire);guard();
  need(after.marker===null&&structure(after.parsed)===structure(first.parsed)&&!after.parsed.lines.some(printLine),'STAGING_REPLACEMENT_REJECTED');
  store.replacements.removed(terminal);return store.replacements.issue(terminal,evidence);
  })().finally(()=>{if(active.get(terminal.owner)===replacement)active.delete(terminal.owner);});return replacement.done;
 };
 return {
  async handle(req,res){
   const path=req.url?.split('?')[0],resource=path==='/jobs'||path?.startsWith('/uploads/');
   if(!resource&&!path?.startsWith('/checkout/')&&!path?.startsWith('/resource-')&&path!=='/proxy/resource-proof')return false;
   let action;
   try{
    gate();
    if(await proofHttp(req,res))return true;
    if(await sessionHttp(req,res))return true;
    if(resource){const ticket=authenticated(req);need(!active.has(ticket.owner),'STAGING_CART_BUSY');resourceWork.set(ticket.owner,(resourceWork.get(ticket.owner)??0)+1);
     try{return await resourcesFor(ticket.owner).handle(req,res,sessions);}finally{const left=resourceWork.get(ticket.owner)-1;if(left)resourceWork.set(ticket.owner,left);else resourceWork.delete(ticket.owner);}}
    action=path.slice('/checkout/'.length);need(path.startsWith('/checkout/')&&req.url===path&&actions.has(action),'DIAGNOSTIC_PATH');
    need(req.headers.origin===STOREFRONT_ORIGIN&&req.headers.cookie===undefined,'RESOURCE_ORIGIN');res.setHeader('Access-Control-Allow-Origin',STOREFRONT_ORIGIN);res.setHeader('Vary','Origin');
    if(req.method==='OPTIONS'){
     const headers=(req.headers['access-control-request-headers']??'').toLowerCase().split(',').map(s=>s.trim()).filter(Boolean);
     need(req.headers['access-control-request-method']==='POST'&&headers.every(x=>['content-type','authorization'].includes(x)),'DIAGNOSTIC_BODY');res.writeHead(204,{'Access-Control-Max-Age':'300','Access-Control-Allow-Methods':'POST','Access-Control-Allow-Headers':'Content-Type, Authorization'});res.end();return true;
    }
    need(req.method==='POST'&&req.headers['content-type']==='application/json'&&!req.headers['content-encoding'],'DIAGNOSTIC_BODY');
    const ticket=action==='replace_session'?null:authenticated(req);
    const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;need(bytes<=(action==='resume_uploads'?65536:8192),'DIAGNOSTIC_BODY');chunks.push(chunk);}
    let body;try{body=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{need(false,'DIAGNOSTIC_BODY');}
    const extra=action==='continue'?['continuation']:action==='eligible'?['reference','generation']:action==='cancel_preparation'?['reservation']:action==='resume'&&Object.hasOwn(body??{},'operation')?['operation']:action==='resume_uploads'&&Object.hasOwn(body??{},'selection')?['selection']:[];
    need(body&&typeof body==='object'&&!Array.isArray(body)&&Object.keys(body).length===2+extra.length&&['proof','cart_id',...extra].every(key=>Object.hasOwn(body,key))&&typeof body.cart_id==='string','DIAGNOSTIC_BODY');
    if(body.proof&&typeof body.proof==='object'){
     need(action!=='replace_session'&&!Array.isArray(body.proof)&&Object.keys(body.proof).sort().join(',')==='challenge,ticket,verifier'&&Object.values(body.proof).every(v=>typeof v==='string'),'DIAGNOSTIC_BODY');
     body.proof=proofs.exchange(req,{...body.proof,action:'cart-capability'}).proof;
    }
    need(typeof body.proof==='string'&&/^[A-Za-z0-9_-]{43}$/.test(body.proof),'DIAGNOSTIC_BODY');
    gate();need(!res.destroyed,'RESOURCE_ABORTED');const input={...body,request:req};let result;
    if(action==='replace_session')result=await replace(input);
    else if(action==='continue')result=await resume(input);
    else result=await start(action,input);
    if(['current','resume','resume_uploads'].includes(action))result={...result,upload_recovery:'uncommitted-v1'};
    gate();need(!res.destroyed,'RESOURCE_ABORTED');send(res,result.continuation?202:200,result);
   }catch(error){record({event:'staging_request_failed',action:action??'resource',code:safeCode(error)});if(!res.headersSent&&!res.destroyed)send(res,403,{code:safeCode(error),checkout_ready:false});else res.destroy();}
   return true;
  },
  async close(){closed=true;proofs.close();for(const op of active.values())op.reject?.(new RuntimeError('STAGING_SERVICE_CLOSED'));await Promise.allSettled([...active.values()].map(op=>op.done));},
  busy:()=>active.size>0||resourceWork.size>0,
 };
}
