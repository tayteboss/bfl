import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {configuration,proofClient,rig,id} from '../../../fixtures/film-printing/f06p-composition/rig.mjs';
import {openDatabase,migrateCheckoutComposition,releaseAbandonedLock} from '../backend/storage.mjs';
import {createResourceSessions} from '../backend/resource-session.mjs';
import {createResourceProof} from '../backend/resource-proof.mjs';
import {createLifecycle} from '../jobs/lifecycle.mjs';
import {sealCartCapability} from '../checkout/cart-capability.mjs';
import {createSessionOnlyRuntime} from '../backend/session-only.mjs';

function snapshot(config){const db=new DatabaseSync(join(config.dataDir,'jobs.sqlite'),{readOnly:true});try{
 const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r=>r.name);
 return {schema:db.prepare("SELECT type,name,sql FROM sqlite_master WHERE type IN ('table','trigger','index') ORDER BY name").all(),rows:Object.fromEntries(tables.map(name=>[name,db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]))};
 }finally{db.close();}}

test('9 to 10 is additive across all 23 prior tables, pending/unknown history and spent F06N admissions',async t=>{
 const config=configuration(t),clock={time:Date.parse('2026-10-21T12:00:00Z')},tokens=[];
 // Generate each old purpose with the concrete signed exchange, never SQL relabel.
 let db=new DatabaseSync(join(config.dataDir,'jobs.sqlite'));
 for(const options of [{sessionOnly:true},{uploadOnly:true},{}]){
  const s=createResourceSessions(db,createLifecycle(db),()=>clock.time,options),p=createResourceProof({secret:config.appSecret,sessions:s,now:()=>clock.time,cartCapability:true});
  tokens.push(proofClient(s,p,config,clock).issue());p.close();
 }
 db.close();
 const h=openDatabase(config,{resourceSessions:true,cartOwner:true,now:()=>clock.time}),s=h.store;
 const p=createResourceProof({secret:config.appSecret,sessions:s.resourceSessions,now:()=>clock.time,cartCapability:true}),c=proofClient(s.resourceSessions,p,config,clock);
 const a=c.issue(),b=c.issue();tokens.push(a,b);assert.throws(()=>c.issue(),/CAPACITY/);
 const ticket=s.resourceSessions.authenticate(c.request(a)),e=p.observeFreshContext({request:c.request(a),proof:c.proof('cart-capability',a),action:'cart-capability',ticket});
 const attempt=s.lifecycle.transaction(()=>{
  const attempt=s.cartCapability.reserve({ticket,cart_id:id,proofId:e.id,created:clock.time,sealed:sealCartCapability(id,config.sessionSecret)});
  s.ownedCart.reserve(ticket,attempt);return attempt;
 });
 s.cartCapability.sending(attempt,'synthetic-crash-snapshot');s.cartCapability.finish(attempt,'unknown');
 assert.throws(()=>s.recordUpload(ticket.owner,{id:'old-blocked-asset',state:'complete',verified:true,url:'https://example.invalid/a'}),/CART_OWNER_RESOURCE_CLOSED/);
 s.lifecycle.event('retained-event',{generated:true},()=>s.lifecycle.retire('job','generated-old-owner','old-job'));
 s.lifecycle.startRecovery();
 assert.throws(()=>migrateCheckoutComposition(config),/DATABASE_LOCKED/);p.close();h.close();
 const before=snapshot(config);assert.equal(Object.keys(before.rows).length,23);
 assert.deepEqual(migrateCheckoutComposition(config),{schema:10,checkout_ready:false});const after=snapshot(config);
 assert.equal(Object.keys(after.rows).length,26);
 for(const [name,rows] of Object.entries(before.rows))if(name!=='runtime_identity')assert.deepEqual(after.rows[name],rows,name);
 const identity=JSON.parse(after.rows.runtime_identity[0].value);assert.deepEqual({...identity,schema:9},JSON.parse(before.rows.runtime_identity[0].value));
 for(const item of before.schema)assert.deepEqual(after.schema.find(x=>x.name===item.name),item,item.name);
 assert.throws(()=>migrateCheckoutComposition(config),/MIGRATION_REQUIRED/);
 assert.throws(()=>openDatabase(config,{resourceSessions:true,cartOwner:true}),/MIGRATION_REQUIRED/);
 const closed=openDatabase(config,{resourceSessions:true,sessionOnly:true,currentClosed:true,now:()=>clock.time});closed.close();
 assert.deepEqual(snapshot(config),after);
 const f=rig(t,{config,clock});
 for(const token of tokens)assert.throws(()=>f.store.resourceSessions.authenticate(f.request(token)),/REJECTED|NEW_OWNER_REQUIRED/);
 // No migration clears pending work or creates eligible members.
 assert.equal(f.rows('checkout_owner_admissions').length,0);assert.throws(()=>f.issue(),/FENCED/);
 f.close();db=new DatabaseSync(join(config.dataDir,'jobs.sqlite'));
 assert.throws(()=>db.prepare('DELETE FROM cart_owner_admissions').run(),/RETAINED/);
 assert.throws(()=>db.prepare("UPDATE cart_owner_admissions SET owner='promoted'").run(),/IMMUTABLE/);
 assert.throws(()=>db.prepare('INSERT INTO jobs VALUES (?,?,?,?,?)').run('blocked',ticket.owner,'key','hash','{}'),/CART_OWNER_RESOURCE_CLOSED/);db.close();
});

