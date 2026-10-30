import test from 'node:test';
import assert from 'node:assert/strict';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {configuration} from '../../../fixtures/film-printing/f06p-composition/rig.mjs';
import {migrateCheckoutComposition,migratePreparedCart,openDatabase} from '../backend/storage.mjs';
import {installPreparedSchema,createPreparedLedger} from '../checkout/prepared-ledger.mjs';
import {createLifecycle,fingerprint} from '../jobs/lifecycle.mjs';
import {cartHash} from '../checkout/storefront.mjs';

function snapshot(path){const db=new DatabaseSync(path,{readOnly:true});try{return Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({name})=>[name,db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]));}finally{db.close();}}
test('prepared migration adds one table and original schema10 closed runtime retains all rows',t=>{
  const config=configuration(t);migrateCheckoutComposition(config);const path=join(config.dataDir,'jobs.sqlite'),before=snapshot(path);
  assert.deepEqual(migratePreparedCart(config),{schema:10,feature:'prepared-cart-v3',checkout_ready:false});
  const after=snapshot(path);assert.equal(Object.keys(after).length,Object.keys(before).length+1);
  for(const [name,rows] of Object.entries(before))assert.deepEqual(after[name],rows,name);
  assert.throws(()=>migratePreparedCart(config),/SCHEMA_MISMATCH/);
  const original=resolve('.staging/prepared-cart-20261029/before/apps/film-printing-staging/backend/storage.mjs');
  const script=`import {openDatabase} from ${JSON.stringify(original)};const db=openDatabase(JSON.parse(process.argv[1]),{resourceSessions:true,sessionOnly:true,currentClosed:true});db.close();`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',script,JSON.stringify(config)],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
  assert.deepEqual(snapshot(path),after);
  const current=openDatabase(config,{resourceSessions:true,checkoutOwner:true,preparedCart:true});current.close();
  const db=new DatabaseSync(path);db.exec('DROP TABLE cart_prepared_jobs');db.close();
  assert.throws(()=>openDatabase(config,{resourceSessions:true,checkoutOwner:true,preparedCart:true}),/MIGRATION_REQUIRED/);
  assert.equal(Object.hasOwn(snapshot(path),'cart_prepared_jobs'),false);
});

function ledger(t){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());const lifecycle=createLifecycle(db),clock={time:1000};
  db.exec('CREATE TABLE jobs(id TEXT PRIMARY KEY,owner TEXT,body TEXT);CREATE TABLE resource_sessions(owner TEXT PRIMARY KEY,expires INTEGER,deadline INTEGER,revoked INTEGER);CREATE TABLE cart_checkout_bindings(cart_hash TEXT,owner_hash TEXT,identity_hash TEXT,marker TEXT,state TEXT);CREATE TABLE cart_job_bindings(job_id TEXT PRIMARY KEY,cart_hash TEXT,owner_hash TEXT)');
  installPreparedSchema(db);
  const owner='prepared-test-owner',cart={id:'gid://shopify/Cart/prepared?key=synthetic-key',owner,complete:true,binding_id:'synthetic-binding',customer_id:null},marker='a'.repeat(64);
  db.prepare('INSERT INTO resource_sessions VALUES (?,?,?,NULL)').run(owner,301000,601000);
  db.prepare('INSERT INTO cart_checkout_bindings VALUES (?,?,?,?,?)').run(cartHash(cart.id),cartHash(owner),fingerprint({owner,binding:cart.binding_id,customer:null}),marker,'confirmed');
  const service=createPreparedLedger(db,lifecycle,{now:()=>clock.time});
  const reserve=(n,generation=n)=>{
    const reference={id:`prepared-job-${n}`,revision:String(n).repeat(64),signature:'c'.repeat(64),config_version:'prepared-config'};
    db.prepare('INSERT OR IGNORE INTO jobs VALUES (?,?,?)').run(reference.id,owner,JSON.stringify(reference));
    return service.reserve(owner,cart,marker,reference,'b'.repeat(64),generation,200000);
  };
  return {db,lifecycle,service,reserve,clock};
}
test('durable preparation reserves cart affinity and cannot issue a repeated add permit',t=>{
  const f=ledger(t),first=f.reserve(1);assert.equal(first.replay,false);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM cart_job_bindings').get().n,1);
  assert.equal(f.reserve(1).replay,true);f.service.issue(first.ticket,'d'.repeat(64));
  assert.throws(()=>f.service.issue(first.ticket,'d'.repeat(64)),/SPENT/);
  f.service.uncertain(first.ticket);assert.throws(()=>f.service.issue(first.ticket,'d'.repeat(64)),/SPENT/);
  f.service.confirm(first.ticket,'e'.repeat(64));assert.equal(f.service.status(first.ticket).state,'confirmed');
});
test('cancelled preparations retain history within eight attempts without reviving stale generations',t=>{
  const f=ledger(t);
  for(let n=1;n<=8;n++){
    const prepared=f.reserve(n);f.service.cancel(prepared.ticket);
    assert.equal(f.lifecycle.state().pending,1);const op=f.lifecycle.startRecovery();f.lifecycle.finish(op);
  }
  assert.throws(()=>f.reserve(9),/PREPARATION_LIMIT/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM cart_prepared_jobs').get().n,8);
  assert.throws(()=>f.reserve(1,2),/REQUEST_CONFLICT/);
});
test('two live or confirmed preparations cannot be replaced by a third job',t=>{
  const f=ledger(t),first=f.reserve(1),second=f.reserve(2);
  f.service.issue(first.ticket,'d'.repeat(64));f.service.confirm(first.ticket,'e'.repeat(64));
  assert.throws(()=>f.service.cancel(first.ticket),/CHANGED/);
  assert.throws(()=>f.reserve(3),/CUSTOMER_JOB_SPENT/);
  f.service.cancel(second.ticket);const op=f.lifecycle.startRecovery();f.lifecycle.finish(op);
  const replacement=f.reserve(3);assert.equal(replacement.replay,false);
  assert.throws(()=>f.reserve(4),/CUSTOMER_JOB_SPENT/);
});
test('unknown authority, changed ticket and original expiry cannot issue a native add',t=>{
  const f=ledger(t),r=f.reserve(1);f.lifecycle.startRecovery();assert.throws(()=>f.service.issue(r.ticket,'d'.repeat(64)),/AUTHORITY_PENDING/);
  assert.throws(()=>f.service.status({...r.ticket,cart_hash:'f'.repeat(64)}),/CHANGED/);
});
