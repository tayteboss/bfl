import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,cpSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {digest} from '../configuration/config.mjs';
import {prepareEngineeringSources} from '../configuration/engineering.mjs';
import {expandFullProductCatalog,encodeFullProductCatalog} from '../pricing/compact-catalog.mjs';
import {applyLabVariantRouting} from '../pricing/lab-variant-catalog.mjs';
import {VARIANTS_BY_LAB,VARIANT} from '../checkout/authority.js';
import {parseCarrierRequest,PRODUCT_ID,VARIANT_ID} from '../carrier/contract.mjs';

// Generated exact source pairs are admitted only in an isolated test copy.
// No test catalog or synthetic identifier is added to the real source registry.
function isolated(t){
 const directory=mkdtempSync(join(tmpdir(),'bfl-lab-variant-test-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const target=join(directory,'app'),app=fileURLToPath(new URL('../',import.meta.url));
 cpSync(app,target,{recursive:true,filter:p=>!['/node_modules','/dist','/.shopify','/tests'].some(part=>p.includes(part))&&!p.endsWith('.before')&&!p.endsWith('.claims-before')});
 const read=name=>JSON.parse(readFileSync(new URL('../../../fixtures/film-printing/full-product-readiness-20261030/'+name,import.meta.url)));
 const config=read('engineering-config-proposal.json'),legacy=read('engineering-catalog-proposal.json');
 assert.deepEqual(Object.keys(VARIANTS_BY_LAB).sort(),['atlanta','chicago','miami','orlando']);
 const catalog=encodeFullProductCatalog(applyLabVariantRouting(expandFullProductCatalog(legacy)),legacy.form_value).catalog;
 const source=join(target,'configuration/engineering.mjs'),original=readFileSync(source,'utf8');
 const pins=[catalog,legacy].map(c=>({config:digest(config),catalog:digest(c)}));
 writeFileSync(source,original.replace('ENGINEERING_SOURCE_PINS=Object.freeze([','ENGINEERING_SOURCE_PINS=Object.freeze(['+pins.map(p=>'Object.freeze('+JSON.stringify(p)+'),').join('')));
 writeFileSync(join(directory,'input.json'),JSON.stringify({config,catalog,legacy}));
 return directory;
}

test('schema5 source admission, four-lab projection, actual variant matching and carrier resolution preserve historical schema4',t=>{
 const directory=isolated(t);
 writeFileSync(join(directory,'worker.mjs'),String.raw`
 import assert from 'node:assert/strict';
 import {readFileSync} from 'node:fs';
 import {digest} from './app/configuration/config.mjs';
 import {expandFullProductCatalog} from './app/pricing/compact-catalog.mjs';
 import {prepareEngineeringSources,createEngineeringScope,assertEngineeringScope,bindEngineeringCustomerJob,assertEngineeringJob} from './app/configuration/engineering.mjs';
 import {STORE,APP,CLIENT} from './app/configuration/schema.mjs';
 import {SHOP,INSTALLATION} from './app/backend/config.mjs';
 import {VARIANTS_BY_LAB,VARIANT,PRODUCT,FULL_PRODUCT_ATTRIBUTES,decodeAuthority} from './app/checkout/authority.js';
 import {resolveSelection} from './app/jobs/selection.mjs';
 import {jobProperties} from './app/jobs/properties.mjs';
 import {quantitySignature} from './app/checkout/quantity-signature.js';
 import {createEligibilityProjector} from './app/checkout/eligibility-projector.mjs';
 import {verifyCustomerTarget} from './app/backend/diagnostic-control.mjs';
 import {parseCarrierRequest,PRODUCT_ID} from './app/carrier/contract.mjs';
 import {resolveCarrierReferences} from './app/carrier/preparation.mjs';
 const {config,catalog,legacy}=JSON.parse(readFileSync(new URL('./input.json',import.meta.url)));
 const identity={shop:{id:SHOP,myshopifyDomain:STORE,currencyCode:'USD'},currentAppInstallation:{id:INSTALLATION,app:{id:APP,apiKey:CLIENT}}};
 let clock=1000;
 const scopeFor=source=>createEngineeringScope({...prepareEngineeringSources({config,catalog:source,issuedAt:1000,until:3601000}),identity,now:()=>clock});
 const scope=scopeFor(catalog),oldScope=scopeFor(legacy),release=assertEngineeringScope(scope).release;
 const priced=expandFullProductCatalog({...catalog,version:'price-'+digest(catalog)}),oldPriced=expandFullProductCatalog({...legacy,version:'price-'+digest(legacy)});
 const rows=Object.keys(VARIANTS_BY_LAB).map(lab=>priced.rows.find(row=>row.lab===lab&&row.service==='photo'&&row.size==='4x6'));
 const jobs=rows.map((row,index)=>{
  const selected=resolveSelection(priced,{service:row.service,size:row.size,paper:row.paper,lab:row.lab,options:row.options,message:'Café 🎞️ — “routing”',copies:2},{completedFileCount:1,canonicalInput:true});
  return {...selected.spec,id:'lab-route-job-'+index,revision:String(index+1).repeat(64),config_version:release.version,price_version:priced.version,
   variant_id:selected.variant_id,unit_price_cents:selected.unit_price_cents,billing_basis:selected.billing_basis,completed_asset_ids:['asset-'+index]};
 });
 const refs=jobs.map(job=>({id:job.id,revision:job.revision,config_version:job.config_version,signature:'a'.repeat(64)}));
 for(const job of jobs){bindEngineeringCustomerJob(scope,'same-owner',job.completed_asset_ids,job.copies,job,64);assertEngineeringJob(scope,'same-owner',job);}
 const forged={...jobs[1],variant_id:jobs[0].variant_id};assert.throws(()=>assertEngineeringJob(scope,'same-owner',forged),/ENGINEERING_JOB/);
 assert.throws(()=>bindEngineeringCustomerJob(scope,'same-owner',forged.completed_asset_ids,forged.copies,forged,64),/ENGINEERING_JOB/);
 let staged=0;const lifecycle={beginPreparation:()=>({epoch:1}),stage(){staged++;},state:()=>({epoch:1,pending:null,operation:null})};
 const resolver={authorityLifecycle:lifecycle,resolveForCheckout:async(owner,references)=>references.map(ref=>jobs.find(j=>j.id===ref.id))};
 const projector=createEligibilityProjector({jobs:resolver,sourceScope:scope});
 const cart={id:'gid://shopify/Cart/lab-routing?key=test',owner:'same-owner',store:STORE,complete:true,customer_id:null,lines:[]};
 const args={cart,context:{release,catalog:priced,shopDate:'2026-10-30'},binding:{marker:'b'.repeat(64),generation:1,epoch:1},lease:{token:'c'.repeat(64),deadline:'2026-10-30T14:00:00',expires_at:1793372400000},references:refs};
 const proposal=await projector.prepare(args);assert.equal(proposal.authority.schema,5);assert.ok(decodeAuthority(proposal.value));assert.equal(staged,1);
 assert.deepEqual(proposal.authority.grants[0].lines.map(line=>line.variant_id),jobs.map(job=>'gid://shopify/ProductVariant/'+job.variant_id));
 assert.equal(new Set(proposal.authority.grants[0].lines.map(line=>line.location_id)).size,4);
 cart.lines=jobs.map((job,i)=>({id:'gid://shopify/CartLine/lab-'+i,variant_id:'gid://shopify/ProductVariant/'+job.variant_id,product_id:PRODUCT,quantity:job.copies,selling_plan:false,reference:refs[i],properties:{...jobProperties(job,refs[i]),_bfl_signature:quantitySignature(refs[i].signature,job.copies)}}));
 assert.equal((await projector.prepare(args)).authority.schema,5);
 // Complete historical canonical and new human property projections both bind
 // to the same canonical job grants. Mixed labels cannot bypass either boundary.
 const displayed=structuredClone(cart.lines);
 for(const [i,line] of cart.lines.entries()){
  assert.equal(line.properties.Service,'Photo Prints');assert.equal(line.properties.Location,jobs[i].lab[0].toUpperCase()+jobs[i].lab.slice(1));
  line.properties={...jobProperties(jobs[i],refs[i],{canonical:true}),_bfl_signature:quantitySignature(refs[i].signature,jobs[i].copies)};
 }
 assert.equal((await projector.prepare(args)).value,proposal.value);
 cart.lines=structuredClone(displayed);cart.lines[0].properties.Location=jobs[0].lab;await assert.rejects(projector.prepare(args),/SPECIFICATION_MISMATCH/);cart.lines=displayed;

 cart.lines[1].variant_id=cart.lines[0].variant_id;await assert.rejects(projector.prepare(args),/VARIANT_MISMATCH/);cart.lines[1].variant_id=VARIANTS_BY_LAB[jobs[1].lab];
 const oldRelease=assertEngineeringScope(oldScope).release,oldJobs=jobs.map(job=>({...job,variant_id:VARIANT.split('/').at(-1),config_version:oldRelease.version,price_version:oldPriced.version}));
 for(const job of oldJobs){bindEngineeringCustomerJob(oldScope,'same-owner',job.completed_asset_ids,job.copies,job,64);assertEngineeringJob(oldScope,'same-owner',job);}
 const oldProjector=createEligibilityProjector({sourceScope:oldScope,jobs:{...resolver,resolveForCheckout:async()=>oldJobs}});
 const old=await oldProjector.prepare({...args,cart:{...cart,lines:[]},context:{...args.context,release:oldRelease,catalog:oldPriced}});
 assert.equal(old.authority.schema,4);assert.ok(old.authority.grants[0].lines.every(line=>!Object.hasOwn(line,'variant_id')));assert.ok(decodeAuthority(old.value));
 // The new target contract is selected only by the genuine private source scope.
 const target={...identity,product:{id:PRODUCT,title:'F00 Film Printing Test',status:'ACTIVE',onlineStoreUrl:null,hasOnlyDefaultVariant:false,variants:{nodes:Object.entries(VARIANTS_BY_LAB).map(([lab,id])=>({id,selectedOptions:[{name:'Lab',value:lab[0].toUpperCase()+lab.slice(1)}],price:'1.00',inventoryItem:{tracked:false,requiresShipping:true}})),pageInfo:{hasNextPage:false}}}};
 let query;const api=async value=>{query=value;return target;};
 assert.deepEqual((await verifyCustomerTarget(api,{sourceScope:scope})).variants,VARIANTS_BY_LAB);assert.match(query,/variants\(first:5\)/);
 await assert.rejects(verifyCustomerTarget(api),/CUSTOMER_TARGET_READBACK/);assert.match(query,/variants\(first:2\)/);
 await assert.rejects(verifyCustomerTarget(api,{sourceScope:{kind:'staging_engineering'}}),/ENGINEERING_SCOPE/);
 for(const change of [v=>v.product.variants.nodes.pop(),v=>v.product.variants.nodes.push(v.product.variants.nodes[0]),v=>v.product.variants.nodes[1].id=VARIANT,v=>v.product.variants.nodes[1].id='gid://shopify/ProductVariant/999',v=>v.product.variants.nodes[1].selectedOptions[0].value='Miami',v=>v.product.variants.nodes[1].selectedOptions[0].name='Title',v=>v.product.variants.nodes[1].selectedOptions.push({name:'Size',value:'4x6'}),v=>v.product.variants.nodes[1].price='2.00',v=>v.product.variants.nodes[1].inventoryItem.tracked=true,v=>v.product.variants.nodes[1].inventoryItem.requiresShipping=false,v=>v.product.variants.pageInfo.hasNextPage=true,v=>v.product.onlineStoreUrl='https://example.invalid',v=>v.shop.myshopifyDomain='1jukgy-dc.myshopify.com']){
  const bad=structuredClone(target);change(bad);await assert.rejects(verifyCustomerTarget(async()=>bad,{sourceScope:scope}));
 }
 const address={country:'US',postal_code:'33132',province:'FL',city:'Miami',address1:'Test address'};
 const body={rate:{currency:'USD',origin:address,destination:address,items:jobs.map((job,i)=>({product_id:PRODUCT_ID,variant_id:Number(job.variant_id),requires_shipping:true,quantity:job.copies,price:job.unit_price_cents,properties:{...jobProperties(job,refs[i]),_bfl_signature:quantitySignature(refs[i].signature,job.copies)}}))}};
 const callback=parseCarrierRequest(Buffer.from(JSON.stringify(body)));
 assert.deepEqual(callback.items.map(i=>i.variant_id),jobs.map(job=>job.variant_id));
 const resolved=await resolveCarrierReferences({callback,owner:'same-owner',jobs:resolver,release,sourceScope:scope});assert.equal(resolved.jobs.length,4);
 for(const [i,line] of body.rate.items.entries())line.properties={...jobProperties(jobs[i],refs[i],{canonical:true}),_bfl_signature:quantitySignature(refs[i].signature,jobs[i].copies)};
 const historicalCallback=parseCarrierRequest(Buffer.from(JSON.stringify(body)));
 assert.deepEqual(await resolveCarrierReferences({callback:historicalCallback,owner:'same-owner',jobs:resolver,release,sourceScope:scope}),resolved);
 body.rate.items[0].properties.Location='Miami';await assert.rejects(resolveCarrierReferences({callback:parseCarrierRequest(Buffer.from(JSON.stringify(body))),owner:'same-owner',jobs:resolver,release,sourceScope:scope}),/SPECIFICATION_MISMATCH/);body.rate.items[0].properties.Location=jobs[0].lab;

 const swapped=structuredClone(body);swapped.rate.items[1].variant_id=Number(jobs[0].variant_id);
 await assert.rejects(resolveCarrierReferences({callback:parseCarrierRequest(Buffer.from(JSON.stringify(swapped))),owner:'same-owner',jobs:resolver,release,sourceScope:scope}),/VARIANT_MISMATCH/);
 clock=3601000;await assert.rejects(projector.prepare(args),/ENGINEERING_EXPIRED/);
 process.stdout.write(JSON.stringify({labs:jobs.length,schema:5,legacySchema:4,exactVariantMismatchRejected:true}));
 `);
 const result=spawnSync(process.execPath,[join(directory,'worker.mjs')],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).labs,4);
});

test('carrier accepts only exact known variants and does not relabel a callback',()=>{
 const address={country:'US',postal_code:'33132',province:'FL',city:'Miami',address1:'Test address'};
 const body=variant=>Buffer.from(JSON.stringify({rate:{currency:'USD',origin:address,destination:address,items:[{product_id:PRODUCT_ID,variant_id:variant,requires_shipping:true,quantity:1,price:40,properties:{_bfl_flow:'f05',_bfl_job:'lab-routing-test',_bfl_revision:'a'.repeat(64),_bfl_config:'f03-'+'b'.repeat(24),_bfl_signature:'c'.repeat(64)}}]}}));
 assert.equal(parseCarrierRequest(body(VARIANT_ID)).items[0].variant_id,String(VARIANT_ID));
 for(const id of Object.values(VARIANTS_BY_LAB)){const value=Number(id.split('/').at(-1));assert.equal(parseCarrierRequest(body(value)).items[0].variant_id,String(value));}
 for(const value of [999,String(VARIANT_ID),null,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>parseCarrierRequest(body(value)),/CALLBACK_PRODUCT/);
});


test('the reviewed compact-v2 exact source pair is admitted and altered routing remains rejected',()=>{
 const directory=new URL('../../../fixtures/film-printing/full-product-lab-routing-20261030/',import.meta.url);
 const read=name=>JSON.parse(readFileSync(new URL(name,directory)));
 const config=read('engineering-config-proposal.json'),catalog=read('engineering-catalog-proposal.json');
 assert.equal(digest(config),'5f603f1fcdaad34f7a558bd12567cf1402523b90a885399acf4ea02098f0cd92');
 assert.equal(digest(catalog),'bf0e9f20f9fc6cee5014791357f237c396f6f7594539cde8e66b74b273ddf3ae');
 const source=prepareEngineeringSources({config,catalog,issuedAt:1000,until:3601000});
 assert.equal(source.contract.expires_at,3601000);
 const changed=structuredClone(catalog);changed.variants_by_lab.chicago=VARIANT;
 assert.throws(()=>prepareEngineeringSources({config,catalog:changed,issuedAt:1000,until:3601000}),/ENGINEERING_SOURCE/);
 assert.throws(()=>prepareEngineeringSources({config,catalog,issuedAt:1000,until:3601001}),/ENGINEERING_WINDOW/);
});
