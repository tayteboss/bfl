import {createHash} from 'node:crypto';
import {createResourceScope} from './resource-session.mjs';
import {createUploadcareAdapter} from '../uploads/uploadcare.mjs';
import {createUploadIngress} from '../uploads/http.mjs';
import {createServer} from 'node:http';
import {need,safeCode,INSTALLATION} from './config.mjs';
import {STORE,APP,CLIENT} from '../configuration/schema.mjs';
import {openDatabase} from './storage.mjs';
import {createResourceProof} from './resource-proof.mjs';
import {createResourceProofHttp} from './resource-proof-http.mjs';
import {createResourceSessionHttp} from './resource-session-http.mjs';
import {createStorefrontSessionIngress} from './storefront-session-http.mjs';
import {resolveDirectBuyerIp} from './buyer-ip.mjs';

// Upload-only composition. No Admin, source polling, jobs, cart, orders or
// publication transport. Provider cleanup uses the same durable SQLite custody.
export function createUploadOnlyRuntime(config,{now=Date.now,uploadcare=config.uploadcare,pollMs=30000}={}) {
  const local=config.host==='127.0.0.1'&&new URL(config.origin).hostname==='127.0.0.1';
  need(config.resourceSessions==='upload-only'&&config.mode==='disabled'&&!config.adminToken&&
    config.store===STORE&&config.app===APP&&config.clientId===CLIENT&&config.installation===INSTALLATION&&
    typeof config.appSecret==='string'&&config.appSecret.length>=32&&config.storefrontSessions==='context-only'&&
    (local||config.host==='0.0.0.0'&&config.origin==='https://film-printing-staging.bellowsfilmlab.com'&&config.buyerIpMode==='caddy-direct'),
    'UPLOAD_ONLY_COMPOSITION_INVALID');
  need(local||Number.isSafeInteger(config.uploadWindowUntil)&&config.uploadWindowUntil>now()&&config.uploadWindowUntil<=now()+1800000,'UPLOAD_WINDOW_REQUIRED');
  need(local||/^[a-f0-9]{64}$/.test(config.uploadDigest??''),'UPLOAD_DIGEST_REQUIRED');
  const windowOpen=()=>!config.uploadWindowUntil||now()<config.uploadWindowUntil;
  const storage=openDatabase(config,{now,resourceSessions:true,uploadOnly:true});
  let uploader;
  const sessions=storage.store.resourceSessions,scope=createResourceScope(storage.store,sessions),tickets=new WeakMap();
  try {need(uploadcare?.enabled===true,'UPLOAD_TRANSPORT_DISABLED');uploader=createUploadcareAdapter({...uploadcare,store:scope.store,custody:storage.store.uploadCustody,now,beforeSend:()=>need(windowOpen(),'UPLOAD_WINDOW_CLOSED')});}
  catch(e){storage.close();throw e;}
  const authenticate=req=>{const ticket=tickets.get(req)??sessions.authenticate(req);sessions.assert(ticket);tickets.set(req,ticket);return ticket.owner;};
  let maintenance=null,timer;
  const cleanup=()=>maintenance??=(async()=>{
    storage.store.uploadLedger.sweep();storage.store.uploadCustody.queue();await uploader.cleanup();
  })().finally(()=>{maintenance=null;});
  const upload=async(action,req,input)=>{
    const owner=authenticate(req),ticket=tickets.get(req);
    let result;
    try {
      if(action==='remove')result=scope.remove(ticket,()=>uploader.remove(owner,input.intent_id));
      else result=await scope.run(ticket,async()=>{
        if(action==='intent'){sessions.admit(ticket,'uploads',input.request_key);return uploader.intent(owner,input.request_key);}
        if(action==='bytes'){
          need(windowOpen(),'UPLOAD_WINDOW_CLOSED');
          need(!config.uploadDigest||createHash('sha256').update(input.bytes).digest('hex')===config.uploadDigest,'UPLOAD_DIAGNOSTIC_PAYLOAD');
          return uploader.upload(owner,input.intent_id,input);
        }
        if(action==='status')return uploader.status(owner,input.intent_id);
        if(action==='preview')return uploader.delivery(owner,input.intent_id,'preview');
        need(false,'UPLOAD_ACTION_INVALID');
      });
    }finally{await cleanup();}
    if(action!=='remove'){need(windowOpen(),'UPLOAD_WINDOW_CLOSED');sessions.assert(ticket);} // cleanup may itself await provider deletion
    if(action==='preview')need(result.expires_at>now(),'UPLOAD_DELIVERY_EXPIRED');
    return result;
  };
  const ingress=createUploadIngress({config,enabled:true,privatePreview:true,authenticate,upload,
    receiveUploadDeletion:()=>{need(false,'UPLOAD_WEBHOOK_DISABLED');}});
  const proofs=createResourceProof({secret:config.appSecret,sessions:storage.store.resourceSessions,now});
  const proofHttp=createResourceProofHttp(proofs);
  const sessionHttp=createResourceSessionHttp({sessions:storage.store.resourceSessions,observeFreshContext:proofs.observeFreshContext});
  const context=createStorefrontSessionIngress({secret:config.appSecret,now,
    resolveBuyerIp:config.buyerIpMode==='caddy-direct'?resolveDirectBuyerIp:undefined});
  const direct=new Set(['/resource-proof/challenge','/resource-proof/exchange',
    '/resource-sessions/issue','/resource-sessions/renew','/resource-sessions/revoke']);
  let closing=false,closed=false;
  const active=new Set();
  const send=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store',
    'X-Content-Type-Options':'nosniff','Connection':'close'});res.end(JSON.stringify(body));};
  const server=createServer({maxHeaderSize:16384,requestTimeout:10000,headersTimeout:10000,connectionsCheckingInterval:1000},(req,res)=>{
    const work=(async()=>{
      try{
        if(closing)return send(res,503,{code:'SHUTTING_DOWN',checkout_ready:false});
        if(req.method==='GET'&&req.url==='/healthz')return send(res,200,{live:true,checkout_ready:false});
        if(req.method==='GET'&&req.url==='/readyz')return send(res,503,{ready:false,checkout_ready:false});
        if(await context.handle(req,res))return;
        const path=req.url?.split('?')[0];
        if(windowOpen()&&(path==='/proxy/resource-proof'||direct.has(path))){
          if(await proofHttp(req,res))return;
          if(await sessionHttp(req,res)){await cleanup();return;}
        }
        if(windowOpen()&&path?.startsWith('/uploads/')){
          if(await sessionHttp(req,res))return; // exact CORS, cookie/query/method checks
          if(await ingress(req,res))return;
        }
        return send(res,404,{code:'NOT_FOUND'});
      }catch(error){if(!res.headersSent)send(res,503,{code:safeCode(error),checkout_ready:false});else res.destroy();}
    })();
    active.add(work);work.finally(()=>active.delete(work));
  });
  server.maxConnections=64;server.maxRequestsPerSocket=1;server.setTimeout(65000,s=>s.destroy());
  server.on('checkContinue',(_req,res)=>send(res,417,{code:'EXPECT_UNSUPPORTED',checkout_ready:false}));
  return Object.freeze({server,
    cleanup,
    async start(){await cleanup();timer=setInterval(()=>void cleanup().catch(()=>{}),pollMs);timer.unref();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port,config.host,()=>{server.removeListener('error',reject);resolve();});});return server.address();},
    async close(){
      if(closed)return;closing=true;clearInterval(timer);proofs.close();context.close();
      const force=setTimeout(()=>server.closeAllConnections(),15000);force.unref();
      await new Promise(resolve=>server.listening?server.close(resolve):resolve());
      await Promise.allSettled([...active]);if(maintenance)await maintenance;clearTimeout(force);storage.close();closed=true;
    },
  });
}
