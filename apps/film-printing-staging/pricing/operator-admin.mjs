// Separate, offline operator boundary. Never used by the runtime or a browser.
import {STORE,APP,CLIENT} from '../configuration/schema.mjs';
import {INSTALLATION,SHOP,need,RuntimeError} from '../backend/config.mjs';
import {PRODUCT,VARIANT,decodeAuthority} from '../checkout/authority.js';
import {CONTEXT_QUERY,decodeCatalog} from '../checkout/shopify.mjs';
import {emptyAuthority,serializeAuthority} from '../checkout/projector.mjs';
import {canonical,verifyRelease} from '../configuration/config.mjs';
import {sha256} from './prepare.mjs';

export const TARGET=Object.freeze({store:STORE,shop:SHOP,app:APP,client:CLIENT,installation:INSTALLATION,product:PRODUCT,variant:VARIANT});
export const IDENTITY_QUERY='query F05AOperatorIdentity { shop { id myshopifyDomain } currentAppInstallation { id app { id apiKey } accessScopes { handle } } }';
export const TARGET_QUERY=`query F05AOperatorTarget {
  product(id:"${PRODUCT}") { id handle form: metafield(namespace:"custom",key:"film_services_json") { type value compareDigest } }
  productVariant(id:"${VARIANT}") { id product { id } requiresComponents inventoryItem { requiresShipping } }
}`;
// Byte-exact existing F06D writer operation; no arbitrary GraphQL accepted.
export const COMMIT=`mutation F06DCommitAuthority($fields:[MetafieldsSetInput!]!) {
      metafieldsSet(metafields:$fields) { metafields { key compareDigest } userErrors { code } }
    }`;
export const descriptor=f=>f===null?null:{type:f.type,sha256:sha256(f.value),compare_digest:f.compareDigest};
export const describe=(context,target)=>({form:descriptor(target.product.form??null),active:descriptor(context.active),
  catalog:descriptor(context.catalogField),authority:descriptor(context.field),fence:descriptor(context.fence)});
const equal=(a,b)=>canonical(a)===canonical(b);
function targetOK(d) {
  need(d.product?.id===PRODUCT && d.product.handle==='f00-film-printing-test' && d.productVariant?.id===VARIANT &&
    d.productVariant.product?.id===PRODUCT && d.productVariant.requiresComponents===false &&
    d.productVariant.inventoryItem?.requiresShipping===true,'OPERATOR_TARGET_CHANGED');
  const f=d.product.form;
  need(f===null || f?.type==='json' && typeof f.value==='string' && typeof f.compareDigest==='string' && f.compareDigest.length>0,'OPERATOR_FORM_INVALID');
  return d;
}
const fromRaw=d=>({active:d.currentAppInstallation?.active,catalogField:d.currentAppInstallation?.catalog??null,
  field:d.shop?.authority??null,fence:d.currentAppInstallation?.fence??null});
function contextOK(d) {
  need(d.shop?.id===SHOP && d.shop.myshopifyDomain===STORE && d.currentAppInstallation?.id===INSTALLATION && d.currentAppInstallation.app?.id===APP,'WRONG_TARGET');
  return d;
}

