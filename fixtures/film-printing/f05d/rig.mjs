import {after} from 'node:test';
const directories=[];after(()=>{for(const dir of directories)rmSync(dir,{recursive:true,force:true});});
import {DatabaseSync} from 'node:sqlite';
import {providerConfig,bytes,asset} from '../f05c/rig.mjs';
export {bytes,asset};
export const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
// Actual local HTTP/SQLite; Shopify signatures and customer observations synthetic.
import {mkdtempSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHmac} from 'node:crypto';
import {createUploadOnlyRuntime} from '../../../apps/film-printing-staging/backend/upload-only.mjs';
import {initializeDatabase,migrateResourceSessions,migrateUploadCustody} from '../../../apps/film-printing-staging/backend/storage.mjs';
import {STORE,APP,CLIENT} from '../../../apps/film-printing-staging/configuration/schema.mjs';
import {INSTALLATION} from '../../../apps/film-printing-staging/backend/config.mjs';
import {STOREFRONT_ORIGIN as origin} from '../../../apps/film-printing-staging/backend/storefront-session.mjs';
import {PROOF_PURPOSE as purpose} from '../../../apps/film-printing-staging/backend/resource-proof.mjs';
import {RESOURCE_AUDIENCE as audience} from '../../../apps/film-printing-staging/backend/resource-session.mjs';
export {origin,purpose,audience};
export async function rig(t,{config,clock={time:Date.now()}}={}){
 const fresh=!config;
 if(fresh){const dataDir=mkdtempSync(join(tmpdir(),'bfl-f05d-'));chmodSync(dataDir,0o700);directories.push(dataDir);
 config={store:STORE,app:APP,clientId:CLIENT,installation:INSTALLATION,dataDir,host:'127.0.0.1',port:0,origin:'http://127.0.0.1:6076',mode:'disabled',adminToken:null,resourceSessions:'upload-only',storefrontSessions:'context-only',buyerIpMode:'disabled',jobSecret:'synthetic-job-secret'.repeat(3),sessionSecret:'synthetic-cookie-secret'.repeat(3),appSecret:'synthetic-proxy-secret'.repeat(3)};
 config.databaseId=initializeDatabase(config);migrateResourceSessions(config);migrateUploadCustody(config);}
 const p={posts:0,deletes:0,beforePost:null,beforeInfo:null,unknownPost:false,unknownDelete:false};
 const fetchImpl=async(url,opt)=>{
  let data;
  if(url.endsWith('/project/'))data={pub_key:providerConfig.publicKey};
  else if(url.endsWith('/base/')){p.posts++;if(p.beforePost)await p.beforePost();if(p.unknownPost)throw Error('synthetic-lost-post');data={file:asset};}
  else if(opt.method==='DELETE'){p.deletes++;if(p.unknownDelete)throw Error('synthetic-lost-delete');data={uuid:asset,url:`https://api.uploadcare.com/files/${asset}/`,datetime_removed:'2026-10-23T00:00:00Z'};}
  else {if(p.beforeInfo)await p.beforeInfo();data={uuid:asset,url:`https://api.uploadcare.com/files/${asset}/`,is_ready:true,is_image:true,mime_type:'image/jpeg',original_file_url:`${providerConfig.cdnOrigin}/${asset}/image.jpg`,datetime_removed:null,datetime_uploaded:'2026-10-21T00:00:00Z',datetime_stored:'2026-10-21T00:00:00Z',size:bytes.length};}
  return new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
 };
 const r=createUploadOnlyRuntime(config,{now:()=>clock.time,pollMs:60000,uploadcare:{config:providerConfig,enabled:true,fetchImpl}});
 const rows=(sql,...args)=>{const db=new DatabaseSync(join(config.dataDir,'jobs.sqlite'),{readOnly:true});try{return db.prepare(sql).all(...args);}finally{db.close();}};
 t.after(async()=>{await r.close();});await r.start();
 const url=`http://127.0.0.1:${r.server.address().port}`;
 const headers=token=>({origin,'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})});
 const call=async(path,input={},token,extra={})=>{const v=await fetch(url+path,{method:'POST',headers:{...headers(token),...extra},body:Buffer.isBuffer(input)?input:JSON.stringify(input)});return {status:v.status,headers:v.headers,body:await v.json()};};
 const sign=(params,patch={})=>{const q=new URLSearchParams({shop:STORE,path_prefix:'/apps/bfl-staging',logged_in_customer_id:'',timestamp:String(Math.floor(clock.time/1000)),...params,...patch});const m=[...new Set(q.keys())].map(k=>`${k}=${q.getAll(k).join(',')}`).sort().join('');q.set('signature',createHmac('sha256',config.appSecret).update(m).digest('hex'));return q.toString();};
 const bootstrap=async(c,customer='',patch={})=>{const query=sign({challenge:c.challenge,purpose,audience,action:c.action,logged_in_customer_id:customer},patch);const v=await fetch(url+'/proxy/resource-proof?'+query);return {status:v.status,body:await v.json()};};
 const challenge=async(action='issue',token)=>call('/resource-proof/challenge',{action},token);
 const proof=async(action='issue',token,customer='')=>{const c=(await challenge(action,token)).body,b=(await bootstrap(c,customer)).body;return call('/resource-proof/exchange',{action,challenge:c.challenge,verifier:c.verifier,ticket:b.ticket},token);};
 const issue=async(customer='')=>call('/resource-sessions/issue',{proof:(await proof('issue',undefined,customer)).body.proof});
 return {p,rows,r,config,clock,url,headers,call,sign,bootstrap,challenge,proof,issue};
}
