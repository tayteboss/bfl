import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {rig,origin,purpose,audience,bytes,selection,deferred} from '../../../fixtures/film-printing/f06j/rig.mjs';
import {createRuntime} from '../backend/server.mjs';
const opaque='a'.repeat(43);
const exchange=(c,b)=>({action:c.action,challenge:c.challenge,verifier:c.verifier,ticket:b.ticket});

test('F06J concrete HTTP signed proof issues independent resource owners; actual uploads/jobs stay isolated',async t=>{
 const f=await rig(t),a=await f.issue('123'),b=await f.issue('123');assert.equal(a.status,200);assert.equal(b.status,200);
 const ta=a.body.token,tb=b.body.token;assert.notEqual(f.ticket(ta).owner,f.ticket(tb).owner);
 const i=await f.call('/uploads/intents',{request_key:'proof-upload-1'},ta);assert.equal(i.status,200);
 assert.equal((await f.call(`/uploads/${i.body.intent_id}/bytes`,bytes,ta,{'content-type':'image/jpeg'})).status,200);
 const job=await f.call('/jobs',selection,ta);assert.equal(job.status,200);assert.equal(job.body.checkout_ready,false);
 assert.throws(()=>f.r.store.get(job.body.reference.id,f.ticket(tb).owner));
 assert.notEqual((await f.call(`/uploads/${i.body.intent_id}/status`,{},tb)).status,200);
 assert.equal((await f.call('/quote',{},ta)).body.code,'RESOURCE_CART_PROOF_UNAVAILABLE');
});

test('F06J response-only ticket AND original verifier required; bootstrap/exchange/issue each single-use',async t=>{
 const f=await rig(t),c=(await f.challenge()).body,d=(await f.challenge()).body,b=await f.bootstrap(c,'123');
 assert.equal(b.status,200);assert.equal(b.headers.get('access-control-allow-origin'),null);assert.equal(b.headers.get('cache-control'),'no-store');
 for(const patch of [{ticket:opaque},{verifier:d.verifier},{challenge:d.challenge},{action:'renew'}])assert.equal((await f.call('/resource-proof/exchange',{...exchange(c,b.body),...patch})).status,403);
 assert.equal((await f.bootstrap(c,'123')).status,403);
 const e=await f.call('/resource-proof/exchange',exchange(c,b.body));assert.equal(e.status,200);
 assert.equal((await f.call('/resource-proof/exchange',exchange(c,b.body))).status,403);
 assert.equal((await f.call('/resource-sessions/issue',{proof:e.body.proof})).status,200);
 assert.equal((await f.call('/resource-sessions/issue',{proof:e.body.proof})).status,403);
});

test('F06J signed purpose/action/audience/shop/path/customer substitutions and duplicate challenge reject',async t=>{
 const f=await rig(t),c=(await f.challenge()).body;
 for(const patch of [{purpose:'bfl:context'},{audience:audience+'/evil'},{action:'renew'},{shop:'other.myshopify.com'},{path_prefix:'/apps/other'},{logged_in_customer_id:'-1'}])assert.equal((await f.bootstrap(c,'',patch)).status,403);
 const query=f.sign({challenge:c.challenge,purpose,audience,action:'issue'});
 for(const q of [query+'&challenge='+c.challenge,query.replace('logged_in_customer_id=','logged_in_customer_id=123')])assert.equal((await fetch(f.url+'/proxy/resource-proof?'+q)).status,403);
 assert.equal((await f.bootstrap(c)).status,200);
});

