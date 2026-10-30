import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {prepareCatalog,sha256} from '../pricing/prepare.mjs';
import {prepareFixedEngineering} from '../pricing/fixed-engineering.mjs';
import {canonical,digest,validateConfig} from '../configuration/config.mjs';
import {prepareEngineeringSources,createEngineeringScope,bindEngineeringCustomerJob,assertEngineeringJob} from '../configuration/engineering.mjs';
import {mockAdmin} from '../../../fixtures/film-printing/f06d/mock-admin.mjs';
import {engineeringJobSpecification} from '../configuration/engineering-job.mjs';
import {legacyHarness} from '../../../fixtures/film-printing/f05a/legacy-price.mjs';
const source=new URL('../../../fixtures/film-printing/f05a/',import.meta.url);
const read=name=>readFileSync(new URL(name,source),'utf8');
const packingRelease=JSON.parse(readFileSync(new URL('../../../fixtures/film-printing/f03/release-2.json',import.meta.url))).release;
function input(){
 const mapping=JSON.parse(read('reviewed-mapping.json'));
 mapping.status='reviewed_staging_test_lab_mapping';
 // Deliberately synthetic readback for local validation mechanics. These IDs
 // are never source-pinned, published or claimed to exist in Shopify.
 mapping.labs=['Miami','Chicago','Orlando','Atlanta'].map((input,i)=>({input,lab:input.toLowerCase(),
   location_id:i?'9990000000'+i:'92443803759',evidence:'Generated local test evidence; not a remote verification'}));
 mapping.location_readback={schema:1,capture_method:'authenticated_shopify_admin_read_only',captured_at:'2026-10-30T00:00:00Z',
   store:mapping.store,product_id:mapping.product_id,variant_id:mapping.variant_id,locations:mapping.labs.map(l=>({lab:l.lab,location_id:l.location_id,
     active:true,fulfills_online_orders:true,variant_available:true,evidence:l.evidence,
     origin:{address1:'Generated TEST origin',address2:'',city:'Generated',province_code:'FL',country_code:'US',postal_code:'33127'}}))};
 return {capture:JSON.parse(read('source-export.json')),metafieldValue:read('metafield-value.json'),script:read('source/film-service.js'),section:read('source/film-printing.liquid'),mapping};
}
const prepare=()=>prepareFixedEngineering({pricingInput:input(),packingRelease});

test('fixed staging preparation derives all888 prices and28 exact selectors without promoting physical evidence',()=>{
 const p=prepare();assert.equal(p.catalog.rows.length,888);assert.equal(p.config.rules.length,28);assert.equal(p.config.packages.length,6);
 assert.deepEqual(p,prepare());assert.equal(p.formValue,read('metafield-value.json'));
 assert.equal(new Set(p.catalog.rows.map(r=>canonical([r.service,r.size,r.paper,r.lab,r.options]))).size,888);
 for(const lab of ['miami','chicago','orlando','atlanta'])assert.equal(p.catalog.rows.filter(r=>r.lab===lab).length,222);
 for(const rule of p.config.rules){
  const original=packingRelease.config.rules.find(r=>r.service===rule.service&&r.size_key===rule.size_key&&r.lab==='all_labs');
  for(const key of ['capacity','capacity_status','print_weight_oz','weight_status','package_id'])assert.equal(rule[key],original[key]);
  assert.ok(rule.paper);assert.equal(rule.enabled,true);assert.match(rule.provenance.evidence,/engineering tests only/);
 }
 for(const pkg of p.config.packages){
  const original=packingRelease.config.packages.find(x=>x.id===pkg.id);
  for(const key of ['length_in','width_in','height_in','empty_weight_oz','dimensions_status','weight_status'])assert.equal(pkg[key],original[key]);
 }
 assert.ok(p.config.labs.every(l=>l.origin_status==='staging_address_only'));
 assert.ok(p.config.policies.every(p=>p.enabled===false));assert.equal(p.review.admitted,false);
 assert.equal(p.review.config_sha256,digest(p.config));assert.equal(p.review.catalog_sha256,digest(p.catalog));
 assert.throws(()=>validateConfig(p.config),/unconfirmed package/);
 // A valid candidate and its self-reported hash do not admit a private scope.
 assert.throws(()=>prepareEngineeringSources({config:p.config,catalog:p.catalog,issuedAt:1,until:1000}),/ENGINEERING_SOURCE/);
});

test('four-lab mapping rejects invented aliases, duplicate IDs, alternate identity, inactive/unavailable variant and incomplete readback',()=>{
 const changes=[m=>{delete m.location_readback;},m=>{m.labs[1].input='Denver';},m=>{m.labs[1].lab='all_labs';},
  m=>{m.labs[1].location_id=m.labs[0].location_id;},m=>{m.labs[3].location_id='92446294127';},m=>{m.labs[0].location_id='999';},
  m=>{m.labs.pop();},m=>{m.location_readback.locations[1].active=false;},m=>{m.location_readback.locations[1].fulfills_online_orders=false;},
  m=>{m.location_readback.locations[1].variant_available=false;},m=>{m.location_readback.locations.pop();},
  m=>{m.location_readback.locations[1].origin.country_code='AU';},m=>{m.location_readback.variant_id='1';},
  m=>{m.location_readback.capture_method='browser_claim';},m=>{m.location_readback.captured_at='never';},m=>{m.source_sha256='0'.repeat(64);}];
 for(const mutate of changes){const i=input();mutate(i.mapping);assert.throws(()=>prepareCatalog(i));}
 const i=input();i.mapping.status='reviewed_staging_identity_mapping_only';assert.throws(()=>prepareCatalog(i));
});

