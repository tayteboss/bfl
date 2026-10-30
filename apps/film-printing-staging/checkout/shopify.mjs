import {assertEngineeringScope,assertEngineeringCatalog} from '../configuration/engineering.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { assertIdentity } from '../configuration/shopify.mjs';
import { verifyRelease, freeze, canonical } from '../configuration/config.mjs';
import { requireValue } from '../shipping/packing.mjs';
import { NAMESPACE, KEY, STORE, decodeAuthority, isEligibilitySchema,isFullProductSchema } from './authority.js';
import { emptyAuthority, serializeAuthority } from './projector.mjs';
import {LEASE_QUERY_FIELDS,readFunctionOwners,leaseFields,leaseEnvelope,sameLeaseContext,sameAuthorityValue,sameLeaseValue} from './lease.mjs';
import {isCompactProductCatalog,expandFullProductCatalog} from '../pricing/compact-catalog.mjs';
import {preparedPolicy} from './prepared-limits.mjs';

// App-owned Shop resource, NOT the AppInstallation's private data. No secret,
// upload URL, session cookie or raw cart token is projected to Functions.
export const AUTHORITY_DEFINITION = {
  name:'BFL checkout authority',namespace:NAMESPACE,key:KEY,type:'json',ownerType:'SHOP',
  access:{admin:'MERCHANT_READ',storefront:'NONE'},
};
export const CONTEXT_QUERY = `query F06DAuthorityContext {
  shop { id myshopifyDomain ianaTimezone
    authority: metafield(namespace: "${NAMESPACE}", key: "${KEY}") {
      value type compareDigest namespace key
      definition { ownerType type { name } access { admin storefront } }
    }
  }
  currentAppInstallation { id app { id apiKey }
    active: metafield(namespace:"bfl_printing",key:"active_config") { id type value compareDigest }
    catalog: metafield(namespace:"bfl_printing",key:"price_catalog") { id type value compareDigest }
    fence: metafield(namespace:"bfl_printing",key:"authority_fence") { id type value compareDigest }
  }
}`;
export const LEASE_CONTEXT_QUERY=CONTEXT_QUERY.replace('F06DAuthorityContext','F06DAuthorityLeaseContext').replace(/}\s*$/,LEASE_QUERY_FIELDS+'}');
const digest = value => createHash('sha256').update(value).digest('hex');
const dayAt = (now,zone) => {
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
  const p=Object.fromEntries(parts.map(v=>[v.type,v.value]));return `${p.year}-${p.month}-${p.day}`;
};
const sourceField=(ownerId,key,field,value=field.value)=>({ownerId,namespace:'bfl_printing',key,type:field.type,value,compareDigest:field.compareDigest});
const authorityField=(context,value)=>({ownerId:context.shopId,namespace:NAMESPACE,key:KEY,type:'json',value,compareDigest:context.field.compareDigest});
export function decodeCatalog(value) {
  const c=JSON.parse(value);
  const catalog={...c,version:`price-${digest(value)}`};
  if(isCompactProductCatalog(catalog))return expandFullProductCatalog(catalog);
  requireValue(c?.store===STORE && c.currency==='USD' && Array.isArray(c.rows),'PRICE_UNAVAILABLE');
  return catalog;
}
const sameContext=(a,b,{allowDateChange=false}={})=>a.shopId===b?.shopId && a.installationId===b.installationId && (a.shopDate===b.shopDate||allowDateChange) &&
  ['active','catalogField','field','fence'].every(k=>(a[k]?.compareDigest??null)===(b[k]?.compareDigest??null))&&sameLeaseContext(a,b);
const protectedContext=c=>{
  requireValue(c.field,'AUTHORITY_DEFINITION_REQUIRED');
  requireValue(c.fence?.type==='single_line_text_field' && c.fence.compareDigest && /^[a-f0-9-]{36}$/.test(c.fence.value),'AUTHORITY_FENCE_REQUIRED');
};

