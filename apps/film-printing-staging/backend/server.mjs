import {createResourceScope} from './resource-session.mjs';
import {createResourceSessionHttp} from './resource-session-http.mjs';
import {createResourceProof} from './resource-proof.mjs';
import {createResourceProofHttp} from './resource-proof-http.mjs';
import {createOrderIngress} from '../orders/http.mjs';
import {createStorefrontSessionIngress} from './storefront-session-http.mjs';
import {resolveDirectBuyerIp} from './buyer-ip.mjs';
import {createOrderWorker} from '../orders/worker.mjs';
import {createOrderHandoff} from '../orders/service.mjs';
import {createServer} from 'node:http';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createJobService} from '../jobs/service.mjs';
import {createJobHandler} from '../jobs/http.mjs';
import {createSessionAuth} from '../jobs/session.mjs';
import {createLifecycleReceiver} from '../jobs/events.mjs';
import {createConfigLoader} from '../configuration/shopify.mjs';
import {createPriceCatalogLoader} from '../jobs/catalog.mjs';
import {createAuthorityAdmin} from '../checkout/shopify.mjs';
import {createCheckoutProjector} from '../checkout/projector.mjs';
import {createStorefrontReader} from '../checkout/storefront.mjs';
import {createCartRefresh} from '../checkout/refresh.mjs';
import {openDatabase} from './storage.mjs';
import {createAdminTransport} from './admin.mjs';
import {verifyAdminSession} from './auth.mjs';
import {createUploadIngress} from '../uploads/http.mjs';
import {createUploadcareAdapter} from '../uploads/uploadcare.mjs';
import {SHOP,INSTALLATION,RuntimeError,need,safeCode} from './config.mjs';
import {STORE,APP,CLIENT} from '../configuration/schema.mjs';