test('fixed full catalog matches captured merchant pricing for every selection and actual file/copy multiplication',()=>{
 const i=input(),p=prepareCatalog(i),form=JSON.parse(i.metafieldValue);
 for(const selected of p.selections){
  const priced=legacyHarness(i.script,form,selected,{files:1,copies:2}).price;
  assert.equal(priced.unitCents,selected.per_file_cents);assert.equal(Math.round(priced.total*100),selected.per_file_cents*2);
 }
});

test('all fixed rows use unique exact catalog prices in immutable job verification, with altered claims rejected',()=>{
 const p=prepare(),catalog={...p.catalog,version:'price-'+sha256(canonical(p.catalog))};
 for(const row of catalog.rows){
  const job={service:row.service,size:row.size,paper:row.paper,lab:row.lab,options:row.options,message:'Client test note',copies:2,
    completed_asset_ids:['asset-local-1'],unit_price_cents:row.per_file_cents,variant_id:row.variant_id};
  assert.match(engineeringJobSpecification(catalog,job,1),/^[a-f0-9]{64}$/);
  assert.throws(()=>engineeringJobSpecification(catalog,{...job,unit_price_cents:job.unit_price_cents+1},1),/ENGINEERING_JOB/);
  assert.throws(()=>engineeringJobSpecification(catalog,{...job,lab:'unmapped'},1),/ENGINEERING_JOB/);
 }
 const row=catalog.rows[0],job={service:row.service,size:row.size,paper:row.paper,lab:row.lab,options:row.options,message:'',copies:1,
   completed_asset_ids:['asset-local-1'],unit_price_cents:row.per_file_cents,variant_id:row.variant_id};
 assert.throws(()=>engineeringJobSpecification({...catalog,rows:[...catalog.rows,row]},job,1),/ENGINEERING_JOB/);
 assert.throws(()=>engineeringJobSpecification(catalog,{...job,variant_id:'1'},1),/ENGINEERING_JOB/);
 assert.throws(()=>engineeringJobSpecification(catalog,{...job,billing_basis:'specification'},1),/ENGINEERING_JOB/);
 assert.throws(()=>engineeringJobSpecification(catalog,job,0),/ENGINEERING_JOB/);
});

test('changed packing observation or source provenance cannot silently enter the fixed engineering candidate',()=>{
 const changed=structuredClone(packingRelease);changed.config.rules.find(r=>r.size_key==='4x6').print_weight_oz=99;
 changed.sha256=digest(changed.config);changed.version='f03-'+changed.sha256.slice(0,24);
 assert.throws(()=>prepareFixedEngineering({pricingInput:input(),packingRelease:changed}),/PACKING_SOURCE_CHANGED/);
 const i=input();i.metafieldValue+=' ';assert.throws(()=>prepareFixedEngineering({pricingInput:i,packingRelease}),/SOURCE_HASH/);
});


test('legacy private scope retains owner/files/copies/note/expiry guards with catalog-derived pricing',()=>{
 const fixture=name=>JSON.parse(readFileSync(new URL('../../../fixtures/film-printing/f06p-integration/'+name,import.meta.url)));
 let now=1000;
 const prepared=prepareEngineeringSources({config:fixture('engineering-config-proposal.json'),catalog:fixture('engineering-catalog-proposal.json'),issuedAt:now,until:2000});
 const scope=createEngineeringScope({...prepared,identity:mockAdmin().data,now:()=>now});
 const job={service:'photo',size:'4x6',paper:'engineering-f06p-paper',lab:'miami',options:{},message:'',copies:2,
   completed_asset_ids:['asset-local-1'],unit_price_cents:40,variant_id:'67852705202287'};
 bindEngineeringCustomerJob(scope,'owner-1',job.completed_asset_ids,2,job);assertEngineeringJob(scope,'owner-1',job);
 for(const changed of [{...job,message:'not accepted by historical source contract'}, {...job,unit_price_cents:1},
   {...job,copies:3},{...job,lab:'chicago'},{...job,completed_asset_ids:['asset-other-1']}])assert.throws(()=>assertEngineeringJob(scope,'owner-1',changed),/ENGINEERING_JOB/);
 assert.throws(()=>assertEngineeringJob(scope,'owner-2',job),/ENGINEERING_JOB/);
 assert.throws(()=>bindEngineeringCustomerJob(scope,'owner-2',job.completed_asset_ids,2,job),/ENGINEERING_ASSETS/);
 now=2000;assert.throws(()=>assertEngineeringJob(scope,'owner-1',job),/ENGINEERING_EXPIRED/);
});
