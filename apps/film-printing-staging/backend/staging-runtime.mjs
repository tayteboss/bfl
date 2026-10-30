import {createServer} from 'node:http';
import {need,safeCode,SHOP} from './config.mjs';
import {openDatabase} from './storage.mjs';
import {createAdminTransport} from './admin.mjs';
import {createStagingCredentialProvider} from './staging-credential.mjs';
import {createStagingAdminTransport} from './staging-admin.mjs';
import {createStagingCheckoutHttp} from './staging-checkout-http.mjs';
import {createStagingServiceState,installStagingServiceSchema} from './staging-state.mjs';
import {createStagingOwnerValidator} from './staging-validation.mjs';
import {createStagingResourceState,createStagingUploadCustody,installStagingResourceSchema} from './staging-resource-state.mjs';
import {createCustomerResources} from './customer-resources.mjs';
import {resolveDirectBuyerIp} from './buyer-ip.mjs';
import {verifyCustomerTarget} from './diagnostic-control.mjs';
import {INVENTORY_QUERY} from './diagnostic-operator.mjs';
import {STORE,APP,CLIENT} from '../configuration/schema.mjs';
import {assertEngineeringScope,createPersistentStagingScope} from '../configuration/engineering.mjs';
import {createStagingCartLedgers,installStagingCartSchema} from '../checkout/staging-cart.mjs';
import {createStagingGrantPublication,installStagingGrantSchema} from '../checkout/staging-grants.mjs';
import {createStagingPreparedPublication,installStagingPreparedSchema} from '../checkout/staging-prepared-publication.mjs';
import {createEligibilityProjector} from '../checkout/eligibility-projector.mjs';
import {createAuthorityAdmin,decodeCatalog} from '../checkout/shopify.mjs';
import {createCartCapabilityTransport} from '../checkout/cart-capability.mjs';
import {leaseDeadline,leaseOwners} from '../checkout/lease.mjs';
import {createUploadcareAdapter} from '../uploads/uploadcare.mjs';
import {createEngineeringCarrier} from '../carrier/engineering.mjs';
import {createCarrierServer} from '../carrier/http.mjs';

