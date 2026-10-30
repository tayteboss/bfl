// Dedicated operator transport: fixed staging endpoint and operations only.
// Excluded from runtime image; never edits drafts, definitions or products.
import {STORE,APP,CLIENT,groupTypes} from './schema.mjs';
import {verifyRelease} from './config.mjs';
import {SHOP,INSTALLATION,need,RuntimeError} from '../backend/config.mjs';
import {CONTEXT_QUERY,createAuthorityAdmin,decodeCatalog} from '../checkout/shopify.mjs';
import {decodeAuthority} from '../checkout/authority.js';
import {emptyAuthority,serializeAuthority} from '../checkout/projector.mjs';
import {parseStrictJson} from '../pricing/prepare.mjs';
import {API_VERSION,IDENTITY_QUERY,DRAFT_QUERY,ARCHIVE_QUERY,ARCHIVE_READBACK,COMMIT,equal,exact,describe,descriptor,draftNodes,snapshotDrafts,validateReview} from './operator-contract.mjs';

export function createConfigurationTransport(config,{mode='disabled',review,now=()=>new Date(),fetchImpl=fetch,timeoutMs=5000,maxBytes=262144}={}) {
  need(config.store===STORE&&config.app===APP&&config.clientId===CLIENT&&config.installation===INSTALLATION,'WRONG_TARGET');
  need(config.mode==='disabled','RUNTIME_WRITES_MUST_BE_DISABLED');
  need(['disabled','inspect','apply','recover'].includes(mode),'OPERATOR_MODE_INVALID');
  need(Number.isInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=5000&&Number.isInteger(maxBytes)&&maxBytes>0&&maxBytes<=262144,'OPERATOR_LIMIT_INVALID');
  let attempted=false,calls=0;
  const reviewed=review?structuredClone(review):null;
  async function request(query,variables={}) {
    need(mode!=='disabled','OPERATOR_DISABLED');need(config.adminToken,'ADMIN_CREDENTIAL_REQUIRED');
    need(++calls<=120,'ADMIN_OPERATION_LIMIT');
    const body=JSON.stringify({query,variables});need(Buffer.byteLength(body)<=262144,'ADMIN_REQUEST_TOO_LARGE');
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
    try {
      const r=await fetchImpl(`https://${STORE}/admin/api/${API_VERSION}/graphql.json`,{method:'POST',redirect:'error',signal:controller.signal,
        headers:{'Content-Type':'application/json','X-Shopify-Access-Token':config.adminToken},body});
      need(r.ok,r.status===401||r.status===403?'ADMIN_ACCESS_DENIED':'ADMIN_UNAVAILABLE');
      need(r.headers.get('x-shopify-api-version')===API_VERSION,'ADMIN_VERSION_MISMATCH');
      need(/^application\/json(?:;|$)/i.test(r.headers.get('content-type')??''),'ADMIN_INVALID_RESPONSE');
      const chunks=[];let bytes=0;
      for await(const chunk of r.body){bytes+=chunk.length;need(bytes<=maxBytes,'ADMIN_RESPONSE_TOO_LARGE');chunks.push(chunk);}
      const parsed=parseStrictJson(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
      need((!Object.hasOwn(parsed,'errors')||Array.isArray(parsed.errors)&&parsed.errors.length===0)&&parsed.data&&typeof parsed.data==='object'&&!Array.isArray(parsed.data),'ADMIN_QUERY_REJECTED');
      return parsed.data;
    } catch(e){throw e instanceof RuntimeError?e:new RuntimeError('ADMIN_UNAVAILABLE');}
    finally{clearTimeout(timer);controller.abort();}
  }
  async function identity() {
    const d=await request(IDENTITY_QUERY),app=d.currentAppInstallation;
    need(d.shop?.id===SHOP&&d.shop.myshopifyDomain===STORE&&app?.id===INSTALLATION&&app.app?.id===APP&&app.app.apiKey===CLIENT,'WRONG_TARGET');
    need(Array.isArray(app.accessScopes)&&app.accessScopes.every(s=>typeof s?.handle==='string'),'ADMIN_SCOPE_UNAVAILABLE');
    // AppInstallation data and this app's Shop fields have owner-scoped access.
    // No product/draft write scope is requested by this command.
    if(mode!=='recover')need(app.accessScopes.some(s=>['read_metaobjects','write_metaobjects'].includes(s.handle)),'METAOBJECT_READ_ACCESS_REQUIRED');
  }
  function contextIdentity(d) {
    need(d.shop?.id===SHOP&&d.shop.myshopifyDomain===STORE&&d.currentAppInstallation?.id===INSTALLATION&&d.currentAppInstallation.app?.id===APP,'WRONG_TARGET');
    return d;
  }
  async function current() {
    const d=contextIdentity(await request(CONTEXT_QUERY));
    const c=await createAuthorityAdmin(async()=>d,{now}).read({allowMissingCatalog:mode==='recover'});
    need(c.field&&c.fence?.type==='single_line_text_field'&&c.fence.compareDigest&&/^[a-f0-9-]{36}$/.test(c.fence.value),'OPERATOR_PROVISIONING_REQUIRED');
    return c;
  }
  async function archive(query,key) {
    const d=await request(query,{key}),app=d.currentAppInstallation;
    need(d.shop?.myshopifyDomain===STORE&&app?.id===INSTALLATION&&app.app?.id===APP,'WRONG_TARGET');
    const f=app.metafield;
    need(f===null||f?.type==='json'&&typeof f.value==='string'&&typeof f.compareDigest==='string'&&f.compareDigest.length>0,'ARCHIVE_CONFLICT');
    if(mode==='apply'&&query===ARCHIVE_QUERY)need(key===reviewed.candidate.archive_key&&equal(descriptor(f),reviewed.current.archive)&&f?.value===(reviewed.current_values.archive??undefined),'OPERATOR_REVIEW_STALE');
    return d;
  }
  async function api(query,variables={}) {
    need(mode!=='disabled','OPERATOR_DISABLED');
    need([CONTEXT_QUERY,DRAFT_QUERY,ARCHIVE_QUERY,ARCHIVE_READBACK,COMMIT].includes(query),'ADMIN_OPERATION_REJECTED');
    const mutation=query===COMMIT,isArchive=[ARCHIVE_QUERY,ARCHIVE_READBACK].includes(query);
    need(exact(variables,mutation?['fields']:query===DRAFT_QUERY?['type']:isArchive?['key']:[]),'ADMIN_OPERATION_REJECTED');
    if(query===DRAFT_QUERY)need(mode!=='recover'&&Object.values(groupTypes).includes(variables.type),'ADMIN_OPERATION_REJECTED');
    if(isArchive)need(typeof variables.key==='string'&&/^release_[a-f0-9]{24}$/.test(variables.key),'ADMIN_OPERATION_REJECTED');
    if(!mutation) {
      await identity();
      if(isArchive)return archive(query,variables.key);
      const d=await request(query,variables);
      if(query===CONTEXT_QUERY)return contextIdentity(d);
      const nodes=draftNodes(d,variables.type);
      if(mode==='apply')need(equal(nodes,reviewed.drafts.records[variables.type]),'OPERATOR_DRAFT_CHANGED');
      return d;
    }
    need(['apply','recover'].includes(mode)&&!attempted,'OPERATOR_WRITE_REJECTED');attempted=true;
    if(mode==='apply')await validateReview(reviewed,config,reviewed?.candidate?.version,now);
    await identity();let c=await current();
    let oldArchive=null;
    if(mode==='apply') {
      // Re-read complete drafts twice at the last boundary. All writers/editors
      // must remain stopped: Shopify has no transaction spanning metaobjects and
      // metafields. Only the exact immutable reviewed release can ever be sent.
      const first=await snapshotDrafts(api),second=await snapshotDrafts(api);
      need(equal(first,second)&&equal(first,{drafts:reviewed.drafts,candidate:reviewed.candidate}),'OPERATOR_DRAFT_CHANGED');
      oldArchive=(await api(ARCHIVE_QUERY,{key:reviewed.candidate.archive_key})).currentAppInstallation.metafield;
      await identity();c=await current();
      need(equal(describe(c,oldArchive),reviewed.current)&&c.shopDate===reviewed.shop_date,'OPERATOR_REVIEW_STALE');
    }
    const fields=variables.fields,archiveKey=mode==='apply'?reviewed.candidate.archive_key:null;
    const keys=['authority','active_config','authority_fence',...(c.catalogField?['price_catalog']:[]),...(archiveKey?[archiveKey]:[])];
    need(Array.isArray(fields)&&fields.length===keys.length&&equal(fields.map(f=>f.key).sort(),keys.sort()),'ADMIN_OPERATION_REJECTED');
    need(fields.every(f=>exact(f,['ownerId','namespace','key','type','value','compareDigest'])&&f.ownerId===(f.key==='authority'?SHOP:INSTALLATION)&&
      f.namespace===(f.key==='authority'?'$app:bfl-checkout':'bfl_printing')),'ADMIN_OPERATION_REJECTED');
    const get=key=>fields.find(f=>f.key===key),authority=get('authority'),fence=get('authority_fence');
    need(authority.type==='json'&&authority.compareDigest===c.field.compareDigest&&decodeAuthority(authority.value)?.grants.length===0,'ADMIN_OPERATION_REJECTED');
    need(fence.type==='single_line_text_field'&&fence.compareDigest===c.fence.compareDigest&&/^[a-f0-9-]{36}$/.test(fence.value)&&fence.value!==c.fence.value,'ADMIN_OPERATION_REJECTED');
    for(const [key,prior] of [['active_config',c.active],['price_catalog',c.catalogField]]) {
      const f=get(key);if(!f){need(prior===null,'ADMIN_OPERATION_REJECTED');continue;}
      need(f.type==='json'&&f.compareDigest===prior.compareDigest&&f.value===(key==='active_config'&&mode==='apply'?reviewed.candidate.value:prior.value),'ADMIN_OPERATION_REJECTED');
    }
    if(mode==='apply') {
      const f=get(archiveKey);
      need(f.type==='json'&&f.compareDigest===(oldArchive?.compareDigest??null)&&f.value===(oldArchive?.value??reviewed.candidate.value),'ARCHIVE_CONFLICT');
      need(authority.value===serializeAuthority(emptyAuthority(verifyRelease(parseStrictJson(reviewed.candidate.value)),decodeCatalog(c.catalogField.value),c.shopDate)),'ADMIN_OPERATION_REJECTED');
      need(now().getTime()<=Date.parse(reviewed.approval.expires_at),'OPERATOR_REVIEW_EXPIRED');
    } else need(equal(decodeAuthority(authority.value),{...decodeAuthority(c.field.value),grants:[]}),'ADMIN_OPERATION_REJECTED');
    const result=await request(COMMIT,{fields});
    need(result.metafieldsSet?.userErrors?.length===0,'OPERATOR_WRITE_REJECTED');
    // Existing F06D readback (including exact archive bytes) finishes lifecycle.
    return result;
  }
  return api;
}