// Adapters are trusted in-process code, never environment module paths or HTTP
// claims. Only the direct Caddy IP boundary is supplied by the executable;
// owner/cart/uploader proofs remain absent.
export function createRuntime(config,{api,adapters={},storefront={},orders={},uploadcare=null,uploadIngress=false,resourceSessions=null,now=()=>new Date(),pollMs=30000,log=()=>{}}={}) {
  for(const [kind,verify] of Object.entries(adapters.eventVerifiers??{}))
    need(['upload','job','owner'].includes(kind)&&typeof verify==='function','EVENT_VERIFIER_UNAVAILABLE');
  // No executable/environment activation. Local composition cannot bind a public
  // host, silently fall back to cookies, or supply an owner resolver.
  if(resourceSessions)need(resourceSessions.mode==='local-test'&&config.host==='127.0.0.1'&&
    new URL(config.origin).hostname==='127.0.0.1'&&
    ((resourceSessions.freshProof===true&&resourceSessions.observeFreshContext===undefined&&typeof config.appSecret==='string'&&config.appSecret.length>=32)||
      (resourceSessions.freshProof===undefined&&typeof resourceSessions.observeFreshContext==='function'))&&
    config.store===STORE&&config.app===APP&&config.clientId===CLIENT&&config.installation===INSTALLATION&&
    typeof api==='function'&&(!uploadcare?.enabled||typeof uploadcare.fetchImpl==='function')&&
    !orders.enabled&&!orders.worker&&!orders.ingress&&!storefront.enabled&&
    !adapters.resolveOwner,'RESOURCE_COMPOSITION_INVALID');
  api??=createAdminTransport(config);
  const storage=openDatabase(config,{now:()=>now().getTime(),resourceSessions:!!resourceSessions});
  const resourceAuth=resourceSessions?storage.store.resourceSessions:null;
  const resourceScope=resourceAuth?createResourceScope(storage.store,resourceAuth):null;
  const store=resourceScope?.store??storage.store;
  const resourceTickets=new WeakMap();
  const resourceProof=resourceSessions?.freshProof===true?createResourceProof({secret:config.appSecret,sessions:resourceAuth,now:()=>now().getTime()}):null;
  const proofHttp=resourceProof?createResourceProofHttp(resourceProof):null;
  const resourceHttp=resourceAuth?createResourceSessionHttp({sessions:resourceAuth,observeFreshContext:resourceProof?.observeFreshContext??resourceSessions.observeFreshContext}):null;
  const withResource=(req,work)=>resourceScope?resourceScope.run(resourceTickets.get(req),work):work();
  const resolveBuyerIp=adapters.resolveBuyerIp??(config.buyerIpMode==='caddy-direct'?resolveDirectBuyerIp:undefined);
  let storefrontIngress;
  try {storefrontIngress=config.storefrontSessions==='context-only'?createStorefrontSessionIngress({secret:config.appSecret,now:()=>now().getTime(),resolveBuyerIp}):null;}
  catch(error){storage.close();throw error;}
  let uploader;
  try {uploader=uploadcare?createUploadcareAdapter({...uploadcare,store,now:()=>now().getTime()}):null;}
  catch(error){storage.close();throw error;}
  const lifecycle=store.lifecycle,scope=new AsyncLocalStorage();
  const admin=createAuthorityAdmin(api,{writesEnabled:config.mode==='reconcile-only',lifecycle,now});
  const configLoader=createConfigLoader(api,{ttlMs:0}),catalogLoader=createPriceCatalogLoader(api);
  const session=createSessionAuth({secret:config.sessionSecret,origin:config.origin,now:()=>now().getTime()});
  let reconciled=false,closing=false,closed=false,maintenance=null,timer=null;
  let recoveryCode='STARTING',sourceCode='NOT_CHECKED';
  const loader={async load({expectedVersion}={}) {
    const context=scope.getStore();need(context,'SNAPSHOT_REQUIRED');
    need(!expectedVersion||context.release.version===expectedVersion,'VERSION_MISMATCH');return context.release;
  }};
  const jobs=createJobService({store,loader,loadCatalog:async()=>{
    const context=scope.getStore();need(context?.catalog,'PRICE_UNAVAILABLE');return context.catalog;
  },secret:config.jobSecret,validateUploads:uploader?(o,ids)=>uploader.validate(o,ids):undefined}); // No callback can set checkout_ready.
  const orderHandoff=createOrderHandoff({store,jobs,config,enabled:orders.enabled===true,secret:config.appSecret,transport:orders.transport});
  let orderWorker,orderIngress;
  try {
    orderWorker=createOrderWorker({inbox:store.orderInbox,handoff:orderHandoff,enabled:orders.worker===true,onRecorded:()=>void refresh()});
    orderIngress=orders.ingress===true?createOrderIngress({enabled:true,secret:config.appSecret,inbox:store.orderInbox,wake:()=>void orderWorker.run()}):null;
  }catch(error){storage.close();throw error;}
  const checkWork=()=>{
    need(!closing&&reconciled&&!lifecycle.state().operation&&!lifecycle.state().pending,'RECOVERY_REQUIRED');
  };
  const withSnapshot=async work=>{
    checkWork();const epoch=lifecycle.state().epoch;
    const context=await admin.read();checkWork();
    const result=await scope.run(context,work);
    checkWork();need(lifecycle.state().epoch===epoch,'AUTHORITY_FENCED');return result;
  };
  const owner=async req=>{
    if(resourceAuth){
      const ticket=resourceTickets.get(req)??resourceAuth.authenticate(req);
      resourceAuth.assert(ticket);resourceTickets.set(req,ticket);return ticket.owner;
    }
    // A bearer never falls back to the legacy cookie transport.
    if(req.headers.authorization)return null;
    if(typeof req.headers.cookie!=='string'||req.headers.cookie.length>8192||/[^\x20-\x7e]/.test(req.headers.cookie))return null;
    const claimed=session.authenticate(req);
    if(!claimed)return null;
    need(typeof adapters.resolveOwner==='function','OWNER_RESOLVER_UNAVAILABLE');
    const verified=await adapters.resolveOwner({request:req,sessionOwner:claimed});
    need(verified===claimed&&!lifecycle.retired('owner',claimed),'OWNER_REJECTED');
    return verified;
  };
  const quote=typeof adapters.resolveCart==='function'&&typeof adapters.provider?.quote==='function'?jobs.quoteService({
    resolveCart:async(request,options)=>{
      const cart=await adapters.resolveCart(request,options);
      need(cart?.owner===request.owner&&cart.store===config.store&&cart.complete===true,'OWNER_REJECTED');return cart;
    },provider:adapters.provider}):null;
  const projector=createCheckoutProjector({jobs,resolveCart:async request=>{
    need(typeof adapters.resolveCart==='function','CART_RESOLVER_UNAVAILABLE');
    const cart=await adapters.resolveCart(request);need(cart?.owner===request.owner,'OWNER_REJECTED');return cart;
  },loadContext:admin.read});
  const readCart=createStorefrontReader({...storefront,store:config.store,shopId:SHOP},storefront.transport);
  const refreshCart=createCartRefresh({store,jobs,admin,
    readCart:async input=>readCart({...input,buyerIp:await resolveBuyerIp?.(input.request)}),verifyOwnership:adapters.verifyCartOwnership,
    publicationEnabled:false,now:()=>now().getTime()});
  const receivers=Object.fromEntries(Object.entries(adapters.eventVerifiers??{}).map(([kind,verify])=>
    [kind,createLifecycleReceiver({store,jobs,kind,verify})]));
  const status=()=>({live:!closing,checkout_ready:false,ready:false,recovery:recoveryCode,sources:sourceCode,
    pending_events:lifecycle.state().pending,unknown_write:!!lifecycle.state().operation,order_intake:store.orderInbox.counts(),order_worker:orderWorker.status(),
    gates:['CHECKOUT_INTEGRATION_UNPROVEN','ORDER_SOURCE_LINK_UNPROVEN',...(!orderIngress?['ORDER_INGRESS_DISABLED']:[]),...(!adapters.resolveOwner?['OWNER_RESOLVER_UNAVAILABLE']:[]),...(resourceAuth?['LOCAL_RESOURCE_SESSIONS_ONLY']:['RESOURCE_SESSIONS_DISABLED']),
      ...(!(uploader||adapters.verifyUpload)?['UPLOADER_UNAVAILABLE']:[]),...(uploader&&!uploader.transportEnabled?['UPLOAD_TRANSPORT_DISABLED']:[]),...(!adapters.resolveCart?['CART_RESOLVER_UNAVAILABLE']:[]),
      ...(!adapters.provider?['RATE_PROVIDER_UNAVAILABLE']:[])]});
  const refresh=()=>{
    if(closing)return Promise.resolve();
    if(maintenance)return maintenance;
    maintenance=(async()=>{
      try {store.uploadLedger.sweep();}
      catch(error){reconciled=false;recoveryCode=safeCode(error);return;}
      const state=lifecycle.state();
      if(!reconciled||state.pending||state.operation) {
        reconciled=false;
        if(config.mode!=='reconcile-only')recoveryCode='AUTHORITY_WRITES_DISABLED';
        else try {await admin.reconcile();store.cartRefresh.recovered();reconciled=true;recoveryCode='RECONCILED';}
        catch(error){recoveryCode=safeCode(error);}
      }
      try {await configLoader.load({fresh:true});await catalogLoader();sourceCode='LOADED';}
      catch(error){sourceCode=safeCode(error);}
      log({event:'maintenance',recovery:recoveryCode,sources:sourceCode,pending_events:lifecycle.state().pending,checkout_ready:false});
    })().finally(()=>{maintenance=null;});
    return maintenance;
  };
  const send=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store',
    'X-Content-Type-Options':'nosniff','Connection':'close'});res.end(JSON.stringify(body));};
  const active=new Set();
  const track=work=>{active.add(work);work.then(()=>active.delete(work),()=>active.delete(work));return work;};
  let ingress=null;
  const server=createServer({maxHeaderSize:16384,requestTimeout:10000,headersTimeout:10000,connectionsCheckingInterval:1000},(req,res)=>{
    const work=(async()=>{
      try {
        if(closing)return send(res,503,{code:'SHUTTING_DOWN',checkout_ready:false});
        if(req.method==='GET'&&req.url==='/healthz')return send(res,200,{live:true,checkout_ready:false});
        if(req.method==='GET'&&req.url==='/readyz')return send(res,503,{ready:false,checkout_ready:false});
        if(req.method==='GET'&&req.url==='/admin/status') {
          if(!config.appSecret)return send(res,503,{code:'ADMIN_SESSION_UNAVAILABLE',checkout_ready:false});
          if(!verifyAdminSession(req.headers.authorization,config.appSecret,now().getTime()))return send(res,401,{code:'UNAUTHENTICATED'});
          return send(res,200,status());
        }
        if(orderIngress&&await orderIngress(req,res))return;
        if(storefrontIngress&&await storefrontIngress.handle(req,res))return;
        if(proofHttp&&await proofHttp(req,res))return;
        if(resourceHttp&&await resourceHttp(req,res))return;
        if(ingress&&await ingress(req,res))return;
        if(req.method!=='POST'||!['/jobs','/quote'].includes(req.url))return send(res,404,{code:'NOT_FOUND'});
        // Check raw byte count before the inherited JSON handler (UTF-8 chunks can
        // split codepoints). No inflated compressed bodies or forwarded Origin.
        if(req.headers['content-encoding'])return send(res,415,{code:'ENCODING_UNSUPPORTED'});
        if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']??''))return send(res,415,{code:'JSON_REQUIRED'});
        if(Number(req.headers['content-length']??0)>32768)return send(res,413,{code:'TOO_LARGE'});
        const authenticated=await owner(req);if(!authenticated)return send(res,401,{code:'UNAUTHENTICATED'});
        checkWork();
        need(uploader||typeof adapters.verifyUpload==='function','UPLOADER_UNAVAILABLE');
        if(req.url==='/quote'){need(adapters.resolveCart,'CART_RESOLVER_UNAVAILABLE');need(quote,'RATE_PROVIDER_UNAVAILABLE');}
        const chunks=[];let bytes=0;
        for await(const chunk of req){bytes+=chunk.length;if(bytes>32768)return send(res,413,{code:'TOO_LARGE'});chunks.push(chunk);}
        const raw=Buffer.concat(chunks);
        // Avoid authenticating/resolving the owner a second time across a race.
        const bounded={method:req.method,url:req.url,headers:req.headers,async *[Symbol.asyncIterator](){yield raw;}};
        checkWork();
        const authenticatedHandler=createJobHandler({service:{prepare:(o,input)=>withResource(req,()=>{
          if(resourceAuth)resourceAuth.admit(resourceTickets.get(req),'jobs',input?.request_key);
          return withSnapshot(()=>jobs.prepare(o,input));
        })},authenticate:async()=>authenticated,
          quote:quote?{quote:request=>withSnapshot(async()=>({...await quote.quote({...request,request:req}),checkout_ready:false}))}:null});
        await authenticatedHandler(bounded,res);
      } catch(error){if(!res.headersSent)send(res,error instanceof RuntimeError&&error.code==='OWNER_REJECTED'?403:503,{code:safeCode(error),checkout_ready:false});else res.destroy();}
    })();
    track(work);
  });
  server.maxConnections=64;server.maxRequestsPerSocket=1;server.setTimeout(15000,socket=>socket.destroy());
  server.on('checkContinue',(req,res)=>send(res,417,{code:'EXPECT_UNSUPPORTED',checkout_ready:false}));
  const runtime={
    server,store,jobs,session,status,refresh,
    retryOrder(deliveryHash,evidenceHash){need(!closing,'SHUTTING_DOWN');store.orderInbox.retry(deliveryHash,evidenceHash);void orderWorker.run();},
    upload(action,request,input={}) {return track((async()=>{
      need(!closing&&uploader,'UPLOADER_UNAVAILABLE');
      const authenticated=await owner(request);need(authenticated,'OWNER_REJECTED');
      try {
        if(action==='remove'&&resourceScope)return resourceScope.remove(resourceTickets.get(request),()=>uploader.remove(authenticated,input.intent_id));
        return await withResource(request,async()=>{
        if(action==='intent'){
          if(resourceAuth)resourceAuth.admit(resourceTickets.get(request),'uploads',input.request_key);
          return uploader.intent(authenticated,input.request_key);
        }
        if(action==='bytes')return await uploader.upload(authenticated,input.intent_id,input);
        if(action==='status')return await uploader.status(authenticated,input.intent_id);
        if(action==='remove')return uploader.remove(authenticated,input.intent_id);
        // In-process only; HTTP upload ingress has no delivery route. Requires
        // the same independently authenticated owner as all upload operations.
        if(action==='delivery')return await uploader.delivery(authenticated,input.intent_id,input.variant);
        throw new RuntimeError('UPLOAD_ACTION_INVALID');
      });} finally {void refresh();}
    })());},
    receiveUploadDeletion(input) {return track((async()=>{
      need(!closing&&uploader,'UPLOADER_UNAVAILABLE');
      const receipt=uploader.deleted(input);void refresh();return receipt;
    })());},
    prepareAuthority(request){return track((async()=>{need(!resourceAuth,'RESOURCE_CART_PROOF_UNAVAILABLE');checkWork();need(typeof request.owner==='string','OWNER_REJECTED');return projector.prepare(request);})());},
    refreshAuthority(request,input={}){return track((async()=>{
      need(!resourceAuth,'RESOURCE_CART_PROOF_UNAVAILABLE');
      need(!closing,'SHUTTING_DOWN');
      const authenticated=await owner(request);need(authenticated,'OWNER_REJECTED');
      // Explicit fields only; no owner/customer/lines/complete claims from input.
      return refreshCart({request,owner:authenticated,cart_id:input.cart_id,request_key:input.request_key});
    })());},
    recordUpload(input){return track((async()=>{
      need(!closing&&(uploader||typeof adapters.verifyUpload==='function'),'UPLOADER_UNAVAILABLE');
      const e=await (uploader?uploader.verifyUpload(input):adapters.verifyUpload(input));
      need(e?.store===config.store&&e.app===config.app&&typeof e.owner==='string'&&e.owner,'OWNER_REJECTED');
      const receipt=store.recordUpload(e.owner,e.asset);void refresh();return receipt;
    })());},
    receiveOrder(input){return track((async()=>{
      need(!closing,'SHUTTING_DOWN');const receipt=await orderHandoff(input);void refresh();return receipt;
    })());},
    receive(kind,input){return track((async()=>{need(!closing&&receivers[kind],'EVENT_VERIFIER_UNAVAILABLE');const receipt=await receivers[kind](input);void refresh();return receipt;})());},
    async start(){
      await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port,config.host,()=>{server.removeListener('error',reject);resolve();});});
      timer=setInterval(()=>void refresh(),pollMs);timer.unref();void refresh();orderWorker.start();return server.address();
    },
    async close(){
      if(closed)return;
      closing=true;clearInterval(timer);const stopOrders=orderWorker.stop();
      storefrontIngress?.close();
      resourceProof?.close();
      const drain=new Promise(resolve=>server.listening?server.close(resolve):resolve());
      const force=setTimeout(()=>server.closeAllConnections(),15000);force.unref();
      await drain;await stopOrders;await Promise.allSettled([...active]);if(maintenance)await maintenance;
      clearTimeout(force);storage.close();closed=true;
    },
  };
  if(uploadIngress===true) {
    try {
      need(uploader&&(resourceAuth||typeof adapters.resolveOwner==='function'),'UPLOAD_INGRESS_INVALID');
      ingress=createUploadIngress({config,enabled:true,authenticate:owner,upload:runtime.upload,receiveUploadDeletion:runtime.receiveUploadDeletion});
    } catch(error){storage.close();throw error;}
  }
  return runtime;
}
