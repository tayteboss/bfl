import {randomUUID} from 'node:crypto';
import {need} from '../backend/config.mjs';
import {preparedOwnerPolicy,preparedPolicyReceipt,CLIENT_POLICY_ADMISSION} from '../checkout/prepared-limits.mjs';
import {assertEngineeringScope} from '../configuration/engineering.mjs';
export const uploadTables=['upload_intents','upload_provider_deletions'];
export const uuid=s=>typeof s==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s);
export const terminal=s=>['failed','removed'].includes(s);
export function installUploadSchema(db) {
  db.exec(`CREATE TABLE upload_intents (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL, request_key TEXT NOT NULL,
    binding TEXT NOT NULL, state TEXT NOT NULL, version INTEGER NOT NULL,
    expires INTEGER NOT NULL, checked_until INTEGER NOT NULL DEFAULT 0,
    digest TEXT, size INTEGER, mime TEXT, asset TEXT UNIQUE,
    UNIQUE(owner,request_key));
    CREATE TABLE upload_provider_deletions (binding TEXT, asset TEXT, PRIMARY KEY(binding,asset));`);
}
// All methods are internal and synchronous. They share jobs' connection and
// transaction; completion/invalidation never cross a second database or await.
export function createUploadLedger(db,store,now=Date.now) {
  const tx=store.lifecycle.transaction;
  const read=id=>db.prepare('SELECT * FROM upload_intents WHERE id=?').get(id);
  const owned=(owner,id,binding)=>{
    const row=read(id);
    need(row&&row.owner===owner&&row.binding===binding,'UPLOAD_INTENT_UNAVAILABLE');
    need(!store.lifecycle.retired('owner',owner),'OWNER_REJECTED');return row;
  };
  const update=(id,state)=>db.prepare('UPDATE upload_intents SET state=?,version=version+1,checked_until=0 WHERE id=?').run(state,id);
  const invalidate=(row,state)=>tx(()=>{
    row=read(row.id);
    if(terminal(row.state)){
      if(row.state==='failed'&&state==='removed')update(row.id,'removed');
      return read(row.id);
    }
    update(row.id,state);
    if(row.asset)store.invalidateUpload({id:`uc:terminal:${row.id}`,kind:'upload',scope:'upload:invalidate',owner:row.owner,asset_id:row.asset,state});
    return read(row.id);
  });
  // A stale provider observation requires revalidation, not asset deletion.
  // The original intent deadline remains a hard bound, including on refresh.
  const expired=row=>row.expires<=now();
  return {
    owned,read,
    create(owner,key,binding,{sourceScope}={}) {return tx(()=>{
      need(typeof owner==='string'&&owner.length>0&&owner.length<=200&&!store.lifecycle.retired('owner',owner),'OWNER_REJECTED');
      need(typeof key==='string'&&/^[a-zA-Z0-9_-]{8,100}$/.test(key),'INVALID_UPLOAD_KEY');
      const prior=db.prepare('SELECT * FROM upload_intents WHERE owner=? AND request_key=?').get(owner,key);
      if(prior){need(prior.binding===binding,'UPLOAD_PROJECT_CHANGED');return prior;}
      need(db.prepare('SELECT count(*) AS n FROM upload_intents WHERE owner=?').get(owner).n<1000,'UPLOAD_INTENT_LIMIT');
      const created=now(),policy=preparedOwnerPolicy(db,owner,sourceScope);
      // Persistent service history remains immutable. Its capacity applies to
      // live, receipt-bound work rather than all experiments/expired sessions.
      const count=policy.clientPolicy==='bfl-persistent-staging-client-v1'?db.prepare(`SELECT count(*) AS n
        FROM upload_intents u JOIN resource_sessions s ON s.owner=u.owner
        JOIN resource_admissions a ON a.owner=s.owner AND a.kind=? AND a.request_hash=?
        WHERE s.revoked IS NULL AND s.expires>? AND s.deadline>? AND u.expires>?
          AND u.state NOT IN ('failed','removed') AND NOT EXISTS
          (SELECT 1 FROM authority_tombstones t WHERE t.kind='owner' AND t.owner=s.owner AND t.target='')
        `).get(CLIENT_POLICY_ADMISSION,preparedPolicyReceipt(sourceScope),created,created,created).n:
        db.prepare('SELECT count(*) AS n FROM upload_intents').get().n;
      need(count<10000,'UPLOAD_INTENT_LIMIT');
      let expires=created+600000;
      if(policy.clientPolicy){
        const session=db.prepare('SELECT expires,deadline,revoked FROM resource_sessions WHERE owner=?').get(owner);
        need(session&&session.revoked===null&&session.expires>created&&session.deadline>created,'RESOURCE_REJECTED');
        // Only new, receipt-bound intents use the full client window. Existing
        // rows and the short provider-observation proof are never extended.
        const contract=assertEngineeringScope(sourceScope).contract,persistent=contract.kind==='persistent_staging';
        const maximum=persistent?policy.ownerMs:policy.windowMs;
        expires=Math.min(created+maximum,session.expires,session.deadline,persistent?Infinity:contract.expires_at);
        need(Number.isSafeInteger(expires)&&expires>created&&expires<=created+(persistent?policy.ownerMs:3600000),'UPLOAD_EXPIRED');
      }
      const id=randomUUID();
      db.prepare('INSERT INTO upload_intents(id,owner,request_key,binding,state,version,expires) VALUES (?,?,?,?,?,1,?)').run(id,owner,key,binding,'issued',expires);
      return read(id);
    });},
    claim(owner,id,binding,{digest,size,mime}) {return tx(()=>{
      const row=owned(owner,id,binding);need(!expired(row),'UPLOAD_EXPIRED');
      if(row.digest){need(row.digest===digest&&row.size===size&&row.mime===mime,'UPLOAD_REPLAY_CONFLICT');return {row,send:false};}
      need(row.state==='issued','UPLOAD_TERMINAL');
      db.prepare("UPDATE upload_intents SET state='sending',version=version+1,digest=?,size=?,mime=? WHERE id=?").run(digest,size,mime,id);
      return {row:read(id),send:true};
    });},
    bind(owner,id,binding,asset) {return tx(()=>{
      const row=owned(owner,id,binding);need(uuid(asset)&&row.state==='sending'&&!expired(row),'UPLOAD_INTENT_UNAVAILABLE');
      need(!db.prepare('SELECT 1 FROM upload_intents WHERE asset=?').get(asset),'UPLOAD_ASSET_REUSED');
      db.prepare("UPDATE upload_intents SET asset=?,state='pending',version=version+1 WHERE id=?").run(asset,id);
      store.recordUpload(owner,{id:asset,state:'pending'});
      const next=read(id);
      return db.prepare('SELECT 1 FROM upload_provider_deletions WHERE binding=? AND asset=?').get(binding,asset)?invalidate(next,'removed'):next;
    });},
    complete(owner,id,binding,expectedVersion,url) {return tx(()=>{
      const row=owned(owner,id,binding);
      need(row.version===expectedVersion&&['pending','complete'].includes(row.state)&&!expired(row),'UPLOAD_STALE');
      need(!db.prepare('SELECT 1 FROM upload_provider_deletions WHERE binding=? AND asset=?').get(binding,row.asset),'UPLOAD_RETIRED');
      store.recordUpload(owner,{id:row.asset,state:'complete',verified:true,url});
      db.prepare("UPDATE upload_intents SET state='complete',version=version+1,checked_until=? WHERE id=?").run(Math.min(now()+60000,row.expires),id);
      return read(id);
    });},
    invalidate,
    remove(owner,id,binding) {return invalidate(owned(owner,id,binding),'removed');},
    deleted(binding,asset) {return tx(()=>{
      need(uuid(asset),'UPLOAD_INVALID_ASSET');
      // Persist even an early deletion before the upload POST response arrives.
      need(db.prepare('SELECT 1 FROM upload_provider_deletions WHERE binding=? AND asset=?').get(binding,asset)||
        db.prepare('SELECT count(*) AS n FROM upload_provider_deletions').get().n<10000,'UPLOAD_EVENT_LIMIT');
      db.prepare('INSERT OR IGNORE INTO upload_provider_deletions VALUES (?,?)').run(binding,asset);
      const row=db.prepare('SELECT * FROM upload_intents WHERE binding=? AND asset=?').get(binding,asset);
      if(row)invalidate(row,'removed');
      return {recorded:true,checkout_ready:false};
    });},
    assertUsable(owner,asset) {
      const row=db.prepare('SELECT * FROM upload_intents WHERE asset=?').get(asset);
      if(row)need(row.owner===owner&&row.state==='complete'&&row.expires>now()&&row.checked_until>now(),'UPLOAD_REVALIDATION_REQUIRED');
    },
    forAssets(owner,ids,binding) {
      need(Array.isArray(ids)&&ids.length>0&&ids.length<=1000&&new Set(ids).size===ids.length,'INVALID_COMPLETED_ASSETS');
      return ids.map(asset=>{
        const row=db.prepare('SELECT * FROM upload_intents WHERE asset=?').get(asset);
        need(row&&row.owner===owner&&row.binding===binding,'UPLOAD_INTENT_UNAVAILABLE');return row;
      });
    },
    sweep({restart=false}={}) {return tx(()=>{
      for(const row of db.prepare("SELECT * FROM upload_intents WHERE state NOT IN ('removed','failed')").all())
        if(expired(row)||(restart&&row.state==='sending'))invalidate(row,'failed');
    });},
  };
}
