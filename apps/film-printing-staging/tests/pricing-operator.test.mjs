import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,chmodSync,rmSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync,fork} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {STORE,APP,CLIENT} from '../configuration/schema.mjs';
import {INSTALLATION} from '../backend/config.mjs';
import {initializeDatabase,openDatabase,releaseAbandonedLock} from '../backend/storage.mjs';
import {runPricingOperator} from '../pricing/operator.mjs';
import {createPricingTransport,IDENTITY_QUERY,TARGET_QUERY,COMMIT} from '../pricing/operator-admin.mjs';
import {CONTEXT_QUERY} from '../checkout/shopify.mjs';
import {decodeAuthority} from '../checkout/authority.js';
import {input,bundle,prepared,syntheticAdmin,approve,field,now} from '../../../fixtures/film-printing/f05a-continuation/operator-fixture.mjs';

const cli=fileURLToPath(new URL('../pricing/operator-cli.mjs',import.meta.url));
const root=fileURLToPath(new URL('../../../fixtures/film-printing/f05a/',import.meta.url));
const keys={jobSecret:'offline-job-secret-'.repeat(3),sessionSecret:'offline-session-secret-'.repeat(3),adminToken:'offline-admin-token-'.repeat(3)};
function fixture(t,{initialize=true}={}) {
  const dir=mkdtempSync(join(tmpdir(),'bfl-pricing-operator-'));chmodSync(dir,0o700);t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const config={store:STORE,app:APP,clientId:CLIENT,installation:INSTALLATION,dataDir:dir,mode:'disabled',...keys};
  if(initialize)config.databaseId=initializeDatabase(config);
  const mock=syntheticAdmin(),base={config,input:input(),prepared,now,allWritersStopped:true,fetchImpl:mock.fetch};
  return {dir,config,mock,base,run:(action,review,patch={})=>runPricingOperator({...base,action,mode:action,review,...patch})};
}
const review=async f=>approve(await f.run('inspect'));
function state(f){const db=openDatabase(f.config,{now:()=>now().getTime()});try{return db.store.lifecycle.state();}finally{db.close();}}
function envFor(f) {
  const env={...process.env,BFL_STORE:STORE,BFL_APP:APP,BFL_CLIENT_ID:CLIENT,BFL_INSTALLATION:INSTALLATION,BFL_STORAGE:'local-persistent',
    BFL_DATA_DIR:f.dir,BFL_DATABASE_ID:f.config.databaseId,BFL_ADMIN_WRITES:'disabled',BFL_ALL_WRITERS_STOPPED:'yes'};
  for(const [name,key] of [['JOB','jobSecret'],['SESSION','sessionSecret'],['ADMIN','adminToken']]) {
    const path=join(f.dir,`${key}.txt`);writeFileSync(path,keys[key],{mode:0o600});env[`BFL_${name}_SECRET_FILE`]=path;
    if(name==='ADMIN'){delete env.BFL_ADMIN_SECRET_FILE;env.BFL_ADMIN_TOKEN_FILE=path;}
  }
  for(const key of ['BFL_JOB_SECRET','BFL_SESSION_SECRET','BFL_ADMIN_TOKEN','BFL_APP_SECRET','BFL_APP_SECRET_FILE','NODE_UNIQUE_ID','BFL_PRICING_OPERATOR'])delete env[key];
  env.WEB_CONCURRENCY='1';return env;
}
const cliArgs=(action,reviewPath,out)=>[action,root,join(root,'reviewed-mapping.json'),join(root,'proposed'),bundle.version,reviewPath,out];

