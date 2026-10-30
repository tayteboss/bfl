import {lstatSync,mkdirSync,writeFileSync,readFileSync,unlinkSync,rmdirSync,openSync,closeSync,statfsSync} from 'node:fs';
import {join} from 'node:path';
import {hostname} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createJobStore} from '../jobs/service.mjs';
import {installUploadSchema,uploadTables} from '../uploads/ledger.mjs';
import {installRefreshSchema,refreshTables} from '../checkout/refresh-ledger.mjs';
import {installOrderSchema,orderTables} from '../orders/ledger.mjs';
import {installOrderInbox,inboxTables} from '../orders/inbox.mjs';
import {RuntimeError,need} from './config.mjs';
import {installCartBindingSchema} from '../checkout/cart-binding.mjs';
import {installOwnedCartSchema} from '../checkout/owned-cart.mjs';
import {installCartCapabilitySchema} from '../checkout/cart-capability.mjs';
import {installCustodySchema} from '../uploads/custody.mjs';
import {installResourceSchema,resourceTables} from './resource-session.mjs';
import {installPreparedSchema,validatePreparedSchema} from '../checkout/prepared-ledger.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const tables=['uploads','jobs','authority_state','authority_preparations','authority_events','authority_tombstones','runtime_identity'];
function directory(config) {
  const s=lstatSync(config.dataDir);
  need(s.isDirectory()&&!s.isSymbolicLink()&&(s.mode&0o077)===0,'PRIVATE_STORAGE_REQUIRED');
  // Reject known Linux network filesystems. Deployment must also attest local
  // storage; platform-specific mount safety cannot be inferred from this alone.
  need(![0x6969,0xff534d42,0x517b].includes(statfsSync(config.dataDir).type>>>0),'LOCAL_STORAGE_REQUIRED');
}
export function acquireLock(config) {
  directory(config);
  const dir=join(config.dataDir,'runtime.lock'), token=randomUUID();
  try {mkdirSync(dir,{mode:0o700});}catch{throw new RuntimeError('DATABASE_LOCKED');}
  writeFileSync(join(dir,'owner.json'),JSON.stringify({token,pid:process.pid,host:hostname()}),{mode:0o600,flag:'wx'});
  const assert=()=>{
    const owner=JSON.parse(readFileSync(join(dir,'owner.json')));
    need(owner.token===token&&owner.pid===process.pid&&owner.host===hostname(),'LOCK_CHANGED');
  };
  const unlock=()=>{
    assert();
    need(JSON.parse(readFileSync(join(dir,'owner.json'))).token===token,'LOCK_CHANGED');
    unlinkSync(join(dir,'owner.json'));rmdirSync(dir);
  };
  unlock.assert=assert;return unlock;
}
// Offline operator command, never an HTTP endpoint or timed lock takeover.
export function releaseAbandonedLock(config,token,allWritersStopped) {
  directory(config);need(allWritersStopped===true,'STOP_ALL_WRITERS_FIRST');
  const dir=join(config.dataDir,'runtime.lock'),owner=JSON.parse(readFileSync(join(dir,'owner.json')));
  need(token===owner.token,'LOCK_CHANGED');
  if(owner.host===hostname()) {
    try {process.kill(owner.pid,0);throw new RuntimeError('WRITER_STILL_ALIVE');}
    catch(error){need(error.code==='ESRCH','WRITER_STILL_ALIVE');}
  }
  unlinkSync(join(dir,'owner.json'));rmdirSync(dir);
}
export function initializeDatabase(config) {
  directory(config);const unlock=acquireLock(config),path=join(config.dataDir,'jobs.sqlite');
  try {
    // Exclusive creation: failed/partial initialization is retained for inspection.
    const fd=openSync(path,'wx',0o600);closeSync(fd);
    const store=createJobStore(path);store.close();
    const db=new DatabaseSync(path),id=randomUUID();
    try {
      db.exec('CREATE TABLE runtime_identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), value TEXT NOT NULL)');
      db.prepare('INSERT INTO runtime_identity VALUES (1,?)').run(JSON.stringify({schema:5,id,store:config.store,app:config.app,
        installation:config.installation,jobKey:hash(config.jobSecret),sessionKey:hash(config.sessionSecret)}));
    } finally {db.close();}
    return id;
  } finally {unlock();}
}
export function openDatabase(config,{now=Date.now,resourceSessions=false,sessionOnly=false,uploadOnly=false,cartCapability=false,cartOwner=false,currentClosed=false,checkoutOwner=false,preparedCart=false,persistentSourceScope=null,configureStore}={}) {
  const unlock=acquireLock(config),path=join(config.dataDir,'jobs.sqlite');
  let store;
  try {
    const s=lstatSync(path);need(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&(s.mode&0o077)===0,'PRIVATE_DATABASE_REQUIRED');
    const db=new DatabaseSync(path,{readOnly:true});
    try {
      need(db.prepare('PRAGMA quick_check').get().quick_check==='ok','DATABASE_CORRUPT');
      const names=db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name);
      need(tables.every(t=>names.includes(t)),'DATABASE_SCHEMA_MISMATCH');
      const row=JSON.parse(db.prepare('SELECT value FROM runtime_identity WHERE singleton=1').get()?.value??'null');
      validateIdentity(row,config);
      need(currentClosed?[6,7,8,9,10].includes(row.schema)&&sessionOnly:checkoutOwner?row.schema===10&&resourceSessions&&!sessionOnly&&!uploadOnly&&!cartOwner:cartOwner?row.schema===9&&resourceSessions&&!sessionOnly&&!uploadOnly:cartCapability?row.schema===8&&resourceSessions&&!sessionOnly&&!uploadOnly:uploadOnly?row.schema===7:resourceSessions?[6,7].includes(row.schema):row.schema===5,'DATABASE_MIGRATION_REQUIRED');
      if(row.schema>=7)need(names.includes('upload_custody')&&db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name IN ('upload_purpose_immutable','upload_job_insert','upload_job_update')").get().n===3,'DATABASE_SCHEMA_MISMATCH');
      if(row.schema>=8)need(names.includes('cart_capability_attempts'),'DATABASE_SCHEMA_MISMATCH');
      if(row.schema>=9)need(names.includes('cart_owner_admissions')&&db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name LIKE 'cart_owner_%'").get().n===8,'DATABASE_SCHEMA_MISMATCH');
      if(row.schema===10)need(['checkout_owner_admissions','checkout_capability_attempts','cart_checkout_bindings'].every(t=>names.includes(t))&&db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name LIKE 'checkout_owner_%'").get().n===2,'DATABASE_SCHEMA_MISMATCH');
      if(preparedCart){need(row.schema===10&&checkoutOwner&&names.includes('cart_prepared_jobs'),'DATABASE_MIGRATION_REQUIRED');validatePreparedSchema(db);}
      if(resourceSessions)need(resourceTables.every(t=>names.includes(t)),'DATABASE_SCHEMA_MISMATCH');
      need(uploadTables.every(t=>names.includes(t)),'DATABASE_SCHEMA_MISMATCH');
      need(refreshTables.every(t=>names.includes(t))&&orderTables.every(t=>names.includes(t))&&inboxTables.every(t=>names.includes(t)),'DATABASE_SCHEMA_MISMATCH');
      // Never let createLifecycle's INSERT OR IGNORE replace a lost durable fence.
      need(db.prepare('SELECT count(*) AS n FROM authority_state WHERE singleton=1').get().n===1,'DATABASE_STATE_MISSING');
    } finally {db.close();}
    store=createJobStore(path,{now,sessionOnly,uploadOnly,cartOwner,checkoutOwner,persistentSourceScope,configureStore});
    store.uploadLedger.sweep({restart:true});
    store.uploadCustody?.recover();
    store.orderInbox.recover();
    let closed=false;
    return {store,assertExclusiveWriter(){need(!closed,'DATABASE_CLOSED');unlock.assert();},close(){if(!closed){store.close();unlock();closed=true;}}};
  } catch(error) {store?.close();unlock();throw error instanceof RuntimeError?error:new RuntimeError('DATABASE_UNAVAILABLE');}
}

function validateIdentity(row,config) {
  need([1,2,3,4,5,6,7,8,9,10].includes(row?.schema)&&row.id===config.databaseId&&row.store===config.store&&row.app===config.app&&
    row.installation===config.installation&&row.jobKey===hash(config.jobSecret)&&row.sessionKey===hash(config.sessionSecret),'DATABASE_IDENTITY_MISMATCH');
}
// Explicit offline feature migration; schema 10 remains readable by the closed
// rollback runtime. Opening prepared mode never creates or repairs this table.
export function migratePreparedCart(config) {
  const unlock=acquireLock(config);let db;
  try {
    const path=join(config.dataDir,'jobs.sqlite'),s=lstatSync(path);
    need(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&(s.mode&0o077)===0,'PRIVATE_DATABASE_REQUIRED');
    db=new DatabaseSync(path);need(db.prepare('PRAGMA quick_check').get().quick_check==='ok','DATABASE_CORRUPT');
    const row=JSON.parse(db.prepare('SELECT value FROM runtime_identity WHERE singleton=1').get().value);validateIdentity(row,config);
    need(row.schema===10,'DATABASE_MIGRATION_REQUIRED');
    const names=db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name);
    need([...tables,...uploadTables,...refreshTables,...orderTables,...inboxTables,...resourceTables,'upload_custody','checkout_owner_admissions','checkout_capability_attempts','cart_checkout_bindings'].every(t=>names.includes(t))&&!names.includes('cart_prepared_jobs'),'DATABASE_SCHEMA_MISMATCH');
    const state=db.prepare('SELECT * FROM authority_state WHERE singleton=1').get();
    need(state&&!state.operation&&db.prepare('SELECT COUNT(*) AS n FROM authority_events WHERE acknowledged=0').get().n===0,'AUTHORITY_PENDING');
    db.exec('BEGIN IMMEDIATE');
    try {installPreparedSchema(db);validatePreparedSchema(db);db.exec('COMMIT');}
    catch(error){db.exec('ROLLBACK');throw error;}
    return {schema:10,feature:'prepared-cart-v3',checkout_ready:false};
  } finally {db?.close();unlock();}
}
// Explicit offline additive migration. Never auto-recreate a missing v2 table.
export function migrateUploads(config) {
  const unlock=acquireLock(config),path=join(config.dataDir,'jobs.sqlite');
  let db;
  try {
    const s=lstatSync(path);need(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&(s.mode&0o077)===0,'PRIVATE_DATABASE_REQUIRED');
    db=new DatabaseSync(path);
    need(db.prepare('PRAGMA quick_check').get().quick_check==='ok','DATABASE_CORRUPT');
    const names=db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name);
    need(tables.every(t=>names.includes(t)),'DATABASE_SCHEMA_MISMATCH');
    const row=JSON.parse(db.prepare('SELECT value FROM runtime_identity WHERE singleton=1').get()?.value??'null');
    validateIdentity(row,config);
    need(db.prepare('SELECT count(*) AS n FROM authority_state WHERE singleton=1').get().n===1,'DATABASE_STATE_MISSING');
    if(row.schema>=2){need(uploadTables.every(t=>names.includes(t))&&(row.schema<3||refreshTables.every(t=>names.includes(t)))&&(row.schema<4||orderTables.every(t=>names.includes(t)))&&(row.schema<5||inboxTables.every(t=>names.includes(t))),'DATABASE_SCHEMA_MISMATCH');return {schema:row.schema,already_migrated:true};}
    need(uploadTables.every(t=>!names.includes(t)),'DATABASE_SCHEMA_MISMATCH');
    db.exec('BEGIN IMMEDIATE');
    try {
      installUploadSchema(db);
      db.prepare('UPDATE runtime_identity SET value=? WHERE singleton=1').run(JSON.stringify({...row,schema:2}));
      db.exec('COMMIT');
    } catch(error){db.exec('ROLLBACK');throw error;}
    return {schema:2,checkout_ready:false};
  } catch(error){throw error instanceof RuntimeError?error:new RuntimeError('DATABASE_UNAVAILABLE');}
  finally {db?.close();unlock();}
}

