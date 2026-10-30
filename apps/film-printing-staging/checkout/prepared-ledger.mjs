import {randomUUID} from 'node:crypto';
import {cartHash,requireCartLocator} from './storefront.mjs';
import {fingerprint as digest} from '../jobs/lifecycle.mjs';
import {need} from '../backend/config.mjs';
import {preparedOwnerPolicy,preparedPolicyReceipt,CLIENT_POLICY_ADMISSION} from './prepared-limits.mjs';

export const preparedColumns=['operation_id','job_id','owner_hash','cart_hash','binding_hash','reference_hash','selection_hash','generation','epoch','expires_at','state','value_hash','observed_hash'];
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export function installPreparedSchema(db){
  db.exec(`CREATE TABLE cart_prepared_jobs (
    operation_id TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE,
    owner_hash TEXT NOT NULL, cart_hash TEXT NOT NULL, binding_hash TEXT NOT NULL,
    reference_hash TEXT NOT NULL, selection_hash TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK(generation>0), epoch INTEGER NOT NULL CHECK(epoch>=0),
    expires_at INTEGER NOT NULL CHECK(expires_at>0),
    state TEXT NOT NULL CHECK(state IN ('reserved','issued','confirmed','cancelled','uncertain')),
    value_hash TEXT, observed_hash TEXT, UNIQUE(owner_hash,generation));`);
}
export function validatePreparedSchema(db){
  need(JSON.stringify(db.prepare('PRAGMA table_info(cart_prepared_jobs)').all().map(r=>r.name))===JSON.stringify(preparedColumns),'PREPARED_SCHEMA_MISMATCH');
  const unique=db.prepare('PRAGMA index_list(cart_prepared_jobs)').all().filter(r=>r.unique).map(r=>db.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno').all(r.name).map(c=>c.name).join(','));
  need(unique.length===3&&['operation_id','job_id','owner_hash,generation'].every(k=>unique.includes(k)),'PREPARED_SCHEMA_MISMATCH');
}
export function createPreparedLedger(db,lifecycle,{now=Date.now}={}){
  validatePreparedSchema(db);
  const tx=lifecycle.transaction;
  const ticket=r=>Object.freeze(Object.fromEntries(['operation_id','job_id','owner_hash','cart_hash','generation','expires_at'].map(k=>[k,r[k]])));
  const current=t=>{
    const r=db.prepare('SELECT * FROM cart_prepared_jobs WHERE operation_id=?').get(t?.operation_id);
    need(r&&['job_id','owner_hash','cart_hash','generation','expires_at'].every(k=>r[k]===t[k]),'PREPARED_OPERATION_CHANGED');return r;
  };
  const clear=()=>{const s=lifecycle.state();need(!s.pending&&!s.operation,'AUTHORITY_PENDING');return s;};
  const assertCapacity=(owner,{sourceScope}={})=>{
    const limits=preparedOwnerPolicy(db,owner,sourceScope);
    const rows=db.prepare('SELECT state FROM cart_prepared_jobs WHERE owner_hash=?').all(cartHash(owner));
    need(rows.length<limits.preparations,'PREPARATION_LIMIT');
    need(rows.filter(r=>r.state!=='cancelled').length<limits.jobs,'CUSTOMER_JOB_SPENT');
  };
  const ownerFor=r=>{
    const job=db.prepare('SELECT owner,body FROM jobs WHERE id=?').get(r.job_id);
    need(job&&cartHash(job.owner)===r.owner_hash&&!lifecycle.retired('owner',job.owner)&&!lifecycle.retired('job',job.owner,r.job_id),'PREPARED_JOB_UNAVAILABLE');
    const s=db.prepare('SELECT expires,deadline,revoked FROM resource_sessions WHERE owner=?').get(job.owner);
    need(s&&s.revoked===null&&now()<r.expires_at&&r.expires_at<=s.expires&&r.expires_at<=s.deadline,'PREPARED_EXPIRED');
    const b=db.prepare('SELECT * FROM cart_checkout_bindings WHERE cart_hash=?').get(r.cart_hash);
    need(b&&b.owner_hash===r.owner_hash&&b.state==='confirmed'&&digest(b.marker)===r.binding_hash,'PREPARED_BINDING_CHANGED');return job.owner;
  };
  return Object.freeze({
    assertCapacity,
    reserve(owner,cart,binding,reference,selectionHash,generation,expiresAt,{sourceScope}={}){return tx(()=>{
      const s=clear();requireCartLocator(cart?.id);
      need(typeof owner==='string'&&owner.length>0&&owner.length<=200&&cart.owner===owner&&cart.complete===true&&hex(binding)&&hex(selectionHash)&&Number.isSafeInteger(generation)&&generation>0&&Number.isSafeInteger(expiresAt)&&expiresAt>now(),'PREPARED_INPUT');
      need(typeof reference?.id==='string'&&hex(reference.revision)&&hex(reference.signature)&&typeof reference.config_version==='string','PREPARED_INPUT');
      const r={operation_id:randomUUID(),job_id:reference.id,owner_hash:cartHash(owner),cart_hash:cartHash(cart.id),binding_hash:digest(binding),reference_hash:digest(reference),selection_hash:selectionHash,generation,epoch:s.epoch,expires_at:expiresAt,state:'reserved',value_hash:null,observed_hash:null};
      const previous=db.prepare('SELECT * FROM cart_prepared_jobs WHERE owner_hash=? AND generation=?').get(r.owner_hash,generation);
      if(previous){need(['job_id','owner_hash','cart_hash','binding_hash','reference_hash','selection_hash','generation','expires_at'].every(k=>previous[k]===r[k]),'PREPARED_REQUEST_CONFLICT');return {ticket:ticket(previous),state:previous.state,replay:true};}
      need(!db.prepare('SELECT 1 FROM cart_prepared_jobs WHERE job_id=?').get(r.job_id),'PREPARED_JOB_SPENT');
      assertCapacity(owner,{sourceScope});
      const policy=preparedOwnerPolicy(db,owner,sourceScope),time=now();
      // Keep spent rows for replay protection; only live persistent work uses
      // the prospective service capacity. Historical policies stay unchanged.
      let count;
      if(policy.clientPolicy==='bfl-persistent-staging-client-v1'){
        const active=db.prepare(`SELECT s.owner FROM resource_sessions s
          JOIN resource_admissions a ON a.owner=s.owner AND a.kind=? AND a.request_hash=?
          WHERE s.revoked IS NULL AND s.expires>? AND s.deadline>? AND NOT EXISTS
          (SELECT 1 FROM authority_tombstones t WHERE t.kind='owner' AND t.owner=s.owner AND t.target='')
          `).all(CLIENT_POLICY_ADMISSION,preparedPolicyReceipt(sourceScope),time,time);
        const perOwner=db.prepare("SELECT count(*) AS n FROM cart_prepared_jobs WHERE owner_hash=? AND expires_at>? AND state<>'cancelled'");
        count=active.reduce((total,row)=>total+perOwner.get(cartHash(row.owner),time).n,0);
      }else count=db.prepare('SELECT COUNT(*) AS n FROM cart_prepared_jobs').get().n;
      need(count<10000,'PREPARED_CAPACITY');
      const prior=db.prepare('SELECT MAX(generation) AS generation,MIN(expires_at) AS expires_at FROM cart_prepared_jobs WHERE owner_hash=?').get(r.owner_hash);
      need(!prior.generation||generation>prior.generation,'PREPARED_GENERATION_STALE');
      need(prior.expires_at===null||expiresAt===prior.expires_at,'PREPARED_LEASE_CHANGED');
      const body=db.prepare('SELECT owner,body FROM jobs WHERE id=?').get(r.job_id);
      need(body?.owner===owner,'PREPARED_JOB_UNAVAILABLE');const job=JSON.parse(body.body);
      need(job.revision===reference.revision&&job.config_version===reference.config_version,'PREPARED_JOB_CHANGED');
      const b=db.prepare('SELECT * FROM cart_checkout_bindings WHERE cart_hash=?').get(r.cart_hash);
      need(b?.marker===binding&&b.identity_hash===digest({owner,binding:cart.binding_id,customer:cart.customer_id}),'PREPARED_BINDING_CHANGED');
      ownerFor(r);
      need(!db.prepare('SELECT 1 FROM cart_job_bindings WHERE job_id=?').get(r.job_id),'PREPARED_JOB_SPENT');
      db.prepare('INSERT INTO cart_job_bindings VALUES (?,?,?)').run(r.job_id,r.cart_hash,r.owner_hash);
      db.prepare('INSERT INTO cart_prepared_jobs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...preparedColumns.map(k=>r[k]));
      return {ticket:ticket(r),state:r.state,replay:false};
    });},
    issue(t,valueHash){return tx(()=>{
      const r=current(t),s=clear();ownerFor(r);
      need(r.state==='reserved'&&r.epoch===s.epoch&&hex(valueHash),'PREPARED_OPERATION_SPENT');
      db.prepare("UPDATE cart_prepared_jobs SET state='issued',value_hash=? WHERE operation_id=?").run(valueHash,r.operation_id);
      return {ticket:ticket(r),issued:true};
    });},
    confirm(t,observedHash){return tx(()=>{
      const r=current(t);clear();ownerFor(r);
      need(['issued','uncertain'].includes(r.state)&&hex(r.value_hash)&&hex(observedHash),'PREPARED_OPERATION_CHANGED');
      db.prepare("UPDATE cart_prepared_jobs SET state='confirmed',observed_hash=? WHERE operation_id=?").run(observedHash,r.operation_id);return {confirmed:true};
    });},
    uncertain(t){return tx(()=>{const r=current(t);need(r.state!=='cancelled','PREPARED_OPERATION_CHANGED');db.prepare("UPDATE cart_prepared_jobs SET state='uncertain' WHERE operation_id=?").run(r.operation_id);return {uncertain:true};});},
    cancel(t){return tx(()=>{
      const r=current(t);need(['reserved','issued','cancelled'].includes(r.state),'PREPARED_OPERATION_CHANGED');
      if(r.state==='cancelled')return {cancelled:true,revoked:false};
      need(!lifecycle.state().operation,'PREPARED_UNCERTAIN');
      const row=db.prepare('SELECT owner FROM jobs WHERE id=?').get(r.job_id);need(row&&cartHash(row.owner)===r.owner_hash,'PREPARED_JOB_UNAVAILABLE');
      return lifecycle.event('prepared-cancel:'+r.operation_id,{kind:'prepared-job',operation:r.operation_id,job:r.job_id,owner:r.owner_hash},()=>{
        lifecycle.retire('job',row.owner,r.job_id);db.prepare("UPDATE cart_prepared_jobs SET state='cancelled' WHERE operation_id=?").run(r.operation_id);
      });
    });},
    status(t){const r=current(t);return {ticket:ticket(r),state:r.state,value_hash:r.value_hash,observed_hash:r.observed_hash};},
  });
}
