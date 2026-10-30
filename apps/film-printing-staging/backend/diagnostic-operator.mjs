// Separate finite executable; backend/main.mjs has no route/flag for this mode.
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {lstatSync,readFileSync,openSync,writeSync,fsyncSync,closeSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readConfig,need,safeCode,SHOP} from './config.mjs';
import {openDatabase} from './storage.mjs';
import {resolveDirectBuyerIp} from './buyer-ip.mjs';
import {createDiagnosticAdminTransport} from './diagnostic-admin.mjs';
import {createDiagnosticCustody} from './diagnostic-custody.mjs';
import {createDiagnosticResources} from './diagnostic-resources.mjs';
import {createCustomerResources} from './customer-resources.mjs';
import {RESOURCE_BOUNDS} from './resource-session.mjs';
import {createCheckoutDiagnostic} from './checkout-diagnostic.mjs';
import {createAuthorityAdmin} from '../checkout/shopify.mjs';
import {createCartCapabilityTransport} from '../checkout/cart-capability.mjs';
import {createEngineeringScope,assertEngineeringScope} from '../configuration/engineering.mjs';
import {createEngineeringSourceOperator} from '../configuration/engineering-operator.mjs';
import {verifyDiagnosticControl,verifyCustomerTarget} from './diagnostic-control.mjs';
import {STORE,APP,CLIENT} from '../configuration/schema.mjs';
import {createCarrierServer} from '../carrier/http.mjs';
import {createEngineeringCarrier} from '../carrier/engineering.mjs';
import {isFullProductCatalog} from '../jobs/selection.mjs';
import {leaseOwners} from '../checkout/lease.mjs';
import {preparedPolicy} from '../checkout/prepared-limits.mjs';

