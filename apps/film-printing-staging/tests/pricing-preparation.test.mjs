import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {prepareCatalog,verifyPreparedCatalog,parseStrictJson,validateForm,cents,perFileCents,sha256} from '../pricing/prepare.mjs';
import {createJobStore,createJobService} from '../jobs/service.mjs';
import {createPriceCatalogLoader,publishPriceCatalog} from '../jobs/catalog.mjs';
import {createAuthorityAdmin,decodeCatalog} from '../checkout/shopify.mjs';
import {createCheckoutProjector} from '../checkout/projector.mjs';
import {createAdminTransport} from '../backend/admin.mjs';
import {STORE,APP,CLIENT} from '../configuration/schema.mjs';
import {SHOP,INSTALLATION} from '../backend/config.mjs';
import {PRODUCT,VARIANT} from '../checkout/authority.js';
import {active,syntheticRelease} from '../../../fixtures/film-printing/f04/synthetic.mjs';
import {mockAdmin,now} from '../../../fixtures/film-printing/f06d/mock-admin.mjs';
import {legacyHarness} from '../../../fixtures/film-printing/f05a/legacy-price.mjs';
const root=new URL('../../../fixtures/film-printing/f05a/',import.meta.url);
const read=name=>readFileSync(new URL(name,root),'utf8');
const input=()=>({capture:parseStrictJson(read('source-export.json')),metafieldValue:read('metafield-value.json'),script:read('source/film-service.js'),section:read('source/film-printing.liquid'),mapping:parseStrictJson(read('reviewed-mapping.json'))});
const prepared=prepareCatalog(input());
function changed(change) {const i=input(),form=JSON.parse(i.metafieldValue);change(form);i.metafieldValue=JSON.stringify(form);i.capture.metafield.sha256=sha256(i.metafieldValue);i.mapping.source_sha256=i.capture.metafield.sha256;return i;}
function jobsFixture(t,catalog=decodeCatalog(prepared.value),release=active) {
  const store=createJobStore(':memory:');t.after(()=>store.close());let current=catalog;
  for(let i=1;i<=3;i++)store.recordUpload('offline-owner',{id:`asset-000${i}`,state:'complete',verified:true,url:`https://example.invalid/${i}`});
  const jobs=createJobService({store,loader:{load:async()=>release},loadCatalog:async()=>current,secret:'f05a-offline-test-only-secret-not-real'});
  return {jobs,store,replace:c=>{current=c;}};
}
const request=(s,key='f05a-request-0001',files=1,copies=1)=>({...s,request_key:key,asset_ids:Array.from({length:files},(_,i)=>`asset-000${i+1}`),copies});