test('F05A operator default and action/mode mismatch perform no network or database access',async t=>{
  const f=fixture(t,{initialize:false});
  for(const patch of [{mode:'disabled'},{mode:'recover'},{allWritersStopped:false},{config:{...f.config,mode:'reconcile-only'}}])await assert.rejects(f.run('apply',null,patch));
  assert.equal(f.mock.calls.length,0);assert.equal(existsSync(join(f.dir,'jobs.sqlite')),false);
});
test('F05A inspect is unapproved, records exact absence/digests/bytes and omits authority grants',async t=>{
  const f=fixture(t),s=await f.run('inspect');
  assert.equal(s.status,'unreviewed_do_not_apply');assert.equal(s.current.form,null);assert.equal(s.current.catalog,null);
  assert.equal(s.approved_at,null);assert.equal(s.source_refresh,null);assert.equal(s.current_values.form,null);assert.equal(f.mock.writes.length,0);
  assert.equal(JSON.stringify(s).includes('grants'),false);await assert.rejects(f.run('apply',s),/APPROVAL_REQUIRED/);
});
test('F05A import creates absent form/catalog in one five-owner-field transaction through F06D',async t=>{
  const f=fixture(t),r=await review(f),result=await f.run('apply',r);
  assert.equal(result.checkout_ready,false);assert.equal(result.price_version,bundle.version);assert.equal(result.status,'imported_empty_authority');
  assert.equal(f.mock.writes.length,1);assert.equal(f.mock.writes[0].length,5);
  for(const key of ['price_catalog','film_services_json'])assert.equal(f.mock.writes[0].find(f=>f.key===key).compareDigest,null);
  assert.equal(f.mock.data.product.form.value,bundle.formValue);assert.equal(f.mock.data.currentAppInstallation.catalog.value,bundle.value);
  assert.deepEqual(decodeAuthority(f.mock.data.shop.authority.value).grants,[]);assert.equal(state(f).operation,null);assert.equal(state(f).epoch,1);
});
test('F05A existing form/catalog need explicit review and exact current CAS; values are not merged',async t=>{
  const f=fixture(t);f.mock.data.product.form=field('{"old":"form"}');f.mock.data.currentAppInstallation.catalog=field(JSON.stringify({store:STORE,currency:'USD',rows:[]}));
  const r=await review(f);assert.equal(r.current_values.form,'{"old":"form"}');await f.run('apply',r);
  for(const [key,old] of [['film_services_json',r.current.form],['price_catalog',r.current.catalog]])assert.equal(f.mock.writes[0].find(f=>f.key===key).compareDigest,old.compare_digest);
  assert.equal(f.mock.data.product.form.value,bundle.formValue);
});
test('F05A exact bundle/version, approval, source freshness, unavailable gate and database binding reject before network',async t=>{
  const f=fixture(t),r=await review(f),calls=f.mock.calls.length;
  const changes=[r=>{r.target.store='1jukgy-dc.myshopify.com';},r=>{r.database_id='wrong';},r=>{r.bundle.price_version='price-wrong';},r=>{r.status='unreviewed_do_not_apply';},
    r=>{r.unavailable_gate_evidence='';},r=>{r.approved_at='2026-10-22T12:00:00Z';},r=>{r.expires_at='2026-10-21T11:59:00Z';},r=>{r.expires_at='2026-10-25T12:00:00Z';},
    r=>{r.source_refresh=null;},r=>{r.source_refresh.capture.captured_at='2026-10-19T12:00:00Z';},r=>{r.source_refresh.capture.theme.id='1';},r=>{r.source_refresh.evidence='';},
    r=>{delete r.current.form;},r=>{r.current_values.form='invented';},r=>{r.extra='unexpected';}];
  for(const change of changes){const s=structuredClone(r);change(s);await assert.rejects(f.run('apply',s));}
  for(const p of [{...prepared,expectedVersion:'wrong'},{...prepared,catalogValue:prepared.catalogValue+' '},{...prepared,formValue:prepared.formValue+' '}])await assert.rejects(f.run('apply',r,{prepared:p}));
  assert.equal(f.mock.calls.length,calls);assert.equal(state(f).epoch,0);
});
test('F05A stale reviewed form, catalog, config, authority and fence reject without a mutation',async t=>{
  for(const key of ['form','catalog','active','authority','fence']) {
    const f=fixture(t),r=await review(f),d=f.mock.data;
    if(key==='form')d.product.form=field('{}');else if(key==='authority')d.shop.authority={...d.shop.authority,...field(d.shop.authority.value+' ')};
    else if(key==='catalog')d.currentAppInstallation.catalog=field(JSON.stringify({store:STORE,currency:'USD',rows:[]}));
    else d.currentAppInstallation[key]={...d.currentAppInstallation[key],value:d.currentAppInstallation[key].value+' ',compareDigest:'changed'};
    await assert.rejects(f.run('apply',r),/REVIEW_STALE/);assert.equal(f.mock.writes.length,0);
  }
});
test('F05A fresh identity and physical target checks reject wrong store/app/client/install/product/variant/handle',async t=>{
  const changes=[d=>{d.shop.myshopifyDomain='1jukgy-dc.myshopify.com';},d=>{d.shop.id='gid://shopify/Shop/1';},d=>{d.currentAppInstallation.id='other';},
    d=>{d.currentAppInstallation.app.id='other';},d=>{d.currentAppInstallation.app.apiKey='other';},d=>{d.product.id='other';},d=>{d.product.handle='film-printing';},
    d=>{d.productVariant.id='other';},d=>{d.productVariant.product.id='other';},d=>{d.productVariant.requiresComponents=true;},d=>{d.productVariant.inventoryItem.requiresShipping=false;}];
  for(const change of changes){const f=fixture(t);change(f.mock.data);await assert.rejects(f.run('inspect'));assert.equal(f.mock.writes.length,0);}
});
test('F05A missing/unprotected authority/fence cannot be provisioned by operator',async t=>{
  for(const change of [d=>{d.shop.authority=null;},d=>{d.currentAppInstallation.fence=null;},d=>{d.shop.authority.definition.access.admin='MERCHANT_READ_WRITE';}]) {
    const f=fixture(t),r=await review(f);change(f.mock.data);await assert.rejects(f.run('apply',r));assert.equal(f.mock.writes.length,0);
  }
});
test('F05A missing product write grant rejects source write and leaves durable recovery required',async t=>{
  const f=fixture(t),r=await review(f);f.mock.data.currentAppInstallation.accessScopes=[];
  await assert.rejects(f.run('apply',r),/PRODUCT_WRITE_ACCESS_REQUIRED/);assert.equal(f.mock.writes.length,0);assert.equal(state(f).operation.kind,'cutover');
  const result=await f.run('recover',r);assert.equal(result.source_state,'both_prior');assert.equal(f.mock.writes[0].length,3);
});
test('F05A each CAS race rejects the whole five-field import and recovery preserves actual sources',async t=>{
  for(const key of ['film_services_json','price_catalog','active_config','authority','authority_fence']) {
    const f=fixture(t),r=await review(f);
    f.mock.beforeWrite=async fields=>{fields.find(f=>f.key===key).compareDigest='stale';};
    await assert.rejects(f.run('apply',r),/WRITE_REJECTED/);
    assert.equal(f.mock.data.product.form,null);assert.equal(f.mock.data.currentAppInstallation.catalog,null);assert.equal(state(f).operation.kind,'cutover');
    f.mock.beforeWrite=null;assert.equal((await f.run('recover',r)).source_state,'both_prior');assert.equal(state(f).operation,null);
  }
});
test('F05A lost response before remote commit is not retried; explicit recovery fences a late old request',async t=>{
  const f=fixture(t),r=await review(f);let delayed;
  f.mock.beforeWrite=async fields=>{delayed=structuredClone(fields);throw Error('lost '+keys.adminToken);};
  await assert.rejects(f.run('apply',r),/ADMIN_UNAVAILABLE/);assert.equal(f.mock.writes.length,1);
  await assert.rejects(f.run('apply',r),/RECOVERY_REQUIRED/);assert.equal(f.mock.writes.length,1);
  f.mock.beforeWrite=null;const result=await f.run('recover',r);assert.equal(result.source_state,'both_prior');
  assert.equal(f.mock.transact(delayed).metafieldsSet.userErrors[0].code,'STALE_OBJECT');assert.equal(f.mock.data.product.form,null);
});
test('F05A lost successful response survives reopen; recovery observes proposed sources and never reapplies form',async t=>{
  const f=fixture(t),r=await review(f);f.mock.afterWrite=async()=>{throw Error('lost response');};
  await assert.rejects(f.run('apply',r),/ADMIN_UNAVAILABLE/);assert.equal(state(f).operation.kind,'cutover');
  assert.equal(f.mock.data.product.form.value,bundle.formValue);f.mock.afterWrite=null;
  assert.equal((await f.run('recover',r)).source_state,'both_proposed');assert.equal(f.mock.writes.length,2);assert.equal(f.mock.writes[1].length,4);
  assert.ok(f.mock.writes[1].every(f=>f.key!=='film_services_json'));assert.equal(state(f).operation,null);
  await assert.rejects(f.run('apply',r),/REVIEW_STALE/);
});
test('F05A failed form or catalog readback retains unknown operation until guarded clearing',async t=>{
  for(const change of [d=>{d.product.form=field('{}');},d=>{d.currentAppInstallation.catalog=field(JSON.stringify({store:STORE,currency:'USD',rows:[]}));}]) {
    const f=fixture(t),r=await review(f);f.mock.afterWrite=async()=>change(f.mock.data);
    await assert.rejects(f.run('apply',r),/READBACK_CHANGED/);assert.equal(state(f).operation.kind,'cutover');f.mock.afterWrite=null;
    assert.equal((await f.run('recover',r)).source_state,'mixed_or_changed');assert.equal(state(f).operation,null);
  }
});
test('F05A recovery can use expired review, preserves form drift, and keeps uncertainty when clearing fails',async t=>{
  const f=fixture(t),r=await review(f);r.expires_at='2026-10-19T00:00:00Z';f.mock.data.product.form=field('{}');
  f.mock.beforeWrite=async()=>{throw Error('network');};await assert.rejects(f.run('recover',r));assert.equal(state(f).operation.kind,'recovery');
  f.mock.beforeWrite=null;const result=await f.run('recover',r);assert.equal(result.source_state,'mixed_or_changed');assert.equal(f.mock.data.product.form.value,'{}');
});
test('F05A recovery cannot claim source state after a failed observation',async t=>{
  const f=fixture(t),r=await review(f);f.mock.readHook=async(q)=>{if(q===TARGET_QUERY)throw Error('unavailable');};
  const result=await f.run('recover',r);assert.equal(result.source_state,'unobserved');assert.equal(result.checkout_ready,false);assert.equal(state(f).operation,null);
});
test('F05A pending lifecycle/cart/upload invalidations block import and are retained until recovery',async t=>{
  const f=fixture(t),r=await review(f),db=openDatabase(f.config,{now:()=>now().getTime()});
  db.store.lifecycle.event('synthetic-invalidation',{id:1},()=>db.store.lifecycle.retire('owner','synthetic-owner'));
  db.store.recordUpload('synthetic-owner-2',{id:'asset-removed',state:'removed'});
  const cart=db.store.cartRefresh.begin('synthetic-owner-2','gid://shopify/Cart/synthetic?key=secret','synthetic-request-1');db.close();
  await assert.rejects(f.run('apply',r),/RECOVERY_REQUIRED/);assert.equal(state(f).pending,3);
  await f.run('recover',r);const after=openDatabase(f.config);assert.equal(after.store.lifecycle.retired('owner','synthetic-owner'),true);
  assert.equal(after.store.cartRefresh.status(cart.ticket).state,'revoked');assert.equal(after.store.lifecycle.state().pending,0);after.close();
});

