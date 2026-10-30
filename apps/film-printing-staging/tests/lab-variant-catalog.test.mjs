import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {canonical} from '../configuration/config.mjs';
import {VARIANT,VARIANTS_BY_LAB} from '../checkout/authority.js';
import {sha256} from '../pricing/prepare.mjs';
import {applyLabVariantRouting,validateLabVariantMapping,LAB_VARIANT_LABS} from '../pricing/lab-variant-catalog.mjs';
import {encodeFullProductCatalog,expandFullProductCatalog,isCompactProductCatalog,COMPACT_LAB_VARIANT_SCHEMA,MAX_CATALOG_BYTES} from '../pricing/compact-catalog.mjs';
import {isLabVariantCatalog,resolveSelection} from '../jobs/selection.mjs';

const oldBytes=readFileSync(new URL('../../../fixtures/film-printing/full-product-readiness-20261030/engineering-catalog-proposal.json',import.meta.url),'utf8');
const old=JSON.parse(oldBytes),historical=expandFullProductCatalog(old),form=old.form_value;
const map=VARIANTS_BY_LAB;
validateLabVariantMapping(map);
const routed=applyLabVariantRouting(historical,map);
const pricedHistorical={...historical,version:'price-'+sha256(oldBytes)},pricedRouted={...routed,version:'price-'+sha256(canonical(routed))};
const withoutRouting=c=>{const copy=structuredClone(c);delete copy.product_semantics.variant_routing;for(const row of [...copy.rows,...copy.custom_rules])row.variant_id=VARIANT.split('/').at(-1);return copy;};
const encode=()=>encodeFullProductCatalog(routed,form);

test('historical v1 bytes, source provenance and price digest remain unchanged',()=>{
 assert.equal(sha256(oldBytes),'15244768b15749c1e7f533fcf82acdbe3f696570803d29c35d198f9ec24252ef');
 assert.equal(encodeFullProductCatalog(historical,form).value,oldBytes);
 assert.deepEqual(expandFullProductCatalog(old),historical);
 assert.equal(isLabVariantCatalog(historical),false);
});

test('pure routing changes only lab variant IDs and explicit semantic marker',()=>{
 assert.equal(isLabVariantCatalog(routed),true);
 assert.deepEqual(withoutRouting(routed),historical);
 assert.equal(routed.rows.filter(r=>r.service!=='darkroom').length,888);
 assert.equal(routed.rows.filter(r=>r.service==='darkroom').length,1296);
 assert.equal(routed.custom_rules.length,36);
 for(const row of [...routed.rows,...routed.custom_rules])assert.equal(row.variant_id,map[row.lab].split('/').at(-1));
 assert.ok(Object.isFrozen(routed.custom_rules[0].options));
});

test('every fixed/Darkroom price and every Custom rule resolve identically except variant and source version',()=>{
 const compare=(before,after,input,files)=>{
  const left=resolveSelection(before,input,{completedFileCount:files});
  const right=resolveSelection(after,input,{completedFileCount:files});
  assert.equal(right.variant_id,map[right.spec.lab].split('/').at(-1));
  for(const key of ['spec','file_count','billing_basis','per_unit_cents','unit_price_cents','total_price_cents'])assert.deepEqual(right[key],left[key]);
 };
 for(const row of routed.rows)compare(pricedHistorical,pricedRouted,{service:row.service,size:row.size,paper:row.paper_input,lab:row.lab_input,options:row.options,copies:1,message:''},row.service==='darkroom'?0:1);
 for(const row of routed.custom_rules)compare(pricedHistorical,pricedRouted,{service:row.service,size:'Custom',custom_dimensions:{width:20,height:16},paper:row.paper_input,lab:row.lab_input,options:row.options,copies:3,message:''},2);
});

test('mapping rejects missing, unknown or duplicate labs/IDs and malformed variants',()=>{
 const bad=[m=>{delete m.atlanta;},m=>{m.denver='gid://shopify/ProductVariant/999';},m=>{m.chicago=m.miami;},m=>{m.miami='67852705202287';},m=>{m.miami='gid://shopify/Location/123';},m=>{m.miami='gid://shopify/ProductVariant/0';}];
 for(const mutate of bad){const m=structuredClone(map);mutate(m);assert.throws(()=>applyLabVariantRouting(historical,m),/LAB_VARIANTS_UNVERIFIED/);}
 const unknown=structuredClone(historical);unknown.rows[0].lab='denver';assert.throws(()=>applyLabVariantRouting(unknown,map));
 assert.throws(()=>applyLabVariantRouting(routed,map));
});

test('v2 codec admits only complete exact authority map, and reconstructs the full source within field limit',()=>{
 const e=encode();assert.equal(e.catalog.wire_schema,COMPACT_LAB_VARIANT_SCHEMA);assert.equal(isCompactProductCatalog(e.catalog),true);
 assert.equal(Object.hasOwn(e.catalog,'variant_id'),false);assert.deepEqual(e.catalog.variants_by_lab,VARIANTS_BY_LAB);
 assert.ok(Buffer.byteLength(e.value)<16384&&Buffer.byteLength(e.value)<MAX_CATALOG_BYTES);
 assert.deepEqual(e.expanded,routed);assert.deepEqual(expandFullProductCatalog(JSON.parse(e.value)),routed);
 assert.equal(expandFullProductCatalog({...e.catalog,version:e.version}).version,e.version);
 assert.equal(e.catalog.expanded_sha256,sha256(canonical(routed)));
 assert.throws(()=>expandFullProductCatalog({...e.catalog,version:'price-'+sha256(oldBytes)}),/PRICE_VERSION_MISMATCH/);
});

test('v2 rejects wire map tampering, prices/options/custom formula edits and mutable input cache poisoning',()=>{
 const encoded=encode();
 for(const mutate of [c=>{delete c.variants_by_lab;},c=>{c.variant_id=old.variant_id;},c=>{c.variants_by_lab.atlanta=c.variants_by_lab.miami;},
  c=>{c.variants_by_lab.atlanta='gid://shopify/ProductVariant/99987654321';},c=>{c.variants_by_lab.denver='gid://shopify/ProductVariant/123';},
  c=>{c.product_semantics.variant_routing='browser';},c=>{c.wire_schema='bfl-full-product-catalog-v1';},c=>{c.labs[1].lab='atlanta';},
  c=>{c.expanded_sha256='0'.repeat(64);},c=>{c.form_value+=' ';},c=>{c.rows=[];}]){
  const changed=structuredClone(encoded.catalog);mutate(changed);assert.throws(()=>expandFullProductCatalog(changed));
 }
 for(const mutate of [c=>{c.rows[0].per_file_cents=1;},c=>{c.rows[0].variant_id='1';},c=>{c.rows[0].options.Turnaround='Free';},
  c=>{c.custom_rules[0].formula.area_mills=1;},c=>{c.custom_rules[0].variant_id='1';},c=>{c.rows.pop();},c=>{c.extra='browser';}]){
  const changed=structuredClone(routed);mutate(changed);assert.throws(()=>encodeFullProductCatalog(changed,form));
 }
 const mutable=JSON.parse(encoded.value);expandFullProductCatalog(mutable);mutable.variants_by_lab.atlanta='gid://shopify/ProductVariant/123';assert.throws(()=>expandFullProductCatalog(mutable));
});
