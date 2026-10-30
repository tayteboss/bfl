import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,cpSync,existsSync,readFileSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {beginRetention,digest,inventory,verifyBundle} from '../checkout/candidate-bundle.mjs';
const source=resolve(process.env.BFL_CANDIDATE_BUNDLE??'fixtures/film-printing/f06b-continuation/attempt-02/candidate');
function workspace(t) {const dir=mkdtempSync(join(tmpdir(),'bfl-custody-test-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}
function copy(t) {const dir=join(workspace(t),'copy');cpSync(source,dir,{recursive:true});return dir;}
function manifest(dir,change) {const p=join(dir,'manifest.json'),m=JSON.parse(readFileSync(p));change(m);writeFileSync(p,JSON.stringify(m));writeFileSync(join(dir,'manifest.sha256'),digest(p)+'\n');}
test('retained candidate verifies all four targets and 440 measured fixtures without building',()=>{assert.equal(verifyBundle(source).compiled_cases,440);});
test('existing reviewed destination, empty directory and symlink cannot be reserved or replaced',t=>{
 const dir=workspace(t),reviewed=join(dir,'reviewed');mkdirSync(reviewed);writeFileSync(join(reviewed,'proof'),'original');
 assert.throws(()=>beginRetention(reviewed),/EEXIST/);assert.equal(readFileSync(join(reviewed,'proof'),'utf8'),'original');
 const empty=join(dir,'empty');mkdirSync(empty);assert.throws(()=>beginRetention(empty),/EEXIST/);
 const link=join(dir,'link');symlinkSync(reviewed,link);assert.throws(()=>beginRetention(link),/EEXIST/);
});
test('failed publication remains incomplete and cannot overwrite a previously published candidate',t=>{
 const dir=workspace(t),r=beginRetention(join(dir,'failed'));writeFileSync(join(r.pending,'partial'),'partial');
 assert.throws(()=>r.publish({status:'invalid'}));r.fail(Error('synthetic packaging failure'));
 assert.ok(existsSync(join(r.root,'INCOMPLETE')));assert.ok(existsSync(join(r.root,'failure.json')));assert.ok(!existsSync(join(r.root,'candidate')));
 assert.throws(()=>beginRetention(r.root),/EEXIST/);assert.equal(readFileSync(join(r.pending,'partial'),'utf8'),'partial');
});
test('interrupted process cannot leave a successful artifact or reusable destination',t=>{
 const path=join(workspace(t),'interrupted'),module=new URL('../checkout/candidate-bundle.mjs',import.meta.url).href;
 assert.throws(()=>execFileSync(process.execPath,['--input-type=module','-e',`import {beginRetention} from ${JSON.stringify(module)}; beginRetention(${JSON.stringify(path)}); process.kill(process.pid,'SIGKILL');`]));
 assert.ok(existsSync(join(path,'INCOMPLETE')));assert.ok(!existsSync(join(path,'candidate')));assert.throws(()=>beginRetention(path),/EEXIST/);
});
test('binary corruption, extra files, missing schema and symlinks fail custody',t=>{
 for(const mutate of [d=>writeFileSync(join(d,'targets/pricing/function.wasm'),'tamper'),d=>writeFileSync(join(d,'extra'),'extra'),d=>rmSync(join(d,'targets/lab/schema.graphql')),d=>{rmSync(join(d,'targets/lab/schema.graphql'));symlinkSync(join(source,'targets/lab/schema.graphql'),join(d,'targets/lab/schema.graphql'));}]) {
  const dir=copy(t);mutate(dir);assert.throws(()=>verifyBundle(dir));
 }
});
test('query/schema mapping drift is caught even when the top-level manifest digest is updated',t=>{
 for(const field of ['query','schema']){const dir=copy(t);manifest(dir,m=>m.targets.pricing[field]=m.targets.validation[field]);assert.throws(()=>verifyBundle(dir));}
});
test('release IDs, target/export drift and readiness flags cannot appear in this candidate',t=>{
 for(const mutate of [m=>m.release_id='invented',m=>m.checkout_ready=true,m=>m.targets.pricing.function_id='invented',m=>m.targets.pricing.export='wrong']){const dir=copy(t);manifest(dir,mutate);assert.throws(()=>verifyBundle(dir));}
});
test('over-budget or reduced matrices fail even if evidence hashes are repinned',t=>{
 for(const mutate of [r=>r.functions.validation.cases.pop(),r=>r.functions.validation.cases[0].instructionCount=8000000]) {
  const dir=copy(t),p=join(dir,'evidence/wasm-results.json'),r=JSON.parse(readFileSync(p));mutate(r);writeFileSync(p,JSON.stringify(r));
  manifest(dir,m=>m.files['evidence/wasm-results.json']=inventory(join(dir,'evidence'))['wasm-results.json']);assert.throws(()=>verifyBundle(dir));
 }
});
test('actual harness refuses an existing destination before compilation and preserves every byte',()=>{
 const destination=resolve(source,'..'),before=inventory(destination);
 assert.throws(()=>execFileSync(process.execPath,[new URL('../checkout/verify-wasm-f06b.mjs',import.meta.url).pathname,'--retain-bundle',destination],{stdio:'pipe'}),/Command failed/);
 assert.deepEqual(inventory(destination),before);
});