// Offline schema2 -> schema3, same exclusive lock and identity. No reconstruction
// of lost schema3 state and no migration from an incomplete schema1 database.
export function migrateCartRefresh(config) {
  const unlock=acquireLock(config),path=join(config.dataDir,'jobs.sqlite');let db;
  try {
    const s=lstatSync(path);need(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&(s.mode&0o077)===0,'PRIVATE_DATABASE_REQUIRED');
    db=new DatabaseSync(path);
    need(db.prepare('PRAGMA quick_check').get().quick_check==='ok','DATABASE_CORRUPT');
    const names=db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name);
    need([...tables,...uploadTables].every(t=>names.includes(t)),'DATABASE_SCHEMA_MISMATCH');
    const row=JSON.parse(db.prepare('SELECT value FROM runtime_identity WHERE singleton=1').get()?.value??'null');
    validateIdentity(row,config);need(row.schema>=2,'DATABASE_MIGRATION_REQUIRED');
    need(db.prepare('SELECT count(*) AS n FROM authority_state WHERE singleton=1').get().n===1,'DATABASE_STATE_MISSING');
    if(row.schema>=3){need(refreshTables.every(t=>names.includes(t))&&(row.schema<4||orderTables.every(t=>names.includes(t)))&&(row.schema<5||inboxTables.every(t=>names.includes(t))),'DATABASE_SCHEMA_MISMATCH');return {schema:row.schema,already_migrated:true};}
    need(refreshTables.every(t=>!names.includes(t)),'DATABASE_SCHEMA_MISMATCH');
    db.exec('BEGIN IMMEDIATE');
    try {
      installRefreshSchema(db);
      db.prepare('UPDATE runtime_identity SET value=? WHERE singleton=1').run(JSON.stringify({...row,schema:3}));
      db.exec('COMMIT');
    } catch(error){db.exec('ROLLBACK');throw error;}
    return {schema:3,checkout_ready:false};
  } catch(error){throw error instanceof RuntimeError?error:new RuntimeError('DATABASE_UNAVAILABLE');}
  finally {db?.close();unlock();}
}

