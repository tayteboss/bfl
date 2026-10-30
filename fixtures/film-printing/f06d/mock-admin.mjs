// OFFLINE ONLY: mocked authenticated Shopify transport and synthetic pricing.
// Models atomic, content-digest CAS (including ABA), never performs network I/O.
import {createHash,randomUUID} from 'node:crypto';
import {APP,CLIENT,STORE,groupTypes} from '../../../apps/film-printing-staging/configuration/schema.mjs';
import {canonical} from '../../../apps/film-printing-staging/configuration/config.mjs';
import {encodeRecord} from '../../../apps/film-printing-staging/configuration/shopify.mjs';
import {emptyAuthority,serializeAuthority} from '../../../apps/film-printing-staging/checkout/projector.mjs';
import {decodeCatalog} from '../../../apps/film-printing-staging/checkout/shopify.mjs';
import {syntheticRelease} from '../f04/synthetic.mjs';
export const now=()=>new Date('2026-10-21T12:00:00Z');
export const hash=value=>createHash('sha256').update(value).digest('hex');
export function mockAdmin({release=syntheticRelease()}={}) {
 const catalog={store:STORE,currency:'USD',rows:[{enabled:true,physical:true,variant_id:'67852705202287',service:'photo',size:'4x6',paper:'synthetic-paper',lab:'miami',options:{},per_file_cents:40}]};
 const field=(value,type='json')=>({value,type,compareDigest:hash(value)});
 const data={shop:{id:'gid://shopify/Shop/81566597231',myshopifyDomain:STORE,ianaTimezone:'America/New_York',authority:{
  ...field(serializeAuthority(emptyAuthority(release,decodeCatalog(JSON.stringify(catalog)),'2026-10-21'))),
  namespace:`app--${APP.split('/').pop()}--bfl-checkout`,key:'authority',definition:{ownerType:'SHOP',type:{name:'json'},access:{admin:'MERCHANT_READ',storefront:'NONE'}}}},
  currentAppInstallation:{id:'gid://shopify/AppInstallation/1073784553583',app:{id:APP,apiKey:CLIENT},active:field(canonical(release)),catalog:field(JSON.stringify(catalog)),fence:field(randomUUID(),'single_line_text_field')}};
 const archives=new Map(),writes=[];
 let passes=0;
 const mock={data,catalog,release,drafts:structuredClone(release.config),archives,writes,changeDrafts:false,reject:false,
  beforeWrite:null,afterWrite:null,beforeRead:null,archiveRead:null,
  async api(query,variables={}) {
   if(query.includes('mutation')) {
    const fields=structuredClone(variables.fields);writes.push(fields);
    if(mock.beforeWrite)await mock.beforeWrite(fields);
    const get=key=>key==='authority'?data.shop.authority:key==='active_config'?data.currentAppInstallation.active:key==='price_catalog'?data.currentAppInstallation.catalog:key==='authority_fence'?data.currentAppInstallation.fence:archives.get(key);
    if(mock.reject || fields.some(f=>f.compareDigest!==(get(f.key)?.compareDigest??null)))return {metafieldsSet:{userErrors:[{code:'STALE_OBJECT'}]}};
    for(const f of fields) {
     const expected=f.key==='authority'?data.shop.id:data.currentAppInstallation.id;
     if(f.ownerId!==expected || !Object.hasOwn(f,'compareDigest'))throw Error('Mock scope/CAS violation');
    }
    for(const f of fields) {
     const next={...get(f.key),...field(f.value,f.type)};
     if(f.key==='authority')data.shop.authority=next;
     else if(f.key==='active_config')data.currentAppInstallation.active=next;
     else if(f.key==='price_catalog')data.currentAppInstallation.catalog=next;
     else if(f.key==='authority_fence')data.currentAppInstallation.fence=next;
     else archives.set(f.key,next);
    }
    if(mock.afterWrite)await mock.afterWrite(fields);
    return {metafieldsSet:{userErrors:[],metafields:fields.map(f=>({key:f.key,compareDigest:hash(f.value)}))}};
   }
   if(query.includes('query Drafts')) {
    const group=Object.keys(groupTypes).find(g=>groupTypes[g]===variables.type);if(group==='packages')passes++;
    return {metaobjects:{nodes:mock.drafts[group].map(r=>({id:r.id,handle:r.id,type:variables.type,updatedAt:mock.changeDrafts?String(passes):'stable',fields:encodeRecord(r)})),pageInfo:{hasNextPage:false}}};
   }
   if(query.includes('Archive')) {
    if(mock.archiveRead)await mock.archiveRead();
    return {shop:{myshopifyDomain:data.shop.myshopifyDomain},currentAppInstallation:{id:data.currentAppInstallation.id,app:data.currentAppInstallation.app,metafield:structuredClone(archives.get(variables.key)??null)}};
   }
   if(mock.beforeRead)await mock.beforeRead();
   return structuredClone(data);
  },
  replace(key,value) { data.currentAppInstallation[key]=field(value); },
 };
 return mock;
}
