// Actual local HTTP/SQLite; Shopify signatures and customer observations synthetic.
import {mkdtempSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHmac} from 'node:crypto';
import {createSessionOnlyRuntime} from '../../../apps/film-printing-staging/backend/session-only.mjs';
import {initializeDatabase,migrateResourceSessions} from '../../../apps/film-printing-staging/backend/storage.mjs';
import {STORE,APP,CLIENT} from '../../../apps/film-printing-staging/configuration/schema.mjs';
import {INSTALLATION} from '../../../apps/film-printing-staging/backend/config.mjs';
import {STOREFRONT_ORIGIN as origin} from '../../../apps/film-printing-staging/backend/storefront-session.mjs';
import {PROOF_PURPOSE as purpose} from '../../../apps/film-printing-staging/backend/resource-proof.mjs';
import {RESOURCE_AUDIENCE as audience} from '../../../apps/film-printing-staging/backend/resource-session.mjs';
export {origin,purpose,audience};
export async function rig(t,{config,clock={time:Date.now()}}={}){
 const fresh=!config;
 if(fresh){const dataDir=mkdtempSync(join(tmpdir(),'bfl-f06k-'));chmodSync(dataDir,0o700);
 config={store:STORE,app:APP,clientId:CLIENT,installation:INSTALLATION,dataDir,host:'127.0.0.1',port:0,origin:'http://127.0.0.1:6076',mode:'disabled',adminToken:null,resourceSessions:'session-only',storefrontSessions:'context-only',buyerIpMode:'disabled',jobSecret:'synthetic-job-secret'.repeat(3),sessionSecret:'synthetic-cookie-secret'.repeat(3),appSecret:'synthetic-proxy-secret'.repeat(3)};
 config.databaseId=initializeDatabase(config);migrateResourceSessions(config);}
 const r=createSessionOnlyRuntime(config,{now:()=>clock.time});
 t.after(async()=>{await r.close();if(fresh)rmSync(config.dataDir,{recursive:true,force:true});});await r.start();
 const url=`http://127.0.0.1:${r.server.address().port}`;
 const headers=token=>({origin,'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})});
 const call=async(path,input={},token,extra={})=>{const v=await fetch(url+path,{method:'POST',headers:{...headers(token),...extra},body:JSON.stringify(input)});return {status:v.status,headers:v.headers,body:await v.json()};};
 const sign=(params,patch={})=>{const q=new URLSearchParams({shop:STORE,path_prefix:'/apps/bfl-staging',logged_in_customer_id:'',timestamp:String(Math.floor(clock.time/1000)),...params,...patch});const m=[...new Set(q.keys())].map(k=>`${k}=${q.getAll(k).join(',')}`).sort().join('');q.set('signature',createHmac('sha256',config.appSecret).update(m).digest('hex'));return q.toString();};
 const bootstrap=async(c,customer='',patch={})=>{const query=sign({challenge:c.challenge,purpose,audience,action:c.action,logged_in_customer_id:customer},patch);const v=await fetch(url+'/proxy/resource-proof?'+query);return {status:v.status,body:await v.json()};};
 const challenge=async(action='issue',token)=>call('/resource-proof/challenge',{action},token);
 const proof=async(action='issue',token,customer='')=>{const c=(await challenge(action,token)).body,b=(await bootstrap(c,customer)).body;return call('/resource-proof/exchange',{action,challenge:c.challenge,verifier:c.verifier,ticket:b.ticket},token);};
 const issue=async(customer='')=>call('/resource-sessions/issue',{proof:(await proof('issue',undefined,customer)).body.proof});
 return {r,config,clock,url,headers,call,sign,bootstrap,challenge,proof,issue};
}