// Explicit additive schema3 -> schema4. No backfill invents historical sources or
// cartToken correspondence. Missing source snapshots stay unavailable for orders.
export function migrateOrders(config) {
  const unlock=acquireLock(config),path=join(config.dataDir,'jobs.sqlite');let db;
  try {
    const s=lstatSync(path);need(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&(s.mode&0o077)===0,'PRIVATE_DATABASE_REQUIRED');
    db=new DatabaseSync(path);
    need(db.prepare('PRAGMA quick_check').get().quick_check==='ok','DATABASE_CORRUPT');
    const names=db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name);
    need([...tables,...uploadTables,...refreshTables].every(t=>names.includes(t)),'DATABASE_SCHEMA_MISMATCH');
    const row=JSON.parse(db.prepare('SELECT value FROM runtime_identity WHERE singleton=1').get()?.value??'null');
    validateIdentity(row,config);need(row.schema>=3,'DATABASE_MIGRATION_REQUIRED');
    need(db.prepare('SELECT count(*) AS n FROM authority_state WHERE singleton=1').get().n===1,'DATABASE_STATE_MISSING');
    if(row.schema>=4){need(orderTables.every(t=>names.includes(t))&&(row.schema<5||inboxTables.every(t=>names.includes(t))),'DATABASE_SCHEMA_MISMATCH');return {schema:row.schema,already_migrated:true};}
    need(orderTables.every(t=>!names.includes(t)),'DATABASE_SCHEMA_MISMATCH');
    db.exec('BEGIN IMMEDIATE');
    try {
      installOrderSchema(db);
      db.prepare('UPDATE runtime_identity SET value=? WHERE singleton=1').run(JSON.stringify({...row,schema:4}));
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
    return {schema:4,checkout_ready:false};
  }catch(error){throw error instanceof RuntimeError?error:new RuntimeError('DATABASE_UNAVAILABLE');}
  finally{db?.close();unlock();}
}

