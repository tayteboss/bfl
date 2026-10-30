// Real local HTTP/SQLite, synthetic Shopify and generated owner/capability history.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {rig} from '../../../fixtures/film-printing/f06n/rig.mjs';
import {mockAdmin} from '../../../fixtures/film-printing/f06d/mock-admin.mjs';
import {openDatabase} from '../backend/storage.mjs';
import {reconcileOnce} from '../backend/reconcile-once.mjs';
import {STORE,APP,CLIENT} from '../configuration/schema.mjs';
import {INSTALLATION,SHOP} from '../backend/config.mjs';
const snapshot=c=>{const db=new DatabaseSync(join(c.dataDir,'jobs.sqlite'),{readOnly:true});try{return Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({name})=>[name,db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));}finally{db.close();}};
async function setup(t) {
 const f=await rig(t,{beforeMigration(c){const s=openDatabase(c,{currentClosed:true,resourceSessions:true,sessionOnly:true});for(let i=0;i<5;i++)s.store.lifecycle.finish(s.store.lifecycle.startRecovery());s.close();}});
 const a=await f.issue(),b=await f.issue();assert.equal(a.status,200);assert.equal(b.status,200);
 const token=a.body.token;
 assert.equal((await f.inspect(token)).status,200);
 const renewal=await f.renew(token);assert.equal(renewal.status,200);
 assert.equal((await f.call('/resource-sessions/revoke',{},renewal.body.token)).status,200);
 assert.equal((await f.call('/resource-sessions/revoke',{},b.body.token??b.body.credential)).status,200);
 await f.close();
 const c={...f.config,mode:'reconcile-only',adminToken:'synthetic-admin-'.repeat(3),resourceSessions:'disabled',storefrontSessions:'disabled',cartToken:null};
 const m=mockAdmin();m.data.currentAppInstallation.app.apiKey=CLIENT;
 const state={requests:0,mutations:0,lost:false,wrongIdentity:false,queries:[]};
 const server=createServer(async(req,res)=>{try{let body='';for await(const x of req)body+=x;const {query,variables}=JSON.parse(body);state.requests++;state.queries.push(query.match(/^(?:query|mutation)\s+(\w+)/)?.[1]);
  let data;if(query.includes('F06EIdentity'))data={shop:{id:SHOP,myshopifyDomain:STORE},currentAppInstallation:{id:INSTALLATION,app:{id:state.wrongIdentity?'gid://shopify/App/1':APP,apiKey:CLIENT}}};
  else {if(query.startsWith('mutation'))state.mutations++;data=await m.api(query,variables);if(state.lost&&query.startsWith('mutation')){res.destroy();return;}}
  // Identity is now checked in the context response itself, before any CAS.
  if(state.wrongIdentity&&data.currentAppInstallation?.app)data.currentAppInstallation.app.id='gid://shopify/App/1';
  res.writeHead(200,{'content-type':'application/json','x-shopify-api-version':'2026-10'});res.end(JSON.stringify({data}));
 }catch{res.destroy();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
 const run=(epoch=7)=>reconcileOnce(c,{expectedEpoch:epoch,expectedPending:2,allWritersStopped:true,fetchImpl:(url,opts)=>{assert.equal(url,`https://${STORE}/admin/api/2026-10/graphql.json`);return fetch(`http://127.0.0.1:${server.address().port}`,opts);}});
 const before=snapshot(c);assert.equal(Object.keys(before).length,23);assert.equal(before.authority_state[0].epoch,7);assert.equal(before.authority_events.length,2);
 return {f,c,m,state,run,before};
}
const unchanged=(f)=>assert.deepEqual(snapshot(f.c),f.before);
const pending=(f,epoch=8)=>{const s=snapshot(f.c);assert.equal(s.authority_state[0].epoch,epoch);assert.ok(s.authority_state[0].operation);assert.ok(s.authority_events.every(x=>x.acknowledged===0));return s;};

test('F06O schema9 two real synthetic resource retirements reconcile once; history and sources retained across reopen',async t=>{
 const f=await setup(t),active=f.m.data.currentAppInstallation.active.value,catalog=f.m.data.currentAppInstallation.catalog.value;
 assert.deepEqual(await f.run(),{revoked:true,checkout_ready:false,cart_verified:false,epoch:8,pending:0,requests:5,mutations:1});
 assert.deepEqual(f.state.queries,['F06DAuthorityContext','F06DAuthorityContext','F06DAuthorityContext','F06DCommitAuthority','F06DAuthorityContext']);
 const s=snapshot(f.c);for(const [name,rows] of Object.entries(f.before))if(!['authority_state','authority_events'].includes(name))assert.deepEqual(s[name],rows,name);
 assert.ok(s.authority_events.every(x=>x.acknowledged===1));assert.equal(f.m.data.currentAppInstallation.active.value,active);assert.equal(f.m.data.currentAppInstallation.catalog.value,catalog);
 const storage=openDatabase(f.c,{currentClosed:true,resourceSessions:true,sessionOnly:true});storage.close();assert.deepEqual(snapshot(f.c),s);
 await assert.rejects(f.run(8),/HISTORY_CHANGED/);assert.equal(f.state.mutations,1);
});
for(const kind of ['authority','fence','active','identity'])test('F06O missing/invalid '+kind+' leaves exact pending history and performs zero writes',async t=>{
 const f=await setup(t);if(kind==='authority')f.m.data.shop.authority=null;else if(kind==='identity')f.state.wrongIdentity=true;else if(kind==='active')f.m.data.currentAppInstallation.active.value='{}';else f.m.data.currentAppInstallation.fence=null;
 await assert.rejects(f.run());unchanged(f);assert.equal(f.state.mutations,0);
});
test('F06O absent catalog is supported without creation or source publication',async t=>{const f=await setup(t);f.m.data.currentAppInstallation.catalog=null;await f.run();assert.equal(f.m.writes[0].length,3);assert.equal(f.m.data.currentAppInstallation.catalog,null);});
test('F06O lost response retains uncertain operation; explicit new recovery reads remote state and fences it',async t=>{
 const f=await setup(t);f.state.lost=true;await assert.rejects(f.run());const s=pending(f);assert.equal(f.state.mutations,1);
 const opened=openDatabase(f.c,{currentClosed:true,resourceSessions:true,sessionOnly:true});opened.close();assert.deepEqual(snapshot(f.c),s);
 f.state.lost=false;assert.equal((await f.run(8)).epoch,9);assert.equal(f.state.mutations,2);
});
test('F06O stale fence CAS stays pending; no blind retry',async t=>{const f=await setup(t);f.m.beforeWrite=()=>f.m.replace('fence','00000000-0000-0000-0000-000000000001');await assert.rejects(f.run());pending(f);assert.equal(f.state.mutations,1);});
test('F06O mismatched readback cannot acknowledge',async t=>{const f=await setup(t);f.m.afterWrite=()=>{f.m.data.currentAppInstallation.fence.value='00000000-0000-0000-0000-000000000001';};await assert.rejects(f.run());pending(f);});
test('F06O event race during remote commit leaves all retirements unacknowledged',async t=>{const f=await setup(t);f.m.beforeWrite=()=>{const db=new DatabaseSync(join(f.c.dataDir,'jobs.sqlite'));try{db.exec('UPDATE authority_state SET epoch=epoch+1');}finally{db.close();}};await assert.rejects(f.run());pending(f,9);});
test('F06O exclusive runtime lock prevents operator and network',async t=>{const f=await setup(t),s=openDatabase(f.c,{currentClosed:true,resourceSessions:true,sessionOnly:true});try{await assert.rejects(f.run(),/DATABASE_LOCKED/);assert.equal(f.state.requests,0);}finally{s.close();}unchanged(f);});
test('F06O reviewed expected epoch and stopped-writer gate reject before network',async t=>{const f=await setup(t);await assert.rejects(f.run(8),/HISTORY_CHANGED/);await assert.rejects(reconcileOnce(f.c,{expectedEpoch:7,expectedPending:2}),/STOP_ALL_WRITERS_FIRST/);unchanged(f);assert.equal(f.state.requests,0);});

test('F06O proposed empty bootstrap metadata can represent absent prices without publishing a catalog',async t=>{
 const f=await setup(t);f.m.data.currentAppInstallation.catalog=null;
 const value=JSON.parse(f.m.data.shop.authority.value);value.price_version='unavailable:price_catalog_absent';
 f.m.data.shop.authority.value=JSON.stringify(value);
 // Synthetic preprovisioned protected field; actual remote provisioning is NOT performed.
 const prior=f.m.data.shop.authority.value;await f.run();
 assert.equal(f.m.data.shop.authority.value,prior);assert.equal(f.m.data.currentAppInstallation.catalog,null);
 assert.deepEqual(f.m.writes[0].map(x=>x.key),['authority','active_config','authority_fence']);
 assert.ok(f.m.writes[0].every(x=>typeof x.compareDigest==='string'&&x.compareDigest.length));
});