test('F05A transport rejects injected fields, wrong owners, source edits and grants even with operator mode',async t=>{
  const f=fixture(t),r=await review(f);await f.run('apply',r);
  // Fresh unchanged-source clearing fields from the actual F06D writer.
  await f.run('recover',r);const original=structuredClone(f.mock.writes.at(-1));
  original.find(f=>f.key==='authority_fence').compareDigest=f.mock.data.currentAppInstallation.fence.compareDigest;
  original.find(f=>f.key==='authority_fence').value='00000000-0000-4000-8000-000000000001';
  const changes=[fields=>{fields.push({...fields[0],key:'extra'});},fields=>{fields[0].ownerId='gid://shopify/Shop/1';},
    fields=>{fields[0].namespace='custom';},fields=>{fields[0].extra=true;},fields=>{fields.find(f=>f.key==='active_config').value='{}';},
    fields=>{fields.find(f=>f.key==='price_catalog').value='{}';},fields=>{fields[0].value='{"grants":[{}]}';},fields=>{fields.find(f=>f.key==='authority_fence').value='invalid';}];
  for(const change of changes) {
    const fields=structuredClone(original);change(fields);const writes=f.mock.writes.length;
    const api=createPricingTransport(f.config,{mode:'recover',fetchImpl:f.mock.fetch});
    await assert.rejects(api(COMMIT,{fields}));assert.equal(f.mock.writes.length,writes);
  }
});

