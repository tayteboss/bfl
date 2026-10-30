import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {createLifecycle,fingerprint} from '../jobs/lifecycle.mjs';
import {createUploadLedger,installUploadSchema} from '../uploads/ledger.mjs';
import {createPreparedLedger,installPreparedSchema,preparedColumns} from '../checkout/prepared-ledger.mjs';
import {cartHash} from '../checkout/storefront.mjs';
import {preparePersistentStagingSources,createPersistentStagingScope} from '../configuration/engineering.mjs';
import {preparedPolicyReceipt,CLIENT_POLICY_ADMISSION} from '../checkout/prepared-limits.mjs';
import {STORE,APP,CLIENT} from '../configuration/schema.mjs';
import {SHOP,INSTALLATION} from '../backend/config.mjs';
const identity={shop:{id:SHOP,myshopifyDomain:STORE},currentAppInstallation:{id:INSTALLATION,app:{id:APP,apiKey:CLIENT}}};
const read=name=>JSON.parse(readFileSync(new URL('../../../fixtures/film-printing/full-product-lab-routing-20261030/'+name,import.meta.url)));
function setup(t,kind,{legacy=false,foreign=false}={}){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());const lifecycle=createLifecycle(db),clock={time:1793332800000};
 const source=()=>createPersistentStagingScope({...preparePersistentStagingSources({config:read('engineering-config-proposal.json'),catalog:read('engineering-catalog-proposal.json'),issuedAt:clock.time-(foreign?1000:0)}),identity,now:()=>clock.time});
 const sourceScope=source(),receipt=preparedPolicyReceipt(sourceScope),owner='resource_capacity_target';
 db.exec('CREATE TABLE resource_sessions(owner TEXT PRIMARY KEY,expires INTEGER,deadline INTEGER,revoked INTEGER);CREATE TABLE resource_admissions(owner TEXT,kind TEXT,request_hash TEXT,PRIMARY KEY(owner,kind,request_hash));CREATE TABLE jobs(id TEXT PRIMARY KEY,owner TEXT,body TEXT);CREATE TABLE cart_checkout_bindings(cart_hash TEXT,owner_hash TEXT,identity_hash TEXT,marker TEXT,state TEXT);CREATE TABLE cart_job_bindings(job_id TEXT PRIMARY KEY,cart_hash TEXT,owner_hash TEXT)');
 const ownerRow=(id,expires=clock.time+86400000)=>{db.prepare('INSERT OR IGNORE INTO resource_sessions VALUES (?,?,?,NULL)').run(id,expires,expires);db.prepare('INSERT OR IGNORE INTO resource_admissions VALUES (?,?,?)').run(id,CLIENT_POLICY_ADMISSION,receipt);};ownerRow(owner);
 if(legacy)db.prepare('DELETE FROM resource_admissions WHERE owner=?').run(owner);
 const cart={id:'gid://shopify/Cart/capacity?key=synthetic-key',owner,complete:true,binding_id:'synthetic-binding',customer_id:null},marker='a'.repeat(64);
 db.prepare('INSERT INTO cart_checkout_bindings VALUES (?,?,?,?,?)').run(cartHash(cart.id),cartHash(owner),fingerprint({owner,binding:cart.binding_id,customer:null}),marker,'confirmed');
 let service,table,reserve;
 if(kind==='upload'){
  installUploadSchema(db);table='upload_intents';service=createUploadLedger(db,{lifecycle},()=>clock.time);
  reserve=n=>service.create(owner,`new-request-${n}`,'binding',{sourceScope});
 }else{
  installPreparedSchema(db);table='cart_prepared_jobs';service=createPreparedLedger(db,lifecycle,{now:()=>clock.time});
  reserve=n=>{const reference={id:`target-job-${n}`,revision:'b'.repeat(64),signature:'c'.repeat(64),config_version:'config-test'};db.prepare('INSERT OR IGNORE INTO jobs VALUES (?,?,?)').run(reference.id,owner,JSON.stringify(reference));return service.reserve(owner,cart,marker,reference,'d'.repeat(64),n,clock.time+3600000,{sourceScope});};
 }
 function seed(count,{expired=false,terminal=false,revoked=false}={}){
  lifecycle.transaction(()=>{for(let i=0;i<count;i++){
   const id='seed-owner-'+Math.floor(i/500);ownerRow(id,clock.time+(expired?-1:86400000));if(revoked)db.prepare('UPDATE resource_sessions SET revoked=? WHERE owner=?').run(clock.time,id);
   if(kind==='upload')db.prepare('INSERT INTO upload_intents(id,owner,request_key,binding,state,version,expires) VALUES (?,?,?,?,?,1,?)').run('history-'+i,id,'history-'+i,'binding',terminal?'removed':'issued',clock.time+3600000);
   else db.prepare('INSERT INTO cart_prepared_jobs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run('history-'+i,'history-job-'+i,cartHash(id),'e'.repeat(64),'f'.repeat(64),'a'.repeat(64),'b'.repeat(64),i+1,0,clock.time+3600000,terminal?'cancelled':'uncertain',null,null);
  }});
 }
 return {db,clock,sourceScope,reserve,seed,table,rows:()=>db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()};
}
for(const kind of ['upload','prepared']){
 for(const status of ['expired','terminal','revoked'])test(`persistent ${kind} capacity preserves 10000 ${status} historical records and admits new work`,t=>{
  const f=setup(t,kind);f.seed(10000,{[status]:true});const before=f.rows();f.reserve(1);assert.equal(f.rows().length,10001);assert.deepEqual(f.rows().slice(0,10000),before);
 });
 test(`persistent ${kind} capacity still rejects the 10000 live-work boundary and accepts one freed slot`,t=>{
  const f=setup(t,kind);f.seed(10000);assert.throws(()=>f.reserve(1),kind==='upload'?/UPLOAD_INTENT_LIMIT/:/PREPARED_CAPACITY/);
  if(kind==='upload')f.db.prepare("UPDATE upload_intents SET state='removed' WHERE id='history-0'").run();
  else f.db.prepare("UPDATE cart_prepared_jobs SET state='cancelled' WHERE operation_id='history-0'").run();
  f.reserve(1);assert.throws(()=>f.reserve(2),kind==='upload'?/UPLOAD_INTENT_LIMIT/:/PREPARED_CAPACITY/);assert.equal(f.rows().length,10001);
 });
 test(`historical ${kind} callers retain the total-history limit without a matching policy receipt`,t=>{
  const f=setup(t,kind,{legacy:true});f.seed(10000,{expired:true});assert.throws(()=>f.reserve(1),kind==='upload'?/UPLOAD_INTENT_LIMIT/:/PREPARED_CAPACITY/);assert.equal(f.rows().length,10000);
 });
 test(`persistent ${kind} capacity requires the exact source receipt`,t=>{
  const f=setup(t,kind);f.seed(10000,{expired:true});f.db.prepare("UPDATE resource_admissions SET request_hash=? WHERE owner='resource_capacity_target'").run('0'.repeat(64));assert.throws(()=>f.reserve(1),kind==='upload'?/UPLOAD_INTENT_LIMIT/:/PREPARED_CAPACITY/);
 });
}
