import { createHash, randomUUID } from 'node:crypto';
import { canonical } from '../configuration/config.mjs';
import { requireValue } from '../shipping/packing.mjs';

export const fingerprint = value => createHash('sha256').update(canonical(value)).digest('hex');

// Shares the private job database and its transaction with upload/job mutations.
// No timer/lease unlock: an abandoned write MUST be reconciled against Shopify.
export function createLifecycle(db) {
  db.exec(`PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS authority_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1), epoch INTEGER NOT NULL, operation TEXT);
    INSERT OR IGNORE INTO authority_state VALUES (1,0,NULL);
    CREATE TABLE IF NOT EXISTS authority_preparations (id TEXT PRIMARY KEY, epoch INTEGER, value_hash TEXT);
    CREATE TABLE IF NOT EXISTS authority_events (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, epoch INTEGER NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS authority_tombstones (kind TEXT, owner TEXT, target TEXT, PRIMARY KEY(kind,owner,target));`);
  let inside=false;
  const transaction = fn => {
    if(inside)return fn(); // Synchronous nesting within this store only.
    db.exec('BEGIN IMMEDIATE');
    inside=true;
    try { const result=fn(); db.exec('COMMIT'); return result; }
    catch(error) { db.exec('ROLLBACK'); throw error; }
    finally { inside=false; }
  };
  const state = () => {
    const row=db.prepare('SELECT * FROM authority_state WHERE singleton=1').get();
    return {epoch:row.epoch,operation:row.operation ? JSON.parse(row.operation) : null,
      pending:db.prepare('SELECT COUNT(*) AS n FROM authority_events WHERE acknowledged=0').get().n};
  };
  const available = () => {
    const s=state(); requireValue(!s.operation && !s.pending,'AUTHORITY_PENDING'); return s;
  };
  const retired = (kind,owner,target='') => !!db.prepare('SELECT 1 FROM authority_tombstones WHERE kind=? AND owner=? AND target=?').get(kind,owner,target);
  const retire = (kind,owner,target='') => db.prepare('INSERT OR IGNORE INTO authority_tombstones VALUES (?,?,?)').run(kind,owner,target);
  const event = (id,body,mutate) => transaction(() => {
    const prior=db.prepare('SELECT * FROM authority_events WHERE id=?').get(id), hash=fingerprint(body);
    if(prior) {
      requireValue(prior.fingerprint===hash,'EVENT_ID_CONFLICT');
      return {recorded:true,revoked:!!prior.acknowledged,checkout_ready:false};
    }
    mutate();
    db.prepare('UPDATE authority_state SET epoch=epoch+1 WHERE singleton=1').run();
    db.prepare('INSERT INTO authority_events(id,fingerprint,epoch) VALUES (?,?,?)').run(id,hash,state().epoch);
    return {recorded:true,revoked:false,checkout_ready:false};
  });
  const assertOperation = op => {
    const s=state(); requireValue(s.operation?.id===op.id && s.epoch===op.epoch,'AUTHORITY_FENCED');
  };
  const reserve = kind => {
    const op={id:randomUUID(),kind,epoch:state().epoch};
    db.prepare('UPDATE authority_state SET operation=? WHERE singleton=1').run(JSON.stringify(op)); return op;
  };
  return {
    transaction, state, retired, retire, event,
    pendingEvents(){return db.prepare('SELECT id,epoch FROM authority_events WHERE acknowledged=0 ORDER BY epoch,id').all();},
    eventResult(id,body) {
      const row=db.prepare('SELECT * FROM authority_events WHERE id=?').get(id);
      if(!row)return null;
      requireValue(row.fingerprint===fingerprint(body),'EVENT_ID_CONFLICT');
      return {recorded:true,revoked:!!row.acknowledged,checkout_ready:false};
    },
    beginPreparation() { return transaction(() => {
      const {epoch}=available(), id=randomUUID();
      // Conservative shop-wide ordering for the bounded projection: any newer
      // preparation supersedes older ones, even when their cart read is delayed.
      db.prepare('DELETE FROM authority_preparations').run();
      db.prepare('INSERT INTO authority_preparations VALUES (?,?,NULL)').run(id,epoch);
      return {id,epoch};
    }); },
    stage(ticket,value) { return transaction(() => {
      const s=available(), row=db.prepare('SELECT * FROM authority_preparations WHERE id=?').get(ticket.id);
      requireValue(row && row.epoch===ticket.epoch && row.epoch===s.epoch,'AUTHORITY_FENCED');
      db.prepare('UPDATE authority_preparations SET value_hash=? WHERE id=?').run(fingerprint(value),ticket.id);
      return ticket;
    }); },
    startPublication(ticket,value) { return transaction(() => {
      const s=available(), row=ticket && db.prepare('SELECT * FROM authority_preparations WHERE id=?').get(ticket.id);
      requireValue(row && row.epoch===s.epoch && row.value_hash===fingerprint(value),'AUTHORITY_FENCED');
      db.prepare('DELETE FROM authority_preparations').run();
      return reserve('publish');
    }); },
    startCutover() { return transaction(() => {
      available(); db.prepare('UPDATE authority_state SET epoch=epoch+1 WHERE singleton=1').run();
      return reserve('cutover');
    }); },
    startRecovery() { return transaction(() => {
      // Supersede an abandoned/in-flight operation locally. Its remote CAS is
      // fenced by a fresh private Shopify token, even for identical grant JSON.
      db.prepare('UPDATE authority_state SET epoch=epoch+1 WHERE singleton=1').run();
      return reserve('recovery');
    }); },
    assertOperation,
    finish(op) { return transaction(() => {
      assertOperation(op);
      if(op.kind==='recovery')db.prepare('UPDATE authority_events SET acknowledged=1 WHERE epoch<=?').run(op.epoch);
      db.prepare('UPDATE authority_state SET operation=NULL WHERE singleton=1').run();
    }); },
  };
}
