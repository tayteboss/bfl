import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {rig,bytes,asset,deferred,origin} from '../../../fixtures/film-printing/f05d/rig.mjs';
import {openDatabase} from '../backend/storage.mjs';
import {createSessionOnlyRuntime} from '../backend/session-only.mjs';
const token=async f=>{const r=await f.issue();assert.equal(r.status,200);return r.body.token;};
const intent=async(f,a,key='owned-upload-1')=>{const r=await f.call('/uploads/intents',{request_key:key},a);assert.equal(r.status,200);return r.body.intent_id;};
const upload=(f,a,id)=>f.call(`/uploads/${id}/bytes`,bytes,a,{'content-type':'image/jpeg'});
const renew=async(f,a)=>f.call('/resource-sessions/renew',{proof:(await f.proof('renew',a)).body.proof},a);
const custody=f=>f.rows('SELECT state FROM upload_custody').map(r=>r.state);

test('F05D real HTTP/SQLite fresh owners isolate intent/bytes/status/preview/removal and preserve replay bounds',async t=>{
 const f=await rig(t),a=await token(f),b=await token(f),id=await intent(f,a);
 assert.equal(await intent(f,a),id);
 assert.equal((await upload(f,a,id)).body.state,'complete');assert.equal(f.p.posts,1);
 assert.equal((await upload(f,a,id)).body.state,'complete');assert.equal(f.p.posts,1);
 for(const action of ['bytes','status','preview','remove'])assert.notEqual((await f.call(`/uploads/${id}/${action}`,action==='bytes'?bytes:{},b,action==='bytes'?{'content-type':'image/jpeg'}:{})).status,200);
 const preview=await f.call(`/uploads/${id}/preview`,{},a);assert.equal(preview.status,200);assert.match(preview.body.url,/synthetic.s.ucarecd.net/);assert.ok(preview.body.expires_at<=f.clock.time+30000);
 assert.equal((await f.call(`/uploads/${id}/original`,{},a)).status,404); // Separate trusted opt-in remains closed here.
 assert.notEqual((await f.call(`/uploads/${asset}/preview`,{},a)).status,200);
 const r=await f.call(`/uploads/${id}/remove`,{},a);assert.equal(r.body.state,'removed');assert.equal(f.p.deletes,1);assert.deepEqual(custody(f),['deleted']);
 assert.notEqual((await f.call(`/uploads/${id}/preview`,{},a)).status,200);
 await f.r.cleanup();assert.equal(f.p.deletes,1);
 assert.equal(f.rows('SELECT count(*) AS n FROM authority_events WHERE acknowledged=0')[0].n,0);
 assert.equal((await intent(f,b,'owner-b-new')).length,36);
});

test('F05D absent/context/session-only credentials, copied locators and broad routes stay closed',async t=>{
 const f=await rig(t),a=await token(f),id=await intent(f,a);
 const c=(await f.call('/session/challenge')).body;
 const b=await (await fetch(f.url+'/proxy/bootstrap?'+f.sign({challenge:c.challenge}))).json();
 const context=(await f.call('/session/exchange',{challenge:c.challenge,verifier:c.verifier,ticket:b.ticket})).body.token;
 for(const credential of [undefined,context,'bflr1_'+'a'.repeat(43)])assert.notEqual((await f.call(`/uploads/${id}/status`,{},credential)).status,200);
 for(const path of ['/jobs','/quote','/cart','/authority','/orders','/hooks/uploadcare','/callbacks/shippo','/checkout','/admin/status'])assert.equal((await f.call(path,{},a)).status,404);
 for(const extra of [{cookie:'x=1'},{origin:'https://foreign.invalid'}])assert.equal((await f.call(`/uploads/${id}/status`,{},a,extra)).status,403);
 assert.equal((await f.call(`/uploads/${id}/status?token=invalid`,{},a)).status,403);
 await f.r.close();
 const s=openDatabase(f.config,{resourceSessions:true,sessionOnly:true,now:()=>f.clock.time});
 const old=s.store.resourceSessions.issue({id:'x'.repeat(43),observedAt:f.clock.time,customerId:null}).token;s.close();
 const next=await rig(t,{config:f.config,clock:f.clock});
 assert.notEqual((await next.call(`/uploads/${id}/status`,{},old)).status,200);
 assert.equal((await next.call(`/uploads/${id}/status`,{},a)).status,200);
});

for(const race of ['renew','expiry','revoke'])test(`F05D ${race} during POST retains exact provider UUID for cleanup but cannot complete or deliver`,async t=>{
 const f=await rig(t),a=await token(f),id=await intent(f,a),began=deferred(),release=deferred();
 f.p.beforePost=()=>{began.resolve();return release.promise;};
 const pending=upload(f,a,id);await began.promise;
 if(race==='renew')assert.equal((await renew(f,a)).status,200);
 if(race==='expiry')f.clock.time+=300001;
 if(race==='revoke')assert.equal((await f.call('/resource-sessions/revoke',{},a)).status,200);
 release.resolve();assert.notEqual((await pending).status,200);
 assert.equal(f.rows('SELECT asset,state FROM upload_intents')[0].asset,null);
 assert.deepEqual(custody(f),['deleted']);assert.equal(f.p.deletes,1);assert.equal(f.p.posts,1);
});

