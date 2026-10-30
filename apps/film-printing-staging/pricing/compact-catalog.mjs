// Server/operator codec only. Compact bytes still require authenticated Admin
// custody and the existing exact-source pin before use. This is not an import
// endpoint, a merchant decision, or a source of location/packing authority.
import {canonical,freeze} from '../configuration/config.mjs';
import {STORE} from '../configuration/schema.mjs';
import {requireValue as need} from '../shipping/packing.mjs';
import {buildFixedCatalogRows,validateForm,sha256,SEMANTICS,LABS} from './prepare.mjs';
import {extendProductCatalog} from './product-catalog.mjs';
import {FULL_PRODUCT_VERSION,CUSTOM_FORMULA_VERSION,DARKROOM_BILLING_VERSION,LAB_VARIANT_VERSION,isLabVariantCatalog} from '../jobs/selection.mjs';
import {VARIANTS_BY_LAB} from '../checkout/authority.js';
import {applyLabVariantRouting,validateLabVariantMapping} from './lab-variant-catalog.mjs';

export const COMPACT_PRODUCT_SCHEMA='bfl-full-product-catalog-v1';
export const COMPACT_LAB_VARIANT_SCHEMA='bfl-full-product-catalog-v2';
export const MAX_CATALOG_BYTES=128*1024;
const verifiedExpansions=new WeakMap();
const deeplyFrozen=value=>value===null||typeof value!=='object'||Object.isFrozen(value)&&Object.values(value).every(deeplyFrozen);
// Exact authenticated F05A form, also read back unchanged on 30 October.
const FORM='9d3131ef27637a2031de72ab2c96d0d9570928ceb4aba24fe6fdeb1dae0056d1';
const VARIANT='67852705202287';
const semanticVersions=(routed=false)=>({version:FULL_PRODUCT_VERSION,custom_formula:CUSTOM_FORMULA_VERSION,darkroom_billing:DARKROOM_BILLING_VERSION,...(routed?{variant_routing:LAB_VARIANT_VERSION}:{})});
const KEYS=['wire_schema','store','currency','provenance','product_semantics','variant_id','labs','form_value','expanded_sha256'];
const V2_KEYS=KEYS.map(k=>k==='variant_id'?'variants_by_lab':k);
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v,keys)=>object(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const same=(a,b)=>canonical(a)===canonical(b);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export const isCompactProductCatalog=catalog=>catalog?.wire_schema===COMPACT_PRODUCT_SCHEMA||catalog?.wire_schema===COMPACT_LAB_VARIANT_SCHEMA;

function regenerate(wire){
  const p=wire.provenance,c=p?.capture;
  const routed=wire.wire_schema===COMPACT_LAB_VARIANT_SCHEMA;
  need(wire.store===STORE&&wire.currency==='USD'&&same(wire.product_semantics,semanticVersions(routed)),'PRICE_UNAVAILABLE');
  if(routed){
    validateLabVariantMapping(VARIANTS_BY_LAB);validateLabVariantMapping(wire.variants_by_lab);
    need(same(wire.variants_by_lab,VARIANTS_BY_LAB),'LAB_VARIANTS_UNVERIFIED');
  }else need(wire.variant_id===VARIANT,'PRICE_UNAVAILABLE');
  need(typeof wire.form_value==='string'&&sha256(wire.form_value)===FORM&&
    exact(p,['semantics','source_version','capture','mapping_sha256'])&&p.semantics===SEMANTICS&&
    c?.metafield?.sha256===FORM&&hash(p.mapping_sha256)&&
    p.source_version===sha256(canonical({metafield:c.metafield,theme:c.theme,semantics:SEMANTICS})),'SOURCE_REFRESH_CHANGED_OR_EXPIRED');
  need(Array.isArray(wire.labs)&&wire.labs.length===LABS.length&&wire.labs.every((lab,i)=>
    exact(lab,['input','lab'])&&lab.input===LABS[i]&&lab.lab===LABS[i].toLowerCase()),'PRICE_UNAVAILABLE');
  const form=validateForm(wire.form_value),mapping={variant_id:VARIANT,labs:wire.labs,
    photo_paper:{paper:'photo-premium-luster'},
    fine_art_papers:form['Fine Arts'].Paper.options.map(p=>({input:p.label,paper:p.label.toLowerCase().replaceAll(' ','-')}))};
  const {rows}=buildFixedCatalogRows(form,mapping);
  const fixed={store:STORE,currency:'USD',provenance:structuredClone(p),rows};
  const expanded=extendProductCatalog(fixed,wire.form_value).catalog;
  return routed?applyLabVariantRouting(expanded,VARIANTS_BY_LAB):expanded;
}

export function expandFullProductCatalog(compact){
  // Only immutable, fully verified source objects may reuse an expansion. A
  // frozen outer object with mutable descendants must still be revalidated.
  if(verifiedExpansions.has(compact))return verifiedExpansions.get(compact);
  const hasVersion=Object.hasOwn(compact??{},'version');
  const keys=compact?.wire_schema===COMPACT_LAB_VARIANT_SCHEMA?V2_KEYS:KEYS;
  need(isCompactProductCatalog(compact)&&exact(compact,hasVersion?[...keys,'version']:keys),'PRICE_UNAVAILABLE');
  const {version,...wire}=compact;
  const value=canonical(wire);
  need(Buffer.byteLength(value)<=MAX_CATALOG_BYTES,'CATALOG_SIZE');
  need(!hasVersion||version==='price-'+sha256(value),'PRICE_VERSION_MISMATCH');
  need(hash(wire.expanded_sha256),'PRICE_UNAVAILABLE');
  const expanded=regenerate(wire);
  need(sha256(canonical(expanded))===wire.expanded_sha256,'CATALOG_EXPANSION_MISMATCH');
  const result=freeze({...expanded,...(hasVersion?{version}: {})});
  if(deeplyFrozen(compact))verifiedExpansions.set(compact,result);
  return result;
}

export function encodeFullProductCatalog(expanded,formValue){
  need(object(expanded)&&Array.isArray(expanded.rows)&&expanded.rows.length===2184&&
    Array.isArray(expanded.custom_rules)&&expanded.custom_rules.length===36,'PRICE_UNAVAILABLE');
  const {version,...source}=expanded,routed=isLabVariantCatalog(source);
  if(routed)validateLabVariantMapping(VARIANTS_BY_LAB);
  const labs=LABS.map(input=>{
    const selected=source.rows.filter(r=>r.lab_input===input);
    const variant=routed?VARIANTS_BY_LAB[input.toLowerCase()].split('/').at(-1):VARIANT;
    need(selected.length>0&&selected.every(r=>r.lab===input.toLowerCase()&&r.variant_id===variant),'PRICE_UNAVAILABLE');
    return {input,lab:input.toLowerCase()};
  });
  const catalog={wire_schema:routed?COMPACT_LAB_VARIANT_SCHEMA:COMPACT_PRODUCT_SCHEMA,store:source.store,currency:source.currency,
    provenance:structuredClone(source.provenance),product_semantics:structuredClone(source.product_semantics),
    ...(routed?{variants_by_lab:structuredClone(VARIANTS_BY_LAB)}:{variant_id:VARIANT}),
    labs,form_value:formValue,expanded_sha256:sha256(canonical(source))};
  // Rebuilding and comparing every row rejects edited prices, missing rows,
  // invented options and extra metadata before a compact value can be reviewed.
  const regenerated=expandFullProductCatalog(catalog);
  need(same(regenerated,source),'CATALOG_EXPANSION_MISMATCH');
  const value=canonical(catalog);
  return freeze({catalog,value,version:'price-'+sha256(value),expanded:regenerated});
}
