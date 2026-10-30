// Local artifact custody only. No deployment, registration, network or readiness.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {cpSync,existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,realpathSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {basename,dirname,isAbsolute,join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
export function inventory(root) {
  const entries={};
  function visit(dir) {
    for(const name of readdirSync(dir).sort()) {
      const path=join(dir,name),s=lstatSync(path);
      assert.ok(!s.isSymbolicLink(),`Symlink forbidden: ${path}`);
      if(s.isDirectory())visit(path);
      else {assert.ok(s.isFile());entries[relative(root,path)]={sha256:digest(path),bytes:s.size};}
    }
  }
  visit(root);return entries;
}
export function beginRetention(destination) {
  const root=join(realpathSync(dirname(resolve(destination))),basename(destination));
  // Exclusive reservation: an existing reviewed, failed, empty or symlink path
  // is never reused. A crash leaves INCOMPLETE, never a successful manifest.
  mkdirSync(root);
  writeFileSync(join(root,'INCOMPLETE'),'Unreleased candidate build is incomplete. Do not use.\n',{flag:'wx'});
  const pending=join(root,'.pending');mkdirSync(pending);
  return {
    root,pending,
    publish(manifest) {
      manifest.files=inventory(pending);
      writeFileSync(join(pending,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
      writeFileSync(join(pending,'manifest.sha256'),digest(join(pending,'manifest.json'))+'\n',{flag:'wx'});
      verifyBundle(pending);
      renameSync(pending,join(root,'candidate'));
      rmSync(join(root,'INCOMPLETE'));
      return join(root,'candidate');
    },
    fail(error) {writeFileSync(join(root,'failure.json'),JSON.stringify({status:'incomplete',error:String(error.message??error),checkout_ready:false},null,2)+'\n',{flag:'wx'});},
  };
}

// A checked-in lock pins the actual locally used compiler, Wasm standard library,
// CLI bundle, runner, trampoline and optimizer. Cargo.lock separately pins crates.
// Paths are discovered locally; these functions never install/download anything.
export function toolchain(cargo,app) {
  const rustc=cargo.replace(/cargo$/,'rustc');
  const sysroot=execFileSync(rustc,['--print','sysroot'],{encoding:'utf8'}).trim();
  const cliEntry=realpathSync(execFileSync('/usr/bin/which',['shopify'],{encoding:'utf8'}).trim());
  const cli=dirname(dirname(cliEntry)),bin=join(cli,'bin');
  const tree = path => {
    const files=inventory(path);
    return {sha256:createHash('sha256').update(JSON.stringify(files)).digest('hex'),files};
  };
  return {
    platform:process.platform,arch:process.arch,node:process.version,
    node_binary_sha256:digest(process.execPath),
    rustc:execFileSync(rustc,['--version'],{encoding:'utf8'}).trim(),
    cargo:execFileSync(cargo,['--version'],{encoding:'utf8'}).trim(),
    rustc_binary_sha256:digest(join(sysroot,'bin/rustc')),
    cargo_binary_sha256:digest(join(sysroot,'bin/cargo')),
    rust_libraries:tree(join(sysroot,'lib')),
    cli_version:JSON.parse(readFileSync(join(cli,'package.json'),'utf8')).version,
    cli_package_sha256:digest(join(cli,'package.json')),
    cli_entry_sha256:digest(cliEntry),cli_dist:tree(join(cli,'dist')),
    tools:Object.fromEntries(['function-runner-9.2.2','shopify-function-trampoline-2.0.1','wasm-opt.cjs'].map(n=>[n,{sha256:digest(join(bin,n)),bytes:lstatSync(join(bin,n)).size}])),
    test_helpers:tree(join(app,'node_modules/@shopify/shopify-function-test-helpers')),
    graphql:tree(join(app,'node_modules/graphql')),
  };
}
export function assertToolchain(cargo,app,lockPath) {
  const actual=toolchain(cargo,app),locked=JSON.parse(readFileSync(lockPath,'utf8'));
  assert.deepEqual(actual,locked,'Toolchain drift: review and repin separately before building a candidate');
  for(const key of Object.keys(process.env).filter(k=>/^(RUSTFLAGS|RUSTC.*|CARGO_.*(RUSTFLAGS|RUSTC|LINKER))$/.test(k))) {
    assert.ok(!process.env[key],`Unreviewed compiler override ${key}`);
  }
  if(process.env.CARGO_HOME)for(const name of ['config','config.toml'])assert.ok(!existsSync(join(process.env.CARGO_HOME,name)),`Unreviewed Cargo config ${name}`);
  return actual;
}

export function retainFile(root,source,name) {
  assert.ok(!isAbsolute(name) && !name.split('/').includes('..'));
  const destination=join(root,name);mkdirSync(dirname(destination),{recursive:true});
  cpSync(source,destination,{errorOnExist:true,force:false});
  assert.equal(digest(destination),digest(source));return destination;
}
export function verifyBundle(root) {
  root=resolve(root);
  assert.ok(!lstatSync(root).isSymbolicLink());
  const manifestPath=join(root,'manifest.json');
  assert.equal(digest(manifestPath),readFileSync(join(root,'manifest.sha256'),'utf8').trim(),'Manifest digest mismatch');
  const m=JSON.parse(readFileSync(manifestPath,'utf8'));
  assert.equal(m.status,'unreleased-candidate');assert.equal(m.checkout_ready,false);
  assert.equal(m.release_id,null);assert.equal(m.store,'bellows-film-printing-staging.myshopify.com');
  assert.equal(m.client_id,'002722c8effe5d2e3243467181b45833');
  const files=inventory(root);delete files['manifest.json'];delete files['manifest.sha256'];
  assert.deepEqual(files,m.files,'Artifact file set or digest mismatch');
  const read = name => {assert.ok(Object.hasOwn(files,name),`Unpinned file ${name}`);return JSON.parse(readFileSync(join(root,name),'utf8'));};
  const results=read('evidence/wasm-results.json');
  const historical=read('reference/f06b-wasm-results.json');
  assert.deepEqual(Object.keys(m.targets).sort(),m.bundle_scope==='staging-shipping-discovery'?['delivery']:[4,5].includes(m.authority_schema)?['delivery','lab','pricing','specification','validation']:['delivery','lab','pricing','validation']);
  let count=0;
  for(const [name,t] of Object.entries(m.targets)) {
    const targets={specification:['cart.validations.generate.run','cart_specification_validations_generate_run'],pricing:['cart.transform.run','cart_transform_run'],validation:['cart.validations.generate.run','cart_validations_generate_run'],lab:['cart.fulfillment-constraints.generate.run','cart_fulfillment_constraints_generate_run'],delivery:['cart.delivery-options.transform.run','cart_delivery_options_transform_run']};
    assert.deepEqual([t.target,t.export],targets[name]);
    assert.equal(t.function_id,null);assert.equal(t.api_version,'2026-07');
    for(const p of [t.wasm,t.query,t.schema,t.config,t.fixtures])assert.ok(Object.hasOwn(files,p));
    const r=results.functions[name],fixtures=read(t.fixtures);
    assert.equal(r.target,t.target);assert.equal(r.export,t.export);
    assert.equal(r.query_sha256,files[t.query].sha256);assert.equal(r.schema_sha256,files[t.schema].sha256);assert.equal(r.config_sha256,files[t.config].sha256);
    assert.equal(r.wasm_sha256,files[t.wasm].sha256);assert.equal(r.wasm_bytes,files[t.wasm].bytes);
    assert.ok(r.wasm_bytes<=256000);assert.ok(r.query_cost<=30);assert.ok(r.query_bytes<=3000);
    assert.equal(files[t.query].bytes,r.query_bytes);
    const required=m.authority_schema>=2?m.required_cases:historical.functions[name].cases.map(c=>c.case);
    assert.ok(Array.isArray(required)&&required.length>=110);
    if(m.authority_schema===2)for(const n of ['v2-identical-replacement','v2-quantity-roundtrip','v2-marker-missing','v2-duplicate-current-job','200-unrelated-200-groups','near-128k-valid-mixed','historical-f06a-golden'])assert.ok(required.includes(n));
    if(m.authority_schema>=3)for(const n of ['v3-subset','v3-remove-all','v3-quantity-1','v3-quantity-5','v3-quantity-stale-wrapper','v3-deadline-equality','v3-deadline-past','v3-deadline-mismatch','v3-expired-sentinel','v3-owner-field-absent','v3-authority-6001-bytes','200-unrelated-200-groups','near-128k-valid-mixed','historical-f06a-golden'])assert.ok(required.includes(n));
    if(m.authority_schema===5)for(const n of ['v5-miami-photo-valid','v5-chicago-custom-valid','v5-orlando-darkroom-valid','v5-atlanta-photo-valid','v5-mixed-three-labs','v5-actual-variant-swapped','v5-signed-variant-wrong-lab','v5-legacy4-rejects-variant-field'])assert.ok(required.includes(n));
    assert.equal(r.cases.length,required.length);assert.equal(fixtures.length,required.length);
    assert.deepEqual(r.cases.map(c=>c.case),required);
    assert.equal(new Set(r.cases.map(c=>c.case)).size,required.length);
    for(let n=0;n<r.cases.length;n++) {
      const c=r.cases[n],f=fixtures[n];count++;
      assert.equal(c.case,f.case);assert.equal(f.target,t.target);assert.equal(f.export,t.export);
      assert.equal(c.input_bytes,Buffer.byteLength(JSON.stringify(f.input)));
      assert.equal(c.output_bytes,Buffer.byteLength(JSON.stringify(f.expectedOutput)));
      assert.equal(c.within_instruction_budget,true);assert.equal(c.within_regression_ceiling,true);
      assert.ok(c.instructionCount>0 && c.instructionCount<8000000 && c.instructionCount<11000000);
      assert.ok(c.input_bytes<=128000 && c.output_bytes<=20000 && c.memoryUsageKiB*1024<=10000000);
    }
    const config=readFileSync(join(root,t.config),'utf8');
    assert.ok(!/^\s*uid\s*=/m.test(config),'Historical UID in candidate config');
    assert.ok(config.includes(`export = "${t.export}"`) && config.includes(`target = "${t.target}"`));
    if(m.authority_schema>=3){
      assert.match(config,/input_variables\s*=\s*\{\s*namespace\s*=\s*"\$app:bfl-checkout",\s*key\s*=\s*"lease_v3"\s*\}/);
      const query=readFileSync(join(root,t.query),'utf8');assert.match(query,/\$deadline:\s*DateTimeWithoutTimezone!/);assert.match(query,/beforeDeadline:\s*dateTimeBefore\(dateTime:\s*\$deadline\)/);
      assert.equal(r.query_cost,{pricing:27,validation:30,lab:29,delivery:30,specification:28}[name]);
      if([4,5].includes(m.authority_schema))for(const name of ['v4-photo-valid','v4-custom-valid','v4-darkroom-valid','v4-custom-tall','v4-custom-tamper-width','v4-darkroom-tamper-process'])assert.ok(required.includes(name));
    }
  }
  assert.equal(count,m.authority_schema>=2?m.required_cases.length*Object.keys(m.targets).length:440);
  return {status:'local-custody-verified',compiled_cases:count,checkout_ready:false,manifest_sha256:digest(manifestPath)};
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  assert.ok(process.argv.length===4 && process.argv[2]==='verify','Usage: node candidate-bundle.mjs verify /absolute/path/to/candidate');
  console.log(JSON.stringify(verifyBundle(process.argv[3]),null,2));
}
