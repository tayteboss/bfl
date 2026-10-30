// Offline generated transport only. Real session/proof/parser/writer/job modules.
import {mkdtempSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHmac} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {initializeDatabase,migrateResourceSessions,migrateUploadCustody,migrateCartCapability,migrateOwnedCart,migrateCheckoutComposition,openDatabase} from '../../../apps/film-printing-staging/backend/storage.mjs';
import {createResourceProof} from '../../../apps/film-printing-staging/backend/resource-proof.mjs';
import {createResourceScope} from '../../../apps/film-printing-staging/backend/resource-session.mjs';
import {createCartCapabilityTransport,BINDING_QUERY,BINDING_MUTATION,BINDING_NAMESPACE,BINDING_KEY} from '../../../apps/film-printing-staging/checkout/cart-capability.mjs';
import {createCheckoutComposition} from '../../../apps/film-printing-staging/checkout/composition.mjs';
import {createJobService} from '../../../apps/film-printing-staging/jobs/service.mjs';
import {createAuthorityAdmin} from '../../../apps/film-printing-staging/checkout/shopify.mjs';
import {STORE,APP,CLIENT} from '../../../apps/film-printing-staging/configuration/schema.mjs';
import {SHOP,INSTALLATION} from '../../../apps/film-printing-staging/backend/config.mjs';
import {STOREFRONT_ORIGIN as origin} from '../../../apps/film-printing-staging/backend/storefront-session.mjs';
import {mockAdmin,now} from '../f06d/mock-admin.mjs';
import {selection,cartResponse} from '../f06c-continuation/synthetic.mjs';
export const id='gid://shopify/Cart/composition-synthetic?key=synthetic-full-key';
export const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
export function configuration(t){
 const dataDir=mkdtempSync(join(tmpdir(),'bfl-composition-'));chmodSync(dataDir,0o700);
 const config={dataDir,store:STORE,app:APP,clientId:CLIENT,installation:INSTALLATION,jobSecret:'synthetic-job-secret'.repeat(3),sessionSecret:'synthetic-session-secret'.repeat(3),appSecret:'synthetic-app-secret'.repeat(3)};
 config.databaseId=initializeDatabase(config);migrateResourceSessions(config);migrateUploadCustody(config);migrateCartCapability(config);migrateOwnedCart(config);
 config.localClosers=[];t.after(()=>{for(const close of config.localClosers)close();rmSync(dataDir,{recursive:true,force:true});});return config;
}
export function proofClient(sessions,proofs,config,clock){
 const request=token=>({headers:{origin,...(token?{authorization:'Bearer '+token}:{})}});
 const proof=(action,token,customer='')=>{
  const req=request(token),c=proofs.challenge(req,{action});
  const q=new URLSearchParams({shop:STORE,path_prefix:'/apps/bfl-staging',logged_in_customer_id:customer,timestamp:String(Math.floor(clock.time/1000)),challenge:c.challenge,purpose:c.purpose,audience:c.audience,action});
  q.set('signature',createHmac('sha256',config.appSecret).update([...q].map(([k,v])=>`${k}=${v}`).sort().join('')).digest('hex'));
  const b=proofs.bootstrap(q.toString());return proofs.exchange(req,{action,challenge:c.challenge,verifier:c.verifier,ticket:b.ticket}).proof;
 };
 const issue=()=>sessions.issue(proofs.observeFreshContext({request:request(),proof:proof('issue'),action:'issue',ticket:null})).token;
 return {request,proof,issue};
}
export function rig(t,{config,clock={time:now().getTime()},enabled=true,state}={}){
 if(!config){config=configuration(t);migrateCheckoutComposition(config);}
 const h=openDatabase(config,{resourceSessions:true,checkoutOwner:true,now:()=>clock.time}),store=h.store;
 const proofs=createResourceProof({secret:config.appSecret,sessions:store.resourceSessions,now:()=>clock.time,cartCapability:true});
 const client=proofClient(store.resourceSessions,proofs,config,clock),m=mockAdmin();
 const admin=createAuthorityAdmin(m.api,{writesEnabled:true,lifecycle:store.lifecycle,now:()=>new Date(clock.time)});
 const scope=createResourceScope(store,store.resourceSessions);
 const jobs=createJobService({store:scope.store,loader:{load:async()=>m.release},loadCatalog:async()=>(await admin.read()).catalog,secret:config.jobSecret});
 state??={cart:{...cartResponse(null,id).data.cart,note:'',attributes:[]},marker:null,reads:0,checks:0,markerReads:0,markerWrites:0,hook:null,lost:false};
 const transport=createCartCapabilityTransport({store:STORE,shopId:SHOP,privateToken:'synthetic-private-token'.repeat(3),enabled:true},{fetchImpl:async(url,opts)=>{
  if(url!==`https://${STORE}/api/2026-07/graphql.json`)throw Error('WRONG_TARGET');
  const q=JSON.parse(opts.body),kind=q.query===BINDING_MUTATION?'markerWrites':q.query===BINDING_QUERY?'markerReads':q.query.startsWith('mutation')?'checks':'reads';
  state[kind]++;if(state.hook)await state.hook(kind,q);
  if(state.lost&&['checks','markerWrites'].includes(kind))throw Error('synthetic lost response');
  let data;const cart=structuredClone(state.cart);
  if(kind==='markerWrites'){state.marker=q.variables.fields[0].value;data={cartMetafieldsSet:{userErrors:[]}};}
  else if(kind==='checks')data={cartLinesUpdate:{cart,userErrors:[],warnings:[]}};
  else {if(kind==='markerReads')cart.binding=state.marker===null?null:{namespace:BINDING_NAMESPACE,key:BINDING_KEY,type:'single_line_text_field',value:state.marker};data={shop:{id:SHOP},cart};}
  return new Response(JSON.stringify({data}),{headers:{'content-type':'application/json','x-shopify-api-version':'2026-07'}});
 }});
 const options={store,jobs,admin,proofs,transport,custodySecret:config.sessionSecret,resolveBuyerIp:()=> '127.0.0.1',now:()=>clock.time,enabled};
 const composition=createCheckoutComposition(options);
 const input=(token,cart_id=id,customer='')=>({request:client.request(token),proof:client.proof('cart-capability',token,customer),cart_id});
 const bind=token=>composition.bind(input(token));
 const install=token=>composition.install(input(token),{freshContext:()=>input(token)});
 const prepare=(token,key='refresh-request-0001')=>composition.prepare(input(token),{request_key:key,freshContext:()=>input(token)});
 const addJob=async token=>{
  const ticket=store.resourceSessions.authenticate(client.request(token)),owner=ticket.owner;
  const prepared=await scope.run(ticket,async()=>{
   store.resourceSessions.admit(ticket,'jobs',selection.request_key);
   for(const asset of selection.asset_ids)scope.store.recordUpload(owner,{id:asset,state:'complete',verified:true,url:`https://example.invalid/${asset}`});
   return jobs.prepare(owner,selection);
  });
  state.cart={...cartResponse(prepared,id).data.cart,note:'',attributes:[]};return prepared;
 };
 const rows=table=>{const db=new DatabaseSync(join(config.dataDir,'jobs.sqlite'),{readOnly:true});try{return db.prepare(`SELECT * FROM ${table}`).all();}finally{db.close();}};
 let closed=false;const close=()=>{if(!closed){closed=true;proofs.close();h.close();}};config.localClosers?.push(close);t.after(close);
 return {config,clock,store,proofs,...client,m,admin,jobs,scope,state,transport,options,composition,input,bind,install,prepare,addJob,rows,close};
}