test('F05A request timeout aborts with no redirect or retry',async t=>{
  const f=fixture(t);let calls=0,aborted=false;
  const api=createPricingTransport(f.config,{mode:'inspect',timeoutMs:5,fetchImpl:async(url,opts)=>{
    calls++;assert.equal(opts.redirect,'error');assert.equal(url,`https://${STORE}/admin/api/2026-10/graphql.json`);
    return new Promise((resolve,reject)=>opts.signal.addEventListener('abort',()=>{aborted=true;reject(Error(keys.adminToken));}));
  }});
  await assert.rejects(api(CONTEXT_QUERY),/ADMIN_UNAVAILABLE/);assert.equal(calls,1);assert.equal(aborted,true);
});

test('F05A real CLI SIGKILL retains lock/unknown commit; explicit lock release and recovery preserve sources',async t=>{
  const f=fixture(t),r=await review(f),env=envFor(f),time=Date.now();
  r.inspected_at=new Date(time-2000).toISOString();r.approved_at=new Date(time-1000).toISOString();r.expires_at=new Date(time+3600000).toISOString();
  r.source_refresh.capture.captured_at=new Date(time-3000).toISOString().replace(/\.\d{3}Z$/,'Z');
  const reviewPath=join(f.dir,'review.json'),remote=join(f.dir,'synthetic-remote.json'),out=join(f.dir,'interrupted-receipt.json');
  writeFileSync(reviewPath,JSON.stringify(r),{mode:0o600});writeFileSync(remote,JSON.stringify(f.mock.data),{mode:0o600});
  const preload=fileURLToPath(new URL('../../../fixtures/film-printing/f05a-continuation/cli-preload.mjs',import.meta.url));
  const testEnv={...env,BFL_SYNTHETIC_OFFLINE_TEST:'yes',BFL_SYNTHETIC_REMOTE_FILE:remote};
  const child=fork(cli,cliArgs('apply',reviewPath,out),{execArgv:['--import',preload],env:{...testEnv,BFL_PRICING_OPERATOR:'apply',BFL_SYNTHETIC_KILL_AFTER_COMMIT:'yes'},silent:true});
  let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
  const outcome=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('child timeout '+stderr));},10000);
    child.once('message',m=>{assert.equal(m.status,'synthetic_commit_applied');child.kill('SIGKILL');});
    child.once('exit',(code,signal)=>{clearTimeout(timer);resolve({code,signal});});
    child.once('error',reject);
  });
  assert.equal(outcome.signal,'SIGKILL',stderr);assert.equal(readFileSync(out,'utf8'),'');
  assert.throws(()=>openDatabase(f.config),/DATABASE_LOCKED/);
  const lock=JSON.parse(readFileSync(join(f.dir,'runtime.lock/owner.json'),'utf8'));releaseAbandonedLock(f.config,lock.token,true);
  assert.equal(state(f).operation.kind,'cutover');
  const before=JSON.parse(readFileSync(remote,'utf8'));assert.equal(before.product.form.value,bundle.formValue);
  const recovered=join(f.dir,'recovery-receipt.json');const result=spawnSync(process.execPath,['--import',preload,cli,...cliArgs('recover',reviewPath,recovered)],{
    env:{...testEnv,BFL_PRICING_OPERATOR:'recover'},encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(readFileSync(recovered)).source_state,'both_proposed');
  const after=JSON.parse(readFileSync(remote));assert.equal(after.product.form.value,before.product.form.value);
  assert.equal(after.currentAppInstallation.catalog.value,before.currentAppInstallation.catalog.value);
  assert.notEqual(after.currentAppInstallation.fence.value,before.currentAppInstallation.fence.value);assert.equal(state(f).operation,null);
});
test('F05A operator requires exact existing database identity/keys/schema and the single writer lock',async t=>{
  const f=fixture(t),r=await review(f);const lock=openDatabase(f.config);await assert.rejects(f.run('apply',r),/DATABASE_LOCKED/);lock.close();
  for(const patch of [{jobSecret:'different'},{databaseId:'different'}])await assert.rejects(f.run('inspect',null,{config:{...f.config,...patch}}),/DATABASE_IDENTITY_MISMATCH/);
  const db=new DatabaseSync(join(f.dir,'jobs.sqlite'));db.exec('DROP TABLE cart_refresh_requests');db.close();
  await assert.rejects(f.run('inspect'),/DATABASE_SCHEMA_MISMATCH/);assert.equal(existsSync(join(f.dir,'runtime.lock')),false);
});
test('F05A fixed transport refuses arbitrary queries, variables, mutation variants and disabled writes',async t=>{
  const f=fixture(t);let api=createPricingTransport(f.config,{fetchImpl:f.mock.fetch});await assert.rejects(api(CONTEXT_QUERY),/DISABLED/);
  api=createPricingTransport(f.config,{mode:'inspect',fetchImpl:f.mock.fetch});
  for(const [query,variables] of [['query X { shop { id } }',{}],[CONTEXT_QUERY,{x:1}],[COMMIT+' ',{fields:[]}],[COMMIT,{fields:[]}]])await assert.rejects(api(query,variables));
  assert.equal(f.mock.calls.length,0);
});
test('F05A transport bounds responses, rejects versions/types/GraphQL errors, and redacts upstream text',async t=>{
  const f=fixture(t),cases=[
    ()=>new Response('secret',{status:403}),
    ()=>new Response('{}',{headers:{'content-type':'application/json','x-shopify-api-version':'2026-07'}}),
    ()=>new Response('secret',{headers:{'content-type':'text/html','x-shopify-api-version':'2026-10'}}),
    ()=>new Response(JSON.stringify({errors:[{message:keys.adminToken}]}),{headers:{'content-type':'application/json','x-shopify-api-version':'2026-10'}}),
    ()=>new Response('x'.repeat(2000),{headers:{'content-type':'application/json','x-shopify-api-version':'2026-10'}}),
    ()=>new Response(new Uint8Array([255]),{headers:{'content-type':'application/json','x-shopify-api-version':'2026-10'}}),
    ()=>{throw Error(keys.adminToken);},
  ];
  for(const fetchImpl of cases){const api=createPricingTransport(f.config,{mode:'inspect',fetchImpl,maxBytes:1024});await assert.rejects(api(CONTEXT_QUERY),e=>/^ADMIN_/.test(e.message)&&!e.message.includes(keys.adminToken));}
});
test('F05A actual CLI defaults disabled before reading any credentials and never overwrites output',t=>{
  const f=fixture(t),out=join(f.dir,'receipt.json'),env=envFor(f);const result=spawnSync(process.execPath,[cli,...cliArgs('inspect','-',out)],{env,encoding:'utf8'});
  assert.equal(result.status,1);assert.match(result.stderr,/OPERATOR_DISABLED/);assert.equal(existsSync(out),false);
  writeFileSync(out,'sentinel');const occupied=spawnSync(process.execPath,[cli,...cliArgs('inspect','-',out)],{env:{...env,BFL_PRICING_OPERATOR:'inspect'},encoding:'utf8'});
  assert.equal(occupied.status,1);assert.equal(readFileSync(out,'utf8'),'sentinel');assert.equal(occupied.stderr.includes(keys.adminToken),false);
});