// Explicit schema4 ->5; existing receipts/consumption/source/pending state retained.
export function migrateOrderInbox(config) {
  const unlock=acquireLock(config),path=join(config.dataDir,'jobs.sqlite');let db;
  try {
    const s=lstatSync(path);need(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&(s.mode&0o077)===0,'PRIVATE_DATABASE_REQUIRED');
    db=new DatabaseSync(path);
    need(db.prepare('PRAGMA quick_check').get().quick_check==='ok','DATABASE_CORRUPT');
    const names=db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name);
    need([...tables,...uploadTables,...refreshTables,...orderTables].every(t=>names.includes(t)),'DATABASE_SCHEMA_MISMATCH');
    const row=JSON.parse(db.prepare('SELECT value FROM runtime_identity WHERE singleton=1').get()?.value??'null');
    validateIdentity(row,config);need(row.schema>=4,'DATABASE_MIGRATION_REQUIRED');
    need(db.prepare('SELECT count(*) AS n FROM authority_state WHERE singleton=1').get().n===1,'DATABASE_STATE_MISSING');
    if(row.schema===5){need(inboxTables.every(t=>names.includes(t)),'DATABASE_SCHEMA_MISMATCH');return {schema:5,already_migrated:true};}
    need(inboxTables.every(t=>!names.includes(t)),'DATABASE_SCHEMA_MISMATCH');
    db.exec('BEGIN IMMEDIATE');
    try {installOrderInbox(db);db.prepare('UPDATE runtime_identity SET value=? WHERE singleton=1').run(JSON.stringify({...row,schema:5}));db.exec('COMMIT');}
    catch(error){db.exec('ROLLBACK');throw error;}
    return {schema:5,checkout_ready:false};
  }catch(error){throw error instanceof RuntimeError?error:new RuntimeError('DATABASE_UNAVAILABLE');}
  finally{db?.close();unlock();}
}

