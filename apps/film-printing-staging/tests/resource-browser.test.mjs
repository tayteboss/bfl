import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createResourceSession} from '../theme/resource-session.js';
import {rig,browserTransport,origin,bytes,selection,deferred} from '../../../fixtures/film-printing/f06j/rig.mjs';
const tick=()=>new Promise(r=>setImmediate(r));
function browser(t){const previous=globalThis.location;globalThis.location={origin};t.after(()=>{if(previous===undefined)delete globalThis.location;else globalThis.location=previous;});}
const count=(f,sql)=>{const db=new DatabaseSync(join(f.config.dataDir,'jobs.sqlite'),{readOnly:true});try{return db.prepare(sql).all();}finally{db.close();}};

test('F06J uninstalled memory consumer drives concrete issue/upload/job/renew/revoke without exposing bearer',async t=>{
 browser(t);const f=await rig(t),calls=[];
 const fetchImpl=browserTransport(f,{intercept:async(path,work)=>{calls.push(path);return work();}});
 const s=createResourceSession({fetchImpl,now:()=>f.clock.time});assert.equal(calls.length,0);
 const issued=await s.issue();assert.equal(issued.generation,1);assert.equal(issued.token,undefined);
 const i=await s.request('/uploads/intents',{request_key:'browser-upload-1'});
 assert.equal((await s.request(`/uploads/${i.intent_id}/bytes`,bytes,{mime:'image/jpeg'})).state,'complete');
 assert.ok((await s.request('/jobs',selection)).reference);
 assert.equal((await s.renew()).generation,2);assert.equal((await s.request(`/uploads/${i.intent_id}/status`,{})).state,'complete');
 assert.equal((await s.revoke()).remote_confirmed,true);await assert.rejects(s.request('/jobs',selection),/RESOURCE_EXPIRED/);
 assert.equal(count(f,'SELECT * FROM resource_sessions')[0].revoked,f.clock.time);
});

test('F06J helper rejects foreign origin, active issue, unsupported paths and resource/context endpoint substitution',async t=>{
 browser(t);const f=await rig(t);globalThis.location={origin:'https://evil.test'};assert.throws(()=>createResourceSession(),/RESOURCE_TARGET/);globalThis.location={origin};
 const s=createResourceSession({fetchImpl:browserTransport(f),now:()=>f.clock.time});await s.issue();
 await assert.rejects(s.issue(),/RESOURCE_ACTIVE/);
 for(const path of ['/quote','/session/context','/resource-sessions/renew','https://evil.test','/jobs?token=x','/uploads/complete'])await assert.rejects(s.request(path,{}),/RESOURCE_PATH/);
 await assert.rejects(s.request('/jobs',{}, {mime:'image/jpeg'}),/RESOURCE_INPUT/);
 await s.revoke();
});

test('F06J concurrent issuance rejects busy; revocation supersedes before exchange without minting authority',async t=>{
 browser(t);const f=await rig(t),began=deferred(),release=deferred();
 const s=createResourceSession({now:()=>f.clock.time,fetchImpl:browserTransport(f,{intercept:async(path,work)=>{
   const result=await work();if(path==='/resource-proof/challenge'){began.resolve();await release.promise;}return result;
 }})});
 const a=s.issue();await began.promise;await assert.rejects(s.issue(),/RESOURCE_BUSY/);await assert.rejects(s.request('/jobs',selection),/RESOURCE_BUSY/);
 assert.equal((await s.revoke()).remote_confirmed,false);release.resolve();await assert.rejects(a,/RESOURCE_SUPERSEDED/);
 assert.equal(count(f,'SELECT * FROM resource_sessions').length,0);
});

test('F06J late issuance response after revoke is discarded and its known credential revoked',async t=>{
 browser(t);const f=await rig(t),began=deferred(),release=deferred();
 const s=createResourceSession({now:()=>f.clock.time,fetchImpl:browserTransport(f,{intercept:async(path,work)=>{
  const response=await work();if(path==='/resource-sessions/issue'){began.resolve();await release.promise;}return response;
 }})});
 const pending=s.issue();await began.promise;await s.revoke();release.resolve();await assert.rejects(pending,/RESOURCE_SUPERSEDED/);
 assert.ok(count(f,'SELECT * FROM resource_sessions')[0].revoked);await assert.rejects(s.renew(),/RESOURCE_EXPIRED/);
});

test('F06J renewal single-flight and late response after revoke cannot install the rotated credential',async t=>{
 browser(t);const f=await rig(t),began=deferred(),release=deferred();
 const s=createResourceSession({now:()=>f.clock.time,fetchImpl:browserTransport(f,{intercept:async(path,work)=>{
  const response=await work();if(path==='/resource-sessions/renew'){began.resolve();await release.promise;}return response;
 }})});
 await s.issue();const pending=s.renew();await began.promise;await assert.rejects(s.renew(),/RESOURCE_BUSY/);
 // The old bearer may already be rotated: local clear succeeds, remote denial
 // is surfaced. The arriving new bearer is separately disposed of.
 await assert.rejects(s.revoke(),/RESOURCE_UNAVAILABLE/);release.resolve();await assert.rejects(pending,/RESOURCE_SUPERSEDED/);
 const row=count(f,'SELECT * FROM resource_sessions')[0];assert.ok(row.revoked);assert.equal(row.generation,3);
 await assert.rejects(s.request('/jobs',selection),/RESOURCE_EXPIRED/);
});