export const RUN_ID='f06p-integrated-v1';
export const INVENTORY_QUERY='query F06PIntegratedInventory { shop { id myshopifyDomain storefrontAccessTokens(first:100){nodes{id accessScopes{handle}} pageInfo{hasNextPage hasPreviousPage}} } currentAppInstallation { id app{id apiKey} accessScopes{handle} } }';
const digest=b=>createHash('sha256').update(b).digest('hex');
export function reserveDiagnosticJournal(directory,planHash){
 const s=lstatSync(directory);need(s.isDirectory()&&!s.isSymbolicLink()&&(s.mode&0o077)===0&&/^[a-f0-9]{64}$/.test(planHash),'PRIVATE_DIAGNOSTIC_DIRECTORY');
 const fd=openSync(join(directory,RUN_ID+'.spent.jsonl'),'wx',0o600);
 const append=record=>{writeSync(fd,JSON.stringify(record)+'\n');fsyncSync(fd);};
 append({event:'reserved',run_id:RUN_ID,plan_sha256:planHash});const d=openSync(directory,'r');try{fsyncSync(d);}finally{closeSync(d);}
 return {append,close:()=>closeSync(fd)};
}
function credential(path,min=32,max=2048){
 const s=lstatSync(path);need(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&(s.mode&0o077)===0&&s.size<=4096,'PRIVATE_DIAGNOSTIC_CREDENTIAL');
 const value=readFileSync(path,'utf8').replace(/\r?\n$/,'');need(value.length>=min&&value.length<=max&&/^[\x21-\x7e]+$/.test(value),'PRIVATE_DIAGNOSTIC_CREDENTIAL');return value;
}
export async function startDiagnosticOperator({config,plan,planHash,directory,sourceRoot,files,uploadConfig,cartToken,shipping,enabled=false,fetchImpl=fetch,importSource,now=Date.now}){
 // Local engineering semantics are exact and private. A later execution still
 // requires a pinned private plan and independently registered host watchdog.
 need(enabled===true&&plan?.phase==='reviewed-integrated'&&plan.run_id===RUN_ID&&plan.source_eligibility==='staging_engineering','OPERATOR_DISABLED');
 need(config.mode==='reconcile-only'&&config.resourceSessions==='disabled'&&config.storefrontSessions==='disabled'&&config.adminToken&&config.appSecret&&
  config.store===STORE&&config.app===APP&&config.clientId===CLIENT&&config.origin==='https://film-printing-staging.bellowsfilmlab.com'&&config.host==='0.0.0.0'&&config.buyerIpMode==='caddy-direct','DIAGNOSTIC_TARGET');
 // This preliminary bound permits source verification only. The admitted
 // private scope below must independently prove its exact pinned source/window.
 const requestedFull=isFullProductCatalog(JSON.parse(plan.engineering?.catalogValue??'null'));
 need(Number.isSafeInteger(plan.until)&&plan.until>now()&&plan.until<=now()+(requestedFull?3600000:1200000)&&plan.watchdog_registered===true,'DIAGNOSTIC_WINDOW');
 need(plan.source_pins&&Object.keys(plan.source_pins).length>=10,'DIAGNOSTIC_SOURCE_PINS');
 for(const [p,h] of Object.entries(plan.source_pins)){need(!p.includes('..')&&!p.startsWith('/')&&digest(readFileSync(join(sourceRoot,p)))===h,'DIAGNOSTIC_SOURCE_CHANGED');}
 const journal=reserveDiagnosticJournal(directory,planHash);let storage,server,carrier,diagnostic,resources,sources,sourceScope,interval,deadline,closed=false,phase='starting',observationUntil=null;
 try{
  const upstream=fetchImpl;
  fetchImpl=async(url,options)=>{
   const started=now(),u=new URL(url);
   const operation=u.hostname==='api.uploadcare.com'?(u.pathname==='/project/'?'provider-identity':'provider-file'):u.pathname.includes('/admin/')?'admin':u.pathname.includes('/api/')?'storefront':'provider';
   try{return await upstream(url,options);}finally{journal.append({event:'network_timing',at:started,operation,time_to_headers_ms:now()-started});}
  };
  need(plan.customer_eligibility===undefined||typeof plan.customer_eligibility==='boolean','CUSTOMER_ELIGIBILITY_MODE');
  const eligibility=plan.customer_eligibility===true;
  const specificationOwner=plan.specification_owner??null;
  need(requestedFull?eligibility&&specificationOwner!==null:specificationOwner===null,'SPECIFICATION_OWNER_REQUIRED');
  leaseOwners(specificationOwner); // The pinned private plan records the actual registration receipt IDs.

  need(!eligibility||plan.customer_flow===true&&plan.customer_edits===true&&plan.customer_jobs===2,'CUSTOMER_ELIGIBILITY_MODE');
  storage=openDatabase(config,{resourceSessions:true,checkoutOwner:true,preparedCart:eligibility,now});const store=storage.store;
  const before=store.lifecycle.state();need(before.epoch===plan.expected_epoch&&before.pending===0&&!before.operation,'DIAGNOSTIC_HISTORY_CHANGED');
  const customerJobs=plan.customer_jobs??1;need([1,2].includes(customerJobs)&&(plan.customer_flow===true||customerJobs===1),'CUSTOMER_JOB_LIMIT');
  const customerEdits=plan.customer_edits===true;need(!customerEdits||plan.customer_flow===true&&customerJobs===2,'CUSTOMER_EDIT_MODE');
  const transport=createDiagnosticAdminTransport(config,{eligibility,specificationOwner,lifecycle:store.lifecycle,publicationLimit:customerEdits?4:customerJobs,replaceSettled:plan.customer_flow===true,enabled:true,permit:()=>{try{return !closed&&phase==='admitting'&&now()<plan.until&&!!assertEngineeringScope(sourceScope);}catch{return false;}},fetchImpl,record:journal.append});
  const inventory=async()=>{
   const d=await transport.api(INVENTORY_QUERY),tokens=d.shop?.storefrontAccessTokens;
   need(d.shop.id===SHOP&&tokens&&Array.isArray(tokens.nodes)&&tokens.nodes.length===0&&tokens.pageInfo?.hasNextPage===false&&tokens.pageInfo.hasPreviousPage===false,'DIAGNOSTIC_PUBLIC_WRITER_UNRESOLVED');
   journal.append({event:'public_token_inventory_empty'});return d;
  };
  const identity=await inventory();
  sourceScope=createEngineeringScope({...plan.engineering,identity,now});
  const policy=preparedPolicy(sourceScope);
  need(assertEngineeringScope(sourceScope).contract.expires_at===plan.until&&plan.until<=now()+policy.windowMs,'DIAGNOSTIC_WINDOW');
  if(policy.clientPolicy){need(eligibility,'CUSTOMER_ELIGIBILITY_MODE');transport.activateFullProduct(sourceScope);}
  if(plan.customer_flow===true)await verifyCustomerTarget(transport.api,{sourceScope});
  else await verifyDiagnosticControl(transport.api,plan.control);
  sources=createEngineeringSourceOperator({config,storage,sourceScope,append:journal.append,fetchImpl,now,eligibility,specificationOwner});
  await sources.apply();
  const admin=createAuthorityAdmin(transport.api,{writesEnabled:true,lifecycle:store.lifecycle,sourceScope,eligibility,specificationOwner,now:()=>new Date(now())});
  const custody=createDiagnosticCustody({store,append:journal.append,maxUploads:plan.customer_flow===true?RESOURCE_BOUNDS.uploads:3});
  resources=(plan.customer_flow===true?createCustomerResources:createDiagnosticResources)({store,api:transport.api,config,uploadConfig,files,importSource,selection:plan.selection,custody,customerJobs,eligibility,enabled:true,permit:()=>!closed&&phase==='admitting'&&now()<plan.until,fetchImpl,now,sourceScope});
  const cart=createCartCapabilityTransport({store:STORE,shopId:SHOP,privateToken:cartToken,enabled:true},{fetchImpl});
  const carts=new Map(),markers=new Set();
  diagnostic=createCheckoutDiagnostic({config:{...config,diagnosticUntil:plan.until},store,jobs:resources.jobs,admin,transport:cart,resolveBuyerIp:resolveDirectBuyerIp,now,enabled:true,record:journal.append,armPublication:transport.arm,prepareResources:resources.prepare,sourceScope,readControl:()=>verifyDiagnosticControl(transport.api,plan.control),customerFlow:plan.customer_flow===true,customerJobs,customerEdits,eligibility,resourceHandler:resources.handle,resumeUploads:resources.resumeUploads,
   rememberCart:({ticket,cart_id,request})=>{const buyerIp=resolveDirectBuyerIp(request);store.resourceSessions.assert(ticket);carts.set(ticket.owner,{cart_id,buyerIp});journal.append({event:'bound_cart',owner:ticket.owner});},
   rememberMarker:marker=>{markers.add(marker);journal.append({event:'installed_marker',marker});},
  });
  if(plan.shipping===true){
   need(shipping&&/^\/carrier\/rates\/[a-f0-9]{64}$/.test(shipping.callbackPath),'CALLBACK_AUTH_REQUIRED');
   const permit=()=>!closed&&phase==='admitting'&&now()<plan.until&&!diagnostic.status().admissions_closed;
   carrier=createCarrierServer({enabled:true,callbackPath:shipping.callbackPath,record:journal.append,
    processCallback:createEngineeringCarrier({sourceScope,jobs:resources.jobs,resolveOwner:id=>{const owner=resources.callbackOwner(id);need(carts.has(owner),'CALLBACK_BINDING_UNAVAILABLE');return owner;},
     token:shipping.token,inventory:shipping.inventory,record:journal.append,permit,now,fetchImpl})});
  }
  const active=new Set();let maintenance=null,stopPromise=null;
  const handle=(req,res)=>{
   const work=(async()=>{
    if(req.method==='GET'&&req.url==='/healthz'){res.writeHead(200);res.end('{"live":true,"checkout_ready":false}');return;}
    if(req.method==='GET'&&req.url==='/readyz'){res.writeHead(503);res.end('{"ready":false,"checkout_ready":false}');return;}
    // A provider recheck and a publication must not mutate the same epoch at
    // once. Waiting requests are tracked in active before this await resumes.
    if(maintenance)await maintenance;
    if(closed){res.writeHead(503);res.end('{"code":"UNAVAILABLE"}');return;}
    if(carrier&&req.url?.startsWith('/carrier/rates/')){await new Promise(resolve=>{res.once('finish',resolve);res.once('close',resolve);carrier.server.emit('request',req,res);});return;}
    if(await diagnostic.handle(req,res))return;res.writeHead(404);res.end('{"code":"NOT_FOUND"}');
   })().catch(()=>{if(!res.headersSent){res.writeHead(503);res.end('{"code":"UNAVAILABLE"}');}else res.destroy();});
   active.add(work);work.finally(()=>active.delete(work));return work;
  };
  server=createServer({maxHeaderSize:16384,requestTimeout:35000,headersTimeout:10000},handle);server.maxConnections=8;server.maxRequestsPerSocket=100;server.setTimeout(35000,s=>s.destroy());
  const stop=()=>{
   if(stopPromise)return stopPromise;closed=true;phase='cleanup';clearInterval(interval);clearTimeout(deadline);
   journal.append({event:'cleanup_started',at:now(),deadline:Math.min(plan.until+630000,now()+480000)});
   stopPromise=(async()=>{
   if(maintenance)await maintenance.catch(()=>{});
   // Clearing is first. Stop admissions/cancel continuation, retire owners and
   // marker, verify EMPTY/fence; only then provider and deployment restoration.
   let error;
   try{await diagnostic.retire();}catch(e){error=e;journal.append({event:'authority_cleanup_unconfirmed'});}
   await carrier?.close();server.closeAllConnections();await new Promise(r=>server.close(r));await Promise.allSettled([...active]);
   try{await diagnostic.close();}catch{error??=Error('cleanup');journal.append({event:'late_authority_cleanup_unconfirmed'});}
   for(const [owner,wire] of carts){try{
    const before=await cart.readBinding(wire);if(before.marker===null)continue;need(markers.has(before.marker),'DIAGNOSTIC_CLEANUP_CONFLICT');
    journal.append({event:'marker_delete_reserved',owner});await cart.deleteBinding(wire);need((await cart.readBinding(wire)).marker===null,'DIAGNOSTIC_CLEANUP_UNCONFIRMED');journal.append({event:'marker_deleted',owner});
   }catch{error??=Error('cleanup');journal.append({event:'marker_cleanup_unconfirmed',owner});}}
   try{const result=await resources.cleanup();journal.append({event:'provider_cleanup',counts:result});need(Object.keys(result).every(k=>k==='deleted'),'DIAGNOSTIC_CLEANUP_UNCONFIRMED');}catch{journal.append({event:'provider_cleanup_unconfirmed'});error??=Error('cleanup');}
   try{await sources.restore();}catch{error??=Error('cleanup');journal.append({event:'source_restoration_unconfirmed'});}
   try{await admin.reconcile();await inventory();}catch{error??=Error('cleanup');journal.append({event:'final_readback_unconfirmed'});}
   phase=error?'closed_unconfirmed':'closed';journal.append({event:phase,checkout_ready:false});storage.close();journal.close();if(error)throw error;
   })();return stopPromise;
  };
  const tick=async()=>{
   if(closed)return; if(maintenance)return maintenance;
   let failed=false,stage='retirement';
   const work=(async()=>{
    await diagnostic.maintenance({busy:active.size>0});
    const status=diagnostic.status();
    if(!closed&&phase==='admitting'&&!active.size&&!status.operation_pending&&!status.admissions_closed){stage='upload_proof';await resources.maintain();}
   })().catch(error=>{failed=true;journal.append({event:'retirement_unconfirmed',stage,code:safeCode(error)});});
   maintenance=work;await work;if(maintenance===work)maintenance=null;
   const retired=diagnostic.status().retired_at;
   if(retired!==null&&phase==='admitting'){
    phase='observing';observationUntil=retired+90000;
    journal.append({event:'retirement_observation',until:observationUntil,hard_deadline:Math.min(plan.until+630000,retired+570000)});
   }
   if(failed||phase==='observing'&&now()>=observationUntil)await stop();
  };
  interval=setInterval(()=>{void tick().catch(()=>{});},1000);interval.unref();
  // Independent host watchdog owns forced termination. Healthy cleanup retains
  // in-memory exact cart custody through its full bounded observation/cleanup.
  deadline=setTimeout(()=>{void stop().catch(()=>{});},Math.max(1,plan.until+630000-now()));deadline.unref();
  await new Promise((ok,no)=>{server.once('error',no);server.listen(config.port,config.host,ok);});
  phase='admitting';journal.append({event:'listening',until:plan.until,hard_deadline:plan.until+630000,checkout_ready:false});
  return {close:stop,tick,handle,address:()=>server.address(),status:()=>({...diagnostic.status(),phase,observation_until:observationUntil,admin:transport.status(),sources:sources.status()})};
 }catch(error){clearInterval(interval);clearTimeout(deadline);await carrier?.close();if(diagnostic)try{await diagnostic.close();}catch{};server?.closeAllConnections();if(server?.listening)await new Promise(r=>server.close(r));
  if(sources)try{await sources.admin.reconcile();journal.append({event:'startup_authority_cleared'});}catch{journal.append({event:'startup_authority_unconfirmed'});}
  if(sources?.status().applied)try{await sources.restore();}catch{journal.append({event:'source_restoration_unconfirmed'});}
  storage?.close();journal.append({event:'startup_failed',code:safeCode(error)});journal.close();throw error;}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 process.umask(0o077);
 try{
  const [planPath,expectedHash,directory,...extra]=process.argv.slice(2);
  need(process.env.BFL_F06P_OPERATOR==='reviewed-integrated'&&process.env.BFL_ALL_WRITERS_STOPPED==='yes'&&!extra.length&&planPath&&expectedHash&&directory,'OPERATOR_DISABLED');
  const stat=lstatSync(planPath);need(stat.isFile()&&!stat.isSymbolicLink()&&(stat.mode&0o077)===0,'PRIVATE_REVIEW_REQUIRED');
  const raw=readFileSync(planPath);need(digest(raw)===expectedHash,'DIAGNOSTIC_REVIEW_CHANGED');const plan=JSON.parse(raw);need(plan.phase==='reviewed-integrated'&&plan.source_eligibility==='staging_engineering','OPERATOR_DISABLED');const config=readConfig();
  const files=plan.files.map(f=>{need(typeof f.path==='string'&&/^fixture-[123]\.png$/.test(f.path),'DIAGNOSTIC_FILE_CHANGED');return {...f,bytes:readFileSync(join(directory,f.path))};});
  const uploadConfig={store:STORE,app:APP,publicKey:'3c958e674d1b0653284b',projectId:699888,cdnOrigin:'https://2082t3ckh5.ucarecd.net',secret:credential(process.env.BFL_UPLOADCARE_API_FILE,20,256),delivery:{projectKey:'3c958e674d1b0653284b',origin:'https://2082t3ckh5.s.ucarecd.net',publicAccessDisabled:true,legacyAccessDisabled:true,signingSecret:credential(process.env.BFL_UPLOADCARE_DELIVERY_FILE)}};
  const shipping=plan.shipping===true?{callbackPath:credential(join(directory,'carrier-path'),79,79),token:credential(join(directory,'shippo-test'),20,256),inventory:JSON.parse(readFileSync(join(directory,'shippo-inventory.json'),'utf8'))}:undefined;
  const runtime=await startDiagnosticOperator({config,plan,planHash:expectedHash,directory,sourceRoot:resolve('.'),files,uploadConfig,cartToken:credential(process.env.BFL_STOREFRONT_PRIVATE_FILE),shipping,enabled:true});
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{runtime.close().then(()=>{process.exitCode=0;},()=>{process.exitCode=1;});});
 }catch(error){console.error(JSON.stringify({code:safeCode(error),checkout_ready:false}));process.exitCode=1;}
}