// Explicit offline schema5 ->6 in the SAME database, under the exclusive lock.
export function migrateResourceSessions(config) {
  const unlock=acquireLock(config),path=join(config.dataDir,'jobs.sqlite');let db;
  try {
    const s=lstatSync(path);need(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&(s.mode&0o077)===0,'PRIVATE_DATABASE_REQUIRED');
    db=new DatabaseSync(path);
    need(db.prepare('PRAGMA quick_check').get().quick_check==='ok','DATABASE_CORRUPT');
    const names=db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name);
    need([...tables,...uploadTables,...refreshTables,...orderTables,...inboxTables].every(t=>names.includes(t)),'DATABASE_SCHEMA_MISMATCH');
    const row=JSON.parse(db.prepare('SELECT value FROM runtime_identity WHERE singleton=1').get()?.value??'null');
    validateIdentity(row,config);need([5,6].includes(row.schema),'DATABASE_MIGRATION_REQUIRED');
    need(db.prepare('SELECT count(*) AS n FROM authority_state WHERE singleton=1').get().n===1,'DATABASE_STATE_MISSING');
    if(row.schema===6){need(resourceTables.every(t=>names.includes(t)),'DATABASE_SCHEMA_MISMATCH');return {schema:6,already_migrated:true};}
    need(resourceTables.every(t=>!names.includes(t)),'DATABASE_SCHEMA_MISMATCH');
    db.exec('BEGIN IMMEDIATE');
    try {installResourceSchema(db);db.prepare('UPDATE runtime_identity SET value=? WHERE singleton=1').run(JSON.stringify({...row,schema:6}));db.exec('COMMIT');}
    catch(error){db.exec('ROLLBACK');throw error;}
    return {schema:6,checkout_ready:false};
  }catch(error){throw error instanceof RuntimeError?error:new RuntimeError('DATABASE_UNAVAILABLE');}
  finally{db?.close();unlock();}
}

