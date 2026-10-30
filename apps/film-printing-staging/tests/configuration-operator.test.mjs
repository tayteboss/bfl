import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,chmodSync,rmSync,readFileSync,writeFileSync,existsSync,lstatSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync,fork} from 'node:child_process';
import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {STORE,APP,CLIENT} from '../configuration/schema.mjs';
import {INSTALLATION} from '../backend/config.mjs';
import {initializeDatabase,openDatabase,releaseAbandonedLock} from '../backend/storage.mjs';
import {runConfigurationOperator} from '../configuration/operator.mjs';
import {createConfigurationTransport} from '../configuration/operator-admin.mjs';
import {IDENTITY_QUERY,DRAFT_QUERY,ARCHIVE_QUERY,ARCHIVE_READBACK,COMMIT,sha256} from '../configuration/operator-contract.mjs';
import {CONTEXT_QUERY} from '../checkout/shopify.mjs';
import {decodeAuthority} from '../checkout/authority.js';
import {syntheticAdmin,approve,field,now} from '../../../fixtures/film-printing/f06d-continuation/operator-fixture.mjs';

const cli=fileURLToPath(new URL('../configuration/operator-cli.mjs',import.meta.url));
const preload=fileURLToPath(new URL('../../../fixtures/film-printing/f06d-continuation/cli-preload.mjs',import.meta.url));
const keys={jobSecret:'offline-configuration-job-'.repeat(3),sessionSecret:'offline-configuration-session-'.repeat(3),adminToken:'offline-configuration-admin-'.repeat(3)};
function fixture(t,{initialize=true,clock=now}={}) {
  const dir=mkdtempSync(join(tmpdir(),'bfl-config-operator-'));chmodSync(dir,0o700);t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const config={store:STORE,app:APP,clientId:CLIENT,installation:INSTALLATION,dataDir:dir,mode:'disabled',...keys};
  if(initialize)config.databaseId=initializeDatabase(config);
  const mock=syntheticAdmin(),base={config,now:clock,allWritersStopped:true,fetchImpl:mock.fetch};
  return {dir,config,mock,clock,base,run:(action,review,patch={})=>runConfigurationOperator({...base,action,mode:action,expectedVersion:review?.candidate.version,review,...patch})};
}
const review=async f=>approve(await f.run('inspect'),f.clock());
function state(f){const db=openDatabase(f.config,{now:()=>f.clock().getTime()});try{return db.store.lifecycle.state();}finally{db.close();}}
function envFor(f) {
  const env={...process.env,BFL_STORE:STORE,BFL_APP:APP,BFL_CLIENT_ID:CLIENT,BFL_INSTALLATION:INSTALLATION,BFL_STORAGE:'local-persistent',
    BFL_DATA_DIR:f.dir,BFL_DATABASE_ID:f.config.databaseId,BFL_ADMIN_WRITES:'disabled',BFL_ALL_WRITERS_STOPPED:'yes',WEB_CONCURRENCY:'1'};
  for(const [name,key] of [['JOB_SECRET','jobSecret'],['SESSION_SECRET','sessionSecret'],['ADMIN_TOKEN','adminToken']]) {
    const path=join(f.dir,`${key}.txt`);writeFileSync(path,keys[key],{mode:0o600});env[`BFL_${name}_FILE`]=path;
  }
  for(const key of ['BFL_JOB_SECRET','BFL_SESSION_SECRET','BFL_ADMIN_TOKEN','BFL_APP_SECRET','BFL_APP_SECRET_FILE','NODE_UNIQUE_ID','BFL_CONFIGURATION_OPERATOR'])delete env[key];
  return env;
}
async function httpFixture(t,f) {
  const server=createServer(async(req,res)=>{
    try {
      assert.equal(req.method,'POST');assert.equal(req.headers['x-shopify-access-token'],keys.adminToken);
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const r=await f.mock.fetch(`https://${STORE}/admin/api/2026-10/graphql.json`,{body:Buffer.concat(chunks).toString()});
      res.writeHead(r.status,Object.fromEntries(r.headers));res.end(await r.text());
    }catch{res.destroy();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});
  return `http://127.0.0.1:${server.address().port}/`;
}
async function childCLI(t,args,env,{kill=false}={}) {
  const child=fork(cli,args,{execArgv:['--import',preload],env,silent:true});let stderr='',stdout='';
  child.stderr.on('data',d=>stderr+=d);child.stdout.on('data',d=>stdout+=d);
  t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('CLI timeout '+stderr));},15000);
    child.once('message',m=>{if(kill){assert.equal(m.status,'synthetic_commit_applied');child.kill('SIGKILL');}});
    child.once('exit',(code,signal)=>{clearTimeout(timer);resolve({code,signal,stderr,stdout});});child.once('error',reject);
  });
}

