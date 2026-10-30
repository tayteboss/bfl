import {STORE,APP,CLIENT} from '../configuration/schema.mjs';
import {INSTALLATION,SHOP,RuntimeError,need} from './config.mjs';

// Existing installed grant only. Never called from a browser or supplied query.
export const STAGING_CREDENTIAL_IDENTITY='query BFLStagingCredentialIdentity { shop { id myshopifyDomain } currentAppInstallation { id app { id apiKey } } }';
const credential=value=>typeof value==='string'&&/^[\x21-\x7e]{32,2048}$/.test(value);
export function createStagingCredentialProvider(config,{fetchImpl=fetch,now=Date.now,timeoutMs=5000,maxBytes=65536,refreshSkewMs=300000}={}) {
 need(config?.store===STORE&&config.app===APP&&config.clientId===CLIENT&&config.installation===INSTALLATION,'WRONG_TARGET');
 need(credential(config.appSecret),'STAGING_APP_CREDENTIAL_REQUIRED');
 need(Number.isSafeInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=30000&&Number.isSafeInteger(maxBytes)&&maxBytes>0&&maxBytes<=1048576&&
  Number.isSafeInteger(refreshSkewMs)&&refreshSkewMs>=1000&&refreshSkewMs<=3600000,'STAGING_CREDENTIAL_CONFIG');
 const appSecret=config.appSecret;
 let cached=null,pending=null,closed=false;
 const clock=()=>{const value=now();need(Number.isSafeInteger(value)&&value>0,'STAGING_CREDENTIAL_CLOCK');return value;};
 async function request(url,options,api=false) {
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try {
   const response=await fetchImpl(url,{...options,redirect:'error',cache:'no-store',signal:controller.signal});
   need(response.ok&&!response.redirected,response.status===401||response.status===403?'STAGING_CREDENTIAL_REJECTED':'STAGING_CREDENTIAL_UNAVAILABLE');
   need(/^application\/json(?:;|$)/i.test(response.headers.get('content-type')??'')&&
    (!api||response.headers.get('x-shopify-api-version')==='2026-10'),'STAGING_CREDENTIAL_RESPONSE');
   let bytes=0;const chunks=[];
   for await(const chunk of response.body){bytes+=chunk.length;need(bytes<=maxBytes,'STAGING_CREDENTIAL_RESPONSE');chunks.push(chunk);}
   return JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(Buffer.concat(chunks)));
  }catch(error){throw error instanceof RuntimeError?error:new RuntimeError('STAGING_CREDENTIAL_UNAVAILABLE');}
  finally{clearTimeout(timer);controller.abort();}
 }
 async function acquire() {
  const issuedAt=clock();
  const auth=await request(`https://${STORE}/admin/oauth/access_token`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','Accept':'application/json'},
   body:new URLSearchParams({grant_type:'client_credentials',client_id:CLIENT,client_secret:appSecret}).toString()});
  need(credential(auth?.access_token)&&Number.isSafeInteger(auth.expires_in)&&auth.expires_in>0&&auth.expires_in<=86400,'STAGING_CREDENTIAL_RESPONSE');
  const expiresAt=issuedAt+auth.expires_in*1000;
  need(Number.isSafeInteger(expiresAt)&&clock()<expiresAt&&!closed,'STAGING_CREDENTIAL_EXPIRED');
  const result=await request(`https://${STORE}/admin/api/2026-10/graphql.json`,{method:'POST',headers:{'Content-Type':'application/json','X-Shopify-Access-Token':auth.access_token},
   body:JSON.stringify({query:STAGING_CREDENTIAL_IDENTITY})},true);
  const data=result?.data,app=data?.currentAppInstallation;
  need((!Object.hasOwn(result??{},'errors')||Array.isArray(result.errors)&&result.errors.length===0)&&
   data?.shop?.id===SHOP&&data.shop.myshopifyDomain===STORE&&app?.id===INSTALLATION&&app.app?.id===APP&&app.app.apiKey===CLIENT,'STAGING_CREDENTIAL_IDENTITY');
  need(!closed&&clock()<expiresAt,'STAGING_CREDENTIAL_EXPIRED');
  // Count token lifetime from before acquisition, never from the later identity read.
  cached={token:auth.access_token,issuedAt,expiresAt,refreshAt:expiresAt-Math.min(refreshSkewMs,Math.floor(auth.expires_in*500))};
  return cached.token;
 }
 return Object.freeze({
  async read(){
   need(!closed,'STAGING_CREDENTIAL_CLOSED');const at=clock();
   if(cached&&at>=cached.issuedAt&&at<cached.refreshAt)return cached.token;
   if(!pending)pending=acquire().finally(()=>{pending=null;});
   return pending;
  },
  close(){closed=true;cached=null;},
 });
}
