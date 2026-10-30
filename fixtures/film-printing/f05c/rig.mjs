// Entirely synthetic credentials, owner, image and provider; no external request.
import {mkdtempSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHmac} from 'node:crypto';
import {STORE,APP,CLIENT} from '../../../apps/film-printing-staging/configuration/schema.mjs';
import {INSTALLATION} from '../../../apps/film-printing-staging/backend/config.mjs';
import {initializeDatabase} from '../../../apps/film-printing-staging/backend/storage.mjs';
import {createRuntime} from '../../../apps/film-printing-staging/backend/server.mjs';
export const asset='11111111-2222-4333-8444-555555555555';
export const bytes=Buffer.from('synthetic-image-bytes');
export const providerConfig={store:STORE,app:APP,publicKey:'synthetic-project-key',cdnOrigin:'https://synthetic.ucarecd.net',secret:'synthetic-provider-secret-value',delivery:{projectKey:'synthetic-project-key',origin:'https://synthetic.s.ucarecd.net',publicAccessDisabled:true,legacyAccessDisabled:true,signingSecret:'a'.repeat(64)},projectId:73,hookId:82,webhookUrl:'https://staging.invalid/hooks/uploadcare',webhookSecret:'s'.repeat(32)};
export async function rig({enabled=true,resolveOwner=async({sessionOwner})=>sessionOwner,origin='http://127.0.0.1:6076'}={}) {
 const dataDir=mkdtempSync(join(tmpdir(),'bfl-f05-ingress-'));chmodSync(dataDir,0o700);
 const config={store:STORE,app:APP,clientId:CLIENT,installation:INSTALLATION,dataDir,host:'127.0.0.1',port:0,origin,mode:'disabled',jobSecret:'synthetic-job-key'.repeat(3),sessionSecret:'synthetic-session-key'.repeat(3)};
 config.databaseId=initializeDatabase(config);
 let time=Date.now();
 const p={calls:[],ready:true,beforeUpload:null,fail:false};
 p.fetch=async(url,options)=>{
  p.calls.push({url,options});if(p.fail)throw Error('synthetic-provider-secret-value');
  let data;
  if(url.endsWith('/project/'))data={pub_key:providerConfig.publicKey};
  else if(url.endsWith('/base/')){if(p.beforeUpload)await p.beforeUpload();data={file:asset};}
  else data={uuid:asset,url:`https://api.uploadcare.com/files/${asset}/`,is_ready:p.ready,is_image:true,mime_type:'image/jpeg',original_file_url:`${providerConfig.cdnOrigin}/${asset}/image.jpg`,datetime_removed:null,datetime_uploaded:'2026-10-21T00:00:00Z',datetime_stored:'2026-10-21T00:00:00Z',size:bytes.length};
  return new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
 };
 const runtime=createRuntime(config,{api:async()=>{throw Error('SYNTHETIC_ADMIN_OFFLINE');},adapters:{resolveOwner},uploadcare:{config:providerConfig,enabled:true,fetchImpl:p.fetch},uploadIngress:enabled,now:()=>new Date(time)});
 const address=await runtime.start(),url=`http://127.0.0.1:${address.port}`;
 const headers=(owner='owner-a')=>({'content-type':'application/json',origin:config.origin,cookie:runtime.session.issue(owner).split(';')[0]});
 const call=async(path,body={},extra={})=>{
  const r=await fetch(url+path,{method:'POST',headers:{...headers(),...extra},body:Buffer.isBuffer(body)?body:JSON.stringify(body)});
  return {status:r.status,body:await r.json()};
 };
 return {runtime,config,p,url,headers,call,advance:n=>time+=n,now:()=>time,async close(){await runtime.close();rmSync(dataDir,{recursive:true,force:true});}};
}
export function deletion(){
 const raw=Buffer.from(JSON.stringify({hook:{id:82,project:73,target_url:providerConfig.webhookUrl,event:'file.deleted',version:'0.7'},data:{uuid:asset,datetime_removed:'2026-10-21T03:00:01Z'}},null,2)+'\n');
 return {raw,signature:'v1='+createHmac('sha256',providerConfig.webhookSecret).update(raw).digest('hex')};
}
