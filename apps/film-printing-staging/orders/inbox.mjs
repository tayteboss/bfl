import {randomUUID} from 'node:crypto';
import {authenticateOrderSignal} from './shopify.mjs';
import {need} from '../backend/config.mjs';
export const inboxTables=['order_inbox'];
export function installOrderInbox(db) {
  db.exec(`CREATE TABLE order_inbox (
    delivery_hash TEXT PRIMARY KEY, order_id TEXT NOT NULL, event_hash TEXT NOT NULL, body_hash TEXT NOT NULL,
    state TEXT NOT NULL, claim TEXT, attempts INTEGER NOT NULL DEFAULT 0, round_attempts INTEGER NOT NULL DEFAULT 0,
    next_at INTEGER NOT NULL, code TEXT, retry_evidence TEXT, received_at INTEGER NOT NULL);
    CREATE INDEX order_inbox_due ON order_inbox(state,next_at);`);
}
const signalOf=r=>({delivery_hash:r.delivery_hash,order_id:r.order_id,event_hash:r.event_hash,body_hash:r.body_hash});
// No enqueue-by-signal method. Only original signed bytes can create a row.
export function createOrderInbox(db,store,now) {
  const tx=store.lifecycle.transaction;
  const get=id=>db.prepare('SELECT * FROM order_inbox WHERE delivery_hash=?').get(id);
  const claimed=t=>{
    need(t&&typeof t.delivery_hash==='string'&&typeof t.claim==='string','ORDER_CLAIM_INVALID');
    const r=get(t.delivery_hash);need(r?.state==='processing'&&r.claim===t.claim,'ORDER_CLAIM_STALE');return r;
  };
  return {
    enqueue(input,secret) {
      const s=authenticateOrderSignal(input,secret);
      db.exec('PRAGMA busy_timeout=250');
      try {return tx(()=>{
        store.orders.checkDelivery(s);const prior=get(s.delivery_hash);
        need(!prior||prior.order_id===s.order_id&&prior.body_hash===s.body_hash&&prior.event_hash===s.event_hash,'ORDER_DELIVERY_CONFLICT');
        if(!prior) {
          need(db.prepare('SELECT COUNT(*) n FROM order_inbox').get().n<1000,'ORDER_INBOX_FULL');
          const held=db.prepare("SELECT 1 FROM order_inbox WHERE order_id=? AND state='held'").get(s.order_id);
          db.prepare('INSERT INTO order_inbox(delivery_hash,order_id,event_hash,body_hash,state,next_at,code,received_at) VALUES (?,?,?,?,?,?,?,?)')
            .run(s.delivery_hash,s.order_id,s.event_hash,s.body_hash,held?'held':'queued',now(),held?'PRIOR_ORDER_HELD':null,now());
        }
        // This ACK has deliberately no consumed/revoked/fulfilled claim or PII.
        return {received:true,durable:true,duplicate:!!prior,processed:false,checkout_ready:false,fulfillment_authorized:false};
      });}finally{db.exec('PRAGMA busy_timeout=5000');}
    },
    recover(){return tx(()=>{
      // Only openDatabase calls this after acquiring the exclusive process lock.
      // Never expire/steal a live claim by elapsed time. Interrupted work holds.
      return db.prepare("UPDATE order_inbox SET state='held',claim=NULL,code='PROCESS_INTERRUPTED' WHERE state='processing'").run().changes;
    });},
    claim(){return tx(()=>{
      if(db.prepare("SELECT 1 FROM order_inbox WHERE state='processing'").get())return null;
      const r=db.prepare("SELECT * FROM order_inbox WHERE state IN ('queued','retry') AND next_at<=? ORDER BY next_at,received_at,delivery_hash LIMIT 1").get(now());
      if(!r)return null;
      need(r.attempts<9&&r.round_attempts<3,'ORDER_ATTEMPT_LIMIT');
      const claim=randomUUID();db.prepare("UPDATE order_inbox SET state='processing',claim=?,attempts=attempts+1,round_attempts=round_attempts+1 WHERE delivery_hash=?").run(claim,r.delivery_hash);
      return {delivery_hash:r.delivery_hash,claim};
    });},
    claimed:t=>Object.freeze(signalOf(claimed(t))),
    finish(t,result){return tx(()=>{
      claimed(t);const done=['recorded','unrelated'].includes(result.state);
      const code=done?null:result.state==='conflict'?'ORDER_CONFLICT':result.unresolved?.[0]??'ORDER_PENDING';
      need(code===null||/^[A-Z0-9_]{1,80}$/.test(code),'ORDER_RESULT_INVALID');
      db.prepare('UPDATE order_inbox SET state=?,claim=NULL,code=? WHERE delivery_hash=?').run(done?'done':'held',code,t.delivery_hash);
    });},
    fail(t,code){return tx(()=>{
      const r=claimed(t);need(/^[A-Z0-9_]{1,80}$/.test(code),'ORDER_RESULT_INVALID');
      const retry=code==='ORDER_READ_UNAVAILABLE'&&r.round_attempts<3&&r.attempts<9;
      db.prepare('UPDATE order_inbox SET state=?,claim=NULL,code=?,next_at=? WHERE delivery_hash=?')
        .run(retry?'retry':'held',code,now()+(r.round_attempts===1?1000:5000),t.delivery_hash);
    });},
    // Trusted in-process operator action, never an HTTP/body flag. A new evidence
    // hash records why a prerequisite changed, not ownership proof or a grant.
    retry(deliveryHash,evidenceHash){return tx(()=>{
      const r=get(deliveryHash);need(r?.state==='held'&&r.attempts<9,'ORDER_RETRY_UNAVAILABLE');
      need(typeof evidenceHash==='string'&&/^[a-f0-9]{64}$/.test(evidenceHash)&&evidenceHash!==r.retry_evidence,'ORDER_RETRY_EVIDENCE_REQUIRED');
      db.prepare("UPDATE order_inbox SET state='queued',claim=NULL,round_attempts=0,next_at=?,code=NULL,retry_evidence=? WHERE delivery_hash=?").run(now(),evidenceHash,deliveryHash);
    });},
    status(deliveryHash){const r=get(deliveryHash);return r?{state:r.state,attempts:r.attempts,round_attempts:r.round_attempts,code:r.code,next_at:r.next_at}:null;},
    counts(){return Object.fromEntries(db.prepare('SELECT state,COUNT(*) n FROM order_inbox GROUP BY state').all().map(r=>[r.state,r.n]));},
  };
}
