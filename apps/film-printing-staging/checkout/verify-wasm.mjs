// Offline candidate build only. No dev/deploy/registration command exists here.
import {mkdtempSync,cpSync,mkdirSync,readFileSync,writeFileSync,symlinkSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {buildFunction,getFunctionInfo,loadSchema,loadInputQuery,validateTestAssets,runFunction} from '@shopify/shopify-function-test-helpers';
import {visit} from 'graphql';
import {scenario,replaceAuthority} from '../../../fixtures/film-printing/f06a/synthetic.mjs';
import * as functions from './functions.js';
import {MAX_BYTES} from './authority.js';
import {serializeAuthority} from './projector.mjs';
const app=fileURLToPath(new URL('..',import.meta.url));
const output=fileURLToPath(new URL('../../../fixtures/film-printing/f06a/',import.meta.url));
const temp=mkdtempSync(join(tmpdir(),'bfl-f06a-offline-'));
const specs={pricing:['cart_transform_run','cart.transform.run','cartTransformRun'],validation:['cart_validations_generate_run','cart.validations.generate.run','cartValidationsGenerateRun'],lab:['cart_fulfillment_constraints_generate_run','cart.fulfillment-constraints.generate.run','cartFulfillmentConstraintsGenerateRun'],delivery:['cart_delivery_options_transform_run','cart.delivery-options.transform.run','cartDeliveryOptionsTransformRun']};
const results={synthetic_offline_only:true,remote_store_operations:0,functions:{}};
const single=await scenario(),multiple=await scenario({count:8}),customer=await scenario({customer:'gid://shopify/Customer/123'});
const large=structuredClone(multiple.input);
for(let i=0;i<192;i++)large.cart.lines.push({id:`gid://shopify/CartLine/ordinary-${i}`,quantity:1,merchandise:{id:'gid://shopify/ProductVariant/999',product:{id:'gid://shopify/Product/999'}},sellingPlanAllocation:null,cost:{amountPerQuantity:{currencyCode:'USD'},subtotalAmount:{amount:'1.00'}}});
const boundary=structuredClone(large);boundary.cart.lines=boundary.cart.lines.slice(0,20);
const padded=structuredClone(boundary),manifest=JSON.parse(padded.shop.authority.value);
const padding='x'.repeat(MAX_BYTES-padded.shop.authority.value.length);
manifest.grants[0].lines[0].claims.message+=padding;padded.cart.lines[0].message.value+=padding;padded.shop.authority.value=serializeAuthority(manifest);
const unrelated=structuredClone(large);unrelated.cart.lines=unrelated.cart.lines.slice(8);unrelated.cart.deliverableLines=[];unrelated.cart.deliveryGroups[0].cartLines=[{id:unrelated.cart.lines[0].id,merchandise:unrelated.cart.lines[0].merchandise}];
const cases=[['valid',single.input],['eight-jobs',multiple.input],['20-line-boundary',boundary],['6000-byte-20-line-boundary',padded],['200-line-cart-denied',large],['192-unrelated-lines',unrelated],['customer',customer.input]];
for(const [name,change] of Object.entries({
 'cart-bootstrap':i=>{i.shop.authority=null;i.buyerJourney.step='CART_INTERACTION';},
 'checkout-interaction':i=>{i.shop.authority=null;i.buyerJourney.step='CHECKOUT_INTERACTION';},
 'missing-authority':i=>i.shop.authority=null,
 'expired':i=>i.shop.localTime.date='2026-10-22',
 'quantity-change':i=>i.cart.lines[0].quantity=5,
 'replay':i=>i.cart.lines[0].id='gid://shopify/CartLine/another-cart',
 'spec-change':i=>i.cart.lines[0].lab.value='other',
 'no-price':i=>i.cart.lines[0].cost.subtotalAmount.amount='1.00',
 'no-lab-map':i=>i.cart.deliverableLines=[],
 'revoked':i=>replaceAuthority(i,a=>a.grants=[]),
 'unrelated':i=>{i.cart.lines=[{id:'other',quantity:1,merchandise:{id:'gid://shopify/ProductVariant/999',product:{id:'gid://shopify/Product/999'}},sellingPlanAllocation:null,cost:{amountPerQuantity:{currencyCode:'USD'},subtotalAmount:{amount:'1.00'}}}];i.cart.deliverableLines=[];i.cart.deliveryGroups[0].cartLines=[{id:'other',merchandise:i.cart.lines[0].merchandise}];},
})) {const input=structuredClone(single.input);change(input);cases.push([name,input]);}
// Keep only queried fields, including aliases; missing nullable properties are null.
function project(value,set) {
 if(value==null)return null;if(Array.isArray(value))return value.map(v=>project(v,set));
 const result={};
 for(const f of set.selections){if(f.kind==='InlineFragment'){Object.assign(result,project(value,f.selectionSet));continue;}
 const key=f.alias?.value??f.name.value;result[key]=f.selectionSet?project(value[key],f.selectionSet):(value[key]??null);}
 return result;
}
try {
 cpSync(join(app,'shopify.app.staging.toml'),join(temp,'shopify.app.staging.toml'));
 cpSync(join(app,'package.json'),join(temp,'package.json'));
 cpSync(join(app,'checkout'),join(temp,'checkout'),{recursive:true});
 symlinkSync(join(app,'node_modules'),join(temp,'node_modules'),'dir');
 process.env.SHOPIFY_FLAG_APP_CONFIG='staging';process.env.SHOPIFY_FLAG_STORE='bellows-film-printing-staging.myshopify.com';process.env.SHOPIFY_FLAG_PATH=temp;
 for(const [name,[file,target,exportName]] of Object.entries(specs)) {
  const dir=join(temp,'extensions',`f02-print-${name}`);mkdirSync(join(dir,'src'),{recursive:true});
  for(const source of ['schema.graphql','shopify.extension.toml','package.json','vite.config.js'])cpSync(join(app,'extensions',`f02-print-${name}`,source),join(dir,source));
  cpSync(join(app,'extensions',`f02-print-${name}`,'locales'),join(dir,'locales'),{recursive:true});
  cpSync(join(app,'checkout','queries',`${name}.graphql`),join(dir,'src',`${file}.graphql`));
  writeFileSync(join(dir,'src','index.js'),`export { ${exportName} } from '../../../checkout/functions.js';\n`);
  const built=await buildFunction(dir);assert.equal(built.success,true);
  const info=await getFunctionInfo(dir),schema=await loadSchema(info.schemaPath),query=await loadInputQuery(join(dir,'src',`${file}.graphql`));
  let cost=0;visit(query,{Field(n,key,parent,path,ancestors){if(n.name.value==='metafield')cost+=3;else if(!n.selectionSet && !(n.name.value==='value' && ancestors.some(a=>a?.kind==='Field' && a.name?.value==='metafield')))cost++;}});
  const bytes=statSync(join(dir,'src',`${file}.graphql`)).size;assert.ok(cost<=30);assert.ok(bytes<=3000);
  const records=[];
  for(const [caseName,source] of cases) {
   const input=project(source,query.definitions[0].selectionSet),expectedOutput=functions[exportName](input);
   const fixture={target,export:target.replaceAll('.','-'),input,expectedOutput};
   const validation=await validateTestAssets({schema,fixture,inputQueryAST:query});
   for(const k of ['inputQuery','inputFixture','outputFixture'])assert.deepEqual(validation[k].errors,[],`${name}/${caseName}/${k}`);
   const run=await runFunction(fixture,info.functionRunnerPath,info.wasmPath,join(dir,'src',`${file}.graphql`),info.schemaPath);
   assert.equal(run.error,null,`${name}/${caseName}`);assert.deepEqual(run.result.output,expectedOutput);
   const withinBudget=run.metadata.instructionCount<11000000;
   const diagnostic=['200-line-cart-denied','192-unrelated-lines'].includes(caseName);
   if(!diagnostic)assert.ok(withinBudget,`${name}/${caseName}: ${run.metadata.instructionCount} instructions`);assert.ok(statSync(info.wasmPath).size<=256000);
   records.push({case:caseName,within_instruction_budget:withinBudget,diagnostic_only:diagnostic,...run.metadata});
   if(caseName==='valid')writeFileSync(join(output,`${name}-synthetic.json`),JSON.stringify({synthetic_offline_only:true,fixture},null,2)+'\n');
  }
  results.functions[name]={query_bytes:bytes,query_cost:cost,wasm_bytes:statSync(info.wasmPath).size,cases:records};
  console.log(`${name}: ${records.filter(r=>!r.diagnostic_only).length} in-scope compiled cases pass; ${records.filter(r=>!r.within_instruction_budget).length} over-budget diagnostics; query cost ${cost}`);
 }
 writeFileSync(join(output,'wasm-results.json'),JSON.stringify(results,null,2)+'\n');
} finally {single.store.close();multiple.store.close();customer.store.close();rmSync(temp,{recursive:true,force:true});}
