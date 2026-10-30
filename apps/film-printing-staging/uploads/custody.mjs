import {need} from '../backend/config.mjs';
import {UPLOAD_ONLY_PURPOSE,SESSION_ONLY_PURPOSE} from '../backend/resource-session.mjs';
import {uuid} from './ledger.mjs';
export function installCustodySchema(db){
  db.exec(`CREATE TABLE upload_custody (
    intent TEXT PRIMARY KEY, owner TEXT NOT NULL, binding TEXT NOT NULL,
    asset TEXT UNIQUE, state TEXT NOT NULL, updated INTEGER NOT NULL);
    CREATE TRIGGER upload_purpose_immutable BEFORE UPDATE OF purpose ON resource_sessions
      WHEN NEW.purpose != OLD.purpose BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RESOURCE_PURPOSE'); END;
    CREATE TRIGGER upload_job_insert BEFORE INSERT ON jobs
      WHEN EXISTS(SELECT 1 FROM resource_sessions WHERE owner=NEW.owner AND purpose IN ('${UPLOAD_ONLY_PURPOSE}','${SESSION_ONLY_PURPOSE}'))
      BEGIN SELECT RAISE(ABORT,'UPLOAD_ONLY'); END;
    CREATE TRIGGER upload_job_update BEFORE UPDATE OF owner ON jobs
      WHEN EXISTS(SELECT 1 FROM resource_sessions WHERE owner=NEW.owner AND purpose IN ('${UPLOAD_ONLY_PURPOSE}','${SESSION_ONLY_PURPOSE}'))
      BEGIN SELECT RAISE(ABORT,'UPLOAD_ONLY'); END;`);
}
// Provider custody is intentionally outside a request's expiring credential
// scope. It can retain/retire an exact claimed intent, NEVER grant a resource.
// Unknown POST/DELETE results are not retried or silently acknowledged.
export function createUploadCustody(db,store,now=Date.now){
  const tx=store.lifecycle.transaction;
  const read=id=>db.prepare('SELECT * FROM upload_custody WHERE intent=?').get(id);
  const set=(id,state)=>db.prepare('UPDATE upload_custody SET state=?,updated=? WHERE intent=?').run(state,now(),id);
  const own=row=>need(row&&db.prepare('SELECT purpose FROM resource_sessions WHERE owner=?').get(row.owner)?.purpose===UPLOAD_ONLY_PURPOSE,'UPLOAD_CUSTODY_SCOPE');
  const fail=id=>{const row=store.uploadLedger.read(id);own(row);store.uploadLedger.invalidate(row,'failed');};
  const service={
    start(id,binding){return tx(()=>{
      const row=store.uploadLedger.read(id);own(row);need(row.binding===binding&&row.state==='sending'&&!read(id),'UPLOAD_CUSTODY_SCOPE');
      // One durable external POST admission for this finite staging diagnostic.
      // No reset on expiry, failure, deletion or restart.
      need(db.prepare('SELECT count(*) AS n FROM upload_custody').get().n<1,'UPLOAD_DIAGNOSTIC_LIMIT');
      db.prepare('INSERT INTO upload_custody VALUES (?,?,?,NULL,?,?)').run(id,row.owner,binding,'sending',now());
    });},
    known(id,binding,asset){return tx(()=>{
      const row=read(id);own(row);need(row.binding===binding&&row.state==='sending'&&uuid(asset),'UPLOAD_CUSTODY_SCOPE');
      db.prepare("UPDATE upload_custody SET asset=?,state='known',updated=? WHERE intent=?").run(asset,now(),id);
    });},
    failed(id){return tx(()=>{
      fail(id);const row=read(id);
      if(row?.state==='sending')set(id,'upload-unknown');
      else if(row?.state==='known')set(id,'queued');
    });},
    retire(owner){return tx(()=>{
      for(const row of db.prepare('SELECT id FROM upload_intents WHERE owner=?').all(owner))fail(row.id);
      service.queue();
    });},
    queue(){return tx(()=>{
      for(const row of db.prepare("SELECT * FROM upload_custody WHERE state='known'").all()){
        const intent=store.uploadLedger.read(row.intent);
        if(['failed','removed'].includes(intent.state)||store.lifecycle.retired('owner',row.owner))set(row.intent,'queued');
      }
    });},
    recover(){return tx(()=>{
      for(const row of db.prepare("SELECT * FROM upload_custody WHERE state IN ('sending','deleting')").all()){
        set(row.intent,row.state==='sending'?'upload-unknown':'delete-unknown');fail(row.intent);
      }
      service.queue();
    });},
    pending(){service.queue();return db.prepare("SELECT * FROM upload_custody WHERE state='queued'").all();},
    beginDelete(id){return tx(()=>{const row=read(id);own(row);need(row.state==='queued'&&uuid(row.asset),'UPLOAD_CUSTODY_SCOPE');set(id,'deleting');return row;});},
    finishDelete(id,confirmed){return tx(()=>{need(read(id)?.state==='deleting','UPLOAD_CUSTODY_SCOPE');set(id,confirmed?'deleted':'delete-unknown');});},
    counts(){return Object.fromEntries(db.prepare('SELECT state,count(*) AS n FROM upload_custody GROUP BY state').all().map(r=>[r.state,r.n]));},
  };
  return Object.freeze(service);
}
