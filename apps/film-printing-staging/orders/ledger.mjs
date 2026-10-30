import {fingerprint} from '../jobs/lifecycle.mjs';
import {freeze,verifyRelease} from '../configuration/config.mjs';
import {need} from '../backend/config.mjs';
export const orderTables=['order_job_snapshots','order_source_bindings','order_deliveries','order_observations','order_consumptions'];
export function installOrderSchema(db) {
  db.exec(`CREATE TABLE order_job_snapshots (job_id TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE order_source_bindings (cart_hash TEXT PRIMARY KEY, owner_hash TEXT NOT NULL,
      cart_token_hash TEXT NOT NULL UNIQUE, customer_hash TEXT NOT NULL, evidence_hash TEXT NOT NULL);
    CREATE TABLE order_deliveries (delivery_hash TEXT PRIMARY KEY, body_hash TEXT NOT NULL, order_id TEXT NOT NULL, event_hash TEXT NOT NULL);
    CREATE TABLE order_observations (sequence INTEGER PRIMARY KEY, order_id TEXT NOT NULL, observation_hash TEXT NOT NULL,
      decision_hash TEXT NOT NULL, event_id TEXT NOT NULL UNIQUE, value TEXT NOT NULL, UNIQUE(order_id,observation_hash,decision_hash));
    CREATE TABLE order_consumptions (job_id TEXT PRIMARY KEY, order_id TEXT NOT NULL, observation_hash TEXT NOT NULL);`);
}
// order_source_bindings deliberately has NO writer in this feature. Neither a
// browser cart ID nor a webhook property proves the cross-surface cartToken link.
// Future authenticated source capture must establish it before any consumption.
// Tests explicitly seed synthetic rows; runtime/operator/HTTP cannot do so.
export function createOrderLedger(db,store) {
  const lifecycle=store.lifecycle;
  const read=value=>value?freeze(JSON.parse(value)):null;
  const latest=id=>db.prepare('SELECT * FROM order_observations WHERE order_id=? ORDER BY sequence DESC LIMIT 1').get(id);
  return {
    capture(job,release,catalog,sourceScope) {
      verifyRelease(release,{sourceScope});
      need(job.config_version===release.version&&job.config_sha256===release.sha256&&job.price_version===catalog.version,'ORDER_SNAPSHOT_MISMATCH');
      const value=JSON.stringify({release,catalog});need(Buffer.byteLength(value)<=1048576,'ORDER_SNAPSHOT_LIMIT');
      db.prepare('INSERT INTO order_job_snapshots VALUES (?,?)').run(job.id,value);
    },
    snapshot:id=>read(db.prepare('SELECT value FROM order_job_snapshots WHERE job_id=?').get(id)?.value),
    job(id) {const row=db.prepare('SELECT owner,body FROM jobs WHERE id=?').get(id);return row?{owner:row.owner,job:read(row.body)}:null;},
    binding(jobId) {return db.prepare(`SELECT b.cart_hash,b.owner_hash,s.cart_token_hash,s.customer_hash,s.evidence_hash
      FROM cart_job_bindings b LEFT JOIN order_source_bindings s ON s.cart_hash=b.cart_hash AND s.owner_hash=b.owner_hash WHERE b.job_id=?`).get(jobId);},
    consumed:id=>db.prepare('SELECT * FROM order_consumptions WHERE job_id=?').get(id),
    checkDelivery(signal) {
      const r=db.prepare('SELECT * FROM order_deliveries WHERE delivery_hash=?').get(signal.delivery_hash);
      need(!r||r.body_hash===signal.body_hash&&r.order_id===signal.order_id&&r.event_hash===signal.event_hash,'ORDER_DELIVERY_CONFLICT');
    },
    latest(id) {return read(latest(id)?.value);},
    // All final ownership/asset/revision/replay checks in decide() are synchronous
    // under the SAME transaction as retirement, records and pending invalidation.
    record(signal,order,decide) {return lifecycle.transaction(()=>{
      this.checkDelivery(signal);
      const prior=latest(order.id),observation=fingerprint({...order,updated_at:undefined});
      const consumed=db.prepare('SELECT * FROM order_consumptions WHERE order_id=?').get(order.id);
      const sourceHash=fingerprint({...order,updated_at:undefined,groups:undefined});
      const previous=read(prior?.value);
      let decision;
      if(consumed&&(consumed.observation_hash!==sourceHash||previous?.state==='conflict'||previous?.state==='recorded'&&prior?.observation_hash!==observation)) {
        // Retain the original immutable manifest. A changed source is an audit
        // hold, never a rewrite or fresh packing calculation using today's rules.
        decision={state:'conflict',unresolved:['ORDER_CHANGED_AFTER_CONSUMPTION'],lines:[],packing:null,consume:[]};
      } else if(consumed&&previous?.state==='recorded'&&prior?.observation_hash===observation) {
        const original=read(prior.value);decision={...original,consume:[]};
      } else decision=decide();
      const {consume,...record}=decision;
      const value={...record,order_id:order.id,source_updated_at:order.updated_at,fulfillment_authorized:false};
      // Delivery timestamps do not order or authorize work; canonical data does.
      const decisionHash=fingerprint({...value,source_updated_at:undefined});
      const existing=db.prepare('SELECT * FROM order_observations WHERE order_id=? AND observation_hash=? AND decision_hash=?').get(order.id,observation,decisionHash);
      if(!existing)need(db.prepare('SELECT COUNT(*) AS n FROM order_observations').get().n<10000,'ORDER_LEDGER_CAPACITY');
      const knownDelivery=db.prepare('SELECT 1 FROM order_deliveries WHERE delivery_hash=?').get(signal.delivery_hash);
      if(!knownDelivery)need(db.prepare('SELECT COUNT(*) AS n FROM order_deliveries').get().n<10000,'ORDER_LEDGER_CAPACITY');
      const eventId=`order-record:${fingerprint([order.id,observation,decisionHash])}`;
      const receipt=lifecycle.event(eventId,{order:order.id,observation,decision:decisionHash},()=>{
        for(const {owner,reference} of consume) {
          need(!this.consumed(reference.id)&&!lifecycle.retired('job',owner,reference.id)&&!lifecycle.retired('owner',owner),'ORDER_JOB_REPLAY');
          // Reuse existing job retirement; its nested transaction is synchronous.
          store.revoke({id:`order-job:${fingerprint([order.id,reference.id])}`,kind:'order',owner,order_id:order.id,references:[reference]});
          db.prepare('INSERT INTO order_consumptions VALUES (?,?,?)').run(reference.id,order.id,sourceHash);
        }
        db.prepare('INSERT INTO order_observations(order_id,observation_hash,decision_hash,event_id,value) VALUES (?,?,?,?,?)')
          .run(order.id,observation,decisionHash,eventId,JSON.stringify(value));
      });
      db.prepare('INSERT OR IGNORE INTO order_deliveries VALUES (?,?,?,?)').run(signal.delivery_hash,signal.body_hash,order.id,signal.event_hash);
      return {...receipt,state:record.state,unresolved:record.unresolved,fulfillment_authorized:false};
    });},
  };
}
