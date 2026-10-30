// OFFLINE TEST ONLY. Synthetic Shopify server; no network or real credentials.
import {readFileSync} from 'node:fs';
import {mockAdmin,hash,now} from '../f06d/mock-admin.mjs';
import {CLIENT} from '../../../apps/film-printing-staging/configuration/schema.mjs';
import {PRODUCT,VARIANT} from '../../../apps/film-printing-staging/checkout/authority.js';
import {IDENTITY_QUERY,TARGET_QUERY,COMMIT} from '../../../apps/film-printing-staging/pricing/operator-admin.mjs';
import {CONTEXT_QUERY} from '../../../apps/film-printing-staging/checkout/shopify.mjs';
import {parseStrictJson,prepareCatalog} from '../../../apps/film-printing-staging/pricing/prepare.mjs';
export {now};
const root=new URL('../f05a/',import.meta.url),read=name=>readFileSync(new URL(name,root),'utf8');
export const input=()=>({capture:parseStrictJson(read('source-export.json')),metafieldValue:read('metafield-value.json'),script:read('source/film-service.js'),section:read('source/film-printing.liquid'),mapping:parseStrictJson(read('reviewed-mapping.json'))});
export const bundle=prepareCatalog(input());
export const prepared={catalogValue:bundle.value,formValue:bundle.formValue,expectedVersion:bundle.version};
export const field=(value,type='json')=>({value,type,compareDigest:hash(value)});
export function syntheticAdmin(saved) {
  const data=saved??mockAdmin().data;
  data.currentAppInstallation.app.apiKey=CLIENT;
  data.currentAppInstallation.accessScopes=[{handle:'write_products'}];
  if(!Object.hasOwn(data,'product')) {
    data.product={id:PRODUCT,handle:'f00-film-printing-test',form:null};
    data.productVariant={id:VARIANT,product:{id:PRODUCT},requiresComponents:false,inventoryItem:{requiresShipping:true}};
    data.currentAppInstallation.catalog=null;
  }
  const get=k=>k==='film_services_json'?data.product.form:k==='authority'?data.shop.authority:data.currentAppInstallation[({active_config:'active',price_catalog:'catalog',authority_fence:'fence'})[k]];
  const put=(k,f)=>{if(k==='film_services_json')data.product.form=f;else if(k==='authority')data.shop.authority=f;else data.currentAppInstallation[({active_config:'active',price_catalog:'catalog',authority_fence:'fence'})[k]]=f;};
  const m={data,calls:[],writes:[],beforeWrite:null,afterWrite:null,readHook:null,
    transact(fields) {
      if(fields.some(f=>f.compareDigest!==(get(f.key)?.compareDigest??null)))return {metafieldsSet:{userErrors:[{code:'STALE_OBJECT'}]}};
      for(const f of fields)put(f.key,{...get(f.key),...field(f.value,f.type)});
      return {metafieldsSet:{userErrors:[],metafields:fields.map(f=>({key:f.key,compareDigest:hash(f.value)}))}};
    },
    async fetch(url,opts) {
      if(!url.startsWith('https://bellows-film-printing-staging.myshopify.com/admin/api/2026-10/'))throw Error('unexpected endpoint');
      const {query,variables}=JSON.parse(opts.body);m.calls.push(query);
      let result;
      if(query===COMMIT) {
        m.writes.push(structuredClone(variables.fields));if(m.beforeWrite)await m.beforeWrite(variables.fields);
        result=m.transact(variables.fields);if(m.afterWrite)await m.afterWrite(variables.fields,result);
      } else {
        if(![IDENTITY_QUERY,TARGET_QUERY,CONTEXT_QUERY].includes(query))throw Error('unexpected operation');
        result=structuredClone(data);if(m.readHook)await m.readHook(query,result);
      }
      return new Response(JSON.stringify({data:result}),{headers:{'content-type':'application/json','x-shopify-api-version':'2026-10'}});
    },
  };
  return m;
}
export function approve(snapshot) {
  return {...snapshot,status:'approved_staging_form_catalog_import',approved_at:now().toISOString(),expires_at:'2026-10-21T13:00:00Z',
    source_refresh:{capture:{...input().capture,captured_at:'2026-10-21T11:59:00Z'},evidence:'SYNTHETIC refreshed capture for offline testing only'},
    unavailable_gate_evidence:'SYNTHETIC stopped-runtime/unavailable gate assertion, not live acceptance'};
}