test('F05A current authenticated source creates 222 exact proposed rows, preserved form bytes and unavailable paths',()=>{
  assert.equal(prepared.catalog.rows.length,222);assert.equal(prepared.catalog.rows.filter(r=>r.service==='photo').length,15);
  assert.equal(prepared.formValue,read('metafield-value.json'));assert.equal(prepared.formValue,read('proposed/film-services.proposed.json'));
  assert.equal(prepared.value,read('proposed/price-catalog.proposed.json'));assert.equal(prepared.diagnostics.checkout_ready,false);
  assert.deepEqual(prepared.diagnostics.unsupported,['Fine Arts / Custom','Darkroom Prints','Unmapped lab / Chicago','Unmapped lab / Orlando','Unmapped lab / Atlanta']);
  assert.ok(prepared.catalog.rows.every(r=>r.lab==='miami' && r.variant_id==='67852705202287'));
  assert.ok(prepared.catalog.rows.filter(r=>r.service==='photo').every(r=>r.paper_input===null && !Object.hasOwn(r.options,'Borders')));
});
test('F05A preparation is deterministic; source, capture and mapping changes produce immutable content versions',()=>{
  assert.deepEqual(prepareCatalog(input()),prepared);
  assert.deepEqual(prepareCatalog(input(),prepared.catalog).diagnostics.change,{source_changed:false,mapping_changed:false,catalog_changed:false});
  const next=prepareCatalog(changed(f=>{f['Photo Prints'].Sizes.options[0].price=0.6;}),prepared.catalog);
  assert.notEqual(next.version,prepared.version);assert.equal(next.diagnostics.change.source_changed,true);
  const i=input();i.capture.captured_at='2026-10-21T03:12:00Z';const recapture=prepareCatalog(i,prepared.catalog);
  assert.equal(recapture.diagnostics.change.source_changed,false);assert.notEqual(recapture.version,prepared.version);
  const j=input();j.mapping.evidence+=' reviewed';const remap=prepareCatalog(j,prepared.catalog);
  assert.equal(remap.diagnostics.change.mapping_changed,true);assert.notEqual(remap.version,prepared.version);
  assert.throws(()=>{prepared.catalog.rows[0].per_file_cents=1;});
});
test('F05A refuses missing/fabricated provenance, wrong target, changed source bytes and unreviewed code',()=>{
  for(const change of [i=>{delete i.capture.captured_at;},i=>{i.capture.store=STORE;},i=>{i.capture.product.id='1';},i=>{i.capture.metafield.key='other';},i=>{i.capture.capture_method='browser_price';},i=>{i.metafieldValue+=' ';},i=>{i.script+='\n';i.capture.theme.script_sha256=sha256(i.script);},i=>{i.section+='\n';i.capture.theme.section_sha256=sha256(i.section);},i=>{i.capture.captured_at='never';},i=>{i.capture.theme.role='unpublished';}]) {
    const i=input();change(i);assert.throws(()=>prepareCatalog(i));
  }
});
test('F05A strictly rejects duplicate JSON keys, escaped key aliases, malformed, deep and unsafe JSON',()=>{
  for(const raw of ['{"price":1,"price":2}','{"a":{"x":1,"\\u0078":2}}','{"__proto__":{}}','{"x":1,}', '['.repeat(34)+'0'+']'.repeat(34),' '.repeat(262145)])assert.throws(()=>parseStrictJson(raw));
  assert.deepEqual(parseStrictJson('{"escaped":"a\\\"b","nested":[{},[],true,false,null,-1,0.1]}'),{escaped:'a"b',nested:[{},[],true,false,null,-1,0.1]});
});
test('F05A exact known schema rejects missing, duplicate, conflicting, unknown services/sizes/groups/options/defaults',()=>{
  for(const change of [f=>{f.Other={};},f=>{delete f['Photo Prints'].Sizes;},f=>{f['Photo Prints'].Sizes.options.pop();},f=>{f['Photo Prints'].Sizes.options[0]=f['Photo Prints'].Sizes.options[1];},f=>{f['Photo Prints'].Sizes.options[0].label='5 × 99';},f=>{f['Fine Arts'].Paper.options[0].label='Unknown';},f=>{f['Photo Prints'].Sizes.options[0].per_job_fee=1;},f=>{f['Photo Prints'].Sizes.options[0].default=true;},f=>{f['Fine Arts'].Paper.options[0].default_if={sizes:['30” × 40”']};},f=>{f['Fine Arts'].Paper.options[0].default=true;},f=>{f['Fine Arts'].Paper.options[3].show_if={sizes:['11” × 14”']};},f=>{f['Fine Arts'].Paper.options[0].show_if={sizes:[]};},f=>{f['Fine Arts'].Paper.options[0].price_overrides={sizes:{Unknown:4}};},f=>{f['Fine Arts'].Paper.options[0].price_overrides={location:{Miami:4}};}])assert.throws(()=>prepareCatalog(changed(change)));
});
test('F05A integer money boundaries reject negatives, fractional cents, unsafe totals, overflow and half-cent multipliers',()=>{
  for(const value of [-0,-1,NaN,Infinity,'1',0.001,2000.01,Number.MAX_SAFE_INTEGER])assert.throws(()=>cents(value));
  assert.equal(cents(0.29),29);assert.equal(cents(2000),200000);assert.equal(cents(0),0);
  assert.equal(perFileCents([40,0],'Speedy (2-3 days)'),60);
  assert.equal(perFileCents([100000],'Rush (1 Day)'),200000);
  for(const values of [[100001],[200000,200000],[Number.MAX_SAFE_INTEGER]])assert.throws(()=>perFileCents(values,'Rush (1 Day)'));
  assert.throws(()=>perFileCents([1],'Speedy (2-3 days)'),/FRACTIONAL_PER_FILE_CENT/);
  assert.throws(()=>perFileCents([40],'Rush-ish'),/UNKNOWN/);
  assert.throws(()=>prepareCatalog(changed(f=>{f['Photo Prints'].Sizes.options[0].price=0.41;})),/FRACTIONAL/);
  // A fixed $10/job cannot be represented by adding 1000 to every per-file row:
  assert.notEqual((40+1000)*3*4,40*3*4+1000);
});
test('F05A mappings require exact captured review and proven Miami/variant identity; alternate is never Atlanta',()=>{
  for(const change of [m=>{m.source_sha256='0'.repeat(64);},m=>{m.store='1jukgy-dc.myshopify.com';},m=>{m.variant_id='1';},m=>{m.physical=false;},m=>{m.evidence='';},m=>{m.labs[0].input='Atlanta';m.labs[0].location_id='92446294127';},m=>{m.labs.push({...m.labs[0]});},m=>{m.labs[0].lab='all_labs';},m=>{m.photo_paper.input='Luster';},m=>{m.photo_paper.paper='generic';},m=>{m.fine_art_papers[0].paper='generic';},m=>{m.fine_art_papers.pop();}]){const i=input();change(i.mapping);assert.throws(()=>prepareCatalog(i));}
  const i=input();i.mapping.labs=[];const unavailable=prepareCatalog(i);assert.equal(unavailable.catalog.rows.length,0);assert.ok(unavailable.diagnostics.unsupported.includes('Unmapped lab / Miami'));
  assert.throws(()=>prepareCatalog(changed(f=>{f['Photo Prints'].description='No paper evidence';})),/NULL_PAPER/);
});
test('F05A all 222 current selections match actual captured conditions/pricing functions and real job service for files/copies',async t=>{
  const {jobs}=jobsFixture(t),source=validateForm(input().metafieldValue);let count=0;
  for(const s of prepared.selections)for(const [files,copies] of [[1,1],[3,2]]) {
    const legacy=legacyHarness(input().script,source,s,{files,copies}).price;
    assert.equal(legacy.unitCents,s.per_file_cents*files);assert.equal(Math.round(legacy.total*100),s.per_file_cents*files*copies);
    const r=request(s,`parity-${++count}`,files,copies);
    if(s.per_file_cents*files*copies>200000)await assert.rejects(jobs.prepare('offline-owner',r),/PRICE_LIMIT/);
    else {const actual=await jobs.prepare('offline-owner',{...r,price:1,file_count:999});assert.equal(actual.unit_price_cents,legacy.unitCents);assert.equal(actual.item.quantity,copies);assert.equal(actual.file_count,files);assert.equal(actual.checkout_ready,false);}
  }
  assert.equal(count,444);
});
test('F05A original source conditions handle paper surcharge, forced Fibre defaults and switching back without sticky overrides',()=>{
  const s={service:'Fine Arts',size:'11” × 14”',paper:'Fibre Paper',lab:'Miami',options:{Borders:'Borderless (Edge-to-edge)',Turnaround:'Standard (4-5 days)'}};
  const h=legacyHarness(input().script,JSON.parse(input().metafieldValue),s);
  assert.equal(h.price.unitCents,2000);
  for(const r of h.radios)if(r.name==='sizes')r.checked=r.value==='30” × 40”';
  assert.equal(h.recalculate().unitCents,8000);assert.equal(h.radios.find(r=>r.name==='paper'&&r.value==='Matte').disabled,true);
  for(const r of h.radios)if(r.name==='sizes')r.checked=r.value==='11” × 14”';
  assert.equal(h.recalculate().unitCents,2000);assert.equal(h.radios.find(r=>r.name==='paper'&&r.value==='Matte').disabled,false);
  for(const r of h.radios)if(r.name==='paper')r.checked=r.value==='Matte';
  assert.equal(h.recalculate().unitCents,1500);
});
test('F05A real service rejects absent/duplicate rows and exact missing/unsupported selection inputs',async t=>{
  const s=prepared.selections.find(s=>s.service==='Photo Prints'),{jobs,replace}=jobsFixture(t);
  for(const patch of [{paper:'Photo premium luster'},{lab:'miami'},{lab:'Atlanta'},{options:{}},{options:{Turnaround:'Rush'}},{options:{...s.options,Borders:'Borderless (Edge-to-edge)'}},{size:'Custom'},{service:'Darkroom Prints'}])await assert.rejects(jobs.prepare('offline-owner',request({...s,...patch})));
  const c=decodeCatalog(prepared.value);c.rows=c.rows.filter(r=>r.service!=='photo');replace(c);await assert.rejects(jobs.prepare('offline-owner',request(s)),/PRICE_UNAVAILABLE/);
  const dup=decodeCatalog(prepared.value);dup.rows.push(...dup.rows);replace(dup);await assert.rejects(jobs.prepare('offline-owner',request(s)),/PRICE_UNAVAILABLE/);
});
test('F05A real job ceiling at exactly $2000, above, zero/fractional/overflow copies and completed-file constraints',async t=>{
  const s=prepared.selections.find(s=>s.service==='Photo Prints'&&s.per_file_cents===40),{jobs}=jobsFixture(t);
  assert.equal((await jobs.prepare('offline-owner',request(s,'ceiling-0001',1,5000))).unit_price_cents,40);
  for(const copies of [5001,10000,0,1.5,Number.MAX_SAFE_INTEGER])await assert.rejects(jobs.prepare('offline-owner',request(s,'ceiling-0002',1,copies)));
  for(const asset_ids of [[],['asset-0001','asset-0001'],['missing-asset']])await assert.rejects(jobs.prepare('offline-owner',{...request(s),asset_ids}));
});
test('F05A actual authenticated catalog loader consumes proposed bytes with the exact content version',async()=>{
  const data={shop:{myshopifyDomain:STORE},currentAppInstallation:{id:INSTALLATION,app:{id:APP},metafield:{type:'json',value:prepared.value}}};
  const catalog=await createPriceCatalogLoader(async()=>structuredClone(data))();assert.equal(catalog.version,prepared.version);assert.equal(catalog.rows.length,222);
  data.currentAppInstallation.metafield=null;await assert.rejects(createPriceCatalogLoader(async()=>data)(),/PRICE_UNAVAILABLE/);
});
test('F05A price update uses existing atomic cutover and invalidates old projections without editing immutable jobs',async t=>{
  // Synthetic physical confirmations only for lifecycle mechanics, not output.
  const release=syntheticRelease(c=>{for(const r of c.rules.filter(r=>r.capacity))r.paper='photo-premium-luster';});
  const mock=mockAdmin({release});mock.replace('catalog',prepared.value);
  const store=createJobStore(':memory:');t.after(()=>store.close());const options={writesEnabled:true,lifecycle:store.lifecycle,now};
  const admin=createAuthorityAdmin(mock.api,options);
  const jobs=createJobService({store,loader:{load:async()=>release},loadCatalog:async()=>(await admin.read()).catalog,secret:'offline-f05a-lifecycle-secret-not-real'});
  store.recordUpload('offline-owner',{id:'asset-0001',state:'complete',verified:true,url:'https://example.invalid/1'});
  const s=prepared.selections.find(s=>s.service==='Photo Prints'&&s.size==='4” × 6”'&&s.options.Turnaround==='Standard (4-5 days)');const p=await jobs.prepare('offline-owner',request(s));
  const before=store.get(p.reference.id,'offline-owner');
  const cart={id:'gid://shopify/Cart/offline-f05a',store:STORE,owner:'offline-owner',customer_id:null,complete:true,lines:[{id:'gid://shopify/CartLine/offline-f05a',variant_id:VARIANT,product_id:PRODUCT,quantity:1,reference:p.reference,properties:p.item.properties}]};
  const projector=createCheckoutProjector({jobs,resolveCart:async()=>cart,loadContext:admin.read});
  const old=await projector.prepare({});await admin.publish(old);
  const next=prepareCatalog(changed(f=>{f['Photo Prints'].Sizes.options[1].price=0.6;}));
  await publishPriceCatalog(mock.api,next.value,options);
  assert.equal(JSON.parse(mock.data.shop.authority.value).grants.length,0);
  assert.deepEqual(mock.writes.at(-1).map(f=>f.key),['authority','active_config','authority_fence','price_catalog']);
  await assert.rejects(admin.publish(old),/AUTHORITY_CHANGED|AUTHORITY_FENCED/);
  await assert.rejects(projector.prepare({}),/PRICE_VERSION_MISMATCH/);
  assert.deepEqual(store.get(p.reference.id,'offline-owner'),before);
  const again=await jobs.prepare('offline-owner',request(s,'new-price-job'));assert.equal(again.unit_price_cents,60);assert.notEqual(again.reference.revision,p.reference.revision);
});
test('F05A F06E transport still rejects source publication even in reconcile-only mode',async t=>{
  const mock=mockAdmin();mock.replace('catalog',prepared.value);const store=createJobStore(':memory:');t.after(()=>store.close());let mutations=0;
  const api=createAdminTransport({store:STORE,app:APP,clientId:CLIENT,installation:INSTALLATION,adminToken:'offline-not-real',mode:'reconcile-only'},{fetchImpl:async(url,options)=>{
    const {query}=JSON.parse(options.body);if(query.startsWith('mutation'))mutations++;
    const data=structuredClone(mock.data);data.currentAppInstallation.app.apiKey=CLIENT;
    return new Response(JSON.stringify({data}),{headers:{'Content-Type':'application/json','x-shopify-api-version':'2026-10'}});
  }});
  const next=prepareCatalog(changed(f=>{f['Photo Prints'].Sizes.options[1].price=0.6;}));
  await assert.rejects(publishPriceCatalog(api,next.value,{writesEnabled:true,lifecycle:store.lifecycle,now}),/ADMIN_OPERATION_REJECTED/);
  assert.equal(mutations,0);assert.ok(store.lifecycle.state().operation);
});
test('F05A local operator command writes review artifacts and refuses to overwrite an existing bundle',()=>{
  const dir=mkdtempSync(join(tmpdir(),'f05a-cli-'));
  try {
    const args=[fileURLToPath(new URL('../pricing/manage.mjs',import.meta.url)),fileURLToPath(root),fileURLToPath(new URL('reviewed-mapping.json',root)),join(dir,'review')];
    const out=JSON.parse(execFileSync(process.execPath,args,{encoding:'utf8'}));assert.equal(out.rows,222);assert.equal(out.checkout_ready,false);
    assert.equal(readFileSync(join(dir,'review/price-catalog.proposed.json'),'utf8'),prepared.value);
    const verified=JSON.parse(execFileSync(process.execPath,[args[0],'--verify',...args.slice(1),prepared.version],{encoding:'utf8'}));assert.equal(verified.status,'verified_local_import_bytes');
    assert.throws(()=>execFileSync(process.execPath,args,{stdio:'pipe'}));assert.ok(existsSync(join(dir,'review/diagnostics.json')));
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test('F05A pre-import verification rejects edited, absent, duplicate, stale and reformatted bytes',()=>{
  const bundle={catalogValue:prepared.value,formValue:prepared.formValue,expectedVersion:prepared.version};
  assert.equal(verifyPreparedCatalog(input(),bundle).version,prepared.version);
  for(const edit of [c=>{c.rows[0].per_file_cents++;},c=>{c.rows.pop();},c=>{c.rows.push({...c.rows[0]});},c=>{delete c.provenance;}]) {
    const c=JSON.parse(prepared.value);edit(c);assert.throws(()=>verifyPreparedCatalog(input(),{...bundle,catalogValue:JSON.stringify(c)}),/BUNDLE_CHANGED/);
  }
  for(const patch of [{catalogValue:prepared.value+'\n'},{formValue:prepared.formValue+' '},{expectedVersion:'price-'+ '0'.repeat(64)}])assert.throws(()=>verifyPreparedCatalog(input(),{...bundle,...patch}),/BUNDLE_CHANGED/);
});