test('F06J context protocol, resource tokens, challenge, verifier and response ticket cannot substitute for proof',async t=>{
 const f=await rig(t),c=(await f.challenge()).body,b=(await f.bootstrap(c)).body;
 const cc=(await f.call('/session/challenge')).body;
 assert.equal((await fetch(f.url+'/proxy/bootstrap?'+f.sign({challenge:c.challenge}))).status,403);
 assert.equal((await f.bootstrap({...c,challenge:cc.challenge})).status,403);
 const cb=await (await fetch(f.url+'/proxy/bootstrap?'+f.sign({challenge:cc.challenge}))).json();
 const context=await f.call('/session/exchange',{challenge:cc.challenge,verifier:cc.verifier,ticket:cb.ticket});assert.equal(context.status,200);
 const token=(await f.issue()).body.token;
 for(const proof of [c.challenge,c.verifier,b.ticket,context.body.token,token,opaque])assert.equal((await f.call('/resource-sessions/issue',{proof})).status,403);
 assert.equal((await f.call('/session/context',{},context.body.token)).status,200);
 assert.equal((await f.call('/resource-proof/challenge',{action:'renew'},context.body.token)).status,403);
});

test('F06J exact origin/header/body/query and preflight bounds, no cookies or credentialed CORS',async t=>{
 const f=await rig(t);
 for(const extra of [{origin:'https://evil.test'},{origin:origin+'/'},{cookie:'bfl_session=fake'},{authorization:'Bearer '+opaque},{'content-type':'text/plain'},{'content-encoding':'gzip'}])assert.equal((await f.call('/resource-proof/challenge',{action:'issue'},undefined,extra)).status,403);
 for(const body of [{action:'issue',customer:'123'},{action:'issue',owner:'x'},[],null,{action:'x'},{action:'issue',extra:'x'.repeat(2000)}])assert.equal((await f.call('/resource-proof/challenge',body)).status,403);
 assert.equal((await f.call('/resource-proof/challenge?x=1',{action:'issue'})).status,403);
 assert.equal((await f.call('/resource-proof/challenge',Buffer.from([0xff]))).status,403);
 const pre=await fetch(f.url+'/resource-proof/challenge',{method:'OPTIONS',headers:{origin,'access-control-request-method':'POST','access-control-request-headers':'content-type, authorization'}});
 assert.equal(pre.status,204);assert.equal(pre.headers.get('access-control-allow-origin'),origin);assert.equal(pre.headers.get('access-control-allow-credentials'),null);assert.equal(pre.headers.get('set-cookie'),null);
 assert.equal((await fetch(f.url+'/resource-proof/exchange',{method:'OPTIONS',headers:{origin,'access-control-request-method':'GET'}})).status,403);
});

test('F06J challenge deadline and signed observation age cannot be extended by delayed exchange',async t=>{
 const f=await rig(t),c=(await f.challenge()).body;
 assert.equal((await f.bootstrap(c,'',{timestamp:String(Math.floor(f.clock.time/1000)-1)})).status,403);
 assert.equal((await f.bootstrap(c,'',{timestamp:String(Math.floor(f.clock.time/1000)+1)})).status,403);
 const b=(await f.bootstrap(c)).body;f.clock.time+=29000;
 const e=await f.call('/resource-proof/exchange',exchange(c,b));assert.equal(e.status,200);assert.ok(e.body.expires_in<=1);
 f.clock.time+=1000;assert.equal((await f.call('/resource-sessions/issue',{proof:e.body.proof})).status,403);
 const next=(await f.challenge()).body;f.clock.time+=30000;assert.equal((await f.bootstrap(next)).status,403);
});

test('F06J renewal is bound to original principal/generation/action; concurrent renew has one winner',async t=>{
 const f=await rig(t),a=(await f.issue()).body.token,b=(await f.issue()).body.token;
 const c=(await f.challenge('renew',a)).body,boot=(await f.bootstrap(c)).body;
 assert.equal((await f.call('/resource-proof/exchange',exchange(c,boot),b)).status,403);
 const e=await f.call('/resource-proof/exchange',exchange(c,boot),a);assert.equal(e.status,200);
 assert.equal((await f.call('/resource-sessions/issue',{proof:e.body.proof})).status,403);
 assert.equal((await f.call('/resource-sessions/renew',{proof:e.body.proof},b)).status,403);
 const other=(await f.proof('renew',a)).body.proof;
 const result=await Promise.all([f.call('/resource-sessions/renew',{proof:e.body.proof},a),f.call('/resource-sessions/renew',{proof:other},a)]);
 assert.deepEqual(result.map(r=>r.status).sort(),[200,403]);assert.throws(()=>f.ticket(a));
 assert.equal(f.ticket(result.find(r=>r.status===200).body.token).generation,2);
});

