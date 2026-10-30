import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {rig,origin} from '../../../fixtures/film-printing/f06k/rig.mjs';
import {openDatabase,migrateResourceSessions} from '../backend/storage.mjs';
import {createSessionOnlyRuntime} from '../backend/session-only.mjs';
const read=f=>new DatabaseSync(join(f.config.dataDir,'jobs.sqlite'),{readOnly:true});
const state=f=>{const d=read(f);try{return {s:d.prepare('SELECT * FROM authority_state').get(),events:d.prepare('SELECT * FROM authority_events').all(),sessions:d.prepare('SELECT purpose,generation,revoked FROM resource_sessions').all(),receipts:d.prepare('SELECT count(*) n FROM resource_evidence').get().n};}finally{d.close();}};
test('session-only issue/rotate/revoke/reissue needs no Admin or provider; resources closed',async t=>{
 const f=await rig(t),a=await f.issue();assert.equal(a.status,200);
 const p=await f.proof('renew',a.body.token),b=await f.call('/resource-sessions/renew',{proof:p.body.proof},a.body.token);assert.equal(b.status,200);
 assert.equal((await f.challenge('renew',a.body.token)).status,403);
 for(const path of ['/jobs','/quote','/uploads/intent','/uploads/status','/authority','/orders','/callbacks','/checkout','/admin/status']){
  assert.equal((await f.call(path,{},b.body.token)).status,404);
  const r=await fetch(f.url+path,{method:'OPTIONS',headers:{origin,'access-control-request-method':'POST'}});assert.equal(r.status,404);assert.equal(r.headers.get('access-control-allow-origin'),null);
 }
 assert.equal((await f.call('/resource-sessions/revoke',{},b.body.token)).status,200);
 assert.equal((await f.challenge('renew',b.body.token)).status,403);
 assert.equal((await f.issue()).status,200);const s=state(f);assert.equal(s.s.epoch,1);assert.equal(s.events.length,0);assert.equal(s.sessions[0].purpose,'bfl:application-session-only:v1');
});
test('synthetic login/logout/account changes retire without remote events and permit separate issue',async t=>{
 const f=await rig(t);
 for(const [a,b] of [['','100'],['100',''],['100','200']]){const issued=await f.issue(a),p=await f.proof('renew',issued.body.token,b);const r=await f.call('/resource-sessions/renew',{proof:p.body.proof},issued.body.token);assert.equal(r.body.code,'RESOURCE_CONTEXT_CHANGED');assert.equal((await f.challenge('renew',issued.body.token)).status,403);}
 assert.equal((await f.issue()).status,200);assert.equal(state(f).events.length,0);assert.equal(state(f).s.epoch,3);
});
test('pending and unknown authority custody is retained; revoke possible but new issue remains fenced',async t=>{
 const f=await rig(t),a=await f.issue();await f.r.close();
 const s=openDatabase(f.config,{resourceSessions:true,sessionOnly:true});s.store.lifecycle.event('retained-event',{kind:'synthetic'},()=>{});const op=s.store.lifecycle.startRecovery();s.close();
 const g=await rig(t,{config:f.config,clock:f.clock});const before=state(g);assert.equal((await g.challenge()).body.code,'RESOURCE_FENCED');
 assert.equal((await g.call('/resource-sessions/revoke',{},a.body.token)).status,200);const after=state(g);
 assert.deepEqual(after.events,before.events);assert.equal(after.s.operation,before.s.operation);assert.equal(JSON.parse(after.s.operation).id,op.id);assert.equal(after.s.epoch,before.s.epoch+1);assert.equal((await g.challenge()).status,403);
 await g.r.close();const h=await rig(t,{config:f.config,clock:f.clock});assert.deepEqual(state(h).events,before.events);assert.equal((await h.challenge()).status,403);await h.r.close();
});
test('restart retains rotation/revocation/admission, discards transient proof; purpose cannot promote',async t=>{
 const f=await rig(t),a=await f.issue(),p=await f.proof();await f.r.close();
 const regular=openDatabase(f.config,{resourceSessions:true});assert.throws(()=>regular.store.resourceSessions.authenticate({headers:f.headers(a.body.token)}),/RESOURCE_REJECTED/);regular.close();
 const limited=openDatabase(f.config,{resourceSessions:true,sessionOnly:true});const ticket=limited.store.resourceSessions.authenticate({headers:f.headers(a.body.token)});assert.throws(()=>limited.store.resourceSessions.admit(ticket,'jobs','test-key-123'),/SESSION_ONLY/);limited.close();
 const g=await rig(t,{config:f.config,clock:f.clock});assert.equal((await g.call('/resource-sessions/issue',{proof:p.body.proof})).status,403);assert.equal((await g.call('/resource-sessions/revoke',{},a.body.token)).status,200);assert.equal((await g.issue()).status,200);await g.r.close();
 const h=await rig(t,{config:f.config,clock:f.clock});assert.equal((await h.challenge('renew',a.body.token)).status,403);assert.ok(state(h).receipts>=5);await h.r.close();
});
test('proof replay, wrong verifier, origin/cookie, substitution and stale epoch reject',async t=>{
 const f=await rig(t),c=(await f.challenge()).body,b=await f.bootstrap(c);assert.equal(b.status,200);assert.equal((await f.bootstrap(c)).status,403);
 assert.equal((await f.call('/resource-proof/exchange',{action:'issue',challenge:c.challenge,verifier:'x'.repeat(43),ticket:b.body.ticket})).status,403);
 const p=await f.call('/resource-proof/exchange',{action:'issue',challenge:c.challenge,verifier:c.verifier,ticket:b.body.ticket});assert.equal(p.status,200);
 const a=await f.call('/resource-sessions/issue',{proof:p.body.proof});assert.equal(a.status,200);assert.equal((await f.call('/resource-sessions/issue',{proof:p.body.proof})).status,403);
 assert.equal((await f.call('/resource-proof/challenge',{action:'issue'},undefined,{origin:'https://example.com'})).status,403);assert.equal((await f.call('/resource-proof/challenge',{action:'issue'},undefined,{cookie:'x=y'})).status,403);
 assert.equal((await f.call('/resource-sessions/issue',{proof:a.body.token})).status,403);
 const stale=await f.proof();await f.call('/resource-sessions/revoke',{},a.body.token);assert.equal((await f.call('/resource-sessions/issue',{proof:stale.body.proof})).status,403);
});
test('server expiry and freshness use clock; expired bearer cannot renew; new session works',async t=>{
 const f=await rig(t),a=await f.issue(),p=await f.proof();f.clock.time+=30001;assert.equal((await f.call('/resource-sessions/issue',{proof:p.body.proof})).status,403);
 f.clock.time+=300000;assert.equal((await f.challenge('renew',a.body.token)).status,403);assert.equal((await f.issue()).status,200);
});
test('context transport remains separate and ready is closed',async t=>{
 const f=await rig(t);const c=(await f.call('/session/challenge',{})).body;
 const q=f.sign({challenge:c.challenge});const r=await fetch(f.url+'/proxy/bootstrap?'+q);const b=await r.json();assert.equal(r.status,200);
 const e=await f.call('/session/exchange',{challenge:c.challenge,verifier:c.verifier,ticket:b.ticket});assert.equal(e.status,200);
 assert.equal((await f.call('/session/context',{},e.body.token)).status,200);assert.equal((await f.challenge('renew',e.body.token)).status,403);
 assert.equal((await fetch(f.url+'/readyz')).status,503);await f.call('/session/revoke',{},e.body.token);
});
test('configuration rejects privileged transport, wrong host and schema lock retained',async t=>{
 const f=await rig(t);assert.throws(()=>createSessionOnlyRuntime({...f.config,mode:'reconcile-only'}),/COMPOSITION/);assert.throws(()=>createSessionOnlyRuntime({...f.config,adminToken:'private'}),/COMPOSITION/);assert.throws(()=>createSessionOnlyRuntime({...f.config,origin:'https://example.com'}),/COMPOSITION/);assert.throws(()=>migrateResourceSessions(f.config),/DATABASE_LOCKED/);
});

test('closed rollback retains schema6 history and refuses resource protocol',async t=>{
 const f=await rig(t),a=await f.issue();await f.call('/resource-sessions/revoke',{},a.body.token);const before=state(f);await f.r.close();
 const g=await rig(t,{config:{...f.config,resourceSessions:'session-only-closed'},clock:f.clock});assert.equal((await g.challenge()).status,404);assert.equal((await fetch(g.url+'/healthz')).status,200);assert.deepEqual(state(g),before);await g.r.close();
 const h=await rig(t,{config:f.config,clock:f.clock});assert.equal((await h.challenge('renew',a.body.token)).status,403);assert.equal((await h.issue()).status,200);await h.r.close();
});