test('F06D operator default, mode and stopped-writer gates precede database/network',async t=>{
  const f=fixture(t,{initialize:false});
  for(const patch of [{mode:'disabled'},{mode:'recover'},{allWritersStopped:false},{config:{...f.config,mode:'reconcile-only'}}])await assert.rejects(f.run('apply',null,patch));
  assert.equal(f.mock.calls.length,0);assert.equal(existsSync(join(f.dir,'jobs.sqlite')),false);
});
test('F06D inspection records complete raw drafts and immutable candidate, never approves or writes',async t=>{
  const f=fixture(t),s=await f.run('inspect');
  assert.equal(s.status,'unreviewed_do_not_apply');assert.equal(s.approval,null);assert.equal(s.current.archive,null);
  assert.equal(s.candidate.value_sha256,sha256(s.candidate.value));assert.equal(s.current_values.archive,null);assert.equal(f.mock.writes.length,0);
  assert.equal(JSON.stringify(s).includes('grants'),false);await assert.rejects(f.run('apply',s),/APPROVAL_REQUIRED/);
});
test('F06D apply performs one five-field source/archive/empty-authority/fence cutover, preserves catalog bytes',async t=>{
  const f=fixture(t),r=await review(f),catalog=f.mock.data.currentAppInstallation.catalog.value;
  const result=await f.run('apply',r);assert.equal(result.status,'published_configuration_empty_authority');assert.equal(result.checkout_ready,false);
  assert.equal(result.version,r.candidate.version);assert.equal(f.mock.writes.length,1);const fields=f.mock.writes[0];assert.equal(fields.length,5);
  assert.equal(fields.find(f=>f.key===r.candidate.archive_key).compareDigest,null);
  assert.equal(f.mock.data.currentAppInstallation.active.value,r.candidate.value);assert.equal(f.mock.archives.get(r.candidate.archive_key).value,r.candidate.value);
  assert.equal(f.mock.data.currentAppInstallation.catalog.value,catalog);assert.equal(fields.find(f=>f.key==='price_catalog').compareDigest,r.current.catalog.compare_digest);
  assert.deepEqual(decodeAuthority(f.mock.data.shop.authority.value).grants,[]);assert.equal(state(f).operation,null);assert.equal(state(f).epoch,1);
  assert.ok(fields.every(f=>!f.ownerId.includes('Product')));
});
test('F06D existing archive keeps its exact noncanonical bytes and digest; conflict cannot be overwritten',async t=>{
  const f=fixture(t),s=await f.run('inspect'),value=JSON.stringify(JSON.parse(s.candidate.value),null,2)+'\n';
  f.mock.archives.set(s.candidate.archive_key,field(value));const r=await review(f);await f.run('apply',r);
  const a=f.mock.writes[0].find(f=>f.key===s.candidate.archive_key);assert.equal(a.value,value);assert.equal(a.compareDigest,sha256(value));
  const g=fixture(t),other=await g.run('inspect');g.mock.archives.set(other.candidate.archive_key,field(g.mock.data.currentAppInstallation.active.value));
  await assert.rejects(g.run('inspect'),/ARCHIVE_CONFLICT/);assert.equal(g.mock.writes.length,0);
});
test('F06D review target/database/version/hash/bytes/evidence/freshness gates reject before network',async t=>{
  const f=fixture(t),r=await review(f),calls=f.mock.calls.length;
  const changes=[s=>{s.target.store='1jukgy-dc.myshopify.com';},s=>{s.database_id='wrong';},s=>{s.api_version='2026-07';},s=>{s.candidate.value+=' ';},
    s=>{s.candidate.version='f03-wrong';},s=>{s.candidate.sha256='0'.repeat(64);},s=>{s.drafts.sha256='0'.repeat(64);},s=>{s.status='unreviewed_do_not_apply';},
    s=>{s.approval.evidence=[];},s=>{s.approval.evidence[0].sha256='bad';},s=>{s.approval.release_version='wrong';},s=>{s.approval.release_sha256='0'.repeat(64);},
    s=>{s.approval.unavailable_gate_evidence='';},s=>{s.approval.writers_stopped_evidence='';},s=>{s.approval.approved_at='2026-10-22T12:00:00Z';},
    s=>{s.approval.expires_at='2026-10-21T11:00:00Z';},s=>{s.approval.expires_at='2026-10-23T12:00:00Z';},s=>{s.extra=true;},s=>{delete s.current.authority;},s=>{s.current_values.active+=' ';}];
  for(const change of changes){const s=structuredClone(r);change(s);await assert.rejects(f.run('apply',s));}
  await assert.rejects(f.run('apply',r,{expectedVersion:'wrong'}));assert.equal(f.mock.calls.length,calls);assert.equal(state(f).epoch,0);
});
test('F06D partial/paginated/duplicate/invalid drafts and duplicate JSON keys fail closed',async t=>{
  const changes=[d=>{d.metaobjects.pageInfo.hasNextPage=true;},d=>{delete d.metaobjects.pageInfo;},d=>{d.metaobjects.nodes=[];},
    d=>{d.metaobjects.nodes.push(d.metaobjects.nodes[0]);},d=>{d.metaobjects.nodes[0].fields.pop();},d=>{d.metaobjects.nodes[0].fields.push(d.metaobjects.nodes[0].fields[0]);},
    d=>{d.metaobjects.nodes[0].type='wrong';},d=>{d.metaobjects.nodes[0].id='1';},d=>{d.metaobjects.nodes[0].updatedAt='invalid';},
    d=>{d.metaobjects.nodes[0].fields.find(f=>f.key==='provenance').value='{"source":"a","source":"b","evidence":"x"}';}];
  for(const change of changes){const f=fixture(t);f.mock.readHook=async(q,d)=>{if(q===DRAFT_QUERY)change(d);};await assert.rejects(f.run('inspect'));assert.equal(f.mock.writes.length,0);}
});
test('F06D draft byte-only edits, timestamps, additions and deletion invalidate prior review',async t=>{
  for(const change of [d=>{d.metaobjects.nodes[0].fields.find(f=>f.key==='provenance').value+=' ';},d=>{d.metaobjects.nodes[0].updatedAt='2026-10-21T11:31:00Z';},
    d=>{const n=structuredClone(d.metaobjects.nodes[0]);n.id='gid://shopify/Metaobject/99999';n.handle='new-record';d.metaobjects.nodes.push(n);},d=>{d.metaobjects.nodes.pop();}]) {
    const f=fixture(t),r=await review(f);f.mock.readHook=async(q,d)=>{if(q===DRAFT_QUERY)change(d);};await assert.rejects(f.run('apply',r));assert.equal(f.mock.writes.length,0);
  }
});
test('F06D edits between inspect passes or during final apply recheck prevent publication',async t=>{
  for(const phase of ['inspect','apply']) {
    const f=fixture(t),r=phase==='apply'?await review(f):null;let calls=0;
    f.mock.readHook=async(q,d)=>{if(q===DRAFT_QUERY&&++calls>(phase==='apply'?8:4))d.metaobjects.nodes[0].updatedAt='2026-10-21T11:31:00Z';};
    await assert.rejects(f.run(phase,r),/DRAFT_CHANGED/);assert.equal(f.mock.writes.length,0);
    if(phase==='apply'){assert.equal(state(f).operation.kind,'cutover');await f.run('recover',r);assert.equal(state(f).operation,null);}
  }
});
test('F06D stale active/catalog/authority/fence/archive and changed shop day reject without write',async t=>{
  for(const key of ['active','catalog','authority','fence','archive','day']) {
    const f=fixture(t),r=await review(f);
    if(key==='archive')f.mock.archives.set(r.candidate.archive_key,field(r.candidate.value));
    else if(key==='authority')f.mock.data.shop.authority={...f.mock.data.shop.authority,compareDigest:'changed'};
    else if(key==='day')f.mock.data.shop.ianaTimezone='Pacific/Kiritimati';
    else f.mock.data.currentAppInstallation[key].compareDigest='changed';
    await assert.rejects(f.run('apply',r),/REVIEW_STALE/);assert.equal(f.mock.writes.length,0);
  }
});
test('F06D fresh store/shop/app/client/installation/scopes and protected authority checks',async t=>{
  const changes=[d=>{d.shop.myshopifyDomain='1jukgy-dc.myshopify.com';},d=>{d.shop.id='gid://shopify/Shop/1';},d=>{d.currentAppInstallation.id='other';},
    d=>{d.currentAppInstallation.app.id='other';},d=>{d.currentAppInstallation.app.apiKey='other';},d=>{d.currentAppInstallation.accessScopes=[];},
    d=>{d.shop.authority=null;},d=>{d.shop.authority.definition.access.admin='MERCHANT_READ_WRITE';},d=>{d.currentAppInstallation.fence=null;},d=>{d.currentAppInstallation.catalog=null;}];
  for(const change of changes){const f=fixture(t);change(f.mock.data);await assert.rejects(f.run('inspect'));assert.equal(f.mock.writes.length,0);}
});
test('F06D each atomic CAS race rejects all fields and keeps pending recovery; catalog never replaced',async t=>{
  for(const key of ['active_config','price_catalog','authority','authority_fence','archive']) {
    const f=fixture(t),r=await review(f),before=f.mock.data.currentAppInstallation.active.value;
    f.mock.beforeWrite=async fields=>{fields.find(f=>f.key===(key==='archive'?r.candidate.archive_key:key)).compareDigest='stale';};
    await assert.rejects(f.run('apply',r),/WRITE_REJECTED/);assert.equal(f.mock.data.currentAppInstallation.active.value,before);assert.equal(f.mock.archives.size,0);
    assert.equal(state(f).operation.kind,'cutover');f.mock.beforeWrite=null;assert.equal((await f.run('recover',r)).active_state,'prior');assert.equal(state(f).operation,null);
  }
});
test('F06D final identity/scope/source/archive rechecks reject changes after initial review validation',async t=>{
  for(const target of ['identity','scope','catalog','archive-identity','archive-bytes']) {
    const f=fixture(t),r=await review(f);let drafts=0;
    f.mock.readHook=async(q,d)=>{
      if(q===DRAFT_QUERY)drafts++;
      if(drafts<8)return;
      if(target==='identity'&&q===IDENTITY_QUERY)d.currentAppInstallation.app.apiKey='wrong';
      if(target==='scope'&&q===IDENTITY_QUERY)d.currentAppInstallation.accessScopes=[];
      if(target==='catalog'&&q===CONTEXT_QUERY)d.currentAppInstallation.catalog.compareDigest='changed';
      if(target==='archive-identity'&&q===ARCHIVE_QUERY)d.currentAppInstallation.id='wrong';
      if(target==='archive-bytes'&&q===ARCHIVE_QUERY)d.currentAppInstallation.metafield=field(r.candidate.value);
    };
    await assert.rejects(f.run('apply',r));assert.equal(f.mock.writes.length,0);
  }
});
test('F06D lost response before commit cannot replay; recovery fences delayed old request',async t=>{
  const f=fixture(t),r=await review(f);let delayed;
  f.mock.beforeWrite=async fields=>{delayed=structuredClone(fields);throw Error(keys.adminToken);};
  await assert.rejects(f.run('apply',r),/ADMIN_UNAVAILABLE/);assert.equal(f.mock.writes.length,1);
  await assert.rejects(f.run('apply',r),/RECOVERY_REQUIRED/);f.mock.beforeWrite=null;
  assert.equal((await f.run('recover',r)).active_state,'prior');assert.equal((await f.mock.api(COMMIT,{fields:delayed})).metafieldsSet.userErrors[0].code,'STALE_OBJECT');
});
test('F06D lost successful response survives reopen and revocation preserves proposed sources/archive',async t=>{
  const f=fixture(t),r=await review(f);f.mock.afterWrite=async()=>{throw Error('lost response');};
  await assert.rejects(f.run('apply',r),/ADMIN_UNAVAILABLE/);assert.equal(state(f).operation.kind,'cutover');f.mock.afterWrite=null;
  const result=await f.run('recover',r);assert.equal(result.active_state,'proposed');assert.equal(result.archive_state,'expected_bytes');
  assert.equal(f.mock.writes[1].length,4);assert.equal(f.mock.data.currentAppInstallation.active.value,r.candidate.value);assert.equal(state(f).operation,null);
  await assert.rejects(f.run('apply',r),/REVIEW_STALE/);
});
test('F06D source and archive readback failures retain pending operation and recover without rollback',async t=>{
  for(const key of ['active','catalog','archive']) {
    const f=fixture(t),r=await review(f);
    f.mock.afterWrite=async()=>{if(key==='archive')f.mock.archives.set(r.candidate.archive_key,field(r.candidate.value+' '));else f.mock.data.currentAppInstallation[key]=field(f.mock.data.currentAppInstallation[key].value+' ');};
    await assert.rejects(f.run('apply',r),/READBACK_CHANGED/);assert.equal(state(f).operation.kind,'cutover');f.mock.afterWrite=null;
    const before=f.mock.data.currentAppInstallation.active.value;const result=await f.run('recover',r);
    assert.equal(f.mock.data.currentAppInstallation.active.value,before);assert.equal(state(f).operation,null);assert.equal(result.checkout_ready,false);
  }
});
test('F06D recovery permits expired/unapproved inspection, unavailable drafts, missing catalog; failed clear stays pending',async t=>{
  const f=fixture(t),s=await f.run('inspect');f.mock.data.currentAppInstallation.accessScopes=[];f.mock.data.currentAppInstallation.catalog=null;
  f.mock.beforeWrite=async()=>{throw Error('lost');};await assert.rejects(f.run('recover',s));assert.equal(state(f).operation.kind,'recovery');f.mock.beforeWrite=null;
  const result=await f.run('recover',s);assert.equal(result.active_state,'prior');assert.equal(f.mock.writes.at(-1).length,3);assert.equal(state(f).operation,null);
});
test('F06D failed recovery observation is explicitly unobserved, never a successful import',async t=>{
  const f=fixture(t),r=await review(f);f.mock.readHook=async(q)=>{if(q===ARCHIVE_READBACK)throw Error('unavailable');};
  const result=await f.run('recover',r);assert.equal(result.status,'revoked_review_required');assert.equal(result.archive_state,'unobserved');assert.equal(state(f).operation,null);
});
test('F06D pending lifecycle/upload/cart state prevents apply; same database recovery retains tombstones',async t=>{
  const f=fixture(t),r=await review(f),db=openDatabase(f.config,{now:()=>now().getTime()});
  db.store.lifecycle.event('synthetic-event',{id:1},()=>db.store.lifecycle.retire('owner','synthetic-owner'));
  db.store.recordUpload('synthetic-owner-2',{id:'asset-removed',state:'removed'});
  const cart=db.store.cartRefresh.begin('synthetic-owner-2','gid://shopify/Cart/synthetic?key=secret','request-1');db.close();
  await assert.rejects(f.run('apply',r),/RECOVERY_REQUIRED/);assert.equal((await f.run('inspect')).status,'recovery_required_do_not_apply');
  await f.run('recover',r);const after=openDatabase(f.config);assert.equal(after.store.lifecycle.retired('owner','synthetic-owner'),true);
  assert.equal(after.store.cartRefresh.status(cart.ticket).state,'revoked');assert.equal(after.store.lifecycle.state().pending,0);after.close();
});
test('F06D exact existing schema5, stable keys/identity, one shared lock; never init or migrate',async t=>{
  const f=fixture(t);const lock=openDatabase(f.config);await assert.rejects(f.run('inspect'),/DATABASE_LOCKED/);lock.close();
  for(const patch of [{jobSecret:'different'},{sessionSecret:'different'},{databaseId:'different'}])await assert.rejects(f.run('inspect',null,{config:{...f.config,...patch}}),/DATABASE_IDENTITY_MISMATCH/);
  const db=new DatabaseSync(join(f.dir,'jobs.sqlite'));db.exec('DROP TABLE order_inbox');db.close();
  await assert.rejects(f.run('inspect'),/DATABASE_SCHEMA_MISMATCH/);assert.equal(existsSync(join(f.dir,'runtime.lock')),false);
});
test('F06D fixed transport rejects arbitrary operations, variables, unknown types/archives, inspect writes',async t=>{
  const f=fixture(t);let api=createConfigurationTransport(f.config,{fetchImpl:f.mock.fetch});await assert.rejects(api(CONTEXT_QUERY),/DISABLED/);
  api=createConfigurationTransport(f.config,{mode:'inspect',fetchImpl:f.mock.fetch});
  for(const [query,variables] of [['query X { shop { id } }',{}],[CONTEXT_QUERY,{x:1}],[DRAFT_QUERY,{type:'other'}],[ARCHIVE_QUERY,{key:'price_catalog'}],[COMMIT+' ',{fields:[]}],[COMMIT,{fields:[]}]])await assert.rejects(api(query,variables));
  assert.equal(f.mock.calls.length,0);
});
test('F06D transport rejects extra fields/owners/catalog changes/grants/archive in recovery and second mutation',async t=>{
  const f=fixture(t),r=await review(f);await f.run('recover',r);const original=structuredClone(f.mock.writes.at(-1));
  original.find(f=>f.key==='authority_fence').compareDigest=f.mock.data.currentAppInstallation.fence.compareDigest;
  original.find(f=>f.key==='authority_fence').value='00000000-0000-4000-8000-000000000001';
  for(const change of [v=>{v.push({...v[0],key:r.candidate.archive_key});},v=>{v[0].ownerId='gid://shopify/Product/1';},v=>{v[0].namespace='custom';},v=>{v[0].extra=true;},
    v=>{v.find(f=>f.key==='price_catalog').value='{}';},v=>{v.find(f=>f.key==='active_config').value=r.candidate.value;},v=>{v[0].value='{"grants":[{}]}';},v=>{v.find(f=>f.key==='authority_fence').value='bad';}]) {
    const fields=structuredClone(original);change(fields);const writes=f.mock.writes.length,api=createConfigurationTransport(f.config,{mode:'recover',fetchImpl:f.mock.fetch,now});
    await assert.rejects(api(COMMIT,{fields}));await assert.rejects(api(COMMIT,{fields:original}),/WRITE_REJECTED/);assert.equal(f.mock.writes.length,writes);
  }
});
test('F06D bounded timeout/type/version/status/errors/UTF8/duplicate response rejection and sanitization',async t=>{
  const f=fixture(t);let calls=0,aborted=false;
  const api=createConfigurationTransport(f.config,{mode:'inspect',timeoutMs:5,fetchImpl:async(url,opts)=>{
    calls++;assert.equal(opts.redirect,'error');assert.equal(url,`https://${STORE}/admin/api/2026-10/graphql.json`);
    return new Promise((resolve,reject)=>opts.signal.addEventListener('abort',()=>{aborted=true;reject(Error(keys.adminToken));}));
  }});
  await assert.rejects(api(CONTEXT_QUERY),/ADMIN_UNAVAILABLE/);assert.equal(calls,1);assert.equal(aborted,true);
  const headers={'content-type':'application/json','x-shopify-api-version':'2026-10'};
  for(const fetchImpl of [()=>new Response(keys.adminToken,{status:403}),()=>new Response('{}',{headers:{...headers,'x-shopify-api-version':'2026-07'}}),
    ()=>new Response('{}',{headers:{...headers,'content-type':'text/html'}}),()=>new Response(JSON.stringify({errors:[{message:keys.adminToken}]}),{headers}),
    ()=>new Response('x'.repeat(2048),{headers}),()=>new Response(new Uint8Array([255]),{headers}),()=>new Response('{"data":{},"data":{}}',{headers}),()=>{throw Error(keys.adminToken);}]) {
    const p=createConfigurationTransport(f.config,{mode:'inspect',fetchImpl,maxBytes:1024});await assert.rejects(p(CONTEXT_QUERY),e=>/^ADMIN_/.test(e.message)&&!e.message.includes(keys.adminToken));
  }
});
test('F06D actual CLI stays disabled before credentials, refuses unsafe review and never overwrites receipt',t=>{
  const f=fixture(t),env=envFor(f),out=join(f.dir,'receipt.json');
  const run=(args,patch={})=>spawnSync(process.execPath,[cli,...args],{env:{...env,...patch},encoding:'utf8'});
  const disabled=run(['inspect','-','-',out],{BFL_ADMIN_TOKEN_FILE:'/nonexistent'});assert.match(disabled.stderr,/OPERATOR_DISABLED/);assert.equal(existsSync(out),false);
  writeFileSync(out,'sentinel');assert.equal(run(['inspect','-','-',out],{BFL_CONFIGURATION_OPERATOR:'inspect'}).status,1);assert.equal(readFileSync(out,'utf8'),'sentinel');
  const unsafe=join(f.dir,'unsafe.json');writeFileSync(unsafe,'{}',{mode:0o644});
  assert.match(run(['apply','wrong',unsafe,join(f.dir,'new')],{BFL_CONFIGURATION_OPERATOR:'apply'}).stderr,/PRIVATE_REVIEW_REQUIRED/);
  chmodSync(unsafe,0o600);const link=join(f.dir,'link');symlinkSync(unsafe,link);
  assert.match(run(['apply','wrong',link,join(f.dir,'new')],{BFL_CONFIGURATION_OPERATOR:'apply'}).stderr,/PRIVATE_REVIEW_REQUIRED/);
  chmodSync(f.dir,0o755);
  assert.match(run(['inspect','-','-',join(f.dir,'new')],{BFL_CONFIGURATION_OPERATOR:'inspect'}).stderr,/PRIVATE_RECEIPT_DIRECTORY_REQUIRED/);
  chmodSync(f.dir,0o700);
});
test('F06D real CLI loopback HTTP inspect/apply stores private receipt, leaves no local lock',async t=>{
  const f=fixture(t,{clock:()=>new Date()}),url=await httpFixture(t,f),env={...envFor(f),BFL_SYNTHETIC_OFFLINE_TEST:'yes',BFL_SYNTHETIC_HTTP:url};
  const inspection=join(f.dir,'inspection.json');let result=await childCLI(t,['inspect','-','-',inspection],{...env,BFL_CONFIGURATION_OPERATOR:'inspect'});
  assert.equal(result.code,0,result.stderr);assert.equal(lstatSync(inspection).mode&0o077,0);const r=approve(JSON.parse(readFileSync(inspection)),new Date());
  const path=join(f.dir,'review.json');writeFileSync(path,JSON.stringify(r),{mode:0o600});const receipt=join(f.dir,'applied.json');
  result=await childCLI(t,['apply',r.candidate.version,path,receipt],{...env,BFL_CONFIGURATION_OPERATOR:'apply'});
  assert.equal(result.code,0,result.stderr);assert.equal(JSON.parse(readFileSync(receipt)).status,'published_configuration_empty_authority');
  assert.equal(existsSync(join(f.dir,'runtime.lock')),false);assert.equal(f.mock.writes.length,1);assert.equal(result.stdout.includes(keys.adminToken),false);
});
test('F06D real CLI SIGKILL after loopback commit retains lock/unknown operation; explicit recovery never replays',async t=>{
  const f=fixture(t,{clock:()=>new Date()}),r=await review(f),url=await httpFixture(t,f);
  const env={...envFor(f),BFL_SYNTHETIC_OFFLINE_TEST:'yes',BFL_SYNTHETIC_HTTP:url},path=join(f.dir,'review.json'),receipt=join(f.dir,'interrupted.json');
  writeFileSync(path,JSON.stringify(r),{mode:0o600});
  const killed=await childCLI(t,['apply',r.candidate.version,path,receipt],{...env,BFL_CONFIGURATION_OPERATOR:'apply',BFL_SYNTHETIC_KILL_AFTER_COMMIT:'yes'},{kill:true});
  assert.equal(killed.signal,'SIGKILL',killed.stderr);assert.equal(readFileSync(receipt,'utf8'),'');assert.throws(()=>openDatabase(f.config),/DATABASE_LOCKED/);
  const owner=JSON.parse(readFileSync(join(f.dir,'runtime.lock/owner.json')));assert.throws(()=>releaseAbandonedLock(f.config,'wrong',true),/LOCK_CHANGED/);
  releaseAbandonedLock(f.config,owner.token,true);assert.equal(state(f).operation.kind,'cutover');
  const before=f.mock.data.currentAppInstallation.active.value;assert.equal(before,r.candidate.value);
  const retry=await childCLI(t,['apply',r.candidate.version,path,join(f.dir,'retry.json')],{...env,BFL_CONFIGURATION_OPERATOR:'apply'});
  assert.match(retry.stderr,/RECOVERY_REQUIRED/);assert.equal(f.mock.writes.length,1);
  const recovered=join(f.dir,'recovered.json'),result=await childCLI(t,['recover',r.candidate.version,path,recovered],{...env,BFL_CONFIGURATION_OPERATOR:'recover'});
  assert.equal(result.code,0,result.stderr);assert.equal(JSON.parse(readFileSync(recovered)).active_state,'proposed');
  assert.equal(f.mock.data.currentAppInstallation.active.value,before);assert.equal(f.mock.archives.get(r.candidate.archive_key).value,before);
  assert.equal(f.mock.writes[1].length,4);assert.equal(state(f).operation,null);assert.equal(f.mock.writes.length,2);
});
