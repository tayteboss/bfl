import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,chmodSync,rmSync,readFileSync,cpSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,createHmac} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {request} from 'node:http';
import {createRuntime} from '../backend/server.mjs';
import {initializeDatabase,openDatabase,migrateResourceSessions} from '../backend/storage.mjs';
import {RESOURCE_BOUNDS as B,createResourceScope} from '../backend/resource-session.mjs';
import {STOREFRONT_ORIGIN} from '../backend/storefront-session.mjs';
import {STORE,APP,CLIENT} from '../configuration/schema.mjs';
import {INSTALLATION} from '../backend/config.mjs';
import {mockAdmin,now as fixtureNow} from '../../../fixtures/film-printing/f06d/mock-admin.mjs';
import {providerConfig,bytes,asset} from '../../../fixtures/film-printing/f05c/rig.mjs';

// All external context/customer signatures, Admin sources and provider responses
// are SYNTHETIC. HTTP, SQLite, jobs, uploads, lifecycle and resource tokens are real
// repository implementations. No internet/browser/Shopify/provider/host calls.
const opaque=()=>randomBytes(32).toString('base64url');
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const selection={request_key:'resource-job-0001',copies:1,service:'Photo Prints',size:'4x6',paper:'synthetic-paper',lab:'miami',asset_ids:[asset],options:{}};
const directories=[];
after(()=>{for(const dir of directories)rmSync(dir,{recursive:true,force:true});});
function config(t){
  const dataDir=mkdtempSync(join(tmpdir(),'bfl-f06i-'));chmodSync(dataDir,0o700);directories.push(dataDir);
  return {store:STORE,app:APP,clientId:CLIENT,installation:INSTALLATION,dataDir,host:'127.0.0.1',port:0,origin:'http://127.0.0.1:6076',
    mode:'reconcile-only',storefrontSessions:'context-only',jobSecret:'synthetic-job-key'.repeat(3),sessionSecret:'synthetic-cookie-key'.repeat(3),appSecret:'synthetic-proxy-key'.repeat(3)};
}
async function rig(t,{enabled=true,c=config(t),m=mockAdmin(),clock={time:fixtureNow().getTime()}}={}){
  if(!c.databaseId){c.databaseId=initializeDatabase(c);if(enabled)migrateResourceSessions(c);}
  const observations=new Map(),p={beforeUpload:null,beforeInfo:null,calls:0},logs=[];
  const observeFreshContext=async({proof})=>{const e=observations.get(proof);if(!e)throw Error('SYNTHETIC_PROOF_REJECTED');e.began?.();if(e.wait)await e.wait;return e;};
  const api=async(q,v)=>{
    if(q.includes('BflActiveConfiguration'))return {shop:m.data.shop,currentAppInstallation:{...m.data.currentAppInstallation,metafield:m.data.currentAppInstallation.active}};
    if(q.includes('F05PriceCatalog'))return {currentAppInstallation:{metafield:m.data.currentAppInstallation.catalog}};
    return m.api(q,v);
  };
  const fetchImpl=async(url)=>{
    p.calls++;let data;
    if(url.endsWith('/project/'))data={pub_key:providerConfig.publicKey};
    else if(url.endsWith('/base/')){if(p.beforeUpload)await p.beforeUpload();data={file:asset};}
    else {if(p.beforeInfo)await p.beforeInfo();data={uuid:asset,url:`https://api.uploadcare.com/files/${asset}/`,is_ready:true,is_image:true,mime_type:'image/jpeg',
      original_file_url:`${providerConfig.cdnOrigin}/${asset}/image.jpg`,datetime_removed:null,datetime_uploaded:'2026-10-21T00:00:00Z',datetime_stored:'2026-10-21T00:00:00Z',size:bytes.length};}
    return new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
  };
  const options={api,now:()=>new Date(clock.time),pollMs:60000,log:e=>logs.push(e),
    ...(enabled?{resourceSessions:{mode:'local-test',observeFreshContext},uploadIngress:true,uploadcare:{config:providerConfig,enabled:true,fetchImpl}}:{})};
  const r=createRuntime(c,options);t.after(()=>r.close());await r.start();await r.refresh();
  const url=`http://127.0.0.1:${r.server.address().port}`;
  const headers=token=>({origin:STOREFRONT_ORIGIN,'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})});
  const call=async(path,input={},token,extra={})=>{const res=await fetch(url+path,{method:'POST',credentials:'omit',headers:{...headers(token),...extra},body:Buffer.isBuffer(input)?input:JSON.stringify(input)});return {status:res.status,headers:res.headers,body:await res.json()};};
  const proof=(customerId=null,patch={})=>{const key=opaque();observations.set(key,{id:opaque(),observedAt:clock.time,customerId,...patch});return key;};
  const issue=async(customer=null)=>{const res=await call('/resource-sessions/issue',{proof:proof(customer)});assert.equal(res.status,200);return res.body.token;};
  const ticket=token=>r.store.resourceSessions.authenticate({headers:headers(token)});
  return {r,c,m,clock,observations,p,logs,url,headers,call,proof,issue,ticket,options};
}
async function upload(f,token){
  const i=await f.call('/uploads/intents',{request_key:'resource-upload-01'},token);assert.equal(i.status,200);
  const receipt=await f.call(`/uploads/${i.body.intent_id}/bytes`,bytes,token,{'content-type':'image/jpeg'});assert.equal(receipt.status,200);assert.equal(receipt.body.state,'complete');return i.body.intent_id;
}

test('F06I default runtime has no issuance/upload endpoint and cannot be enabled on nonloopback or with cookie resolver',async t=>{
  const f=await rig(t,{enabled:false});assert.equal((await f.call('/resource-sessions/issue',{proof:opaque()})).status,404);
  assert.equal((await f.call('/uploads/intents',{request_key:'not-enabled'})).status,404);
  assert.ok(f.r.status().gates.includes('RESOURCE_SESSIONS_DISABLED'));
  for(const patch of [{host:'0.0.0.0'},{origin:'https://film-printing-staging.bellowsfilmlab.com'}])assert.throws(()=>createRuntime({...f.c,...patch},{api:async()=>{},resourceSessions:{mode:'local-test',observeFreshContext:async()=>{}}}),/RESOURCE_COMPOSITION_INVALID/);
  assert.throws(()=>createRuntime(f.c,{resourceSessions:{mode:'enabled'}}),/RESOURCE_COMPOSITION_INVALID/);
  assert.throws(()=>createRuntime(f.c,{api:async()=>{},resourceSessions:{mode:'local-test',observeFreshContext:async()=>{}},adapters:{resolveOwner:async()=>{}}}),/RESOURCE_COMPOSITION_INVALID/);
  // F06K adds a separate session-only executable; the resource-bearing local
  // composition above still cannot become public or acquire a cookie resolver.
});

test('F06I migration preserves copied schema5 jobs/uploads/fences, exclusive locks and identity; schema6 requires explicit open',async t=>{
  const c=config(t);c.databaseId=initializeDatabase(c);const old=openDatabase(c);
  old.store.recordUpload('old-owner',{id:'old-upload',state:'complete',verified:true,url:'https://example.invalid/file'});
  old.store.save('old-owner','old-request','fingerprint',{id:'old-job',completed_asset_ids:['old-upload']});
  old.store.revoke({id:'old-owner-event',kind:'owner',owner:'retired-owner'});const op=old.store.lifecycle.startRecovery();
  assert.throws(()=>migrateResourceSessions(c),/DATABASE_LOCKED/);old.close();
  const copy=config(t);copy.databaseId=c.databaseId;cpSync(join(c.dataDir,'jobs.sqlite'),join(copy.dataDir,'jobs.sqlite'));
  const before=readFileSync(join(c.dataDir,'jobs.sqlite'));
  assert.equal(migrateResourceSessions(copy).schema,6);assert.equal(migrateResourceSessions(copy).already_migrated,true);
  assert.deepEqual(readFileSync(join(c.dataDir,'jobs.sqlite')),before);
  assert.throws(()=>openDatabase(copy),/DATABASE_MIGRATION_REQUIRED/);
  const next=openDatabase(copy,{resourceSessions:true});assert.equal(next.store.get('old-job','old-owner').id,'old-job');
  assert.equal(next.store.lifecycle.retired('owner','retired-owner'),true);assert.deepEqual(next.store.lifecycle.state().operation,op);assert.equal(next.store.lifecycle.state().pending,1);next.close();
  assert.throws(()=>migrateResourceSessions({...copy,jobSecret:'wrong'}),/DATABASE_IDENTITY_MISMATCH/);
  const db=new DatabaseSync(join(copy.dataDir,'jobs.sqlite'));db.exec('DROP TABLE resource_evidence');db.close();
  assert.throws(()=>migrateResourceSessions(copy),/DATABASE_SCHEMA_MISMATCH/);assert.throws(()=>openDatabase(copy,{resourceSessions:true}),/DATABASE_SCHEMA_MISMATCH/);
});

test('F06I real HTTP CORS is exact, cookie-free and bounded; asserted owners/customers/carts never issue',async t=>{
  const f=await rig(t);let res=await fetch(f.url+'/resource-sessions/issue',{method:'OPTIONS',headers:{origin:STOREFRONT_ORIGIN,'access-control-request-method':'POST','access-control-request-headers':'content-type,authorization'}});
  assert.equal(res.status,204);assert.equal(res.headers.get('access-control-allow-origin'),STOREFRONT_ORIGIN);assert.equal(res.headers.get('access-control-allow-credentials'),null);
  for(const extra of [{origin:f.c.origin},{origin:'https://foreign.invalid'},{origin:'null'},{cookie:'bfl_session=x'},{'content-encoding':'gzip'}])assert.equal((await f.call('/resource-sessions/issue',{proof:f.proof()},null,extra)).status,403);
  for(const body of [{proof:f.proof(),owner:'victim'},{owner:'victim'},{proof:f.proof(),customer_id:null},{proof:f.proof(),cart_id:'claimed'},[],null,{proof:'x'.repeat(1100)}])assert.equal((await f.call('/resource-sessions/issue',body)).status,403);
  assert.equal((await f.call('/resource-sessions/issue?token=claimed',{proof:f.proof()})).status,403);
  res=await f.call('/resource-sessions/issue',{proof:f.proof()});assert.equal(res.status,200);assert.equal(res.headers.get('set-cookie'),null);assert.equal(res.headers.get('cache-control'),'no-store');
  assert.equal(res.body.owner,undefined);assert.equal(res.body.resource_only,true);assert.equal(res.body.cart_verified,false);assert.equal(res.body.checkout_ready,false);
});

test('F06I signed context remains context only; cookie, job, upload and unknown credentials cannot substitute',async t=>{
  const f=await rig(t),a=await f.issue();
  const challenge=(await f.call('/session/challenge')).body;
  const q=new URLSearchParams({shop:STORE,path_prefix:'/apps/bfl-staging',logged_in_customer_id:'123',timestamp:String(Math.floor(f.clock.time/1000)),challenge:challenge.challenge});
  q.set('signature',createHmac('sha256',f.c.appSecret).update([...q].map(([k,v])=>`${k}=${v}`).sort().join('')).digest('hex'));
  const bootstrap=await (await fetch(f.url+'/proxy/bootstrap?'+q)).json();
  const context=(await f.call('/session/exchange',{...challenge,ticket:bootstrap.ticket,expires_in:undefined,checkout_ready:undefined})).body;
  // The challenge response's metadata is stripped by JSON.stringify(undefined).
  assert.ok(context.token);assert.equal((await f.call('/session/context',{},context.token)).status,200);
  assert.equal((await f.call('/session/context',{},a)).status,403);
  await upload(f,a);const job=(await f.call('/jobs',selection,a)).body;assert.ok(job.reference);
  const {uploadToken}=await import('../uploads/uploadcare.mjs');
  for(const token of [context.token,job.reference.signature,uploadToken('synthetic-provider-secret','intent',f.clock.time),'bflr1_'+opaque()]){
    assert.notEqual((await f.call('/uploads/intents',{request_key:'foreign-request'},token)).status,200);
    assert.notEqual((await f.call('/jobs',selection,token)).status,200);
  }
  const cookie=f.r.session.issue(f.ticket(a).owner).split(';')[0];
  assert.equal((await f.call('/jobs',selection,null,{cookie})).status,403);
  assert.equal((await f.call('/jobs',selection,a,{cookie})).status,403);
  assert.equal((await f.call('/jobs',selection,a,{origin:f.c.origin})).status,403);
  assert.equal((await f.call('/quote',{},a)).status,403);
  await assert.rejects(f.r.refreshAuthority({headers:f.headers(a)},{cart_id:'untrusted'}),/RESOURCE_CART_PROOF_UNAVAILABLE/);
  await assert.rejects(f.r.prepareAuthority({owner:f.ticket(a).owner}),/RESOURCE_CART_PROOF_UNAVAILABLE/);
});

test('F06I principals create and isolate actual upload/job resources without claimed identity or transfer',async t=>{
  const f=await rig(t),a=await f.issue(),b=await f.issue(),id=await upload(f,a);
  const job=await f.call('/jobs',{...selection,owner:f.ticket(b).owner,customer_id:'claimed'},a);
  assert.equal(job.status,200);assert.equal(job.body.checkout_ready,false);
  assert.equal(f.r.store.get(job.body.reference.id,f.ticket(a).owner).id,job.body.reference.id);
  assert.throws(()=>f.r.store.get(job.body.reference.id,f.ticket(b).owner));
  assert.notEqual((await f.call(`/uploads/${id}/status`,{},b)).status,200);
  assert.notEqual((await f.call('/jobs',selection,b)).status,200);
  const newIntent=await f.call('/uploads/intents',{request_key:'resource-upload-01'},b);assert.equal(newIntent.status,200);assert.notEqual(newIntent.body.intent_id,id);
  assert.notEqual(f.ticket(a).owner,f.ticket(b).owner);
});

test('F06I durable one-use evidence, expiry, unknown evidence and exact credential domain reject',async t=>{
  const f=await rig(t),proof=f.proof(),first=await f.call('/resource-sessions/issue',{proof});assert.equal(first.status,200);
  assert.equal((await f.call('/resource-sessions/issue',{proof})).status,403);
  for(const p of [opaque(),f.proof(null,{observedAt:f.clock.time-B.freshMs}),f.proof(null,{observedAt:f.clock.time+1})])assert.equal((await f.call('/resource-sessions/issue',{proof:p})).status,403);
  const token=first.body.token;
  assert.throws(()=>f.ticket(token.slice(6)));assert.throws(()=>f.ticket(token.replace('bflr1_','bflc1_')));
  f.clock.time+=B.ttlMs;assert.throws(()=>f.ticket(token));assert.equal((await f.call('/resource-sessions/renew',{proof:f.proof()},token)).status,403);
});

test('F06I concurrent renewal has one winner; previous generation cannot replay or recover with fresh context',async t=>{
  const f=await rig(t),a=await f.issue(),owner=f.ticket(a).owner,id=await upload(f,a);
  const results=await Promise.all([f.call('/resource-sessions/renew',{proof:f.proof()},a),f.call('/resource-sessions/renew',{proof:f.proof()},a)]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,403]);const next=results.find(r=>r.status===200).body.token;
  assert.equal(f.ticket(next).owner,owner);assert.equal(f.ticket(next).generation,2);assert.throws(()=>f.ticket(a));
  assert.equal((await f.call(`/uploads/${id}/status`,{},next)).status,200);
  assert.notEqual((await f.call(`/uploads/${id}/status`,{},a)).status,200);
  const replacement=await f.issue();assert.notEqual(f.ticket(replacement).owner,owner);
  assert.notEqual((await f.call(`/uploads/${id}/status`,{},replacement)).status,200);
});

for(const [customer,changed] of [[null,'gid://shopify/Customer/123'],['gid://shopify/Customer/123',null],['gid://shopify/Customer/123','gid://shopify/Customer/456']])test(`F06I observed customer change from ${customer??'absent'} to ${changed??'absent'} retires owner; no account merge`,async t=>{
  const f=await rig(t),a=await f.issue(customer),owner=f.ticket(a).owner;
  const res=await f.call('/resource-sessions/renew',{proof:f.proof(changed)},a);
  assert.equal(res.status,403);assert.equal(res.body.code,'RESOURCE_CONTEXT_CHANGED');assert.throws(()=>f.ticket(a));
  assert.equal(f.r.store.lifecycle.retired('owner',owner),true);await f.r.refresh();
  const b=await f.issue(changed);assert.notEqual(f.ticket(b).owner,owner);
});

test('F06I explicit logout persists retirement/revocation after restart and never writes raw tokens to database/logs',async t=>{
  const f=await rig(t),a=await f.issue(),b=await f.issue(),owner=f.ticket(a).owner;
  assert.equal((await f.call('/resource-sessions/revoke',{},a)).status,200);assert.throws(()=>f.ticket(a));
  await f.r.refresh();await f.r.close();
  const dbBytes=readFileSync(join(f.c.dataDir,'jobs.sqlite'));for(const token of [a,b])assert.equal(dbBytes.includes(Buffer.from(token)),false);
  for(const token of [a,b])assert.equal(JSON.stringify(f.logs).includes(token),false);
  const next=await rig(t,{c:f.c,m:f.m,clock:f.clock});assert.equal(next.r.store.lifecycle.retired('owner',owner),true);assert.throws(()=>next.ticket(a));
  assert.equal(next.ticket(b).generation,1);assert.equal((await next.call('/uploads/intents',{request_key:'after-restart'},b)).status,200);
});

test('F06I async upload renewal fences provider completion before durable binding',async t=>{
  const f=await rig(t),a=await f.issue(),began=deferred(),release=deferred();
  const i=(await f.call('/uploads/intents',{request_key:'delayed-upload'},a)).body;
  f.p.beforeUpload=()=>{began.resolve();return release.promise;};
  const pending=f.call(`/uploads/${i.intent_id}/bytes`,bytes,a,{'content-type':'image/jpeg'});await began.promise;
  const next=await f.call('/resource-sessions/renew',{proof:f.proof()},a);assert.equal(next.status,200);release.resolve();
  assert.notEqual((await pending).status,200);const row=f.r.store.uploadLedger.read(i.intent_id);assert.equal(row.asset,null);assert.notEqual(row.state,'complete');
  // The external upload may already exist; this local fence does not undo it or
  // retry it. The existing ledger's uncertain-send recovery remains responsible.
});

test('F06I logout and unrelated lifecycle change fence asynchronous work before resource save',async t=>{
  const f=await rig(t),a=await f.issue(),ticket=f.ticket(a),scope=createResourceScope(f.r.store,f.r.store.resourceSessions);
  const begun=deferred(),release=deferred();
  const pending=scope.run(ticket,async()=>{begun.resolve();await release.promise;scope.store.save(ticket.owner,'stale-job-key','fp',{id:'stale-job',completed_asset_ids:[]});});
  await begun.promise;await f.call('/resource-sessions/revoke',{},a);release.resolve();await assert.rejects(pending);
  assert.throws(()=>f.r.store.getForRevocation('stale-job',ticket.owner));await f.r.refresh();
  const b=await f.issue(),bt=f.ticket(b),again=deferred();
  const read=scope.run(bt,async()=>{await again.promise;return {secret:'must-not-return'};});
  f.r.store.revoke({id:'unrelated-event',kind:'owner',owner:'different-owner'});await f.r.refresh();again.resolve();await assert.rejects(read,/RESOURCE_FENCED/);
});

test('F06I issuance and resource admissions are durable, bounded and idempotent',async t=>{
  const f=await rig(t),a=await f.issue();
  for(let n=0;n<B.uploads;n++)assert.equal((await f.call('/uploads/intents',{request_key:`bounded-upload-${n}`},a)).status,200);
  assert.equal((await f.call('/uploads/intents',{request_key:'bounded-upload-0'},a)).status,200);
  assert.notEqual((await f.call('/uploads/intents',{request_key:'bounded-upload-extra'},a)).status,200);
  const ticket=f.ticket(a);for(let n=0;n<B.jobs;n++)f.r.store.resourceSessions.admit(ticket,'jobs',`bounded-job-${n}`);
  assert.throws(()=>f.r.store.resourceSessions.admit(ticket,'jobs','bounded-job-extra'),/RESOURCE_ADMISSION_LIMIT/);
  for(let n=1;n<B.issuesPerMinute;n++)await f.issue();assert.equal((await f.call('/resource-sessions/issue',{proof:f.proof()})).body.code,'RESOURCE_RATE');
  await f.r.close();const next=await rig(t,{c:f.c,m:f.m,clock:f.clock});
  assert.equal((await next.call('/resource-sessions/issue',{proof:next.proof()})).body.code,'RESOURCE_RATE');
  assert.notEqual((await next.call('/uploads/intents',{request_key:'bounded-upload-extra'},a)).status,200);
});

test('F06I corrupted purpose/audience/generation and retired owner fail closed',async t=>{
  const f=await rig(t),a=await f.issue(),ticket=f.ticket(a);await f.r.close();
  const db=new DatabaseSync(join(f.c.dataDir,'jobs.sqlite'));
  const original=db.prepare('SELECT * FROM resource_sessions').get();
  for(const column of ['purpose','audience']){
    db.prepare(`UPDATE resource_sessions SET ${column}=?`).run('wrong');
    const s=openDatabase(f.c,{resourceSessions:true,now:()=>f.clock.time});assert.throws(()=>s.store.resourceSessions.authenticate({headers:f.headers(a)}));s.close();
    db.prepare(`UPDATE resource_sessions SET ${column}=?`).run(original[column]);
  }
  db.exec('UPDATE resource_sessions SET generation=generation+1');db.close();
  const s=openDatabase(f.c,{resourceSessions:true,now:()=>f.clock.time});assert.throws(()=>s.store.resourceSessions.assert(ticket),/RESOURCE_FENCED/);
  s.store.revoke({id:'external-retirement',kind:'owner',owner:ticket.owner});assert.throws(()=>s.store.resourceSessions.authenticate({headers:f.headers(a)}));s.close();
});

test('F06I actual HTTP job cannot commit while its provider validation races renewal',async t=>{
  const f=await rig(t),a=await f.issue();await upload(f,a);const owner=f.ticket(a).owner,began=deferred(),release=deferred();
  f.p.beforeInfo=()=>{began.resolve();return release.promise;};
  const pending=f.call('/jobs',selection,a);await began.promise;
  assert.equal((await f.call('/resource-sessions/renew',{proof:f.proof()},a)).status,200);release.resolve();
  assert.notEqual((await pending).status,200);
  await f.r.close();const db=new DatabaseSync(join(f.c.dataDir,'jobs.sqlite'),{readOnly:true});
  assert.equal(db.prepare('SELECT count(*) AS n FROM jobs WHERE owner=?').get(owner).n,0);db.close();
});

test('F06I logout wins against delayed renewal evidence; evidence cannot resurrect retired owner',async t=>{
  const f=await rig(t),a=await f.issue(),release=deferred(),began=deferred();
  const proof=f.proof(null,{wait:release.promise,began:began.resolve});
  const pending=f.call('/resource-sessions/renew',{proof},a);
  await began.promise; // The old credential was captured before logout.
  assert.equal((await f.call('/resource-sessions/revoke',{},a)).status,200);release.resolve();
  assert.equal((await pending).status,403);assert.throws(()=>f.ticket(a));
});

test('F06I maximum generations and absolute deadline cannot be extended',async t=>{
  const f=await rig(t);let token=await f.issue();
  for(let i=1;i<B.generations;i++){
    const result=await f.call('/resource-sessions/renew',{proof:f.proof()},token);assert.equal(result.status,200);token=result.body.token;
  }
  assert.equal((await f.call('/resource-sessions/renew',{proof:f.proof()},token)).body.code,'RESOURCE_RENEWAL_LIMIT');
  let timed=await f.issue();const deadline=f.clock.time+B.absoluteMs;
  while(f.clock.time+240000<deadline){f.clock.time+=240000;const result=await f.call('/resource-sessions/renew',{proof:f.proof()},timed);assert.equal(result.status,200);timed=result.body.token;}
  f.clock.time=deadline-1;assert.ok(f.ticket(timed));
  const last=await f.call('/resource-sessions/renew',{proof:f.proof()},timed);assert.equal(last.status,200);assert.equal(last.body.expires_in,0);
  f.clock.time=deadline;assert.throws(()=>f.ticket(last.body.token));
});

test('F06I durable principal capacity does not reopen after expiry or restart',async t=>{
  const f=await rig(t);
  for(let i=0;i<B.sessions;i++){
    if(i&&i%B.issuesPerMinute===0)f.clock.time+=60001;
    await f.issue();
  }
  f.clock.time+=B.absoluteMs;
  assert.equal((await f.call('/resource-sessions/issue',{proof:f.proof()})).body.code,'RESOURCE_CAPACITY');
  await f.r.close();const next=await rig(t,{c:f.c,m:f.m,clock:f.clock});
  assert.equal((await next.call('/resource-sessions/issue',{proof:next.proof()})).body.code,'RESOURCE_CAPACITY');
});

test('F06I fresh-proof replay stays consumed after restart; raw credential/proof absent from database/WAL',async t=>{
  const f=await rig(t),proof=f.proof(),e=f.observations.get(proof),res=await f.call('/resource-sessions/issue',{proof});
  assert.equal(res.status,200);const token=res.body.token;
  for(const suffix of ['', '-wal', '-shm']){
    let data;try{data=readFileSync(join(f.c.dataDir,'jobs.sqlite'+suffix));}catch(error){assert.equal(error.code,'ENOENT');continue;}
    for(const secret of [token,proof,e.id])assert.equal(data.includes(Buffer.from(secret)),false);
  }
  await f.r.close();const next=await rig(t,{c:f.c,m:f.m,clock:f.clock});
  const replay=next.proof(null,{id:e.id,observedAt:e.observedAt});
  assert.equal((await next.call('/resource-sessions/issue',{proof:replay})).body.code,'RESOURCE_REPLAY');
});

test('F06I duplicate credential/origin headers, streamed overflow and invalid UTF8 reject',async t=>{
  const f=await rig(t),token=await f.issue();
  const raw=(path,headers,body)=>new Promise((resolve,reject)=>{
    const req=request(f.url+path,{method:'POST',headers},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end(body);
  });
  const base=['Host',new URL(f.url).host,'Origin',STOREFRONT_ORIGIN,'Content-Type','application/json'];
  assert.equal(await raw('/resource-sessions/renew',[...base,'Authorization',`Bearer ${token}`,'Authorization',`Bearer ${token}`],JSON.stringify({proof:f.proof()})),403);
  assert.equal(await raw('/resource-sessions/issue',[...base,'Origin',STOREFRONT_ORIGIN],JSON.stringify({proof:f.proof()})),403);
  assert.equal(await raw('/resource-sessions/issue',[...base,'Transfer-Encoding','chunked'],' '.repeat(1025)),403);
  assert.equal(await raw('/resource-sessions/issue',base,Buffer.from([0xff])),403);
  for(const headers of [{'access-control-request-method':'GET'},{'access-control-request-method':'POST','access-control-request-headers':'cookie'}]){
    const res=await fetch(f.url+'/jobs',{method:'OPTIONS',headers:{origin:STOREFRONT_ORIGIN,...headers}});assert.equal(res.status,403);
  }
});

test('F06I context observer timeout cannot issue later and errors never reflect upstream secrets',async t=>{
  const f=await rig(t),release=deferred();const proof=f.proof(null,{wait:release.promise});
  const result=await f.call('/resource-sessions/issue',{proof});assert.equal(result.status,403);assert.equal(result.body.code,'RESOURCE_EVIDENCE_TIMEOUT');
  release.resolve();await new Promise(r=>setImmediate(r));
  assert.equal((await f.call('/resource-sessions/issue',{proof:opaque()})).body.code,'UNAVAILABLE');
  await f.r.close();const db=new DatabaseSync(join(f.c.dataDir,'jobs.sqlite'),{readOnly:true});assert.equal(db.prepare('SELECT count(*) AS n FROM resource_sessions').get().n,0);db.close();
});

test('F06I in-flight expiry denies a late local resource commit',async t=>{
  const f=await rig(t),token=await f.issue(),ticket=f.ticket(token),release=deferred();
  const scope=createResourceScope(f.r.store,f.r.store.resourceSessions);
  const work=scope.run(ticket,async()=>{await release.promise;scope.store.save(ticket.owner,'expired-key','fp',{id:'expired-job',completed_asset_ids:[]});});
  f.clock.time+=B.ttlMs;release.resolve();await assert.rejects(work,/RESOURCE_REJECTED/);
  assert.throws(()=>f.r.store.getForRevocation('expired-job',ticket.owner));
});


test('F06I synchronous owned removal reports its terminal receipt and fences stale work',async t=>{
  const f=await rig(t),a=await f.issue(),b=await f.issue(),id=await upload(f,a),ticket=f.ticket(a);
  assert.notEqual((await f.call(`/uploads/${id}/remove`,{},b)).status,200);
  const result=await f.call(`/uploads/${id}/remove`,{},a);assert.equal(result.status,200);assert.equal(result.body.state,'removed');
  assert.equal(result.body.asset_id,null);assert.equal(result.body.checkout_ready,false);
  assert.throws(()=>f.r.store.resourceSessions.assert(ticket),/RESOURCE_FENCED/);
  await f.r.refresh();assert.equal((await f.call(`/uploads/${id}/status`,{},a)).body.state,'removed');
});


test('future customer policy cannot alter ordinary issuance or an already-issued credential',async t=>{
 const f=await rig(t),token=await f.issue();
 const db=new DatabaseSync(join(f.c.dataDir,'jobs.sqlite'),{readOnly:true});t.after(()=>db.close());
 const rows=()=>db.prepare('SELECT * FROM resource_sessions ORDER BY owner').all();const before=rows();
 assert.equal(before[0].expires-before[0].created,300000);
 assert.throws(()=>f.r.store.resourceSessions.issue({id:opaque(),observedAt:f.clock.time,customerId:null},{ttlMs:600000}),/RESOURCE_SESSION_POLICY/);
 assert.deepEqual(rows(),before);
 assert.equal((await f.call('/resource-sessions/issue',{proof:f.proof(),ttlMs:600000})).status,403);
 assert.deepEqual(rows(),before);assert.equal(f.ticket(token).owner,before[0].owner);
});