for(const [before,after] of [['','123'],['123',''],['123','456']])test(`F06J synthetic observed identity ${before||'absent'} to ${after||'absent'} retires without transfer`,async t=>{
 const f=await rig(t),a=(await f.issue(before)).body.token,owner=f.ticket(a).owner;
 const e=(await f.proof('renew',a,after)).body;
 const result=await f.call('/resource-sessions/renew',{proof:e.proof},a);assert.equal(result.status,403);assert.equal(result.body.code,'RESOURCE_CONTEXT_CHANGED');
 assert.throws(()=>f.ticket(a));assert.equal(f.r.store.lifecycle.retired('owner',owner),true);
 await f.r.refresh();const b=(await f.issue(after)).body.token;assert.notEqual(f.ticket(b).owner,owner);
});

test('F06J revocation/epoch fencing invalidates outstanding challenge and proofs',async t=>{
 const f=await rig(t),a=(await f.issue()).body.token,c=(await f.challenge('renew',a)).body;
 const issueProof=(await f.proof()).body.proof;
 assert.equal((await f.call('/resource-sessions/revoke',{},a)).status,200);await f.r.refresh();
 assert.equal((await f.bootstrap(c)).status,403);
 assert.equal((await f.call('/resource-sessions/issue',{proof:issueProof})).status,403);
});

test('F06J restart destroys pending proof secrets while durable credentials/rotation/revocation and admission remain',async t=>{
 const f=await rig(t),a=(await f.issue()).body.token,b=(await f.issue()).body.token;
 const e=(await f.proof('renew',a)).body.proof,next=(await f.call('/resource-sessions/renew',{proof:e},a)).body.token;
 const pending=(await f.proof()).body.proof,c=(await f.challenge()).body;
 await f.call('/resource-sessions/revoke',{},b);await f.r.refresh();await f.r.close();
 const nextRig=await rig(t,{config:f.config,clock:f.clock,m:f.m});
 // Close the replacement before the original rig's directory cleanup hook.
 try {
  assert.throws(()=>nextRig.ticket(a));assert.throws(()=>nextRig.ticket(b));assert.equal(nextRig.ticket(next).generation,2);
  assert.equal((await nextRig.call('/resource-sessions/issue',{proof:pending})).status,403);assert.equal((await nextRig.bootstrap(c)).status,403);
  assert.equal((await nextRig.call('/resource-sessions/renew',{proof:e},next)).status,403);
  const db=new DatabaseSync(join(f.config.dataDir,'jobs.sqlite'),{readOnly:true});
  const rows=db.prepare('SELECT * FROM resource_evidence').all();db.close();assert.ok(rows.some(r=>r.action==='proof-challenge'));assert.ok(rows.some(r=>r.action==='renew'));
  const raw=readFileSync(join(f.config.dataDir,'jobs.sqlite'));for(const value of [a,b,next,pending,c.challenge,c.verifier])assert.equal(raw.includes(Buffer.from(value)),false);
  assert.equal(JSON.stringify(f.logs).includes(a),false);
 }finally{await nextRig.r.close();}
});

test('F06J challenge rate/admission survives restart; total durable evidence capacity fails closed',async t=>{
 const f=await rig(t);for(let i=0;i<32;i++)assert.equal((await f.challenge()).status,200);
 assert.equal((await f.challenge()).status,403);await f.r.close();
 const g=await rig(t,{config:f.config,clock:f.clock,m:f.m});
 try{
  assert.equal((await g.challenge()).status,403);g.clock.time+=60000;assert.equal((await g.challenge()).status,200);
  const db=new DatabaseSync(join(g.config.dataDir,'jobs.sqlite'));
  const count=db.prepare('SELECT count(*) AS n FROM resource_evidence').get().n;
  db.exec('BEGIN');for(let i=count;i<4096;i++)db.prepare('INSERT INTO resource_evidence VALUES (?,?,?,?)').run('synthetic-capacity-'+i,0,0,'synthetic');db.exec('COMMIT');db.close();
  assert.equal((await g.challenge()).body.code,'RESOURCE_CAPACITY');
 }finally{await g.r.close();}
});

