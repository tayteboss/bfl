import {STORE,APP,CLIENT} from '../configuration/schema.mjs';
import {INSTALLATION,SHOP,RuntimeError,need} from './config.mjs';
import {decodeAuthority} from '../checkout/authority.js';
import {CONTEXT_QUERY,LEASE_CONTEXT_QUERY} from '../checkout/shopify.mjs';
import {LEASE_KEY,readFunctionOwners,leaseFields,leaseOwners} from '../checkout/lease.mjs';
import {canonical} from '../configuration/config.mjs';
const IDENTITY='query F06EIdentity { shop { id myshopifyDomain } currentAppInstallation { id app { id apiKey } } }';
export const CATALOG_DELETE='mutation F06PEngineeringCatalogDelete($metafields:[MetafieldIdentifierInput!]!){metafieldsDelete(metafields:$metafields){deletedMetafields{ownerId namespace key} userErrors{field message}}}';
export function createAdminTransport(config,{fetchImpl=fetch,timeoutMs=5000,maxBytes=1048576,publicationCustody,sourceCustody,eligibility=false,specificationOwner=null,credentialProvider=null}={}) {
  need(config.store===STORE&&config.app===APP&&config.clientId===CLIENT&&config.installation===INSTALLATION,'WRONG_TARGET');
  need(specificationOwner===null||eligibility,'SPECIFICATION_OWNER_REQUIRED');
  need(credentialProvider===null||typeof credentialProvider.read==='function','ADMIN_CREDENTIAL_REQUIRED');
  const ownerCount=eligibility?leaseOwners(specificationOwner).length:0;
  const endpoint=`https://${STORE}/admin/api/2026-10/graphql.json`;
  async function request(query,variables={}) {
    const token=credentialProvider?await credentialProvider.read():config.adminToken;
    need(credentialProvider?typeof token==='string'&&/^[\x21-\x7e]{32,2048}$/.test(token):token,'ADMIN_CREDENTIAL_REQUIRED');
    const body=JSON.stringify({query,variables});need(Buffer.byteLength(body)<=262144,'ADMIN_REQUEST_TOO_LARGE');
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),timeoutMs);
    try {
      const response=await fetchImpl(endpoint,{method:'POST',redirect:'error',signal:controller.signal,
        headers:{'Content-Type':'application/json','X-Shopify-Access-Token':token},body});
      need(response.ok,response.status===401||response.status===403?'ADMIN_ACCESS_DENIED':'ADMIN_UNAVAILABLE');
      need(response.headers.get('x-shopify-api-version')==='2026-10','ADMIN_VERSION_MISMATCH');
      need(/^application\/json(?:;|$)/i.test(response.headers.get('content-type')??''),'ADMIN_INVALID_RESPONSE');
      const chunks=[];let bytes=0;
      for await(const chunk of response.body) {bytes+=chunk.length;need(bytes<=maxBytes,'ADMIN_RESPONSE_TOO_LARGE');chunks.push(chunk);}
      const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      need(!result.errors?.length&&result.data&&typeof result.data==='object','ADMIN_QUERY_REJECTED');
      return result.data;
    } catch(error) {throw error instanceof RuntimeError?error:new RuntimeError('ADMIN_UNAVAILABLE');}
    finally {clearTimeout(timer);controller.abort();}
  }
  const assertTarget=d=>{
    need(d.shop?.myshopifyDomain===STORE&&d.shop.id===SHOP&&d.currentAppInstallation?.id===INSTALLATION&&
      d.currentAppInstallation.app?.id===APP&&d.currentAppInstallation.app?.apiKey===CLIENT,'WRONG_TARGET');
    return d;
  };
  const identity=async()=>assertTarget(await request(IDENTITY));
  const contextQuery=eligibility?LEASE_CONTEXT_QUERY:CONTEXT_QUERY;
  const context=async()=>assertTarget(await request(contextQuery));
  // Server-only GraphQL API. No route accepts a query/variables from a browser.
  return async(query,variables={})=>{
    const mutation=/^\s*mutation\s/.test(query);
    const sourceWrite=mutation&&sourceCustody?.isArmed()===true;
    need(mutation||/^\s*query\s/.test(query),'ADMIN_OPERATION_REJECTED');
    if(query===CATALOG_DELETE){
      need(config.mode==='reconcile-only'&&sourceCustody,'ADMIN_OPERATION_REJECTED');
      const current=await context();
      sourceCustody.deleteCatalog(current,variables);return request(query,variables);
    }
    if(mutation) {
      need(config.mode==='reconcile-only','AUTHORITY_WRITES_DISABLED');
      need(/^mutation F06DCommitAuthority\(/.test(query.trim()),'ADMIN_OPERATION_REJECTED');
      const all=variables.fields;
      need(Array.isArray(all),'ADMIN_OPERATION_REJECTED');
      const fields=all.filter(f=>f.key!==LEASE_KEY),owners=all.filter(f=>f.key===LEASE_KEY);
      need(fields.length>=3&&fields.length<=(sourceWrite?5:4)&&owners.length===ownerCount&&
        new Set(all.map(f=>`${f.ownerId}\0${f.namespace}\0${f.key}`)).size===all.length,'ADMIN_OPERATION_REJECTED');
      const keys=['authority','active_config','authority_fence','price_catalog'];
      need(fields.every(f=>(keys.includes(f.key)||sourceWrite&&/^release_[a-f0-9]{24}$/.test(f.key))&&((sourceWrite&&f.compareDigest===null)||typeof f.compareDigest==='string'&&f.compareDigest.length>0)&&
        f.ownerId===(f.key==='authority'?SHOP:INSTALLATION)&&f.namespace===(f.key==='authority'?'$app:bfl-checkout':'bfl_printing'))&&
        ['authority','active_config','authority_fence'].every(k=>fields.some(f=>f.key===k))&&
        (decodeAuthority(fields.find(f=>f.key==='authority').value)?.grants.length===0||publicationCustody),'ADMIN_OPERATION_REJECTED');
    }
    // The context contains the same exact token/shop/app identity. Validate it
    // in the same response rather than paying for a separate identity request.
    if(query===contextQuery)return context();
    if(mutation) {
      // The runtime's only enabled write is revocation. Do not let even an
      // internal caller use this credential boundary to change source prices.
      const current=await context(), fields=variables.fields;
      const a=fields.find(f=>f.key==='authority'),old=current.shop?.authority;
      const publication=decodeAuthority(a.value)?.grants.length>0||publicationCustody?.isArmedFor?.(a.value)===true;
      if(eligibility){
        const owners=fields.filter(f=>f.key===LEASE_KEY),expected=leaseFields(readFunctionOwners(current,{specificationOwner}),a.value,{specificationOwner});
        const sort=rows=>[...rows].sort((x,y)=>x.ownerId.localeCompare(y.ownerId));
        need(canonical(sort(owners))===canonical(sort(expected)),'ADMIN_OPERATION_REJECTED');
      }
      if(sourceWrite){
        need(sourceCustody.isArmed()&&!publication,'ADMIN_OPERATION_REJECTED');sourceCustody.commit(current,fields);return request(query,variables);
      }
      need(old && a.compareDigest===old.compareDigest && a.type==='json' &&
        (publication||canonical(decodeAuthority(a.value))===canonical({...decodeAuthority(old.value),grants:[]})), 'ADMIN_OPERATION_REJECTED');
      for(const [key,alias] of [['active_config','active'],['price_catalog','catalog']]) {
        const f=fields.find(v=>v.key===key),prior=current.currentAppInstallation?.[alias];
        need(prior ? f && f.value===prior.value && f.type===prior.type && f.compareDigest===prior.compareDigest : !f,'ADMIN_OPERATION_REJECTED');
      }
      const fence=fields.find(f=>f.key==='authority_fence'),prior=current.currentAppInstallation?.fence;
      need(fence.type==='single_line_text_field' && /^[a-f0-9-]{36}$/.test(fence.value) &&
        fence.value!==prior?.value && fence.compareDigest===prior?.compareDigest,'ADMIN_OPERATION_REJECTED');
      if(publication)publicationCustody.consume(a.value); // Exact single prepared value, before send.
    }
    if(!mutation)await identity();
    return request(query,variables); // Never retry, especially an uncertain mutation.
  };
}
