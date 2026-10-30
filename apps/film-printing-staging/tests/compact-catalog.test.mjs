import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {canonical} from '../configuration/config.mjs';
import {sha256} from '../pricing/prepare.mjs';
import {extendProductCatalog} from '../pricing/product-catalog.mjs';
import {encodeFullProductCatalog,expandFullProductCatalog,isCompactProductCatalog,MAX_CATALOG_BYTES} from '../pricing/compact-catalog.mjs';
import {resolveSelection} from '../jobs/selection.mjs';

const source=new URL('../../../fixtures/film-printing/f05a/',import.meta.url);
const form=readFileSync(new URL('metafield-value.json',source),'utf8');
const original=JSON.parse(readFileSync(new URL('proposed/price-catalog.proposed.json',source),'utf8'));
// Only canonical label expansion is tested here. No live location facts or
// admission pins are created by this local test fixture.
const mapped={...original,rows:['Miami','Chicago','Orlando','Atlanta'].flatMap(lab=>original.rows.map(row=>({...row,lab:lab.toLowerCase(),lab_input:lab})))};
const full=extendProductCatalog(mapped,form),encoded=encodeFullProductCatalog(full.catalog,form);

test('compact wire stays below Shopify JSON limit and regenerates every exact row/rule',()=>{
  assert.ok(Buffer.byteLength(full.value)>MAX_CATALOG_BYTES);
  assert.ok(Buffer.byteLength(encoded.value)<16384);
  assert.equal(isCompactProductCatalog(encoded.catalog),true);
  assert.equal(encoded.version,'price-'+sha256(encoded.value));
  assert.deepEqual(expandFullProductCatalog(JSON.parse(encoded.value)),full.catalog);
  assert.deepEqual(encoded.expanded,full.catalog);
  assert.equal(encoded.catalog.expanded_sha256,sha256(full.value));
  assert.deepEqual(encodeFullProductCatalog(full.catalog,form),encoded);
  assert.equal(Object.hasOwn(encoded.catalog,'rows'),false);
  assert.equal(Object.hasOwn(original,'wire_schema'),false);
});

test('loader runtime version remains the compact source digest, including resolved job prices',()=>{
  const restored=expandFullProductCatalog({...JSON.parse(encoded.value),version:encoded.version});
  assert.equal(restored.version,encoded.version);
  assert.ok(Object.isFrozen(restored.rows[0].options));
  for(const row of restored.rows){
    const input={service:row.service,size:row.size,paper:row.paper_input,lab:row.lab_input,options:row.options,copies:1,message:''};
    const files=row.service==='darkroom'?0:1;
    const actual=resolveSelection(restored,input,{completedFileCount:files});
    assert.equal(actual.unit_price_cents,row.per_file_cents??row.per_specification_cents);
    assert.equal(actual.price_version,encoded.version);
  }
  assert.throws(()=>expandFullProductCatalog({...encoded.catalog,version:full.version}),/PRICE_VERSION_MISMATCH/);
});

test('compact encoding rejects altered expanded prices, options, lab mapping and row sets',()=>{
  for(const mutate of [c=>{c.rows[0].per_file_cents=1;},c=>{c.rows.pop();},c=>{c.rows[0].options.Turnaround='Free';},
    c=>{c.rows[0].lab='unmapped';},c=>{c.rows[0].variant_id='1';},c=>{c.custom_rules[0].formula.area_mills=1;},
    c=>{c.product_semantics.custom_formula='browser';},c=>{c.extra='unreviewed';}]){
    const changed=structuredClone(full.catalog);mutate(changed);assert.throws(()=>encodeFullProductCatalog(changed,form));
  }
});

test('wire cannot authorize self-reported form prices, unknown fields, versions or mappings',()=>{
  for(const mutate of [c=>{c.expanded_sha256='0'.repeat(64);},c=>{c.form_value+=' ';},
    c=>{const f=JSON.parse(c.form_value);f['Photo Prints'].Sizes.options[0].price=0.01;c.form_value=JSON.stringify(f);c.provenance.capture.metafield.sha256=sha256(c.form_value);},
    c=>{c.labs[0].lab='chicago';},c=>{c.labs.push({input:'Denver',lab:'denver'});},c=>{c.variant_id='1';},
    c=>{c.rows=[];},c=>{c.wire_schema='future';},c=>{c.product_semantics.darkroom_billing='per_file';},
    c=>{c.provenance.source_version='0'.repeat(64);},c=>{c.provenance.capture.theme.script_sha256='0'.repeat(64);},
    c=>{c.provenance.capture.extra='x'.repeat(MAX_CATALOG_BYTES);}]){
    const changed=structuredClone(encoded.catalog);mutate(changed);assert.throws(()=>expandFullProductCatalog(changed));
  }
});

test('mutable input never creates stale cached expanded authority',()=>{
  const wire=JSON.parse(encoded.value),first=expandFullProductCatalog(wire);
  wire.form_value+=' ';assert.throws(()=>expandFullProductCatalog(wire));
  assert.equal(canonical(first),full.value);
});