for(const race of ['renew','expiry','revoke'])test(`F05D ${race} during private preview provider await prevents late signature`,async t=>{
 const f=await rig(t),a=await token(f),id=await intent(f,a);assert.equal((await upload(f,a,id)).status,200);
 const began=deferred(),release=deferred();f.p.beforeInfo=()=>{began.resolve();return release.promise;};
 const pending=f.call(`/uploads/${id}/preview`,{},a);await began.promise;
 if(race==='renew')assert.equal((await renew(f,a)).status,200);
 if(race==='expiry')f.clock.time+=300001;
 if(race==='revoke')assert.equal((await f.call('/resource-sessions/revoke',{},a)).status,200);
 release.resolve();const result=await pending;assert.notEqual(result.status,200);assert.equal(result.body.url,undefined);
 assert.deepEqual(custody(f),['deleted']);
});

test('F05D uncertain POST remains durable unknown across restart; duplicate never uploads again',async t=>{
 const f=await rig(t),a=await token(f),id=await intent(f,a);f.p.unknownPost=true;
 assert.notEqual((await upload(f,a,id)).status,200);assert.deepEqual(custody(f),['upload-unknown']);
 assert.equal((await upload(f,a,id)).body.state,'failed');assert.equal(f.p.posts,1);assert.equal(f.p.deletes,0);
 await f.r.close();const next=await rig(t,{config:f.config,clock:f.clock});await next.r.cleanup();
 assert.deepEqual(custody(next),['upload-unknown']);assert.equal(next.p.posts,0);assert.equal(next.p.deletes,0);
});

test('F05D uncertain DELETE remains durable unknown and never retries after restart',async t=>{
 const f=await rig(t),a=await token(f),id=await intent(f,a);await upload(f,a,id);f.p.unknownDelete=true;
 assert.equal((await f.call(`/uploads/${id}/remove`,{},a)).body.state,'removed');assert.deepEqual(custody(f),['delete-unknown']);
 await f.r.cleanup();assert.equal(f.p.deletes,1);await f.r.close();
 const next=await rig(t,{config:f.config,clock:f.clock});assert.deepEqual(custody(next),['delete-unknown']);assert.equal(next.p.deletes,0);
});

test('F05D immutable upload purpose, job exclusion, admission bounds, pending authority and retained locks',async t=>{
 const f=await rig(t),a=await token(f);await intent(f,a);
 assert.throws(()=>openDatabase(f.config,{resourceSessions:true,uploadOnly:true}),/DATABASE_LOCKED/);
 await f.r.close();const s=openDatabase(f.config,{resourceSessions:true,uploadOnly:true,now:()=>f.clock.time});
 const ticket=s.store.resourceSessions.authenticate({headers:f.headers(a)});
 assert.throws(()=>s.store.resourceSessions.admit(ticket,'jobs','cannot-admit-job'),/UPLOAD_ONLY/);
 assert.throws(()=>s.store.save(ticket.owner,'job-key-1','fp',{id:'job-id-1',completed_asset_ids:[]}),/UPLOAD_ONLY/);
 for(let i=1;i<1000;i++)s.store.resourceSessions.admit(ticket,'uploads',`admit-key-${i}`);
 assert.throws(()=>s.store.resourceSessions.admit(ticket,'uploads','admit-over-limit'),/RESOURCE_ADMISSION_LIMIT/);
 s.store.revoke({id:'legacy-pending',kind:'owner',owner:'legacy'});const op=s.store.lifecycle.startRecovery();s.close();
 const db=new DatabaseSync(join(f.config.dataDir,'jobs.sqlite'));
 assert.throws(()=>db.prepare('UPDATE resource_sessions SET purpose=? WHERE owner=?').run('bfl:application-resources:v1',ticket.owner),/IMMUTABLE_RESOURCE_PURPOSE/);
 assert.throws(()=>db.prepare('INSERT INTO jobs VALUES (?,?,?,?,?)').run('forbidden',ticket.owner,'other-key','fp','{}'),/UPLOAD_ONLY/);db.close();
 const next=await rig(t,{config:f.config,clock:f.clock});assert.equal((await next.issue()).status,403);
 assert.equal(next.rows('SELECT count(*) AS n FROM authority_events WHERE acknowledged=0')[0].n,1);
 assert.equal(JSON.parse(next.rows('SELECT operation FROM authority_state')[0].operation).id,op.id);
 assert.equal((await next.call('/resource-sessions/revoke',{},a)).status,200);
 assert.equal(next.rows('SELECT count(*) AS n FROM authority_events WHERE acknowledged=0')[0].n,1);
});