export function createPricingTransport(config,{mode='disabled',bundle,review,now=()=>new Date(),fetchImpl=fetch,timeoutMs=5000,maxBytes=1048576}={}) {
  need(config.store===STORE && config.app===APP && config.clientId===CLIENT && config.installation===INSTALLATION,'WRONG_TARGET');
  need(config.mode==='disabled','RUNTIME_WRITES_MUST_BE_DISABLED');
  need(['disabled','inspect','apply','recover'].includes(mode),'OPERATOR_MODE_INVALID');
  let attempted=false;
  async function request(query,variables={}) {
    need(mode!=='disabled','OPERATOR_DISABLED');need(config.adminToken,'ADMIN_CREDENTIAL_REQUIRED');
    const body=JSON.stringify({query,variables});need(Buffer.byteLength(body)<=262144,'ADMIN_REQUEST_TOO_LARGE');
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
    try {
      const r=await fetchImpl(`https://${STORE}/admin/api/2026-10/graphql.json`,{method:'POST',redirect:'error',signal:controller.signal,
        headers:{'Content-Type':'application/json','X-Shopify-Access-Token':config.adminToken},body});
      need(r.ok,r.status===401||r.status===403?'ADMIN_ACCESS_DENIED':'ADMIN_UNAVAILABLE');
      need(r.headers.get('x-shopify-api-version')==='2026-10','ADMIN_VERSION_MISMATCH');
      need(/^application\/json(?:;|$)/i.test(r.headers.get('content-type')??''),'ADMIN_INVALID_RESPONSE');
      const chunks=[];let bytes=0;
      for await(const chunk of r.body){bytes+=chunk.length;need(bytes<=maxBytes,'ADMIN_RESPONSE_TOO_LARGE');chunks.push(chunk);}
      const parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
      need((!Object.hasOwn(parsed,'errors')||Array.isArray(parsed.errors)&&parsed.errors.length===0) &&
        parsed.data && typeof parsed.data==='object' && !Array.isArray(parsed.data),'ADMIN_QUERY_REJECTED');
      return parsed.data;
    } catch(e){throw e instanceof RuntimeError?e:new RuntimeError('ADMIN_UNAVAILABLE');}
    finally{clearTimeout(timer);controller.abort();}
  }
  async function identity() {
    const d=await request(IDENTITY_QUERY),app=d.currentAppInstallation;
    need(d.shop?.id===SHOP && d.shop.myshopifyDomain===STORE && app?.id===INSTALLATION && app.app?.id===APP && app.app.apiKey===CLIENT,'WRONG_TARGET');
    need(Array.isArray(app.accessScopes) && app.accessScopes.every(s=>typeof s.handle==='string'),'ADMIN_SCOPE_UNAVAILABLE');
    return app.accessScopes.map(s=>s.handle);
  }
  const readTarget=async()=>targetOK(await request(TARGET_QUERY));
  return async(query,variables={})=>{
    need(mode!=='disabled','OPERATOR_DISABLED');
    need([CONTEXT_QUERY,TARGET_QUERY,COMMIT].includes(query),'ADMIN_OPERATION_REJECTED');
    const mutation=query===COMMIT;
    need(equal(Object.keys(variables),mutation?['fields']:[]),'ADMIN_OPERATION_REJECTED');
    if(!mutation){await identity();return query===TARGET_QUERY?readTarget():contextOK(await request(query));}
    need(['apply','recover'].includes(mode) && !attempted,'OPERATOR_WRITE_REJECTED');
    // Single attempt even after a local validation error. A fresh command must
    // reacquire durable state and re-review; no implicit mutation retry.
    attempted=true;
    const scopes=await identity();
    if(mode==='apply')need(scopes.includes('write_products'),'PRODUCT_WRITE_ACCESS_REQUIRED');
    const current=contextOK(await request(CONTEXT_QUERY)),c=fromRaw(current),fields=variables.fields;
    const keys=['authority','active_config','authority_fence',...(mode==='apply'||c.catalogField?['price_catalog']:[])];
    need(Array.isArray(fields)&&fields.length===keys.length&&equal(fields.map(f=>f.key).sort(),[...keys].sort()),'ADMIN_OPERATION_REJECTED');
    need(fields.every(f=>equal(Object.keys(f).sort(),['ownerId','namespace','key','type','value','compareDigest'].sort()) &&
      f.ownerId===(f.key==='authority'?SHOP:INSTALLATION) && f.namespace===(f.key==='authority'?'$app:bfl-checkout':'bfl_printing')),'ADMIN_OPERATION_REJECTED');
    const get=key=>fields.find(f=>f.key===key),a=get('authority'),fence=get('authority_fence');
    need(c.field && c.active && c.fence && a.type==='json' && a.compareDigest===c.field.compareDigest &&
      decodeAuthority(a.value)?.grants.length===0,'ADMIN_OPERATION_REJECTED');
    need(fence.type==='single_line_text_field' && fence.compareDigest===c.fence.compareDigest &&
      /^[a-f0-9-]{36}$/.test(fence.value) && fence.value!==c.fence.value,'ADMIN_OPERATION_REJECTED');
    for(const [key,prior] of [['active_config',c.active],['price_catalog',c.catalogField]]) {
      const f=get(key);if(!f){need(prior===null,'ADMIN_OPERATION_REJECTED');continue;}
      need(f.type==='json' && f.compareDigest===(prior?.compareDigest??null),'ADMIN_OPERATION_REJECTED');
      const value=key==='price_catalog'&&mode==='apply'?bundle.value:mode==='apply'&&key==='active_config'?canonical(verifyRelease(JSON.parse(prior.value))):prior?.value;
      need(f.value===value,'ADMIN_OPERATION_REJECTED');
    }
    let target;
    if(mode==='apply') {
      need(now().getTime()<=Date.parse(review.expires_at),'OPERATOR_REVIEW_EXPIRED');
      target=await readTarget();
      need(equal(describe(c,target),review.current),'OPERATOR_REVIEW_STALE');
      need(a.value===serializeAuthority(emptyAuthority(verifyRelease(JSON.parse(c.active.value)),decodeCatalog(bundle.value),decodeAuthority(a.value).valid_on)),'ADMIN_OPERATION_REJECTED');
    } else {
      need(equal(decodeAuthority(a.value),{...decodeAuthority(c.field.value),grants:[]}),'ADMIN_OPERATION_REJECTED');
    }
    const submitted=fields.map(f=>({...f}));
    if(mode==='apply')submitted.push({ownerId:PRODUCT,namespace:'custom',key:'film_services_json',type:'json',value:bundle.formValue,compareDigest:target.product.form?.compareDigest??null});
    // Shopify metafieldsSet is atomic across owners. Preserve every existing CAS
    // guard and add the reviewed product form to the SAME transaction.
    const result=await request(COMMIT,{fields:submitted});
    need(result.metafieldsSet?.userErrors?.length===0,'OPERATOR_WRITE_REJECTED');
    if(mode==='apply') {
      await identity();const after=await readTarget();
      need(after.product.form?.value===bundle.formValue,'OPERATOR_FORM_READBACK_CHANGED');
    }
    // F06D still owns source/authority/fence readback and lifecycle completion.
    return result;
  };
}