test('crash leaves sending marker and exclusive lock; compatible closed rollback preserves both journals',async t=>{
 const config=configuration(t);migrateCheckoutComposition(config);
 const script=`import {rig} from './fixtures/film-printing/f06p-composition/rig.mjs';
 const f=rig({after(){}},{config:JSON.parse(process.argv[1])});const token=f.issue();await f.bind(token);
 f.state.hook=async kind=>{if(kind==='markerWrites')process.exit(42);};await f.install(token);`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',script,JSON.stringify(config)],{encoding:'utf8'});
 assert.equal(child.status,42,child.stderr);const prior=snapshot(config);
 assert.equal(prior.rows.cart_checkout_bindings[0].state,'sending');
 assert.throws(()=>openDatabase(config,{sessionOnly:true,currentClosed:true}),/LOCKED/);
 const lock=JSON.parse(readFileSync(join(config.dataDir,'runtime.lock/owner.json')));
 assert.throws(()=>releaseAbandonedLock(config,lock.token,false),/STOP_ALL_WRITERS_FIRST/);
 assert.throws(()=>releaseAbandonedLock(config,'wrong',true),/LOCK_CHANGED/);
 releaseAbandonedLock(config,lock.token,true);
 const closed=openDatabase(config,{resourceSessions:true,sessionOnly:true,currentClosed:true});closed.close();
 assert.deepEqual(snapshot(config),prior);
});

test('schema10 compatible closed executable responds to health only; no resource/binding/refresh route',async t=>{
 const config=configuration(t);migrateCheckoutComposition(config);
 const runtime=createSessionOnlyRuntime({...config,host:'127.0.0.1',origin:'http://127.0.0.1:6076',mode:'disabled',resourceSessions:'session-only-closed',storefrontSessions:'context-only'});
 try{
  // Exercise the actual HTTP handler without opening a network socket.
  for(const url of ['/healthz','/readyz','/resource-sessions/issue','/resource-proof/challenge','/checkout/bind','/cart/refresh']){
   const result=await new Promise(resolve=>runtime.server.emit('request',{method:url.endsWith('z')?'GET':'POST',url,headers:{}},{headersSent:false,writeHead(status){this.status=status;},end(body){resolve({status:this.status,body:JSON.parse(body)});}}));
   assert.equal(result.status,url==='/healthz'?200:url==='/readyz'?503:404);assert.notEqual(result.body.checkout_ready,true);
  }
 }finally{await runtime.close();}
});
