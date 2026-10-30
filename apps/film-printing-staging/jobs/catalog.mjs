import {createHash} from 'node:crypto';
import {ACTIVE_QUERY,assertIdentity} from '../configuration/shopify.mjs';
import {STORE} from '../configuration/schema.mjs';
import {requireValue} from '../shipping/packing.mjs';
import {freeze} from '../configuration/config.mjs';
import {assertEngineeringCatalog} from '../configuration/engineering.mjs';
import {createAuthorityAdmin,decodeCatalog} from '../checkout/shopify.mjs';
import {isCompactProductCatalog,expandFullProductCatalog} from '../pricing/compact-catalog.mjs';
import {isFullProductCatalog,resolveSelection} from './selection.mjs';
// Authenticated Admin transport only. No storefront JSON/price inputs are substituted.
// This separate app-private price catalog is intentionally NOT populated by F05.
export function createPriceCatalogLoader(api,{sourceScope}={}) {
 return async()=>{
  assertIdentity(await api(ACTIVE_QUERY));
  const data=await api('query F05PriceCatalog { currentAppInstallation { metafield(namespace:"bfl_printing",key:"price_catalog") { type value } } }');
  const field=data.currentAppInstallation?.metafield;
  requireValue(field?.type==='json','PRICE_UNAVAILABLE');
  if(sourceScope)assertEngineeringCatalog(sourceScope,field.value);
  let catalog;try{catalog=JSON.parse(field.value);}catch{throw Error('Invalid private catalog');}
  catalog={...catalog,version:'price-'+createHash('sha256').update(field.value).digest('hex')};
  if(isCompactProductCatalog(catalog))catalog=expandFullProductCatalog(catalog);
  requireValue(catalog?.store===STORE && catalog.currency==='USD' && Array.isArray(catalog.rows),'PRICE_UNAVAILABLE');
  return freeze(catalog);
 };
}

// Internal operator path only. Receives approved catalog bytes, never DOM prices;
// absent real pricing stays absent. Initial creation uses compareDigest:null.
export function validatePriceCatalog(value) {
 const catalog=decodeCatalog(value);
 if(isFullProductCatalog(catalog)){
   for(const row of catalog.rows)resolveSelection(catalog,{...row,copies:1,message:''},{completedFileCount:row.service==='darkroom'?0:1,canonicalInput:true});
   for(const row of catalog.custom_rules)resolveSelection(catalog,{...row,size:'1x1',size_mode:'custom',custom_dimensions:{width:1,height:1},copies:1,message:''},{completedFileCount:1,canonicalInput:true});
   return catalog;
 }
 requireValue(catalog.rows.every(r=>typeof r.enabled==='boolean' && typeof r.physical==='boolean' &&
   /^\d+$/.test(r.variant_id) && ['photo','fine_art'].includes(r.service) && /^\d+(?:\.\d+)?x\d+(?:\.\d+)?$/.test(r.size) &&
   typeof r.paper==='string' && r.paper.length>0 && typeof r.lab==='string' && r.lab.length>0 &&
   Number.isSafeInteger(r.per_file_cents) && r.per_file_cents>0 && r.per_file_cents<=200000),'PRICE_UNAVAILABLE');
 return catalog;
}
export async function publishPriceCatalog(api,value,{writesEnabled=false,lifecycle,now}={}) {
 requireValue(writesEnabled,'AUTHORITY_WRITES_DISABLED');
 requireValue(lifecycle,'LIFECYCLE_REQUIRED');
 validatePriceCatalog(value);
 const admin=createAuthorityAdmin(api,{writesEnabled,lifecycle,now});
 const context=await admin.read({allowMissingCatalog:true});
 return admin.cutover({context,catalogValue:value});
}