// Offline schema6 ->7; same DB, keys, exclusive lock and retained history.
export function migrateUploadCustody(config) {
  const unlock=acquireLock(config);let db;
  try {
    const path=join(config.dataDir,'jobs.sqlite'),s=lstatSync(path);
    need(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&(s.mode&0o077)===0,'PRIVATE_DATABASE_REQUIRED');
    db=new DatabaseSync(path);need(db.prepare('PRAGMA quick_check').get().quick_check==='ok','DATABASE_CORRUPT');
    const row=JSON.parse(db.prepare('SELECT value FROM runtime_identity WHERE singleton=1').get().value);validateIdentity(row,config);
    need(row.schema===6,'DATABASE_MIGRATION_REQUIRED');
    const names=db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x=>x.name);
    need([...tables,...uploadTables,...refreshTables,...orderTables,...inboxTables,...resourceTables].every(t=>names.includes(t))&&!names.includes('upload_custody'),'DATABASE_SCHEMA_MISMATCH');
    need(db.prepare('SELECT count(*) AS n FROM authority_state WHERE singleton=1').get().n===1,'DATABASE_STATE_MISSING');
    db.exec('BEGIN IMMEDIATE');
    try {installCustodySchema(db);db.prepare('UPDATE runtime_identity SET value=? WHERE singleton=1').run(JSON.stringify({...row,schema:7}));db.exec('COMMIT');}
    catch(e){db.exec('ROLLBACK');throw e;}
    return {schema:7,checkout_ready:false};
  }finally{db?.close();unlock();}
}

// Explicit offline additive migration retains all schema7 rows. Schema8 is an
// intermediate migration; owned-cart mode requires schema9, closed accepts both.
export function migrateCartCapability(config) {
 const unlock=acquireLock(config);let db;
 try {
  const path=join(config.dataDir,'jobs.sqlite'),s=lstatSync(path);
  need(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&(s.mode&0o077)===0,'PRIVATE_DATABASE_REQUIRED');
  db=new DatabaseSync(path);need(db.prepare('PRAGMA quick_check').get().quick_check==='ok','DATABASE_CORRUPT');
  const row=JSON.parse(db.prepare('SELECT value FROM runtime_identity WHERE singleton=1').get().value);validateIdentity(row,config);
  need(row.schema===7,'DATABASE_MIGRATION_REQUIRED');
  const names=db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x=>x.name);
  need([...tables,...uploadTables,...refreshTables,...orderTables,...inboxTables,...resourceTables,'upload_custody'].every(t=>names.includes(t))&&!names.includes('cart_capability_attempts'),'DATABASE_SCHEMA_MISMATCH');
  need(db.prepare('SELECT count(*) AS n FROM authority_state WHERE singleton=1').get().n===1,'DATABASE_STATE_MISSING');
  need(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name IN ('upload_purpose_immutable','upload_job_insert','upload_job_update')").get().n===3,'DATABASE_SCHEMA_MISMATCH');
  db.exec('BEGIN IMMEDIATE');
  try{installCartCapabilitySchema(db);db.prepare('UPDATE runtime_identity SET value=? WHERE singleton=1').run(JSON.stringify({...row,schema:8}));db.exec('COMMIT');}
  catch(e){db.exec('ROLLBACK');throw e;}
  return {schema:8,checkout_ready:false};
 }finally{db?.close();unlock();}
}