test('F05D one durable provider-send ceiling survives deletion; changing owner or intent cannot reset it',async t=>{
 const f=await rig(t),a=await token(f),id=await intent(f,a);await upload(f,a,id);await f.call(`/uploads/${id}/remove`,{},a);
 const b=await token(f),other=await intent(f,b,'second-send-1');assert.notEqual((await upload(f,b,other)).status,200);
 assert.equal(f.p.posts,1);assert.equal(f.rows('SELECT count(*) AS n FROM upload_custody')[0].n,1);
});

test('F05D upload window closes and payload digest rejects before provider POST',async t=>{
 const f=await rig(t);await f.r.close();f.config.uploadWindowUntil=f.clock.time+1000;f.config.uploadDigest='0'.repeat(64);
 const next=await rig(t,{config:f.config,clock:f.clock}),a=await token(next),id=await intent(next,a);
 assert.equal((await upload(next,a,id)).body.code,'UPLOAD_DIAGNOSTIC_PAYLOAD');assert.equal(next.p.posts,0);
 f.clock.time+=1001;assert.equal((await next.call(`/uploads/${id}/status`,{},a)).status,404);assert.equal((await next.issue()).status,404);
});

test('F05D nonvisual browser library executes owned uploads over real local HTTP without exposing application bearer',async t=>{
 const {createOwnedUploads}=await import('../theme/owned-uploads.js');
 const {browserTransport}=await import('../../../fixtures/film-printing/f06j/rig.mjs');
 const previous=globalThis.location;globalThis.location={origin};t.after(()=>{if(previous===undefined)delete globalThis.location;else globalThis.location=previous;});
 const f=await rig(t),client=createOwnedUploads({fetchImpl:browserTransport(f),now:()=>f.clock.time});
 assert.equal((await client.issue()).token,undefined);const i=await client.intent('browser-owned-1');
 assert.equal((await client.bytes(i.intent_id,new Blob([bytes],{type:'image/jpeg'}))).state,'complete');
 assert.equal((await client.renew()).generation,2);assert.equal((await client.status(i.intent_id)).state,'complete');
 assert.ok((await client.preview(i.intent_id)).url);assert.throws(()=>client.status(asset),/UPLOAD_INTENT_UNAVAILABLE/);
 assert.equal((await client.remove(i.intent_id)).state,'removed');assert.equal((await client.revoke()).remote_confirmed,true);
 assert.equal(f.p.posts,1);assert.equal(f.p.deletes,1);
});

test('F05D real killed writer retains lock; explicit recovery preserves unknown send custody and closed rollback',async t=>{
 const {spawn}=await import('node:child_process');const {once}=await import('node:events');const {readFileSync}=await import('node:fs');
 const {releaseAbandonedLock}=await import('../backend/storage.mjs');
 const f=await rig(t),a=await token(f),id=await intent(f,a);await f.r.close();
 const module=new URL('../backend/storage.mjs',import.meta.url).href;
 const script=`import {openDatabase} from ${JSON.stringify(module)};const c=JSON.parse(process.env.TEST_CONFIG);const s=openDatabase(c,{resourceSessions:true,uploadOnly:true});const r=s.store.uploadLedger.read(${JSON.stringify(id)});s.store.uploadLedger.claim(r.owner,r.id,r.binding,{digest:'a'.repeat(64),size:1,mime:'image/jpeg'});s.store.uploadCustody.start(r.id,r.binding);console.log('ready');setInterval(()=>{},1000);`;
 const child=spawn(process.execPath,['--input-type=module','-e',script],{env:{...process.env,TEST_CONFIG:JSON.stringify(f.config)},stdio:['ignore','pipe','ignore']});t.after(()=>child.kill('SIGKILL'));
 await once(child.stdout,'data');const lock=JSON.parse(readFileSync(join(f.config.dataDir,'runtime.lock/owner.json')));
 assert.throws(()=>releaseAbandonedLock(f.config,lock.token,true),/WRITER_STILL_ALIVE/);
 const exited=once(child,'exit');child.kill('SIGKILL');await exited;
 assert.throws(()=>openDatabase(f.config,{resourceSessions:true,uploadOnly:true}),/DATABASE_LOCKED/);
 assert.throws(()=>releaseAbandonedLock(f.config,'wrong',true),/LOCK_CHANGED/);releaseAbandonedLock(f.config,lock.token,true);
 const next=await rig(t,{config:f.config,clock:f.clock});assert.deepEqual(custody(next),['upload-unknown']);assert.equal(next.p.posts,0);assert.equal(next.p.deletes,0);
 await next.r.close();const closed=createSessionOnlyRuntime({...f.config,resourceSessions:'session-only-closed'},{now:()=>f.clock.time});t.after(()=>closed.close());
 const address=await closed.start();assert.equal((await fetch(`http://127.0.0.1:${address.port}/uploads/intents`,{method:'POST'})).status,404);
 assert.deepEqual(custody(next),['upload-unknown']);assert.equal(next.rows('SELECT count(*) AS n FROM resource_admissions')[0].n,1);
});
