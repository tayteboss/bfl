import {createServer} from 'node:http';
import {need,safeCode,INSTALLATION,SHOP} from './config.mjs';
import {STORE,APP,CLIENT} from '../configuration/schema.mjs';
import {openDatabase} from './storage.mjs';
import {createResourceProof} from './resource-proof.mjs';
import {createResourceProofHttp} from './resource-proof-http.mjs';
import {createResourceSessionHttp} from './resource-session-http.mjs';
import {createStorefrontSessionIngress} from './storefront-session-http.mjs';
import {STOREFRONT_ORIGIN} from './storefront-session.mjs';
import {resolveDirectBuyerIp} from './buyer-ip.mjs';
import {createCartCapabilityTransport} from '../checkout/cart-capability.mjs';
import {createOwnedCart} from '../checkout/owned-cart.mjs';

// Bounded executable: two fresh application owners, one durable cart attempt.
// No Admin, uploads, jobs, source loader, refresh/publication or reconciliation.
export function createOwnedCartRuntime(config,{now=Date.now,fetchImpl=fetch}={}){
 const local=config.host==='127.0.0.1'&&new URL(config.origin).hostname==='127.0.0.1';
 need(config.resourceSessions==='owned-cart'&&config.mode==='disabled'&&!config.adminToken&&!config.uploadcare&&
  config.store===STORE&&config.app===APP&&config.clientId===CLIENT&&config.installation===INSTALLATION&&
  typeof config.appSecret==='string'&&config.appSecret.length>=32&&config.storefrontSessions==='context-only'&&
  typeof config.cartToken==='string'&&config.cartToken.length>=32&&
  Number.isSafeInteger(config.cartWindowUntil)&&config.cartWindowUntil>now()&&config.cartWindowUntil<=now()+1800000&&
  (local||config.host==='0.0.0.0'&&config.origin==='https://film-printing-staging.bellowsfilmlab.com'&&config.buyerIpMode==='caddy-direct'),'CART_OWNER_COMPOSITION');
 const storage=openDatabase(config,{now,resourceSessions:true,cartOwner:true}),sessions=storage.store.resourceSessions;
 const proofs=createResourceProof({secret:config.appSecret,sessions,now,cartCapability:true});
 const proofHttp=createResourceProofHttp(proofs),sessionHttp=createResourceSessionHttp({sessions,observeFreshContext:proofs.observeFreshContext});
 const context=createStorefrontSessionIngress({secret:config.appSecret,now,resolveBuyerIp:local?undefined:resolveDirectBuyerIp});
 const transport=createCartCapabilityTransport({store:STORE,shopId:SHOP,privateToken:config.cartToken,enabled:true},{fetchImpl});
 const owned=createOwnedCart({store:storage.store,proofs,transport,custodySecret:config.sessionSecret,now,permit:()=>!closing&&now()<config.cartWindowUntil,
  resolveBuyerIp:local?req=>{need(req.socket.remoteAddress==='127.0.0.1','BUYER_IP_PEER_REJECTED');return req.socket.remoteAddress;}:resolveDirectBuyerIp});
 const direct=new Set(['/resource-proof/challenge','/resource-proof/exchange','/resource-sessions/issue','/resource-sessions/renew','/resource-sessions/revoke']);
 const send=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Connection':'close'});res.end(JSON.stringify(body));};
 let closing=false,closed=false,timer;const active=new Set();
 const maintenance=()=>sessions.retireExpiredCartOwners();
 const server=createServer({maxHeaderSize:16384,requestTimeout:10000,headersTimeout:10000,connectionsCheckingInterval:1000},(req,res)=>{
  const work=(async()=>{try{
   if(closing)return send(res,503,{code:'SHUTTING_DOWN',checkout_ready:false});
   if(req.method==='GET'&&req.url==='/healthz')return send(res,200,{live:true,checkout_ready:false});
   if(req.method==='GET'&&req.url==='/readyz')return send(res,503,{ready:false,checkout_ready:false});
   if(await context.handle(req,res))return;
   maintenance();const path=req.url?.split('?')[0],windowOpen=now()<config.cartWindowUntil;
   // Revocation remains possible after the finite route window. It preserves
   // real pending authority events, including while other work is fenced.
   if((windowOpen&&(path==='/proxy/resource-proof'||direct.has(path)))||path==='/resource-sessions/revoke'){
    if(await proofHttp(req,res))return;if(await sessionHttp(req,res))return;
   }
   if(!windowOpen||!['/owned-cart/bind','/owned-cart/status'].includes(path))return send(res,404,{code:'NOT_FOUND'});
   need(req.url===path&&req.headers.origin===STOREFRONT_ORIGIN&&!req.headers.cookie,'CART_HTTP_REJECTED');
   res.setHeader('Access-Control-Allow-Origin',STOREFRONT_ORIGIN);res.setHeader('Vary','Origin');
   if(req.method==='OPTIONS'){
    const headers=(req.headers['access-control-request-headers']??'').toLowerCase().split(',').map(x=>x.trim()).filter(Boolean);
    need(req.headers['access-control-request-method']==='POST'&&headers.every(h=>['content-type','authorization'].includes(h)),'CART_HTTP_REJECTED');
    res.writeHead(204,{'Access-Control-Allow-Methods':'POST','Access-Control-Allow-Headers':'Content-Type, Authorization','Cache-Control':'no-store'});res.end();return;
   }
   need(req.method==='POST'&&req.headers['content-type']==='application/json'&&!req.headers['content-encoding'],'CART_HTTP_REJECTED');
   sessions.assert(sessions.authenticate(req));
   let n=0;const chunks=[];for await(const c of req){n+=c.length;need(n<=4096,'CART_HTTP_REJECTED');chunks.push(c);}
   let input;try{input=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{need(false,'CART_HTTP_REJECTED');}
   need(input&&Object.keys(input).length===2&&typeof input.proof==='string'&&typeof input.cart_id==='string','CART_HTTP_REJECTED');
   need(!res.destroyed&&now()<config.cartWindowUntil,'CART_WINDOW_CLOSED');
   const result=await owned[path.endsWith('/bind')?'bind':'status']({request:req,...input});
   need(!res.destroyed&&now()<config.cartWindowUntil,'CART_WINDOW_CLOSED');send(res,200,result);
  }catch(e){if(!res.headersSent&&!res.destroyed)send(res,403,{code:safeCode(e),checkout_ready:false});else res.destroy();}})();
  active.add(work);work.finally(()=>active.delete(work));
 });
 server.maxConnections=64;server.maxRequestsPerSocket=1;server.setTimeout(20000,s=>s.destroy());
 server.on('checkContinue',(_req,res)=>send(res,417,{code:'EXPECT_UNSUPPORTED',checkout_ready:false}));
 return Object.freeze({server,
  async start(){maintenance();timer=setInterval(()=>{try{maintenance();}catch{}},1000);timer.unref();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port,config.host,()=>{server.removeListener('error',reject);resolve();});});return server.address();},
  async close(){if(closed)return;closing=true;clearInterval(timer);proofs.close();context.close();const force=setTimeout(()=>server.closeAllConnections(),15000);force.unref();await new Promise(r=>server.listening?server.close(r):r());await Promise.allSettled([...active]);clearTimeout(force);storage.close();closed=true;},
 });
}