// Explicit same-database 8 -> 9. No admission backfill or previous-row edits.
export function migrateOwnedCart(config){
 const unlock=acquireLock(config);let db;
 try{
  const path=join(config.dataDir,'jobs.sqlite'),s=lstatSync(path);
  need(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&(s.mode&0o077)===0,'PRIVATE_DATABASE_REQUIRED');
  db=new DatabaseSync(path);need(db.prepare('PRAGMA quick_check').get().quick_check==='ok','DATABASE_CORRUPT');
  const row=JSON.parse(db.prepare('SELECT value FROM runtime_identity WHERE singleton=1').get().value);validateIdentity(row,config);
  need(row.schema===8,'DATABASE_MIGRATION_REQUIRED');
  const names=db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x=>x.name);
  need([...tables,...uploadTables,...refreshTables,...orderTables,...inboxTables,...resourceTables,'upload_custody','cart_capability_attempts'].every(t=>names.includes(t))&&!names.includes('cart_owner_admissions'),'DATABASE_SCHEMA_MISMATCH');
  need(db.prepare('SELECT count(*) AS n FROM authority_state WHERE singleton=1').get().n===1,'DATABASE_STATE_MISSING');
  need(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name IN ('upload_purpose_immutable','upload_job_insert','upload_job_update')").get().n===3,'DATABASE_SCHEMA_MISMATCH');
  db.exec('BEGIN IMMEDIATE');
  try{installOwnedCartSchema(db);db.prepare('UPDATE runtime_identity SET value=? WHERE singleton=1').run(JSON.stringify({...row,schema:9}));db.exec('COMMIT');}
  catch(e){db.exec('ROLLBACK');throw e;}
  return {schema:9,checkout_ready:false};
 }finally{db?.close();unlock();}
}

// Offline-only additive migration. No CLI/runtime flag invokes this candidate.
export function migrateCheckoutComposition(config){
 const unlock=acquireLock(config);let db;
 try{
  const path=join(config.dataDir,'jobs.sqlite'),s=lstatSync(path);
  need(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&(s.mode&0o077)===0,'PRIVATE_DATABASE_REQUIRED');
  db=new DatabaseSync(path);need(db.prepare('PRAGMA quick_check').get().quick_check==='ok','DATABASE_CORRUPT');
  const row=JSON.parse(db.prepare('SELECT value FROM runtime_identity WHERE singleton=1').get().value);validateIdentity(row,config);
  need(row.schema===9,'DATABASE_MIGRATION_REQUIRED');
  const names=db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x=>x.name);
  need([...tables,...uploadTables,...refreshTables,...orderTables,...inboxTables,...resourceTables,'upload_custody','cart_capability_attempts','cart_owner_admissions'].every(t=>names.includes(t))&&!['checkout_owner_admissions','checkout_capability_attempts','cart_checkout_bindings'].some(t=>names.includes(t)),'DATABASE_SCHEMA_MISMATCH');
  need(db.prepare('SELECT count(*) AS n FROM authority_state WHERE singleton=1').get().n===1,'DATABASE_STATE_MISSING');
  need(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name IN ('upload_purpose_immutable','upload_job_insert','upload_job_update')").get().n===3,'DATABASE_SCHEMA_MISMATCH');
  need(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name LIKE 'cart_owner_%'").get().n===8,'DATABASE_SCHEMA_MISMATCH');
  db.exec('BEGIN IMMEDIATE');
  try{installOwnedCartSchema(db,{checkout:true});installCartCapabilitySchema(db,{checkout:true});installCartBindingSchema(db);db.prepare('UPDATE runtime_identity SET value=? WHERE singleton=1').run(JSON.stringify({...row,schema:10}));db.exec('COMMIT');}
  catch(e){db.exec('ROLLBACK');throw e;}
  return {schema:10,checkout_ready:false};
 }finally{db?.close();unlock();}
}