// All workers MUST share the same durable private job store. No process-local
// lock, elapsed-time lease takeover or caller-asserted checkout readiness.
export function createAuthorityAdmin(api,{writesEnabled=false,now=()=>new Date(),lifecycle,sourceScope,eligibility=false,specificationOwner=null}={}) {
  const writable=()=>{
    requireValue(writesEnabled,'AUTHORITY_WRITES_DISABLED');
    requireValue(lifecycle,'LIFECYCLE_REQUIRED');
  };
  // These finite sources contain no daily price table. A publication may cross
  // midnight without changing its original issuance date or lease. Every other
  // source/CAS/owner guard remains exact; historical daily projections stay daily.
  const fullProductDateChange=(a,b,authority)=>{
    if(!eligibility||!sourceScope||!isFullProductSchema(authority?.schema)||!authority.grants.length||
      a?.timezone!==b?.timezone||!preparedPolicy(sourceScope).clientPolicy)return false;
    const {contract}=assertEngineeringScope(sourceScope),time=Number(now());
    const sourceUntil=contract.kind==='persistent_staging'?Infinity:contract.expires_at;
    if(time<contract.issued_at||time>=sourceUntil||!authority.lease||
      time>=authority.lease.expires_at||authority.lease.expires_at>sourceUntil)return false;
    const first=dayAt(contract.issued_at,a.timezone),last=dayAt(time,a.timezone);
    return [a.shopDate,b.shopDate,authority.valid_on].every(day=>typeof day==='string'&&day>=first&&day<=last);
  };
  async function read({allowMissingCatalog=false}={}) {
    const data=await api(eligibility?LEASE_CONTEXT_QUERY:CONTEXT_QUERY);
    const app=assertIdentity(data), field=data.shop.authority;
    requireValue(/^gid:\/\/shopify\/Shop\/\d+$/.test(data.shop.id) && /^gid:\/\/shopify\/AppInstallation\/\d+$/.test(app.id),'WRONG_TARGET');
    requireValue(app.active?.type==='json' && app.active.compareDigest,'AUTHORITY_SOURCE_UNAVAILABLE');
    const release=verifyRelease(JSON.parse(app.active.value),{sourceScope,intent:'protect'});
    requireValue(allowMissingCatalog && !app.catalog || app.catalog?.type==='json' && app.catalog.compareDigest,'AUTHORITY_SOURCE_UNAVAILABLE');
    const catalog=app.catalog ? decodeCatalog(app.catalog.value) : null;
    if(field) {
      const d=field.definition;
      requireValue(field.namespace===`app--${app.app.id.split('/').pop()}--bfl-checkout` && field.key===KEY && field.type==='json' && field.compareDigest &&
        d?.ownerType==='SHOP' && d.type?.name==='json' && d.access?.admin==='MERCHANT_READ' && d.access?.storefront==='NONE','UNPROTECTED_AUTHORITY');
      requireValue(decodeAuthority(field.value),'INVALID_PRIOR_AUTHORITY');
    }
    return freeze({release,catalog,shopDate:dayAt(now(),data.shop.ianaTimezone),shopId:data.shop.id,installationId:app.id,
      field:field??null,active:app.active,catalogField:app.catalog??null,fence:app.fence??null,
      ...(eligibility?{timezone:data.shop.ianaTimezone,functionOwners:readFunctionOwners(data,{specificationOwner})}:{})});
  }
  async function commit(current,value,op,{active=current.active.value,catalog=current.catalogField?.value,archive,publication=false}={}) {
    // Rotate on EVERY write, including identical/empty projections. This private
    // token prevents digest ABA and fences a delayed pre-recovery HTTP request.
    const token=randomUUID();
    const fields=[
      decodeAuthority(value)?.grants.length===0 ? authorityCutoverField(current,value) : authorityField(current,value),
      sourceField(current.installationId,'active_config',current.active,active),
      sourceField(current.installationId,'authority_fence',current.fence,token),
    ];
    if(catalog!==undefined)fields.push(sourceField(current.installationId,'price_catalog',current.catalogField??{type:'json',compareDigest:null},catalog));
    if(archive)fields.push(sourceField(current.installationId,archive.key,archive.field,archive.field.value));
    if(eligibility)fields.push(...leaseFields(current.functionOwners,value,{specificationOwner}));
    lifecycle.assertOperation(op);
    // From here any throw is ambiguous or unacknowledged. Leave the durable
    // operation pending. Recovery reads actual state and clears grants with CAS.
    const response=await api(`mutation F06DCommitAuthority($fields:[MetafieldsSetInput!]!) {
      metafieldsSet(metafields:$fields) { metafields { key compareDigest } userErrors { code } }
    }`,{fields});
    requireValue(response.metafieldsSet && response.metafieldsSet.userErrors?.length===0,'AUTHORITY_WRITE_REJECTED');
    const after=await read({allowMissingCatalog:catalog===undefined});
    protectedContext(after);
    requireValue(sameAuthorityValue(after.field?.value,value) && after.active.value===active && after.catalogField?.value===catalog && after.fence?.value===token &&
      after.shopId===current.shopId && after.installationId===current.installationId &&
      (after.shopDate===current.shopDate||publication&&fullProductDateChange(after,current,decodeAuthority(value))),'AUTHORITY_READBACK_CHANGED');
    if(eligibility)requireValue(after.timezone===current.timezone&&after.functionOwners.every((owner,i)=>
      owner.id===current.functionOwners[i].id&&sameLeaseValue(owner.field?.value,leaseEnvelope(value))),'AUTHORITY_READBACK_CHANGED');
    if(archive) {
      const data=await api(`query F06DArchive($key:String!) { shop { myshopifyDomain } currentAppInstallation { id app { id } metafield(namespace:"bfl_printing",key:$key) { type value compareDigest } } }`,{key:archive.key});
      const app=assertIdentity(data);
      requireValue(app.id===current.installationId && app.metafield?.type==='json' && app.metafield.value===archive.field.value,'ARCHIVE_READBACK_CHANGED');
    }
    lifecycle.finish(op);
    return {published:true,checkout_ready:false};
  }
  return {
    read,
    async publish(prepared) {
      writable();
      if(sourceScope)assertEngineeringScope(sourceScope);
      const current=await read(); protectedContext(current);
      if(sourceScope)assertEngineeringCatalog(sourceScope,current.catalogField.value);
      const a=decodeAuthority(prepared.value),allowDateChange=fullProductDateChange(current,prepared.context,a);
      requireValue(sameContext(current,prepared.context,{allowDateChange}),'AUTHORITY_CHANGED');
      if(eligibility)requireValue(isEligibilitySchema(a?.schema),'LEASE_AUTHORITY_REQUIRED');
      if(isFullProductSchema(a?.schema))requireValue(eligibility&&specificationOwner!==null,'SPECIFICATION_OWNER_REQUIRED');
      requireValue(a && a.config_version===current.release.version && a.config_sha256===current.release.sha256 && a.price_version===current.catalog.version && a.valid_on===prepared.context.shopDate && (a.valid_on===current.shopDate||allowDateChange),'AUTHORITY_CHANGED');
      const op=lifecycle.startPublication(prepared.ticket,prepared.value);
      return commit(current,prepared.value,op,{publication:true});
    },
    // Sole current source writer. Config publisher supplies its verified immutable
    // archive; catalog publisher supplies exact approved bytes. No arbitrary fields.
    async cutover({context,release=context.release,catalogValue=context.catalogField?.value,archive,activeValue=canonical(release)}) {
      writable(); verifyRelease(release,{sourceScope});
      requireValue(canonical(verifyRelease(JSON.parse(activeValue),{sourceScope}))===canonical(release),'AUTHORITY_SOURCE_UNAVAILABLE');
      const current=await read({allowMissingCatalog:true}); protectedContext(current);
      requireValue(sameContext(current,context),'AUTHORITY_CHANGED');
      const catalog=decodeCatalog(catalogValue);
      if(release.sha256!==current.release.sha256 || archive) {
        requireValue(archive?.key===`release_${release.sha256.slice(0,24)}` && archive.field?.type==='json' &&
          Object.hasOwn(archive.field,'compareDigest') && canonical(verifyRelease(JSON.parse(archive.field.value),{sourceScope}))===canonical(release),'ARCHIVE_REQUIRED');
      }
      const value=serializeAuthority(emptyAuthority(release,catalog,current.shopDate,{sourceScope}));
      const op=lifecycle.startCutover();
      return commit(current,value,op,{active:activeValue,catalog:catalogValue,archive});
    },
    async reconcile() {
      writable();
      const op=lifecycle.startRecovery();
      const current=await read({allowMissingCatalog:true}); protectedContext(current);
      // Conservative whole-projection revocation: no private upload IDs need to
      // be added to Function input; unrelated owners can freshly reauthorize.
      const value=serializeAuthority({...decodeAuthority(current.field.value),grants:[]});
      await commit(current,value,op);
      return {revoked:true,checkout_ready:false};
    },
  };
}

export function authorityCutoverField(context,emptyValue) {
  const a=decodeAuthority(emptyValue);
  requireValue(context.field?.compareDigest && a?.grants.length===0,'INVALID_CUTOVER');
  return {ownerId:context.shopId,namespace:NAMESPACE,key:KEY,type:'json',value:emptyValue,compareDigest:context.field.compareDigest};
}
