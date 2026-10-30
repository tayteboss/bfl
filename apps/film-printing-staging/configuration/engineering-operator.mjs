// Finite source lifecycle on the SAME locked DB, using the normal F06D writer.
// No drafts/form rows/merchant prices are edited. All receipts are private/fsynced.
import {createAdminTransport,CATALOG_DELETE} from '../backend/admin.mjs';
import {SHOP,INSTALLATION,need} from '../backend/config.mjs';
import {STORE,APP} from './schema.mjs';
import {canonical,verifyRelease} from './config.mjs';
import {assertEngineeringScope,assertEngineeringCatalog} from './engineering.mjs';
import {createAuthorityAdmin,CONTEXT_QUERY,LEASE_CONTEXT_QUERY,decodeCatalog} from '../checkout/shopify.mjs';
import {readFunctionOwners,leaseFields,leaseEnvelope,sameLeaseContext,leaseOwners,sameAuthorityValue,sameLeaseValue} from '../checkout/lease.mjs';
import {decodeAuthority} from '../checkout/authority.js';
import {emptyAuthority,serializeAuthority} from '../checkout/projector.mjs';
import {validatePriceCatalog} from '../jobs/catalog.mjs';

export const ENGINEERING_ARCHIVE='query F06PEngineeringArchive($key:String!){shop{myshopifyDomain} currentAppInstallation{id app{id} metafield(namespace:"bfl_printing",key:$key){id type value compareDigest}}}';
const same=(a,b)=>canonical(a)===canonical(b);
const fieldKeys=['ownerId','namespace','key','type','value','compareDigest'];
export function createEngineeringSourceOperator({config,storage,sourceScope,append,history=[],fetchImpl=fetch,now=Date.now,eligibility=false,specificationOwner=null,credentialProvider=null}){
 need(specificationOwner===null||eligibility,'SPECIFICATION_OWNER_REQUIRED');
 const ownerCount=eligibility?leaseOwners(specificationOwner).length:0;
 const scope=assertEngineeringScope(sourceScope,'protect'),store=storage.store;
 validatePriceCatalog(scope.catalogValue);
 need(typeof append==='function','SOURCE_JOURNAL_REQUIRED');storage.assertExclusiveWriter();
 const events=[...history];const record=e=>{append(e);events.push(structuredClone(e));};
 const last=event=>events.findLast(e=>e.event===event);
 let armed=null,deleting=null,requests=events.filter(e=>e.event==='source_admin_attempt').length,mutations=events.filter(e=>e.event==='source_admin_attempt'&&e.kind==='mutation').length;
 const exclusive=()=>{storage.assertExclusiveWriter();need(storage.store===store,'SOURCE_WRITER_CHANGED');};
 const contextMatches=(d,c)=>d.shop?.id===SHOP&&d.shop.myshopifyDomain===STORE&&d.currentAppInstallation?.id===INSTALLATION&&d.currentAppInstallation.app?.id===APP&&
  ['active','catalog','fence'].every(k=>same(d.currentAppInstallation[k]??null,c[k==='catalog'?'catalogField':k]??null))&&same(d.shop.authority,c.field)&&
  (!eligibility||sameLeaseContext({timezone:d.shop.ianaTimezone,functionOwners:readFunctionOwners(d,{specificationOwner})},c));
 const custody={
  isArmed:()=>!!armed,
  commit(d,fields){
   exclusive();const a=armed;need(a,'SOURCE_NOT_ARMED');
   need(contextMatches(d,a.context),'SOURCE_CHANGED');
   const op=store.lifecycle.state().operation;need(op?.kind==='cutover'&&op.epoch===a.epoch+1,'SOURCE_OPERATION_CHANGED');store.lifecycle.assertOperation(op);
   if(a.phase==='apply')assertEngineeringScope(sourceScope);
   const expected=[
    {ownerId:SHOP,namespace:'$app:bfl-checkout',key:'authority',type:'json',value:a.authority,compareDigest:a.context.field.compareDigest},
    {ownerId:INSTALLATION,namespace:'bfl_printing',key:'active_config',type:'json',value:a.activeValue,compareDigest:a.context.active.compareDigest},
    {ownerId:INSTALLATION,namespace:'bfl_printing',key:'price_catalog',type:'json',value:a.catalogValue,compareDigest:a.context.catalogField?.compareDigest??null},
    {ownerId:INSTALLATION,namespace:'bfl_printing',key:a.archive.key,type:'json',value:a.archive.field.value,compareDigest:a.archive.field.compareDigest},
   ];
   if(eligibility)expected.push(...leaseFields(a.context.functionOwners,a.authority,{specificationOwner}));
   need(fields.length===5+ownerCount&&fields.every(f=>same(Object.keys(f).sort(),[...fieldKeys].sort())),'SOURCE_FIELDS');
   need(expected.every(f=>same(f,fields.find(v=>v.ownerId===f.ownerId&&v.namespace===f.namespace&&v.key===f.key))),'SOURCE_FIELDS');
   const f=fields.find(v=>v.key==='authority_fence');need(f&&f.ownerId===INSTALLATION&&f.namespace==='bfl_printing'&&f.type==='single_line_text_field'&&f.compareDigest===a.context.fence.compareDigest&&/^[a-f0-9-]{36}$/.test(f.value)&&f.value!==a.context.fence.value,'SOURCE_FIELDS');
   armed=null;record({event:'source_send_reserved',phase:a.phase});
  },
  deleteCatalog(d,variables){
   exclusive();const c=deleting;need(c&&contextMatches(d,c.context),'SOURCE_DELETE_CONFLICT');
   need(same(variables,{metafields:[{ownerId:INSTALLATION,namespace:'bfl_printing',key:'price_catalog'}]}),'SOURCE_DELETE_SCOPE');
   store.lifecycle.assertOperation(c.operation);
   need(decodeAuthority(d.shop.authority.value)?.grants.length===0&&same(d.currentAppInstallation.catalog,c.field),'SOURCE_DELETE_CONFLICT');
   deleting=null;record({event:'catalog_delete_send_reserved',field_id:c.field.id});
  },
 };
 const raw=createAdminTransport(config,{sourceCustody:custody,eligibility,specificationOwner,credentialProvider,fetchImpl:async(url,options)=>{
  const query=JSON.parse(options.body).query,mutation=query.startsWith('mutation');
  need(++requests<=64&&(!mutation||++mutations<=8),'SOURCE_REQUEST_LIMIT');record({event:'source_admin_attempt',kind:mutation?'mutation':'query',count:requests});
  return fetchImpl(url,options);
 }});
 const api=(query,variables={})=>{
  need(query===(eligibility?LEASE_CONTEXT_QUERY:CONTEXT_QUERY)||query===ENGINEERING_ARCHIVE||query===CATALOG_DELETE||query.startsWith('mutation F06DCommitAuthority(')||query.startsWith('query F06DArchive('),'SOURCE_OPERATION_REJECTED');
  return raw(query,variables);
 };
 const admin=createAuthorityAdmin(api,{writesEnabled:true,lifecycle:store.lifecycle,sourceScope,eligibility,specificationOwner,now:()=>new Date(now())});
 async function archive(value){
  const release=verifyRelease(JSON.parse(value),{sourceScope,intent:'protect'}),key=`release_${release.sha256.slice(0,24)}`;
  const result=await api(ENGINEERING_ARCHIVE,{key}),app=result.currentAppInstallation;
  need(result.shop.myshopifyDomain===STORE&&app.id===INSTALLATION&&app.app.id===APP,'WRONG_TARGET');
  const prior=app.metafield;need(prior===null||prior.type==='json'&&typeof prior.compareDigest==='string'&&same(JSON.parse(prior.value),release),'SOURCE_ARCHIVE_CONFLICT');
  return {key,field:prior??{type:'json',value:canonical(release),compareDigest:null}};
 }
 async function cutover(phase,activeValue,catalogValue){
  exclusive();const context=await admin.read({allowMissingCatalog:true});
  const release=verifyRelease(JSON.parse(activeValue),{sourceScope}),a=await archive(activeValue);
  armed={phase,context,activeValue,catalogValue,archive:a,epoch:store.lifecycle.state().epoch,
   authority:serializeAuthority(emptyAuthority(release,decodeCatalog(catalogValue),context.shopDate,{sourceScope}))};
  try{return await admin.cutover({context,release,activeValue,catalogValue,archive:a});}finally{armed=null;}
 }
 return Object.freeze({admin,api,
  async apply(){
   exclusive();assertEngineeringScope(sourceScope);need(!last('source_apply_reserved'),'SOURCE_APPLY_SPENT');
   const c=await admin.read({allowMissingCatalog:true});
   need(!c.release.config.engineering&&c.catalogField===null&&decodeAuthority(c.field.value)?.grants.length===0,'SOURCE_PREIMAGE_REQUIRED');
   verifyRelease(c.release);need(!store.lifecycle.state().pending&&!store.lifecycle.state().operation,'SOURCE_RECOVERY_REQUIRED');
   record({event:'source_preimage',active:c.active,authority:c.field,original_release:c.release,...(eligibility?{timezone:c.timezone,function_owners:c.functionOwners}:{})});
   record({event:'source_apply_reserved'});
   await cutover('apply',scope.releaseValue,scope.catalogValue);
   const after=await admin.read();need(after.active.value===scope.releaseValue&&after.catalogField.value===scope.catalogValue&&/^gid:\/\/shopify\/Metafield\/\d+$/.test(after.catalogField.id),'SOURCE_READBACK');
   if(eligibility)need(after.functionOwners.every(o=>sameLeaseValue(o.field?.value,leaseEnvelope(after.field.value))),'SOURCE_READBACK');
   record({event:'source_applied',active:after.active,catalog:after.catalogField,...(eligibility?{lease_sentinels:true,function_owners:after.functionOwners}:{})});return after;
  },
  async restore(){
   exclusive();const prior=last('source_preimage'),applied=last('source_applied');
   need(prior&&applied,'SOURCE_RESTORATION_UNCONFIRMED');
   // Always clear first, even if source/deletion was uncertain. Exact protective
   // parsing permits this after scope expiry/revocation and process restart.
   await admin.reconcile();
   need(!last('source_restore_reserved')&&!last('catalog_delete_reserved'),'SOURCE_RESTORE_SPENT');
   let c=await admin.read();
   need(c.active.value===scope.releaseValue&&same(c.catalogField,applied.catalog),'SOURCE_RESTORE_CONFLICT');
   assertEngineeringCatalog(sourceScope,c.catalogField.value,'protect');
   record({event:'source_restore_reserved'});
   await cutover('restore',prior.active.value,scope.catalogValue);
   c=await admin.read();need(c.active.value===prior.active.value&&same(c.catalogField,applied.catalog)&&decodeAuthority(c.field.value)?.grants.length===0,'SOURCE_RESTORE_CONFLICT');
   exclusive();const operation=store.lifecycle.startCutover();deleting={context:c,field:applied.catalog,operation};
   // No CAS exists for metafieldsDelete. All normal writers share this lock;
   // remote editors must remain excluded. Immediate exact re-read is a guard,
   // not an atomic compare-and-delete guarantee.
   record({event:'catalog_delete_reserved',field:applied.catalog});
   try{
    const result=await api(CATALOG_DELETE,{metafields:[{ownerId:INSTALLATION,namespace:'bfl_printing',key:'price_catalog'}]});
    need(result.metafieldsDelete?.userErrors?.length===0&&same(result.metafieldsDelete.deletedMetafields,[{ownerId:INSTALLATION,namespace:'bfl_printing',key:'price_catalog'}]),'SOURCE_DELETE_UNCONFIRMED');
    const after=await admin.read({allowMissingCatalog:true});exclusive();
    need(after.catalogField===null&&after.active.value===prior.active.value&&sameAuthorityValue(after.field.value,c.field.value)&&after.fence.value===c.fence.value,'SOURCE_DELETE_UNCONFIRMED');
    if(eligibility)need(after.functionOwners.every(o=>sameLeaseValue(o.field?.value,leaseEnvelope(after.field.value))),'SOURCE_DELETE_UNCONFIRMED');
    store.lifecycle.finish(operation);record({event:'source_restored',catalog_absent:true,active_sha256:after.release.sha256,...(eligibility?{lease_sentinels:true}:{})});return {restored:true,catalog_absent:true,checkout_ready:false};
   }catch(error){record({event:'catalog_delete_unknown'});throw error;}finally{deleting=null;}
  },
  status:()=>({requests,mutations,applied:!!last('source_applied'),restored:!!last('source_restored'),delete_spent:!!last('catalog_delete_reserved')}),
 });
}
