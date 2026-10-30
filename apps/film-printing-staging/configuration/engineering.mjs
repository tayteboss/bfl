// One reviewed staging fixture. No browser input can construct this private
// in-process scope; ordinary validation remains merchant-only.
import {createHash} from 'node:crypto';
import {canonical,digest,freeze} from './config.mjs';
import {STORE,APP,CLIENT} from './schema.mjs';
import {SHOP,INSTALLATION,need} from '../backend/config.mjs';
import {engineeringJobSpecification} from './engineering-job.mjs';
import {isFullProductCatalog,isLabVariantCatalog} from '../jobs/selection.mjs';
import {variantForLab} from '../checkout/authority.js';

export const ENGINEERING_RUN='f06p-integrated-v1';
export const PERSISTENT_STAGING_RUN='bfl-client-staging-v1';
export const ENGINEERING_TARGET=Object.freeze({store:STORE,shop:SHOP,app:APP,client:CLIENT,installation:INSTALLATION,draft:'189196533871',product:'15620086005871',variant:'67852705202287'});
export const ENGINEERING_CONFIG='e451d6b004d18605e68498aa3e511b6cbb198c73d6d3a954e693aec870caf8fd';
export const ENGINEERING_CATALOG='243f34246e449332f3473c3e1669e7233e53ddfa3e4e7be5eedce7e448edabc8';
// Exact accepted customer-form catalog; the older fixture remains historical.
export const ENGINEERING_FORM_CATALOG='6ec37f1c22c5cd36f6729661e6cc567d668f19145fd4de1f166a03d2cd4e8076';
// Admission is exact-pair pinned. Candidate preparation emits hashes for review;
// caller-provided hashes, browser claims or generic configuration cannot add pins.
export const ENGINEERING_SOURCE_PINS=Object.freeze([
 Object.freeze({config:ENGINEERING_CONFIG,catalog:ENGINEERING_CATALOG}),
 Object.freeze({config:ENGINEERING_CONFIG,catalog:ENGINEERING_FORM_CATALOG}),
 // 30Oct authenticated four-location/variant readback and compact catalog review:
 // fixtures/film-printing/full-product-readiness-20261030/catalog-review.json.
 Object.freeze({config:'5f603f1fcdaad34f7a558bd12567cf1402523b90a885399acf4ea02098f0cd92',catalog:'15244768b15749c1e7f533fcf82acdbe3f696570803d29c35d198f9ec24252ef'}),
 // Exact per-lab variant routing; original compact-v1 source remains historical.
 // fixtures/film-printing/full-product-lab-routing-20261030/catalog-review.json.
 Object.freeze({config:'5f603f1fcdaad34f7a558bd12567cf1402523b90a885399acf4ea02098f0cd92',catalog:'bf0e9f20f9fc6cee5014791357f237c396f6f7594539cde8e66b74b273ddf3ae'}),
]);
const engineeringSources=(config,catalog)=>ENGINEERING_SOURCE_PINS.some(p=>p.config===digest(config)&&p.catalog===digest(catalog));
export const ENGINEERING_FILES=Object.freeze([
 '9cd01d72a2a97ef31d52f8b7a72108153bc5568e86cffc1095cd8325d50a94a2',
 'f788f06fc09ab5e9dec68269f287058ad124c89d0b998a4bf4950563decea26d',
 '17e127d82cbd05129a553652ac36829016ef4ac1cb58a291bb7c1427aa07a0f0',
]);
export const rawHash=value=>createHash('sha256').update(value).digest('hex');
const scopes=new WeakMap();
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join()===keys.sort().join();
function sources(releaseValue,catalogValue,{persistent=false}={}){
 const release=JSON.parse(releaseValue),catalog=JSON.parse(catalogValue),config=release?.config;
 need(exact(release,['version','sha256','config'])&&exact(config,['schema_version','store','packages','rules','labs','policies','engineering']),'ENGINEERING_SOURCE');
 const {engineering,...base}=config;
 need(engineeringSources(base,catalog),'ENGINEERING_SOURCE');
 if(persistent){
  need(exact(engineering,['kind','run_id','issued_at'])&&engineering.kind==='persistent_staging'&&engineering.run_id===PERSISTENT_STAGING_RUN&&
   isLabVariantCatalog(catalog)&&digest(base)==='5f603f1fcdaad34f7a558bd12567cf1402523b90a885399acf4ea02098f0cd92'&&
   digest(catalog)==='bf0e9f20f9fc6cee5014791357f237c396f6f7594539cde8e66b74b273ddf3ae'&&Number.isSafeInteger(engineering.issued_at)&&engineering.issued_at>=0,'PERSISTENT_STAGING_SOURCE');
 }else{
  need(exact(engineering,['kind','run_id','issued_at','expires_at'])&&engineering.kind==='staging_engineering'&&engineering.run_id===ENGINEERING_RUN,'ENGINEERING_SCOPE');
  need(Number.isSafeInteger(engineering.issued_at)&&Number.isSafeInteger(engineering.expires_at)&&engineering.expires_at>engineering.issued_at&&engineering.expires_at-engineering.issued_at<=(isFullProductCatalog(catalog)?3600000:1200000),'ENGINEERING_WINDOW');
 }
 need(release.sha256===digest(config)&&release.version===`f03-${release.sha256.slice(0,24)}`&&releaseValue===canonical(release)&&catalogValue===canonical(catalog),'ENGINEERING_SOURCE');
 return {release,catalog,engineering,legacy:digest(base)===ENGINEERING_CONFIG};
}
// The service's exact configuration remains available between client visits.
// This is a different prospective source contract, never an extended experiment.
export function preparePersistentStagingSources({config,catalog,issuedAt}){
 const next={...structuredClone(config),engineering:{kind:'persistent_staging',run_id:PERSISTENT_STAGING_RUN,issued_at:issuedAt}};
 const sha256=digest(next),releaseValue=canonical({version:`f03-${sha256.slice(0,24)}`,sha256,config:next}),catalogValue=canonical(catalog);
 sources(releaseValue,catalogValue,{persistent:true});
 return freeze({contract:{kind:'persistent_staging',run_id:PERSISTENT_STAGING_RUN,target:ENGINEERING_TARGET,
  release_sha256:rawHash(releaseValue),catalog_sha256:rawHash(catalogValue),issued_at:issuedAt},releaseValue,catalogValue});
}
export function createPersistentStagingScope({contract,releaseValue,catalogValue,identity,now=Date.now,mode='admission'}){
 need(['admission','recovery'].includes(mode)&&exact(contract,['kind','run_id','target','release_sha256','catalog_sha256','issued_at'])&&
  contract.kind==='persistent_staging'&&contract.run_id===PERSISTENT_STAGING_RUN&&canonical(contract.target)===canonical(ENGINEERING_TARGET),'PERSISTENT_STAGING_TARGET');
 const app=identity?.currentAppInstallation;
 need(identity?.shop?.id===SHOP&&identity.shop.myshopifyDomain===STORE&&app?.id===INSTALLATION&&app.app?.id===APP&&app.app.apiKey===CLIENT,'PERSISTENT_STAGING_TARGET');
 const parsed=sources(releaseValue,catalogValue,{persistent:true});
 need(contract.release_sha256===rawHash(releaseValue)&&contract.catalog_sha256===rawHash(catalogValue)&&contract.issued_at===parsed.engineering.issued_at,'PERSISTENT_STAGING_SOURCE');
 const scope=Object.freeze({kind:'persistent_staging'});
 scopes.set(scope,{...parsed,persistent:true,contract:freeze(structuredClone(contract)),releaseValue,catalogValue,now,revoked:mode==='recovery',assets:null});
 if(mode==='admission')assertEngineeringScope(scope);
 return scope;
}
export function prepareEngineeringSources({config,catalog,issuedAt,until}){
 // Preparation is not admission. These hashes pin the exact approved proposal,
 // including unchanged observed/staging-only statuses and provenance.
 need(engineeringSources(config,catalog),'ENGINEERING_SOURCE');
 const next={...structuredClone(config),engineering:{kind:'staging_engineering',run_id:ENGINEERING_RUN,issued_at:issuedAt,expires_at:until}};
 const sha256=digest(next),releaseValue=canonical({version:`f03-${sha256.slice(0,24)}`,sha256,config:next}),catalogValue=canonical(catalog);
 sources(releaseValue,catalogValue);
 const contract={kind:'staging_engineering',run_id:ENGINEERING_RUN,target:ENGINEERING_TARGET,release_sha256:rawHash(releaseValue),catalog_sha256:rawHash(catalogValue),files:[...ENGINEERING_FILES],issued_at:issuedAt,expires_at:until};
 return freeze({contract,releaseValue,catalogValue});
}
export function createEngineeringScope({contract,releaseValue,catalogValue,identity,now=Date.now,mode='admission'}){
 need(['admission','recovery'].includes(mode),'ENGINEERING_SCOPE');
 need(exact(contract,['kind','run_id','target','release_sha256','catalog_sha256','files','issued_at','expires_at'])&&contract.kind==='staging_engineering'&&contract.run_id===ENGINEERING_RUN&&canonical(contract.target)===canonical(ENGINEERING_TARGET),'ENGINEERING_TARGET');
 const app=identity?.currentAppInstallation;
 need(identity?.shop?.id===SHOP&&identity.shop.myshopifyDomain===STORE&&app?.id===INSTALLATION&&app.app?.id===APP&&app.app.apiKey===CLIENT,'ENGINEERING_TARGET');
 const parsed=sources(releaseValue,catalogValue);
 need(contract.release_sha256===rawHash(releaseValue)&&contract.catalog_sha256===rawHash(catalogValue)&&canonical(contract.files)===canonical(ENGINEERING_FILES)&&contract.issued_at===parsed.engineering.issued_at&&contract.expires_at===parsed.engineering.expires_at,'ENGINEERING_SOURCE');
 const scope=Object.freeze({kind:'staging_engineering'});
 scopes.set(scope,{...parsed,contract:freeze(structuredClone(contract)),releaseValue,catalogValue,now,revoked:mode==='recovery',assets:null});
 if(mode==='admission')assertEngineeringScope(scope);
 return scope;
}
function scopeState(scope,intent='admit'){
 const s=scopes.get(scope);need(s&&['admit','protect'].includes(intent),'ENGINEERING_SCOPE');
 // Protective parsing is exact-byte scoped and survives expiry/revocation. It
 // never enables jobs, quotes, orders, source application or nonempty authority.
 if(intent==='admit')need(!s.revoked&&s.now()>=s.contract.issued_at&&(s.persistent||s.now()<s.contract.expires_at),'ENGINEERING_EXPIRED');
 return s;
}
export function assertEngineeringConfig(scope,config,intent='admit'){
 const s=scopeState(scope,intent);need(canonical(config)===canonical(s.release.config),'ENGINEERING_SOURCE');return true;
}
export function assertEngineeringCatalog(scope,value,intent='admit'){
 const s=scopeState(scope,intent);need(value===s.catalogValue,'ENGINEERING_SOURCE');
}
export function engineeringFiles(scope,files){
 assertEngineeringScope(scope);need(Array.isArray(files)&&files.length===3,'ENGINEERING_FILES');
 files.forEach((f,i)=>need(f.path===`fixture-${i+1}.png`&&f.mime==='image/png'&&Buffer.isBuffer(f.bytes)&&f.bytes.length===79&&rawHash(f.bytes)===ENGINEERING_FILES[i]&&f.sha256===ENGINEERING_FILES[i],'ENGINEERING_FILES'));
}
export function bindEngineeringAssets(scope,owner,ids){
 const s=scopeState(scope);need(!s.assets&&typeof owner==='string'&&Array.isArray(ids)&&ids.length===3&&new Set(ids).size===3,'ENGINEERING_ASSETS');
 s.assets={owner,ids:[...ids].sort()};
}
// Server-verified selections for the current finite customer acceptance.
// This private scope is never constructed from a browser claim.
export function bindEngineeringCustomerJob(scope,owner,ids,copies,job,limit=2){
 const s=scopeState(scope),prior=s.customerJobs??[];
 const zeroFileJob=!s.legacy&&job?.service==='darkroom'; // Exact catalog semantics are checked below; no invented parcel rule.
 need(([2,8].includes(limit)||isFullProductCatalog(s.catalog)&&limit===64||s.persistent&&limit===4096)&&!s.assets&&(s.persistent||prior.length<limit)&&typeof owner==='string'&&Array.isArray(ids)&&(ids.length>0||zeroFileJob)&&ids.length<=1000&&new Set(ids).size===ids.length&&Number.isSafeInteger(copies)&&copies>0&&copies<=10000&&
  (s.persistent||prior.every(j=>j.owner===owner)),'ENGINEERING_ASSETS');
 const specification=job?engineeringJobSpecification(s.catalog,job,ids.length,{requireBillingBasis:!s.legacy}):null;
 if(job){
  need((isLabVariantCatalog(s.catalog)?`gid://shopify/ProductVariant/${job.variant_id}`===variantForLab(job.lab):job.variant_id===ENGINEERING_TARGET.variant)&&job.copies===copies&&Array.isArray(job.completed_asset_ids)&&canonical([...job.completed_asset_ids].sort())===canonical([...ids].sort()),'ENGINEERING_JOB');
  if(s.legacy)need(job.message==='','ENGINEERING_JOB');
 }
 // Persistent resource/job admissions are durable and owner-scoped in SQLite.
 // The finite diagnostic's in-memory single-owner selection list is unchanged.
 if(s.persistent){need(job&&typeof specification==='string','ENGINEERING_JOB');return;}
 s.customerJobs=[...prior,{owner,ids:[...ids].sort(),copies,specification}];
}
export function assertEngineeringJob(scope,owner,job){
 const s=scopeState(scope);need(job&&(isLabVariantCatalog(s.catalog)?`gid://shopify/ProductVariant/${job.variant_id}`===variantForLab(job.lab):job.variant_id===ENGINEERING_TARGET.variant)&&Array.isArray(job.completed_asset_ids),'ENGINEERING_JOB');
 const specification=engineeringJobSpecification(s.catalog,job,job.completed_asset_ids.length,{requireBillingBasis:!s.legacy});
 // Job service verifies the immutable owner's record, signature, source version
 // and provider assets. Requiring process memory here would break safe restarts.
 if(s.persistent){need(typeof owner==='string'&&owner.startsWith('resource_')&&typeof specification==='string','ENGINEERING_JOB');return;}
 const selection=s.customerJobs?.find(j=>j.owner===owner&&j.copies===job.copies&&canonical([...job.completed_asset_ids].sort())===canonical(j.ids)&&(!j.specification||j.specification===specification));
 const matched=selection?(!selection.specification||selection.specification===specification):
  s.assets?.owner===owner&&canonical([...job.completed_asset_ids].sort())===canonical(s.assets.ids)&&job.copies===4;
 need(matched,'ENGINEERING_JOB');
 if(s.legacy)need(job.message==='','ENGINEERING_JOB');
}
export function revokeEngineeringScope(scope){scopeState(scope,'protect').revoked=true;}

export function assertEngineeringScope(scope,intent='admit'){const s=scopeState(scope,intent);return freeze({contract:s.contract,release:s.release,catalog:s.catalog,releaseValue:s.releaseValue,catalogValue:s.catalogValue});}
