// Offline candidate build only. No dev/deploy/registration command exists here.
import {mkdtempSync,cpSync,mkdirSync,readFileSync,writeFileSync,symlinkSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {buildFunction,getFunctionInfo,loadSchema,loadInputQuery,validateTestAssets,runFunction} from '@shopify/shopify-function-test-helpers';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {visit} from 'graphql';
import {buildCases as legacyCases,padInput} from '../../../fixtures/film-printing/f06b/cases.mjs';
import * as functions from './functions.js';
import {beginRetention,assertToolchain,retainFile,digest} from './candidate-bundle.mjs';
const app=fileURLToPath(new URL('..',import.meta.url));
const repository=resolve(app,'../..');
const args=process.argv.slice(2);
const shippingOnly=args[0]==='--shipping-discovery';if(shippingOnly)args.shift();
const labVariants=args[0]==='--eligibility-v5';
const fullProduct=labVariants||args[0]==='--eligibility-v4';if(fullProduct)args.shift();
const eligibility=fullProduct||args[0]==='--eligibility-v3';if(eligibility&&!fullProduct)args.shift();
const bound=eligibility||args[0]==='--binding-v2';if(bound&&!eligibility)args.shift();
const queryDirectory=fullProduct?'queries-v4':eligibility?'queries-v3':'queries';
if(bound)assert.ok(args.length===2&&args[0]==='--retain-bundle','V2 requires a new retained bundle');
const {buildCases}=fullProduct?await import('./full-product-cases.mjs'):eligibility?await import('../../../fixtures/film-printing/f06v3-candidate/cases.mjs'):bound?await import('../../../fixtures/film-printing/f06p-candidate/cases.mjs'):{buildCases:legacyCases};
assert.ok(args.length===0 || (args.length===2 && args[0]==='--retain-bundle'),'Usage: node verify-wasm-f06b.mjs [--retain-bundle NEW_DIRECTORY]');
const retention=args.length?beginRetention(args[1]):null;
const output=retention?join(retention.pending,'evidence'):join(repository,'fixtures/film-printing/f06b');
if(retention)mkdirSync(output);
const manifest={schema:1,status:'unreleased-candidate',checkout_ready:false,release_id:null,
 ...(shippingOnly?{bundle_scope:'staging-shipping-discovery'}:{}),
 authority_schema:labVariants?5:fullProduct?4:eligibility?3:bound?2:1,
 store:'bellows-film-printing-staging.myshopify.com',shop_id:'81566597231',app_id:'436988772353',
 client_id:'002722c8effe5d2e3243467181b45833',installation_id:'1073784553583',
 identity_verification:'Historical references only; no remote re-verification',targets:{},source_sha256:{}};
const temp=mkdtempSync(join(tmpdir(),'bfl-f06b-offline-'));
const specs={pricing:['cart_transform_run','cart.transform.run','cartTransformRun'],validation:['cart_validations_generate_run','cart.validations.generate.run','cartValidationsGenerateRun'],lab:['cart_fulfillment_constraints_generate_run','cart.fulfillment-constraints.generate.run','cartFulfillmentConstraintsGenerateRun'],delivery:['cart_delivery_options_transform_run','cart.delivery-options.transform.run','cartDeliveryOptionsTransformRun']};
if(fullProduct)specs.specification=['cart_specification_validations_generate_run','cart.validations.generate.run','cartSpecificationValidationsGenerateRun'];
const templateName=name=>name==='specification'?'validation':name;
const results={synthetic_offline_only:true,remote_store_operations:0,instruction_limit:11000000,regression_ceiling:8000000,input_limit_bytes:128000,output_limit_bytes:20000,functions:{}};
if(shippingOnly)for(const target of Object.keys(specs))if(target!=='delivery')delete specs[target];
let suite;
// Keep only queried fields, including aliases; missing nullable properties are null.
function project(value,set) {
 if(value==null)return null;if(Array.isArray(value))return value.map(v=>project(v,set));
 const result={};
 for(const f of set.selections){if(f.kind==='InlineFragment'){Object.assign(result,project(value,f.selectionSet));continue;}
 const key=f.alias?.value??f.name.value;result[key]=f.selectionSet?project(value[key],f.selectionSet):(key==='__typename'?(value[key]??(value.id?.startsWith('gid://shopify/Customer/')?'Customer':'SellingPlanAllocation')):(value[key]??null));}
 return result;
}
try {
 suite=await buildCases({labVariants});const {cases}=suite;
 if(shippingOnly){
  assert.ok(bound,'Shipping discovery requires V2');
  const base=cases.find(([name])=>name==='valid')[1];
  for(const [name,valid,code] of [['test-service-valid',true,'BFL_SHIPPO_c355361391ae286b9b8d2d4bf6057208a9161b0a5865ac1956d083a9eb46a9c4'],['test-service-invalid',false,'BFL_SHIPPO_c355361391ae286b9b8d2d4bf6057208a9161b0a5865ac1956d083a9eb46a9c4'],['other-service-hidden',true,'F02_TEST_PRINT']]){
   const input=structuredClone(base);input.cart.deliveryGroups[0].deliveryOptions=[{handle:'test',deliveryMethodType:'SHIPPING',code}];if(!valid)input.cart.binding.value='f'.repeat(64);
   assert.equal(functions.cartDeliveryOptionsTransformRun(input).operations.length,name==='test-service-valid'?0:1);cases.push([name,input]);
  }
 }
 assert.match(readFileSync(join(app,'shopify.app.staging.toml'),'utf8'),/client_id = "002722c8effe5d2e3243467181b45833"/);
 cpSync(join(app,'shopify.app.staging.toml'),join(temp,'shopify.app.staging.toml'));
 cpSync(join(app,'package.json'),join(temp,'package.json'));
 cpSync(join(app,'checkout'),join(temp,'checkout'),{recursive:true,filter:p=>!p.split('/').includes('target')});
 const cargo=process.env.BFL_CARGO??'cargo';
 const lockPath=join(app,bound?'checkout/candidate-toolchain-v2.lock.json':'checkout/candidate-toolchain.lock.json');
 if(retention) {
  manifest.toolchain=assertToolchain(cargo,app,lockPath);
  // Capture only build/reference inputs, never credentials, runtime state or the app's .shopify directory.
  const sources=['checkout/rust/Cargo.toml','checkout/rust/Cargo.lock','checkout/rust/src/lib.rs',
   'checkout/authority.js','checkout/functions.js',...(fullProduct?['checkout/full-product-cases.mjs']:[]),'checkout/verify-wasm-f06b.mjs','checkout/candidate-bundle.mjs',
   ...(bound?['checkout/candidate-toolchain-v2.lock.json','checkout/candidate-bundle-v2-readme.txt']:['checkout/candidate-toolchain.lock.json','checkout/candidate-bundle-readme.txt']),'shopify.app.staging.toml','package.json','package-lock.json'];
  for(const source of sources) {
   retainFile(retention.pending,join(app,source),`source/${source}`);
   manifest.source_sha256[`apps/film-printing-staging/${source}`]=digest(join(app,source));
  }
  retainFile(retention.pending,join(repository,'fixtures/film-printing/f06b/wasm-results.json'),'reference/f06b-wasm-results.json');
  retainFile(retention.pending,join(repository,'fixtures/film-printing/f06b/cases.mjs'),'reference/cases.mjs');
  retainFile(retention.pending,join(repository,'fixtures/film-printing/f06a/synthetic.mjs'),'reference/synthetic.mjs');
  if(eligibility){retainFile(retention.pending,join(repository,'fixtures/film-printing/f06v3-candidate/cases.mjs'),'reference/v3-cases.mjs');manifest.source_sha256['fixtures/film-printing/f06v3-candidate/cases.mjs']=digest(join(repository,'fixtures/film-printing/f06v3-candidate/cases.mjs'));}
  if(bound)for(const name of ['cases.mjs','synthetic.mjs'])retainFile(retention.pending,join(repository,'fixtures/film-printing/f06p-candidate',name),`reference/v2-${name}`);
  for(const name of Object.keys(specs))retainFile(retention.pending,join(repository,'fixtures/film-printing/f06a',`${templateName(name)}-synthetic.json`),`reference/f06a-${name}.json`);
 }
 execFileSync(cargo,['build','--offline','--locked','--manifest-path',join(temp,'checkout/rust/Cargo.toml'),'--target','wasm32-unknown-unknown','--release'],{stdio:'inherit',cwd:temp,env:{...process.env,CARGO_TARGET_DIR:join(temp,'checkout/rust/target')}});
 const wasm=join(temp,'checkout/rust/target/wasm32-unknown-unknown/release/bfl_checkout.wasm');
 results.rustc=execFileSync(cargo.replace(/cargo$/,'rustc'),['--version'],{encoding:'utf8'}).trim();
 results.toolchain=execFileSync(cargo,['--version'],{encoding:'utf8'}).trim();
 results.raw_wasm_sha256=createHash('sha256').update(readFileSync(wasm)).digest('hex');
 symlinkSync(join(app,'node_modules'),join(temp,'node_modules'),'dir');
 process.env.SHOPIFY_FLAG_APP_CONFIG='staging';process.env.SHOPIFY_FLAG_STORE='bellows-film-printing-staging.myshopify.com';process.env.SHOPIFY_FLAG_PATH=temp;
 for(const [name,[file,target,exportName]] of Object.entries(specs)) {
  const dir=join(temp,'extensions',retention?`f06${bound?"p":"b"}-candidate-${name}`:`f02-print-${templateName(name)}`);mkdirSync(join(dir,'src'),{recursive:true});
  const template=templateName(name);
  for(const source of ['schema.graphql','shopify.extension.toml','package.json','vite.config.js'])cpSync(join(app,'extensions',`f02-print-${templateName(name)}`,source),join(dir,source));
  cpSync(join(app,'extensions',`f02-print-${templateName(name)}`,'locales'),join(dir,'locales'),{recursive:true});
  cpSync(join(app,'checkout',queryDirectory,`${name}.graphql`),join(dir,'src',`${file}.graphql`));
  writeFileSync(join(dir,'src','index.js'),`export { ${exportName} } from '../../../checkout/functions.js';\n`);
  // Shopify CLI must trampoline/optimize Rust's raw Wasm before the runner can execute it.
  // Only this temporary extension copy is modified; the released configuration stays intact.
  mkdirSync(join(dir,'dist'),{recursive:true});
  const configPath=join(dir,'shopify.extension.toml');
  writeFileSync(configPath,readFileSync(configPath,'utf8').replace('command = ""','command = "cp ../../checkout/rust/target/wasm32-unknown-unknown/release/bfl_checkout.wasm dist/function.wasm"').replace(`export = "${target.replaceAll('.','-')}"`,`export = "${file}"`).replace(`src/${target.replaceAll('.','_')}.graphql`,`src/${file}.graphql`));
  if(eligibility)writeFileSync(configPath,readFileSync(configPath,'utf8').replace(/^(\s*input_query = .*\n)/m,'$1  input_variables = { namespace = "$app:bfl-checkout", key = "lease_v3" }\n'));
  if(retention)writeFileSync(configPath,readFileSync(configPath,'utf8')
   .replace(/^uid = .*\n/m,'').replace(`handle = "f02-print-${name}"`,`handle = "f06b-candidate-${name}"`)
   .replace('name = "t:name"',`name = "F06${bound?"P":"B"} unreleased ${name} candidate"`)
   .replace('description = "t:description"','description = "Unreleased F06B authority candidate; local build verification only"'));
  const built=await buildFunction(dir);assert.equal(built.success,true);
  if(retention)writeFileSync(join(output,`${name}-build.log`),built.output+'\n');

  const info=await getFunctionInfo(dir),schema=await loadSchema(info.schemaPath),query=await loadInputQuery(join(dir,'src',`${file}.graphql`));
  let cost=0;visit(query,{Field(n,key,parent,path,ancestors){if(n.name.value==='metafield')cost+=3;else if(n.name.value!=='__typename' && !n.selectionSet && !(n.name.value==='value' && ancestors.some(a=>a?.kind==='Field' && a.name?.value==='metafield')))cost++;}});
  results.cli_version=execFileSync('shopify',['version'],{encoding:'utf8',env:process.env}).trim();
  results.runner=execFileSync(info.functionRunnerPath,['--version'],{encoding:'utf8'}).trim();
  const bytes=statSync(join(dir,'src',`${file}.graphql`)).size;assert.ok(cost<=30);assert.ok(bytes<=3000);
  let testedWasm=info.wasmPath,testedQuery=join(dir,'src',`${file}.graphql`),testedSchema=info.schemaPath;
  if(retention) {
   const targetDir=`targets/${name}`;
   testedWasm=retainFile(retention.pending,info.wasmPath,`${targetDir}/function.wasm`);
   testedQuery=retainFile(retention.pending,testedQuery,`${targetDir}/${file}.graphql`);
   testedSchema=retainFile(retention.pending,info.schemaPath,`${targetDir}/schema.graphql`);
   retainFile(retention.pending,configPath,`${targetDir}/shopify.extension.toml`);
   manifest.targets[name]={target,export:file,api_version:'2026-07',function_id:null,
    wasm:`${targetDir}/function.wasm`,query:`${targetDir}/${file}.graphql`,schema:`${targetDir}/schema.graphql`,
    config:`${targetDir}/shopify.extension.toml`,fixtures:`evidence/${name}-matrix.json`};
   for(const source of [`checkout/${queryDirectory}/${name}.graphql`,`extensions/f02-print-${template}/schema.graphql`,`extensions/f02-print-${template}/shopify.extension.toml`])manifest.source_sha256[`apps/film-printing-staging/${source}`]=digest(join(app,source));
   assert.equal(digest(info.functionRunnerPath),manifest.toolchain.tools['function-runner-9.2.2'].sha256);
  }
  const testedHash=digest(testedWasm),records=[],fixtures=[];
  const historical=JSON.parse(readFileSync(join(repository,'fixtures/film-printing/f06a',`${templateName(name)}-synthetic.json`),'utf8')).fixture;
  const historicalInput=structuredClone(historical.input);
  if(fullProduct&&name==='specification')historicalInput.cart.deliveryGroups??=[];
  if(eligibility){historicalInput.leaseOwner={lease:{value:JSON.stringify({deadline:'1970-01-01T00:00:00',authority:JSON.parse(historicalInput.shop.authority.value)})}};historicalInput.shop.localTime.beforeDeadline=false;}
  const targetCases=[...cases,['historical-f06a-golden',historicalInput]];
  if(bound)manifest.required_cases=targetCases.map(([name])=>name);
  for(const [caseName,source] of targetCases) {
   const input=project(source,query.definitions[0].selectionSet);
   if(caseName.startsWith('near-128k')){
    if(name!=='specification')padInput(input);
    else {
     const bytes=127900;
     for(const line of input.cart.lines.filter(l=>l.merchandise?.id!=='gid://shopify/ProductVariant/67852705202287'))for(const key of ['signature','revision','config','job','size_mode','width','height','process','scanning','negatives']){
      if(Buffer.byteLength(JSON.stringify(input))>=bytes)break;
      line[key]={value:''};const remaining=bytes-Buffer.byteLength(JSON.stringify(input));assert.ok(remaining>=0);line[key].value='x'.repeat(Math.min(remaining,2000));
     }
     assert.equal(Buffer.byteLength(JSON.stringify(input)),bytes);
    }
   }
   const expectedOutput=functions[exportName](input);
   suite.assertOutput?.(caseName,name,input,expectedOutput);
   if(caseName==='historical-f06a-golden'&&!bound)assert.deepEqual(expectedOutput,historical.expectedOutput);
   if(caseName==='historical-f06a-golden'&&bound)assert.equal((await import('./authority.js')).inspectCart(input).valid,false,'V1 grant must not authorize V2');
   const fixture={target,export:file,input,expectedOutput};
   const validation=await validateTestAssets({schema,fixture,inputQueryAST:query});
   // The pinned helper omits GraphQL's built-in __typename on Customer from its
   // fixture field map. Validate that one field against the actual query here;
   // retain it in the fixture passed to the compiled Function runner.
   if((shippingOnly||eligibility)&&input.cart.buyerIdentity?.customer?.__typename==='Customer') {
    assert.match(readFileSync(testedQuery,'utf8'),/customer\s*\{\s*__typename\s*\}/);
    validation.inputFixture.errors=validation.inputFixture.errors.filter(e=>!(e.message==='Extra field `__typename` found in fixture data not in query'&&JSON.stringify(e.path)===JSON.stringify(['cart','buyerIdentity','customer','__typename'])));
   }
   for(const k of ['inputQuery','inputFixture','outputFixture'])assert.deepEqual(validation[k].errors,[],`${name}/${caseName}/${k}`);
   const run=await runFunction(fixture,info.functionRunnerPath,testedWasm,testedQuery,testedSchema);
   assert.equal(run.error,null,`${name}/${caseName}`);assert.deepEqual(run.result.output,expectedOutput);
   const withinBudget=run.metadata.instructionCount<11000000;
   assert.ok(withinBudget,`${name}/${caseName}: ${run.metadata.instructionCount} instructions`);
   assert.ok(run.metadata.instructionCount<results.regression_ceiling,`${name}/${caseName}: runtime margin regression`);assert.ok(statSync(info.wasmPath).size<=256000);
   const inputBytes=Buffer.byteLength(JSON.stringify(input)),outputBytes=Buffer.byteLength(JSON.stringify(run.result.output));
   assert.ok(inputBytes<=128000,`${name}/${caseName}: input ${inputBytes}`);
   assert.ok(outputBytes<=20000);assert.ok(run.metadata.memoryUsageKiB*1024<=10000000);
   records.push({case:caseName,within_instruction_budget:withinBudget,within_regression_ceiling:run.metadata.instructionCount<results.regression_ceiling,input_bytes:inputBytes,output_bytes:outputBytes,...run.metadata});
   if(retention)fixtures.push({case:caseName,...fixture});
   if(caseName==='valid')writeFileSync(join(output,`${name}-synthetic.json`),JSON.stringify({synthetic_offline_only:true,fixture},null,2)+'\n');
  }
  assert.equal(digest(testedWasm),testedHash,'Tested Wasm changed during execution');
  assert.equal(digest(info.wasmPath),testedHash,'Retained bytes differ from compiled bytes');
  if(retention)writeFileSync(join(output,`${name}-matrix.json`),JSON.stringify(fixtures)+'\n');
  results.functions[name]={query_bytes:bytes,query_cost:cost,wasm_bytes:statSync(info.wasmPath).size,wasm_sha256:createHash('sha256').update(readFileSync(info.wasmPath)).digest('hex'),cases:records};
  if(retention)Object.assign(results.functions[name],{target,export:file,query_sha256:digest(testedQuery),schema_sha256:digest(testedSchema),config_sha256:digest(configPath)});
  console.log(`${name}: ${records.length} compiled cases pass; max ${Math.max(...records.map(r=>r.instructionCount))} instructions; query cost ${cost}`);
 }
 writeFileSync(join(output,'wasm-results.json'),JSON.stringify(results,null,2)+'\n');
 if(retention) {
  assertToolchain(cargo,app,lockPath);
  for(const [name,hash] of Object.entries(manifest.source_sha256))assert.equal(digest(join(repository,name)),hash,`Source changed during build: ${name}`);
  manifest.build={cargo:['build','--offline','--locked','--target','wasm32-unknown-unknown','--release'],
   shopify:['app function build --path <temporary extension>','app function info --json --path <temporary extension>'],
   environment:{SHOPIFY_FLAG_APP_CONFIG:'staging',SHOPIFY_FLAG_STORE:manifest.store,SHOPIFY_FLAG_PATH:'<temporary absolute app path>'},
   postprocessing:'Shopify CLI trampoline 2.0.1 then wasm-opt -Oz; pinned CLI and tool bytes',raw_wasm_sha256:results.raw_wasm_sha256};
  manifest.verification={compiled_cases:Object.values(results.functions).reduce((n,f)=>n+f.cases.length,0),retained_bytes_executed:true,instruction_limit:11000000,regression_ceiling:8000000,
   source_behavior:fullProduct?'V4 complete specification split across two fail-closed validations':eligibility?'V3 immutable unit eligibility, quantity signature and original Function deadline':bound?'V2 protected binding/current-job contract; legacy fixtures retained as history':'Unchanged Rust, queries and JS reference; all F06B case names retained',external_requests:0};
  retainFile(retention.pending,join(app,fullProduct?'checkout/candidate-bundle-v4-readme.txt':eligibility?'checkout/candidate-bundle-v3-readme.txt':bound?'checkout/candidate-bundle-v2-readme.txt':'checkout/candidate-bundle-readme.txt'),'README.txt');
  console.log(`Retained verified candidate: ${retention.publish(manifest)}`);
 }
} catch(error) {if(retention)retention.fail(error);throw error;}
finally {suite?.close();rmSync(temp,{recursive:true,force:true});}