test('F06J lost issuance response leaves bounded orphan; new issuance has new scope and cannot recover it',async t=>{
 browser(t);const f=await rig(t);let lost=true;
 const s=createResourceSession({now:()=>f.clock.time,fetchImpl:browserTransport(f,{intercept:async(path,work)=>{
  const response=await work();if(path==='/resource-sessions/issue'&&lost){lost=false;await response.text();throw Error('synthetic response lost');}return response;
 }})});
 await assert.rejects(s.issue(),/RESOURCE_UNAVAILABLE/);await assert.rejects(s.renew(),/RESOURCE_EXPIRED/);await s.issue();
 const rows=count(f,'SELECT * FROM resource_sessions');assert.equal(rows.length,2);assert.notEqual(rows[0].owner,rows[1].owner);assert.equal(rows[0].revoked,null);
 assert.equal(rows[0].expires-rows[0].created,300000);await s.revoke();
});

test('F06J lost rotation response clears custody, old credential cannot recover; next issue creates a different principal',async t=>{
 browser(t);const f=await rig(t);let lost=true;
 const s=createResourceSession({now:()=>f.clock.time,fetchImpl:browserTransport(f,{intercept:async(path,work)=>{
  const response=await work();if(path==='/resource-sessions/renew'&&lost){lost=false;await response.text();throw Error('synthetic response lost');}return response;
 }})});
 await s.issue();await assert.rejects(s.renew(),/RESOURCE_UNAVAILABLE/);await assert.rejects(s.renew(),/RESOURCE_EXPIRED/);
 const orphan=count(f,'SELECT * FROM resource_sessions')[0];assert.equal(orphan.generation,2);assert.equal(orphan.revoked,null);
 await s.issue();const rows=count(f,'SELECT * FROM resource_sessions');assert.equal(rows.length,2);assert.notEqual(rows[0].owner,rows[1].owner);await s.revoke();
});

test('F06J observation change retires and clears browser credential; no automatic issuance/transfer',async t=>{
 browser(t);const f=await rig(t);let customer='123';
 const s=createResourceSession({now:()=>f.clock.time,fetchImpl:browserTransport(f,{customer:()=>customer})});await s.issue();customer='';
 await assert.rejects(s.renew(),/RESOURCE_CONTEXT_CHANGED/);assert.equal(count(f,'SELECT * FROM resource_sessions').length,1);
 await assert.rejects(s.request('/jobs',selection),/RESOURCE_EXPIRED/);await f.r.refresh();await s.issue();assert.equal(count(f,'SELECT * FROM resource_sessions').length,2);await s.revoke();
});

test('F06J local expiry and delayed issuance response use send-time expiry; no stale credential becomes current',async t=>{
 browser(t);const f=await rig(t);let delay=false;
 const s=createResourceSession({now:()=>f.clock.time,fetchImpl:browserTransport(f,{intercept:async(path,work)=>{
  const response=await work();if(delay&&path==='/resource-sessions/issue')f.clock.time+=300000;return response;
 }})});
 await s.issue();f.clock.time+=300000;await assert.rejects(s.renew(),/RESOURCE_EXPIRED/);await assert.rejects(s.request('/jobs',selection),/RESOURCE_EXPIRED/);
 delay=true;await assert.rejects(s.issue(),/RESOURCE_EXPIRED/);await assert.rejects(s.renew(),/RESOURCE_EXPIRED/);
});

test('F06J in-flight resource response after renewal is suppressed even if server side effect completed',async t=>{
 browser(t);const f=await rig(t),began=deferred(),release=deferred();let held=true;
 const s=createResourceSession({now:()=>f.clock.time,fetchImpl:browserTransport(f,{intercept:async(path,work)=>{
  const response=await work();if(held&&path==='/uploads/intents'){held=false;began.resolve();await release.promise;}return response;
 }})});
 await s.issue();const pending=s.request('/uploads/intents',{request_key:'browser-delayed-intent'});await began.promise;await s.renew();release.resolve();await assert.rejects(pending,/RESOURCE_SUPERSEDED/);
 assert.equal(count(f,'SELECT * FROM upload_intents').length,1);await s.revoke();
});

test('F06J failed remote revocation still clears local custody and does not claim success',async t=>{
 browser(t);const f=await rig(t);
 const s=createResourceSession({now:()=>f.clock.time,fetchImpl:browserTransport(f,{intercept:async(path,work)=>{
  if(path==='/resource-sessions/revoke')throw Error('synthetic offline');return work();
 }})});
 await s.issue();await assert.rejects(s.revoke(),/RESOURCE_UNAVAILABLE/);await assert.rejects(s.renew(),/RESOURCE_EXPIRED/);
 assert.equal(count(f,'SELECT * FROM resource_sessions')[0].revoked,null);
});

test('F06J helper source remains standalone with no persistence, imports, timers, globals or automatic calls',()=>{
 const source=readFileSync(new URL('../theme/resource-session.js',import.meta.url),'utf8');
 for(const forbidden of ['localStorage','sessionStorage','document.cookie','window.','setInterval(','setTimeout(','console.','import '])assert.equal(source.includes(forbidden),false);
 assert.equal(source.includes("credentials:'omit'"),true);assert.equal(source.includes("credentials:'same-origin'"),true);
});