const tables=['staging_service','staging_cart_peers','staging_capability_attempts','staging_cart_replacements','staging_binding_history','staging_resource_state','staging_upload_custody','staging_grant_versions','staging_grant_publication','staging_prepared_references'];
export function openStagingStorage(config,{sourceScope,now=Date.now,initialize=false}={}){
 let database;
 const storage=openDatabase(config,{resourceSessions:true,checkoutOwner:true,preparedCart:true,persistentSourceScope:sourceScope,now,configureStore(store,db){
  database=db;const present=tables.filter(name=>db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  if(initialize){need(present.length===0&&!store.lifecycle.state().pending&&!store.lifecycle.state().operation,'STAGING_MIGRATION_STATE');
   store.lifecycle.transaction(()=>{installStagingCartSchema(db);installStagingResourceSchema(db);installStagingGrantSchema(db);installStagingPreparedSchema(db);installStagingServiceSchema(db,sourceScope);});
  }else need(present.length===tables.length,'STAGING_MIGRATION_REQUIRED');
  Object.assign(store,createStagingCartLedgers({db,store,sourceScope,now}));
  store.staging=createStagingServiceState({db,store,sourceScope,sessionSecret:config.sessionSecret,now});
 }});
 return {...storage,db:database};
}

// Durable isolated staging only. The service stays available; each individual
// browser still receives a separate immutable finite owner and cart binding.
export async function createPersistentStagingRuntime({config,manifest,files,uploadConfig,shipping,fetchImpl=fetch,now=Date.now,
 resolveBuyerIp=resolveDirectBuyerIp,credentialProvider=null,record=()=>{},importSource,initialize=false}){
 need(config.store===STORE&&config.app===APP&&config.clientId===CLIENT&&config.appSecret&&config.mode==='disabled'&&!config.adminToken&&config.resourceSessions==='disabled'&&config.buyerIpMode==='caddy-direct','STAGING_RUNTIME_TARGET');
 need(config.origin==='https://film-printing-staging.bellowsfilmlab.com'&&config.host==='0.0.0.0'&&manifest?.kind==='bfl-persistent-staging-v1','STAGING_RUNTIME_TARGET');
 leaseOwners(manifest.specification_owner);
 const credentials=credentialProvider??createStagingCredentialProvider(config,{fetchImpl,now});
 const privateConfig={...config,mode:'reconcile-only'};
 const identityApi=createAdminTransport(config,{credentialProvider:credentials,fetchImpl});
 let storage,server,checkout,carrier,timer,maintenance=null,closePromise=null,phase='starting';
 const resources=new Map(),active=new Set(),permit=()=>phase==='starting'||phase==='admitting';
 try{
  const identity=await identityApi(INVENTORY_QUERY),tokens=identity.shop?.storefrontAccessTokens;
  need(identity.shop?.id===SHOP&&tokens?.nodes?.length===0&&tokens.pageInfo?.hasNextPage===false&&tokens.pageInfo.hasPreviousPage===false,'STAGING_PUBLIC_WRITER_UNRESOLVED');
  const sourceScope=createPersistentStagingScope({...manifest.engineering,identity,now}),scope=assertEngineeringScope(sourceScope);
  storage=openStagingStorage(config,{sourceScope,now,initialize});const {store,db}=storage;
  const resourceState=createStagingResourceState({db,store,sourceScope}),custody=createStagingUploadCustody({db,store,sourceScope,now});custody.recover();
  const publication=createStagingAdminTransport(privateConfig,{lifecycle:store.lifecycle,sourceScope,specificationOwner:manifest.specification_owner,credentialProvider:credentials,fetchImpl,permit});
  const authorityAdmin=createAuthorityAdmin(publication.api,{writesEnabled:true,lifecycle:store.lifecycle,sourceScope,eligibility:true,specificationOwner:manifest.specification_owner,now:()=>new Date(now())});
  const admin={...authorityAdmin,async reconcile(){const result=await authorityAdmin.reconcile();publication.cleared(await authorityAdmin.read());return result;}};
  const transport=createCartCapabilityTransport({store:STORE,shopId:SHOP,enabled:true},{fetchImpl,credentialProvider:credentials});
  const resourcesFor=owner=>{
   if(!resources.has(owner))resources.set(owner,createCustomerResources({store,api:publication.api,config,uploadConfig,files,custody,customerJobs:2,eligibility:true,enabled:true,permit,fetchImpl,importSource,now,sourceScope,
    persistent:{owner,state:resourceState,ticketForOwner:id=>store.resourceSessions.ticketForOwner(id)}}));
   return resources.get(owner);
  };
  const jobs={authorityLifecycle:store.lifecycle,resolveForCheckout:(owner,refs,release)=>resourcesFor(owner).jobs.resolveForCheckout(owner,refs,release)};
  const registry=createStagingGrantPublication({db,lifecycle:store.lifecycle,admin,source:{config_version:scope.release.version,config_sha256:scope.release.sha256,price_version:decodeCatalog(scope.catalogValue).version},
   validateOwner:createStagingOwnerValidator({db,store,jobs,transport,sourceScope,now}),deadlineFor:(end,time,zone)=>leaseDeadline(end,time,zone,{sourceScope}),armPublication:publication.arm,now,enabled:true,permit});
  const projector=createEligibilityProjector({jobs,sourceScope});
  const publisher=createStagingPreparedPublication({db,store,jobs,admin,registry,prepareAuthority:projector.prepare,sourceScope,now,enabled:true,permit,record});
  checkout=createStagingCheckoutHttp({config,store,admin,transport,sourceScope,resourcesFor,publisher,registry,resolveBuyerIp,now,permit,record});
  const cleaner=createUploadcareAdapter({store,config:uploadConfig,enabled:true,fetchImpl,now,custody,concurrency:4});
  const refreshProofs=async()=>{
   // A private read-only provider recheck may run while an unrelated authority
   // invalidation is pending. It cannot issue a session or publish a grant.
   const rows=store.staging.refreshableAssets();let next=0;
   const results=await Promise.allSettled(Array.from({length:Math.min(4,rows.length)},async()=>{
    while(next<rows.length){
     const row=rows[next++];if(store.lifecycle.retired('owner',row.owner))continue;
     try{await cleaner.refresh(row.owner,[row.asset]);}
     catch(error){const current=store.uploadLedger.read(row.id);need(current&&['failed','removed'].includes(current.state),'STAGING_PROVIDER_RECOVERY_REQUIRED');record({event:'staging_asset_unavailable',code:safeCode(error)});}
    }
   }));
   const failed=results.find(result=>result.status==='rejected');if(failed)throw failed.reason;
  };
  const recoverKnown=async()=>{
   const events=store.lifecycle.pendingEvents();if(!events.length)return;
   const excluded=store.staging.invalidations(events);
   await registry.reconcileKnown({...excluded,authorizeInvalidations:current=>{store.staging.invalidations(current);return JSON.stringify(current)===JSON.stringify(events);}});
  };
  // Startup and idle maintenance fence uncertain publication outcomes with
  // exact CAS recovery. Old candidates are never retried; their owners suspend.
  const recoverUnknown=async()=>{
   if(store.lifecycle.state().operation||registry.status().uncertain){await admin.reconcile();await registry.recoverCleared();record({event:'staging_unknown_publication_suspended'});}
  };
  await recoverUnknown();
  store.resourceSessions.retireExpiredCartOwners();
  await refreshProofs();
  await recoverKnown();
  await registry.prune();await registry.verify();
  await verifyCustomerTarget(publication.api,{sourceScope,persistentStaging:true});
  if(shipping){
   need(/^\/carrier\/rates\/[a-f0-9]{64}$/.test(shipping.callbackPath),'CALLBACK_AUTH_REQUIRED');
   carrier=createCarrierServer({enabled:true,callbackPath:shipping.callbackPath,record,processCallback:createEngineeringCarrier({sourceScope,jobs,
    resolveOwner:id=>{const owner=store.staging.ownerForJob(id);store.staging.wireFor(owner);return resourcesFor(owner).callbackOwner(id);},token:shipping.token,inventory:shipping.inventory,record,permit,now,fetchImpl})});
  }
  const tick=()=>{
   if(phase!=='admitting'||active.size||checkout.busy())return Promise.resolve();if(maintenance)return maintenance;
   maintenance=(async()=>{
    storage.assertExclusiveWriter();await recoverUnknown();store.resourceSessions.retireExpiredCartOwners();store.uploadLedger.sweep();await refreshProofs();
    await recoverKnown();await registry.prune();await cleaner.cleanup();
   })().catch(error=>{record({event:'staging_maintenance_failed',code:safeCode(error)});throw error;}).finally(()=>{maintenance=null;});return maintenance;
  };
  const handle=(req,res)=>{
   const work=(async()=>{
    if(req.method==='GET'&&req.url==='/healthz'){res.writeHead(200);res.end('{"live":true}');return;}
    if(req.method==='GET'&&req.url==='/readyz'){const ready=phase==='admitting'&&!store.lifecycle.state().operation&&!store.lifecycle.state().pending&&!registry.status().uncertain;res.writeHead(ready?200:503);res.end(JSON.stringify({ready,staging:true,checkout_ready:false}));return;}
    if(maintenance)await maintenance;
    need(phase==='admitting','STAGING_SERVICE_CLOSED');storage.assertExclusiveWriter();
    if(carrier&&req.url?.startsWith('/carrier/rates/')){await new Promise(resolve=>{res.once('finish',resolve);res.once('close',resolve);carrier.server.emit('request',req,res);});return;}
    if(await checkout.handle(req,res))return;res.writeHead(404);res.end('{"code":"NOT_FOUND"}');
   })().catch(error=>{record({event:'staging_http_failed',code:safeCode(error)});if(!res.headersSent&&!res.destroyed){res.writeHead(503);res.end('{"code":"UNAVAILABLE"}');}else res.destroy();});
   active.add(work);work.finally(()=>active.delete(work));return work;
  };
  server=createServer({maxHeaderSize:16384,requestTimeout:35000,headersTimeout:10000},handle);server.maxConnections=32;server.maxRequestsPerSocket=100;server.setTimeout(35000,s=>s.destroy());
  return {
   async start(){need(phase==='starting','STAGING_SERVICE_STATE');await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port,config.host,resolve);});phase='admitting';timer=setInterval(()=>{void tick().catch(()=>{});},1000);timer.unref();record({event:'staging_listening',persistent:true});},
   close(){if(closePromise)return closePromise;phase='closing';clearInterval(timer);closePromise=(async()=>{
    if(maintenance)await maintenance.catch(()=>{});await checkout.close();await carrier?.close();
    server.closeIdleConnections();if(server.listening)await new Promise(resolve=>server.close(resolve));await Promise.allSettled([...active]);
    // Valid owner deadlines, grants and known upload custody survive a graceful
    // restart. No temporary-run restoration or blanket owner retirement occurs.
    storage.close();credentials.close?.();phase='closed';record({event:'staging_stopped',durable:true});
   })();return closePromise;},
   tick,handle,address:()=>server.address(),status:()=>({phase,authority:registry.status(),checkout_ready:false}),
  };
 }catch(error){phase='failed';clearInterval(timer);await checkout?.close();await carrier?.close();server?.closeAllConnections();if(server?.listening)await new Promise(resolve=>server.close(resolve));storage?.close();credentials.close?.();throw error;}
}
