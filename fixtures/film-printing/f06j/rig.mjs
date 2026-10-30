// SYNTHETIC Shopify signatures/customer/Admin/provider responses. Real loopback
// HTTP, SQLite, resource service, lifecycle and browser-library calls. No browser.
import {mkdtempSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHmac} from 'node:crypto';
import {createRuntime} from '../../../apps/film-printing-staging/backend/server.mjs';
import {initializeDatabase,migrateResourceSessions} from '../../../apps/film-printing-staging/backend/storage.mjs';
import {STORE,APP,CLIENT} from '../../../apps/film-printing-staging/configuration/schema.mjs';
import {INSTALLATION} from '../../../apps/film-printing-staging/backend/config.mjs';
import {STOREFRONT_ORIGIN as origin} from '../../../apps/film-printing-staging/backend/storefront-session.mjs';
import {PROOF_PURPOSE as purpose} from '../../../apps/film-printing-staging/backend/resource-proof.mjs';
import {RESOURCE_AUDIENCE as audience} from '../../../apps/film-printing-staging/backend/resource-session.mjs';
import {mockAdmin,now as fixtureNow} from '../f06d/mock-admin.mjs';
import {providerConfig,bytes,asset} from '../f05c/rig.mjs';
export {origin,bytes,asset,purpose,audience};
export const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
export const selection={request_key:'fresh-proof-job-1',copies:1,service:'Photo Prints',size:'4x6',paper:'synthetic-paper',lab:'miami',asset_ids:[asset],options:{}};
export async function rig(t,{config,clock={time:fixtureNow().getTime()},m=mockAdmin()}={}) {
  const fresh=!config;
  if(fresh){
    const dataDir=mkdtempSync(join(tmpdir(),'bfl-f06j-'));chmodSync(dataDir,0o700);
    config={store:STORE,app:APP,clientId:CLIENT,installation:INSTALLATION,dataDir,host:'127.0.0.1',port:0,origin:'http://127.0.0.1:6076',mode:'reconcile-only',storefrontSessions:'context-only',
      jobSecret:'synthetic-job-secret'.repeat(3),sessionSecret:'synthetic-cookie-secret'.repeat(3),appSecret:'synthetic-proxy-secret'.repeat(3)};
    config.databaseId=initializeDatabase(config);migrateResourceSessions(config);
  }
  const logs=[],p={beforeUpload:null};
  const api=async(q,v)=>{
    if(q.includes('BflActiveConfiguration'))return {shop:m.data.shop,currentAppInstallation:{...m.data.currentAppInstallation,metafield:m.data.currentAppInstallation.active}};
    if(q.includes('F05PriceCatalog'))return {currentAppInstallation:{metafield:m.data.currentAppInstallation.catalog}};
    return m.api(q,v);
  };
  const fetchImpl=async url=>{
    let data;if(url.endsWith('/project/'))data={pub_key:providerConfig.publicKey};
    else if(url.endsWith('/base/')){if(p.beforeUpload)await p.beforeUpload();data={file:asset};}
    else data={uuid:asset,url:`https://api.uploadcare.com/files/${asset}/`,is_ready:true,is_image:true,mime_type:'image/jpeg',original_file_url:`${providerConfig.cdnOrigin}/${asset}/image.jpg`,datetime_removed:null,datetime_uploaded:'2026-10-21T00:00:00Z',datetime_stored:'2026-10-21T00:00:00Z',size:bytes.length};
    return new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
  };
  const options={api,now:()=>new Date(clock.time),pollMs:60000,log:e=>logs.push(e),resourceSessions:{mode:'local-test',freshProof:true},uploadIngress:true,uploadcare:{config:providerConfig,enabled:true,fetchImpl}};
  const r=createRuntime(config,options);
  t.after(async()=>{await r.close();if(fresh)rmSync(config.dataDir,{recursive:true,force:true});});
  await r.start();await r.refresh();
  const url=`http://127.0.0.1:${r.server.address().port}`;
  const headers=token=>({origin,'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})});
  const call=async(path,input={},token,extra={})=>{
    const response=await fetch(url+path,{method:'POST',headers:{...headers(token),...extra},body:Buffer.isBuffer(input)?input:JSON.stringify(input)});
    return {status:response.status,headers:response.headers,body:await response.json()};
  };
  const sign=(params,patch={})=>{
    const q=new URLSearchParams({shop:STORE,path_prefix:'/apps/bfl-staging',logged_in_customer_id:'',timestamp:String(Math.floor(clock.time/1000)),...params,...patch});
    const message=[...new Set(q.keys())].map(k=>`${k}=${q.getAll(k).join(',')}`).sort().join('');q.set('signature',createHmac('sha256',config.appSecret).update(message).digest('hex'));return q.toString();
  };
  const bootstrap=async(c,customer='',patch={})=>{
    const query=sign({challenge:c.challenge,purpose,audience,action:c.action,logged_in_customer_id:customer},patch);
    const response=await fetch(url+'/proxy/resource-proof?'+query);
    return {status:response.status,body:await response.json(),headers:response.headers,query};
  };
  const challenge=async(action='issue',token)=>call('/resource-proof/challenge',{action},token);
  const proof=async(action='issue',token,customer='')=>{
    const c=(await challenge(action,token)).body,b=(await bootstrap(c,customer)).body;
    return call('/resource-proof/exchange',{action,challenge:c.challenge,verifier:c.verifier,ticket:b.ticket},token);
  };
  const issue=async(customer='')=>call('/resource-sessions/issue',{proof:(await proof('issue',undefined,customer)).body.proof});
  const ticket=token=>r.store.resourceSessions.authenticate({headers:headers(token)});
  return {r,config,clock,m,options,logs,p,url,call,headers,sign,bootstrap,challenge,proof,issue,ticket};
}
export function browserTransport(f,{customer=()=>'',intercept=async(_path,work)=>work()}={}) {
  return async(url,init)=>{
    const proxy=url.startsWith('/apps/');
    if(proxy){
      if(init.credentials!=='same-origin'||init.headers?.Authorization)throw Error('INVALID_TEST_PROXY');
      const q=new URL(url,'https://example.test').searchParams;
      return intercept('/proxy/resource-proof',()=>fetch(f.url+'/proxy/resource-proof?'+f.sign(Object.fromEntries(q),{logged_in_customer_id:customer()})));
    }
    if(!url.startsWith('https://film-printing-staging.bellowsfilmlab.com/')||init.credentials!=='omit')throw Error('INVALID_TEST_TARGET');
    const path=new URL(url).pathname;
    return intercept(path,()=>fetch(f.url+path,{...init,headers:{...init.headers,origin}}));
  };
}
