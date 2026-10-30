// Pure operator preparation, not admission or evidence that a variant exists.
// Compact v2 separately requires the exact authenticated authority map, and
// normal runtime admission still requires the reviewed config/catalog pins.
import {canonical,freeze} from '../configuration/config.mjs';
import {requireValue as need} from '../shipping/packing.mjs';
import {VARIANT,VARIANTS_BY_LAB} from '../checkout/authority.js';
import {FULL_PRODUCT_VERSION,CUSTOM_FORMULA_VERSION,DARKROOM_BILLING_VERSION,LAB_VARIANT_VERSION} from '../jobs/selection.mjs';

export const LAB_VARIANT_LABS=Object.freeze(['miami','chicago','orlando','atlanta']);
const same=(a,b)=>canonical(a)===canonical(b);
export function validateLabVariantMapping(mapping){
  need(mapping&&typeof mapping==='object'&&!Array.isArray(mapping)&&
    same(Object.keys(mapping).sort(),[...LAB_VARIANT_LABS].sort())&&
    Object.values(mapping).every(id=>typeof id==='string'&&/^gid:\/\/shopify\/ProductVariant\/[1-9]\d*$/.test(id))&&
    new Set(Object.values(mapping)).size===4,'LAB_VARIANTS_UNVERIFIED');
  return mapping;
}
export function applyLabVariantRouting(catalog,variantsByLab=VARIANTS_BY_LAB){
  validateLabVariantMapping(variantsByLab);
  need(catalog&&same(catalog.product_semantics,{version:FULL_PRODUCT_VERSION,
    custom_formula:CUSTOM_FORMULA_VERSION,darkroom_billing:DARKROOM_BILLING_VERSION})&&
    Array.isArray(catalog.rows)&&catalog.rows.length===2184&&
    catalog.rows.filter(r=>r.service==='darkroom').length===1296&&
    Array.isArray(catalog.custom_rules)&&catalog.custom_rules.length===36,'PRICE_UNAVAILABLE');
  const route=row=>{
    need(LAB_VARIANT_LABS.includes(row.lab)&&typeof row.lab_input==='string'&&row.lab_input.toLowerCase()===row.lab&&
      row.variant_id===VARIANT.split('/').at(-1),'PRICE_UNAVAILABLE');
    return {...structuredClone(row),variant_id:variantsByLab[row.lab].split('/').at(-1)};
  };
  const {version,...source}=structuredClone(catalog);
  return freeze({...source,product_semantics:{...source.product_semantics,variant_routing:LAB_VARIANT_VERSION},
    rows:source.rows.map(route),custom_rules:source.custom_rules.map(route)});
}
