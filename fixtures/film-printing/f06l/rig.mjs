// Real local HTTP and SQLite; all Shopify signatures/responses are SYNTHETIC.
import {mkdtempSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHmac} from 'node:crypto';
import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {initializeDatabase,migrateResourceSessions,migrateUploadCustody,migrateCartCapability,openDatabase} from '../../../apps/film-printing-staging/backend/storage.mjs';
import {createResourceProof} from '../../../apps/film-printing-staging/backend/resource-proof.mjs';
import {createResourceProofHttp} from '../../../apps/film-printing-staging/backend/resource-proof-http.mjs';
import {createCartCapabilityAdapter,createCartCapabilityTransport,CAPABILITY_ACTION} from '../../../apps/film-printing-staging/checkout/cart-capability.mjs';
import {STORE,APP,CLIENT} from '../../../apps/film-printing-staging/configuration/schema.mjs';
import {SHOP,INSTALLATION} from '../../../apps/film-printing-staging/backend/config.mjs';
import {STOREFRONT_ORIGIN as origin} from '../../../apps/film-printing-staging/backend/storefront-session.mjs';
export {origin,CAPABILITY_ACTION};
export const id='gid://shopify/Cart/f06l-synthetic-cart?key=synthetic-private-capability';
export const cart=()=>({id,updatedAt:'2026-10-23T01:00:00Z',totalQuantity:0,note:'',attributes:[],buyerIdentity:{customer:null,purchasingCompany:null},lines:{pageInfo:{hasNextPage:false,hasPreviousPage:false},nodes:[]}});
export const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
export async function rig(t,{clock={time:Date.now()},mode='normal',config,cartCapability=true}={}){
 const fresh=!config;if(fresh){const dataDir=mkdtempSync(join(tmpdir(),'bfl-f06l-'));chmodSync(dataDir,0o700);config={dataDir,store:STORE,app:APP,clientId:CLIENT,installation:INSTALLATION,jobSecret:'synthetic-job-secret'.repeat(3),sessionSecret:'synthetic-session-secret'.repeat(3),appSecret:'synthetic-app-secret'.repeat(3)};config.databaseId=initializeDatabase(config);migrateResourceSessions(config);migrateUploadCustody(config);migrateCartCapability(config);}
 const h=openDatabase(config,{resourceSessions:true,cartCapability:true,now:()=>clock.time}),store=h.store;
 const proofs=createResourceProof({secret:config.appSecret,sessions:store.resourceSessions,now:()=>clock.time,cartCapability});const proofHttp=createResourceProofHttp(proofs);
 const state={reads:0,writes:0,current:cart(),mode,gate:null,alter:null};
 const server=createServer(async(req,res)=>{
  if(req.url==='/synthetic-storefront'){
   let b='';for await(const x of req)b+=x;const q=JSON.parse(b),write=q.query.startsWith('mutation');if(write)state.writes++;else state.reads++;
   if(state.gate&&write)await state.gate.promise;
   if(state.alter)state.alter(write,state);
   if(state.mode==='lost'&&write){res.destroy();return;}
   const c=structuredClone(state.current);c.id=q.variables.id;
   if(state.mode==='incomplete')c.lines.pageInfo.hasNextPage=true;
   if(write)c.updatedAt='2026-10-23T01:00:01Z';
   if(write&&state.mode==='changed')c.note='changed';
   res.writeHead(200,{'content-type':'application/json','x-shopify-api-version':'2026-07'});
   res.end(JSON.stringify(write?{data:{cartLinesUpdate:{cart:c,userErrors:state.mode==='error'?[{code:'INVALID',field:['cartId']}]:[],warnings:state.mode==='warning'?[{code:'WARNING'}]:[]}}}:{data:{shop:{id:SHOP},cart:c}}));return;
  }
  if(await proofHttp(req,res))return;res.writeHead(404);res.end();
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const url=`http://127.0.0.1:${server.address().port}`;
 const transport=createCartCapabilityTransport({store:STORE,shopId:SHOP,privateToken:'synthetic-storefront-token'.repeat(3),enabled:true},{fetchImpl:async(target,options)=>{if(target!==`https://${STORE}/api/2026-07/graphql.json`)throw Error('WRONG_TARGET');return fetch(url+'/synthetic-storefront',options);}});
 const adapter=createCartCapabilityAdapter({store,proofs,transport,custodySecret:config.sessionSecret,resolveBuyerIp:()=> '127.0.0.1',now:()=>clock.time});
 const request=token=>({headers:{origin,authorization:'Bearer '+token}});
 const call=async(path,body,token)=>{const r=await fetch(url+path,{method:'POST',headers:{origin,'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
 const proof=async(action,token,customer='')=>{
  const c=await call('/resource-proof/challenge',{action},token);if(c.status!==200)return c;
  const q=new URLSearchParams({shop:STORE,path_prefix:'/apps/bfl-staging',logged_in_customer_id:customer,timestamp:String(Math.floor(clock.time/1000)),challenge:c.body.challenge,purpose:c.body.purpose,audience:c.body.audience,action});
  q.set('signature',createHmac('sha256',config.appSecret).update([...q].map(([k,v])=>`${k}=${v}`).sort().join('')).digest('hex'));
  const b=await(await fetch(url+'/proxy/resource-proof?'+q)).json();return call('/resource-proof/exchange',{action,challenge:c.body.challenge,verifier:c.body.verifier,ticket:b.ticket},token);
 };
 const issue=async(customer='')=>{const p=await proof('issue',undefined,customer);return store.resourceSessions.issue(proofs.observeFreshContext({request:{headers:{origin}},proof:p.body.proof,action:'issue',ticket:null})).token;};
 const inspect=async(token,cart_id=id,p)=>adapter.inspect({request:request(token),cart_id,proof:p??(await proof(CAPABILITY_ACTION,token)).body.proof});
 const rows=()=>{const db=new DatabaseSync(join(config.dataDir,'jobs.sqlite'),{readOnly:true});try{return db.prepare('SELECT * FROM cart_capability_attempts').all();}finally{db.close();}};
 let closed=false;const close=async()=>{if(closed)return;closed=true;state.gate?.resolve();server.closeAllConnections();await new Promise(r=>server.close(r));proofs.close();h.close();};
 t.after(async()=>{await close();if(fresh)rmSync(config.dataDir,{recursive:true,force:true});});
 return {config,store,proofs,adapter,state,clock,request,proof,issue,inspect,rows,close};
}