test('F06J concrete renewal fences in-flight provider completion before real SQLite binding',async t=>{
 const f=await rig(t),a=(await f.issue()).body.token,i=(await f.call('/uploads/intents',{request_key:'proof-race-upload'},a)).body;
 const began=deferred(),release=deferred();f.p.beforeUpload=()=>{began.resolve();return release.promise;};
 const upload=f.call(`/uploads/${i.intent_id}/bytes`,bytes,a,{'content-type':'image/jpeg'});await began.promise;
 const e=(await f.proof('renew',a)).body,renew=await f.call('/resource-sessions/renew',{proof:e.proof},a);assert.equal(renew.status,200);
 release.resolve();assert.notEqual((await upload).status,200);
 assert.notEqual((await f.call(`/uploads/${i.intent_id}/status`,{},renew.body.token)).body.state,'complete');
});

test('F06J concrete composition excludes synthetic callback and public binding; default executable unchanged',async t=>{
 const f=await rig(t);
 assert.throws(()=>createRuntime(f.config,{...f.options,resourceSessions:{mode:'local-test',freshProof:true,observeFreshContext:()=>({})}}),/RESOURCE_COMPOSITION_INVALID/);
 assert.throws(()=>createRuntime({...f.config,host:'0.0.0.0'},f.options),/RESOURCE_COMPOSITION_INVALID/);
 const main=readFileSync(new URL('../backend/main.mjs',import.meta.url),'utf8');assert.equal(main.includes('freshProof'),false);
});

test('F06J consumed proof stays burned if resource issuance fails; cannot retry after rate window',async t=>{
 const f=await rig(t);for(let i=0;i<16;i++)assert.equal((await f.issue()).status,200);
 const e=(await f.proof()).body;assert.equal((await f.call('/resource-sessions/issue',{proof:e.proof})).body.code,'RESOURCE_RATE');
 assert.equal((await f.call('/resource-sessions/issue',{proof:e.proof})).status,403);
 f.clock.time+=60000;assert.equal((await f.call('/resource-sessions/issue',{proof:e.proof})).status,403);
 assert.equal((await f.issue()).status,200);
});

test('F06J evidence rechecks lifecycle inside durable issuance transaction after observer consumption',async t=>{
 const {createResourceProof}=await import('../backend/resource-proof.mjs');
 const f=await rig(t),a=(await f.issue()).body.token;
 const adapter=createResourceProof({secret:f.config.appSecret,sessions:f.r.store.resourceSessions,now:()=>f.clock.time});
 const request={headers:f.headers()},c=adapter.challenge(request,{action:'issue'}),b=adapter.bootstrap(f.sign({challenge:c.challenge,purpose,audience,action:'issue'}));
 const e=adapter.exchange(request,exchange(c,b));const observation=adapter.observeFreshContext({request,proof:e.proof,action:'issue',ticket:null});
 await f.call('/resource-sessions/revoke',{},a);await f.r.refresh();
 assert.throws(()=>f.r.store.resourceSessions.issue(observation),/RESOURCE_FENCED/);adapter.close();
});

test('F06J duplicate security headers denied on new direct ingress',async t=>{
 const {request}=await import('node:http');const f=await rig(t);
 for(const duplicated of [['Origin',origin,'Origin',origin],['Origin',origin,'Authorization','Bearer '+opaque,'Authorization','Bearer '+opaque]]){
  const result=await new Promise((resolve,reject)=>{
   const req=request(f.url+'/resource-proof/challenge',{method:'POST',headers:['Host',new URL(f.url).host,'Content-Type','application/json',...duplicated]},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});
   req.on('error',reject);req.end(JSON.stringify({action:'issue'}));
  });assert.equal(result,403);
 }
});
