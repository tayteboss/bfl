// Real local HTTP, runtime and SQLite. Only Shopify signs/replies are synthetic.
import {mkdtempSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {createHmac} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {initializeDatabase,migrateResourceSessions,migrateUploadCustody,migrateCartCapability,migrateOwnedCart} from '../../../apps/film-printing-staging/backend/storage.mjs';
import {createOwnedCartRuntime} from '../../../apps/film-printing-staging/backend/owned-cart.mjs';
import {STORE,APP,CLIENT} from '../../../apps/film-printing-staging/configuration/schema.mjs';
import {SHOP,INSTALLATION} from '../../../apps/film-printing-staging/backend/config.mjs';
export {origin,deferred} from '../f06l/rig.mjs';
import {origin,deferred,cart} from '../f06l/rig.mjs';
export const id='gid://shopify/Cart/f06n-synthetic-cart?key=synthetic-private-capability';
const resources=new WeakMap();
export async function rig(t,{config,clock={time:Date.now()},mode='normal',beforeMigration}={}){
 const fresh=!config;
 if(fresh){const dataDir=mkdtempSync(join(tmpdir(),'bfl-f06n-'));chmodSync(dataDir,0o700);
  config={dataDir,store:STORE,app:APP,clientId:CLIENT,installation:INSTALLATION,jobSecret:'synthetic-job'.repeat(4),sessionSecret:'synthetic-session'.repeat(4),appSecret:'synthetic-app'.repeat(4),cartToken:'synthetic-private'.repeat(4),cartWindowUntil:clock.time+1800000,resourceSessions:'owned-cart',storefrontSessions:'context-only',mode:'disabled',host:'127.0.0.1',origin:'http://127.0.0.1:6076',port:0};
  config.databaseId=initializeDatabase(config);migrateResourceSessions(config);migrateUploadCustody(config);migrateCartCapability(config);
  await beforeMigration?.(config,clock);migrateOwnedCart(config);
 }
 const state={reads:0,writes:0,current:{...cart(),id},mode,gate:null,before:null,after:null,ips:[]};
 const upstream=createServer(async(req,res)=>{
  let b='';for await(const x of req)b+=x;const q=JSON.parse(b),write=q.query.startsWith('mutation');
  state.ips.push(req.headers['shopify-storefront-buyer-ip']);if(write)state.writes++;else state.reads++;
  if(state.before)await state.before(write,state);if(write&&state.gate)await state.gate.promise;
  if(write&&state.mode==='lost'){res.destroy();return;}
  const c=structuredClone(state.current);c.id=q.variables.id;if(write)c.updatedAt='2026-10-23T01:00:01Z';
  if(state.mode==='incomplete')delete c.buyerIdentity;
  if(write&&state.mode==='changed')c.note='changed';
  if(state.after)state.after(write,c);
  res.writeHead(200,{'content-type':'application/json','x-shopify-api-version':'2026-07'});
  res.end(JSON.stringify(write?{data:{cartLinesUpdate:{cart:c,userErrors:state.mode==='invalid'?[{code:'INVALID',field:['cartId']}]:[],warnings:[]}}}:{data:{shop:{id:SHOP},cart:c}}));
 });await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
 const runtime=createOwnedCartRuntime(config,{now:()=>clock.time,fetchImpl:async(url,opts)=>{
  if(url!==`https://${STORE}/api/2026-07/graphql.json`)throw Error('WRONG_TARGET');return fetch(`http://127.0.0.1:${upstream.address().port}`,opts);
 }});const addr=await runtime.start(),url=`http://127.0.0.1:${addr.port}`;
 const headers=token=>({origin,'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})});
 const call=async(path,body={},token,extra={})=>{const r=await fetch(url+path,{method:'POST',headers:{...headers(token),...extra},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
 const sign=(args={},customer='')=>{const q=new URLSearchParams({shop:STORE,path_prefix:'/apps/bfl-staging',logged_in_customer_id:customer,timestamp:String(Math.floor(clock.time/1000)),...args});q.set('signature',createHmac('sha256',config.appSecret).update([...q].map(([k,v])=>`${k}=${v}`).sort().join('')).digest('hex'));return q.toString();};
 const proof=async(action,token,customer='')=>{
  const c=await call('/resource-proof/challenge',{action},token);if(c.status!==200)return c;
  const b=await(await fetch(url+'/proxy/resource-proof?'+sign({challenge:c.body.challenge,purpose:c.body.purpose,audience:c.body.audience,action},customer))).json();
  return call('/resource-proof/exchange',{action,challenge:c.body.challenge,verifier:c.body.verifier,ticket:b.ticket},token);
 };
 const issue=async(customer='')=>call('/resource-sessions/issue',{proof:(await proof('issue',undefined,customer)).body.proof});
 const renew=async token=>call('/resource-sessions/renew',{proof:(await proof('renew',token)).body.proof},token);
 const inspect=async(token,cart_id=id,p,action='bind')=>call('/owned-cart/'+action,{cart_id,proof:p??(await proof('cart-capability',token)).body.proof},token);
 const rows=(sql='SELECT * FROM cart_capability_attempts')=>{const db=new DatabaseSync(join(config.dataDir,'jobs.sqlite'),{readOnly:true});try{return db.prepare(sql).all();}finally{db.close();}};
 let closed=false;const close=async()=>{if(closed)return;closed=true;state.gate?.resolve();await runtime.close();upstream.closeAllConnections();await new Promise(r=>upstream.close(r));};
 if(!resources.has(t)){const list=[];resources.set(t,list);t.after(async()=>{for(const r of [...list].reverse())await r.close();for(const r of list)if(r.fresh)rmSync(r.dir,{recursive:true,force:true});});}
 resources.get(t).push({close,fresh,dir:config.dataDir});
 return {config,clock,state,r:runtime,url,headers,call,sign,proof,issue,renew,inspect,rows,close};
}
