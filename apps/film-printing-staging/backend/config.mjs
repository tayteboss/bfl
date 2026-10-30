import {readFileSync,lstatSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {STORE,APP,CLIENT} from '../configuration/schema.mjs';
export const INSTALLATION='gid://shopify/AppInstallation/1073784553583';
export const SHOP='gid://shopify/Shop/81566597231';
export class RuntimeError extends Error { constructor(code) {super(code);this.code=code;} }
export const need=(condition,code)=>{if(!condition)throw new RuntimeError(code);};
// Preserve a small enum from internal checkout guards, without exposing an
// exception message, stack, URL, body or an arbitrary upstream error code.
const checkoutCodes=new Set(['INVALID_PRIOR_AUTHORITY','AUTHORITY_WRITE_REJECTED','AUTHORITY_READBACK_CHANGED','FUNCTION_OWNER_CHANGED','FUNCTION_LEASE_UNPROTECTED']);
export const safeCode=error=>error instanceof RuntimeError||error instanceof Error&&checkoutCodes.has(error.code)?error.code:'UNAVAILABLE';
function secret(env,name,required=false,minLength=32,maxLength=2048) {
  need(!env[name],'USE_SECRET_FILE');
  const path=env[`${name}_FILE`];
  if(!path){need(!required,'SECRET_REQUIRED');return null;}
  try {
    need(isAbsolute(path),'SECRET_FILE_INVALID');
    const s=lstatSync(path);
    need(s.isFile() && !s.isSymbolicLink() && s.size<=4096 && (s.mode&0o077)===0,'SECRET_FILE_INVALID');
    const value=readFileSync(path,'utf8').replace(/\r?\n$/,'');
    need(value.length>=minLength && value.length<=maxLength && /^[\x21-\x7e]+$/.test(value),'SECRET_FILE_INVALID');
    return value;
  } catch {throw new RuntimeError('SECRET_FILE_INVALID');}
}
export function readConfig(env=process.env) {
  need(env.BFL_STORE===STORE && env.BFL_APP===APP && env.BFL_CLIENT_ID===CLIENT && env.BFL_INSTALLATION===INSTALLATION,'WRONG_TARGET');
  need(env.BFL_STORAGE==='local-persistent' && (env.WEB_CONCURRENCY??'1')==='1' && !env.NODE_UNIQUE_ID,'SINGLE_LOCAL_DATABASE_REQUIRED');
  need(isAbsolute(env.BFL_DATA_DIR??''),'DATA_DIRECTORY_REQUIRED');
  const origin=env.BFL_ORIGIN??'http://127.0.0.1:6076';
  let url;try{url=new URL(origin);}catch{throw new RuntimeError('INVALID_ORIGIN');}
  const local=url.protocol==='http:' && url.hostname==='127.0.0.1';
  const isolatedBellowsOrigin=origin==='https://film-printing-staging.bellowsfilmlab.com';
  need(url.origin===origin && !url.username && !url.password && (local || url.protocol==='https:') &&
    (isolatedBellowsOrigin || (url.hostname!=='bellowsfilmlab.com' && !url.hostname.endsWith('.bellowsfilmlab.com'))) && !url.hostname.endsWith('.myshopify.com'),'INVALID_ORIGIN');
  const host=env.BFL_BIND??'127.0.0.1', port=Number(env.PORT??6076);
  need(['127.0.0.1','0.0.0.0'].includes(host) && (host==='127.0.0.1'||!local),'INVALID_BIND');
  need(Number.isInteger(port)&&port>0&&port<=65535,'INVALID_PORT');
  const mode=env.BFL_ADMIN_WRITES??'disabled';
  need(['disabled','reconcile-only'].includes(mode),'INVALID_WRITE_MODE');
  const jobSecret=secret(env,'BFL_JOB_SECRET',true),sessionSecret=secret(env,'BFL_SESSION_SECRET',true);
  const adminToken=secret(env,'BFL_ADMIN_TOKEN'),appSecret=secret(env,'BFL_APP_SECRET');
  const storefrontSessions=env.BFL_STOREFRONT_SESSIONS??'disabled';
  need(['disabled','context-only'].includes(storefrontSessions),'INVALID_SESSION_MODE');
  need(storefrontSessions==='disabled'||appSecret,'APP_SECRET_REQUIRED');
  const resourceSessions=env.BFL_RESOURCE_SESSIONS??'disabled';
  need(['disabled','session-only','session-only-closed','upload-only','owned-cart'].includes(resourceSessions),'INVALID_RESOURCE_MODE');
  need(resourceSessions==='disabled'||isolatedBellowsOrigin&&host==='0.0.0.0'&&
    mode==='disabled'&&!adminToken&&appSecret&&storefrontSessions==='context-only','INVALID_RESOURCE_TARGET');
  const buyerIpMode=env.BFL_BUYER_IP??'disabled';
  need(['disabled','caddy-direct'].includes(buyerIpMode),'INVALID_BUYER_IP_MODE');
  need(buyerIpMode==='disabled'||isolatedBellowsOrigin&&host==='0.0.0.0','INVALID_BUYER_IP_TARGET');
  need(jobSecret!==sessionSecret && (!appSecret || ![jobSecret,sessionSecret].includes(appSecret)),'SEPARATE_KEYS_REQUIRED');
  need(mode==='disabled'||adminToken,'ADMIN_CREDENTIAL_REQUIRED');
  const cartWindowUntil=Number(env.BFL_CART_WINDOW_UNTIL??0);
  need(resourceSessions!=='owned-cart'||buyerIpMode==='caddy-direct'&&Number.isSafeInteger(cartWindowUntil)&&cartWindowUntil>Date.now()&&cartWindowUntil<=Date.now()+1800000,'CART_WINDOW_REQUIRED');
  const cartToken=resourceSessions==='owned-cart'?secret(env,'BFL_STOREFRONT_PRIVATE',true):null;
  const uploadWindowUntil=Number(env.BFL_UPLOAD_WINDOW_UNTIL??0);
  need(resourceSessions!=='upload-only'||Number.isSafeInteger(uploadWindowUntil)&&uploadWindowUntil>Date.now()&&uploadWindowUntil<=Date.now()+1800000,'UPLOAD_WINDOW_REQUIRED');
  const uploadDigest=env.BFL_UPLOAD_DIGEST;
  need(resourceSessions!=='upload-only'||/^[a-f0-9]{64}$/.test(uploadDigest??''),'UPLOAD_DIGEST_REQUIRED');
  const uploadcare=resourceSessions==='upload-only'?{enabled:true,config:{store:STORE,app:APP,
    publicKey:'3c958e674d1b0653284b',projectId:699888,cdnOrigin:'https://2082t3ckh5.ucarecd.net',
    secret:secret(env,'BFL_UPLOADCARE_API',true,20,256),
    delivery:{projectKey:'3c958e674d1b0653284b',origin:'https://2082t3ckh5.s.ucarecd.net',
      publicAccessDisabled:true,legacyAccessDisabled:true,signingSecret:secret(env,'BFL_UPLOADCARE_DELIVERY',true)}}}:null;
  return Object.freeze({cartWindowUntil,cartToken,uploadDigest,uploadWindowUntil,uploadcare,store:STORE,app:APP,clientId:CLIENT,installation:INSTALLATION,dataDir:env.BFL_DATA_DIR,
    databaseId:env.BFL_DATABASE_ID,origin,host,port,mode,jobSecret,sessionSecret,adminToken,appSecret,storefrontSessions,buyerIpMode,resourceSessions});
}
