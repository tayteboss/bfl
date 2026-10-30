import {createServer} from 'node:http';
import {need,safeCode,INSTALLATION} from './config.mjs';
import {STORE,APP,CLIENT} from '../configuration/schema.mjs';
import {openDatabase} from './storage.mjs';
import {createResourceProof} from './resource-proof.mjs';
import {createResourceProofHttp} from './resource-proof-http.mjs';
import {createResourceSessionHttp} from './resource-session-http.mjs';
import {createStorefrontSessionIngress} from './storefront-session-http.mjs';
import {resolveDirectBuyerIp} from './buyer-ip.mjs';

// A deliberately separate executable composition: no Admin/provider transport,
// resource handlers, source loader, background reconciliation or owner resolver.
// Local tests use the same composition on loopback with synthetic signatures.
export function createSessionOnlyRuntime(config,{now=Date.now}={}) {
  const local=config.host==='127.0.0.1'&&new URL(config.origin).hostname==='127.0.0.1';
  need(['session-only','session-only-closed'].includes(config.resourceSessions)&&config.mode==='disabled'&&!config.adminToken&&
    config.store===STORE&&config.app===APP&&config.clientId===CLIENT&&config.installation===INSTALLATION&&
    typeof config.appSecret==='string'&&config.appSecret.length>=32&&config.storefrontSessions==='context-only'&&
    (local||config.host==='0.0.0.0'&&config.origin==='https://film-printing-staging.bellowsfilmlab.com'&&config.buyerIpMode==='caddy-direct'),
    'SESSION_ONLY_COMPOSITION_INVALID');
  const storage=openDatabase(config,{now,resourceSessions:true,sessionOnly:true,currentClosed:config.resourceSessions==='session-only-closed'});
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
        if(config.resourceSessions==='session-only'&&(path==='/proxy/resource-proof'||direct.has(path))){
          if(await proofHttp(req,res))return;
          if(await sessionHttp(req,res))return;
        }
        return send(res,404,{code:'NOT_FOUND'});
      }catch(error){if(!res.headersSent)send(res,503,{code:safeCode(error),checkout_ready:false});else res.destroy();}
    })();
    active.add(work);work.finally(()=>active.delete(work));
  });
  server.maxConnections=64;server.maxRequestsPerSocket=1;server.setTimeout(15000,s=>s.destroy());
  server.on('checkContinue',(_req,res)=>send(res,417,{code:'EXPECT_UNSUPPORTED',checkout_ready:false}));
  return Object.freeze({server,
    async start(){await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port,config.host,()=>{server.removeListener('error',reject);resolve();});});return server.address();},
    async close(){
      if(closed)return;closing=true;proofs.close();context.close();
      const force=setTimeout(()=>server.closeAllConnections(),15000);force.unref();
      await new Promise(resolve=>server.listening?server.close(resolve):resolve());
      await Promise.allSettled([...active]);clearTimeout(force);storage.close();closed=true;
    },
  });
}
