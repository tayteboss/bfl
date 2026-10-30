import {need} from './config.mjs';
import {preparedPolicy,preparedPolicyReceipt,CLIENT_POLICY_ADMISSION} from '../checkout/prepared-limits.mjs';
import {uuid} from '../uploads/ledger.mjs';

const POLICY='bfl-persistent-staging-client-v1';
const fields=new Set(['owner','id','asset','digest','source','sourceStarted','sourcePending','verifying','cropPending','cropped','removed']);
const samePrincipal=(a,b)=>a&&b&&['owner','verifier','generation'].every(k=>a[k]===b[k]);
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===keys.slice().sort().join(',');
export function installStagingResourceSchema(db){
 db.exec(`CREATE TABLE staging_resource_state(owner TEXT PRIMARY KEY,source_receipt TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL);
 CREATE TABLE staging_upload_custody(intent TEXT PRIMARY KEY,owner TEXT NOT NULL,binding TEXT NOT NULL,asset TEXT UNIQUE,state TEXT NOT NULL,updated INTEGER NOT NULL);`);
}
// The existing jobs and admission tables remain authoritative. In particular a
// crash after job commit but before HTTP response cannot reset a preparation quota.
export function createStagingResourceState({db,store,sourceScope}){
 need(preparedPolicy(sourceScope).clientPolicy===POLICY,'STAGING_RESOURCE_SCOPE');
 const receipt=preparedPolicyReceipt(sourceScope),maximumJobs=preparedPolicy(sourceScope).preparations;
 const ownerPolicy=owner=>need(db.prepare('SELECT 1 FROM resource_admissions WHERE owner=? AND kind=? AND request_hash=?').get(owner,CLIENT_POLICY_ADMISSION,receipt),'STAGING_RESOURCE_SCOPE');
 const jobsFor=owner=>db.prepare('SELECT id,request_key,body FROM jobs WHERE owner=? ORDER BY rowid').all(owner).map(row=>{
  const body=JSON.parse(row.body);
  need(body.id===row.id&&Array.isArray(body.completed_asset_ids)&&Number.isSafeInteger(body.copies),'STAGING_RESOURCE_STATE');
  return {id:row.id,key:row.request_key,selection:JSON.stringify([body.completed_asset_ids.slice().sort(),body.copies])};
 });
 const validate=(owner,value)=>{
  need(exact(value,['version','revision','owner','principal','intents','job','jobKey','jobKeys','jobIds'])&&value.version===1&&value.owner===owner&&
   Number.isSafeInteger(value.revision)&&value.revision>=0&&exact(value.principal,['owner','verifier','generation'])&&value.principal.owner===owner&&
   /^[a-f0-9]{64}$/.test(value.principal.verifier)&&Number.isSafeInteger(value.principal.generation)&&value.principal.generation>0&&
   Array.isArray(value.intents)&&value.intents.length<=1000&&new Set(value.intents.map(row=>row.id)).size===value.intents.length&&
   Array.isArray(value.jobKeys)&&Array.isArray(value.jobIds)&&value.jobKeys.length<=maximumJobs&&value.jobIds.length<=maximumJobs&&value.jobKey===null,'STAGING_RESOURCE_STATE');
  for(const row of value.intents){
   need(row&&typeof row==='object'&&!Array.isArray(row)&&Object.keys(row).every(key=>fields.has(key))&&row.owner===owner&&uuid(row.id),'STAGING_RESOURCE_STATE');
   const intent=store.uploadLedger.read(row.id);
   need(intent?.owner===owner&&(!row.asset||uuid(row.asset)&&row.asset===intent.asset)&&(!row.digest||/^[a-f0-9]{64}$/.test(row.digest)&&row.digest===intent.digest),'STAGING_RESOURCE_STATE');
   for(const key of ['sourceStarted','sourcePending','verifying','cropPending','removed'])need(row[key]===undefined||typeof row[key]==='boolean','STAGING_RESOURCE_STATE');
   if(row.source)need(exact(row.source,['kind','origin','url_sha256','sha256','bytes','mime'])&&row.source.kind==='public_https'&&
    typeof row.source.origin==='string'&&new URL(row.source.origin).origin===row.source.origin&&row.source.origin.startsWith('https://')&&
    /^[a-f0-9]{64}$/.test(row.source.url_sha256)&&/^[a-f0-9]{64}$/.test(row.source.sha256)&&Number.isSafeInteger(row.source.bytes)&&row.source.bytes>0&&
    ['image/png','image/jpeg','image/tiff'].includes(row.source.mime),'STAGING_RESOURCE_STATE');
   // Crop is deliberately unavailable in the accepted persistent MVP. Do not
   // persist arbitrary derivative objects or reinterpret old edited assets.
   need(row.cropped===undefined,'STAGING_RESOURCE_STATE');
  }
  need(Buffer.byteLength(JSON.stringify({...value,job:null,jobKeys:[],jobIds:[]}))<=1048576,'STAGING_RESOURCE_STATE');
  return value;
 };
 const withJobs=(owner,value)=>{
  const jobs=jobsFor(owner);need(jobs.length<=maximumJobs,'STAGING_RESOURCE_STATE');
  return {...value,job:jobs.at(-1)?.id??null,jobKey:null,jobKeys:jobs.map(row=>[row.key,row.selection]),jobIds:jobs.map(row=>row.id)};
 };
 return Object.freeze({
  load(owner){
   ownerPolicy(owner);const row=db.prepare('SELECT * FROM staging_resource_state WHERE owner=?').get(owner);
   if(!row){need(!db.prepare('SELECT 1 FROM upload_intents WHERE owner=?').get(owner)&&!db.prepare('SELECT 1 FROM jobs WHERE owner=?').get(owner),'STAGING_RESOURCE_STATE');return null;}
   need(row.source_receipt===receipt,'STAGING_RESOURCE_SCOPE');
   const value=validate(owner,JSON.parse(row.body));need(value.revision===row.revision,'STAGING_RESOURCE_STATE');
   return structuredClone(withJobs(owner,value));
  },
  save(owner,value){return store.lifecycle.transaction(()=>{
   ownerPolicy(owner);validate(owner,value);
   const row=db.prepare('SELECT * FROM staging_resource_state WHERE owner=?').get(owner);
   need(row?row.source_receipt===receipt&&row.revision===value.revision:value.revision===0,'STAGING_RESOURCE_STALE');
   if(row){const before=JSON.parse(row.body);need(samePrincipal(before.principal,value.principal),'STAGING_RESOURCE_SCOPE');
    for(const old of before.intents){const next=value.intents.find(item=>item.id===old.id);need(next&&(!old.sourceStarted||next.sourceStarted)&&(!old.removed||next.removed)&&(!old.digest||old.digest===next.digest)&&(!old.asset||next.asset===old.asset||next.removed),'STAGING_RESOURCE_STATE');}
   }
   // Jobs are committed by their own immutable ledger, so do not duplicate
   // every job's up-to-1000 asset list in this per-owner upload checkpoint.
   const revision=value.revision+1,body=JSON.stringify({...value,revision,job:null,jobKeys:[],jobIds:[]});
   db.prepare('INSERT INTO staging_resource_state VALUES (?,?,?,?) ON CONFLICT(owner) DO UPDATE SET revision=excluded.revision,body=excluded.body').run(owner,receipt,revision,body);
   return revision;
  });},
 });
}
// Synchronous FULL SQLite commits precede each provider POST/DELETE. Unknown
// sends remain terminal across restart; retaining custody never grants authority.
export function createStagingUploadCustody({db,store,sourceScope,now=Date.now}){
 need(preparedPolicy(sourceScope).clientPolicy===POLICY,'STAGING_CUSTODY_SCOPE');
 const tx=store.lifecycle.transaction,receipt=preparedPolicyReceipt(sourceScope);
 // Receipt ownership remains readable for protective cleanup after revocation.
 // Only start/admitOwner additionally require a live bound resource ticket.
 const own=row=>need(row&&db.prepare('SELECT 1 FROM resource_admissions WHERE owner=? AND kind=? AND request_hash=?').get(row.owner,CLIENT_POLICY_ADMISSION,receipt),'STAGING_CUSTODY_SCOPE');
 const read=id=>db.prepare('SELECT * FROM staging_upload_custody WHERE intent=?').get(id);
 const set=(id,state)=>db.prepare('UPDATE staging_upload_custody SET state=?,updated=? WHERE intent=?').run(state,now(),id);
 const fail=id=>{const row=store.uploadLedger.read(id);own(row);store.uploadLedger.invalidate(row,'failed');};
 const service={
  admitOwner(ticket){store.resourceSessions.assert(ticket);store.checkoutOwner.member(ticket);own(ticket);},
  start(id,binding){return tx(()=>{
   const row=store.uploadLedger.read(id);own(row);store.checkoutOwner.bound(store.resourceSessions.ticketForOwner(row.owner));
   need(row.binding===binding&&row.state==='sending'&&!read(id),'STAGING_CUSTODY_SCOPE');
   // Intent allocation and resource_admissions already enforce the same 1000
   // per-owner ceiling. Retired/deleted custody is never reset or reused.
   need(db.prepare('SELECT count(*) AS n FROM staging_upload_custody WHERE owner=?').get(row.owner).n<1000,'STAGING_CUSTODY_LIMIT');
   db.prepare('INSERT INTO staging_upload_custody VALUES (?,?,?,NULL,?,?)').run(id,row.owner,binding,'sending',now());
  });},
  known(id,binding,asset){return tx(()=>{
   const row=read(id);own(row);need(row.state==='sending'&&row.binding===binding&&uuid(asset),'STAGING_CUSTODY_SCOPE');
   db.prepare("UPDATE staging_upload_custody SET asset=?,state='known',updated=? WHERE intent=?").run(asset,now(),id);
  });},
  failed(id){return tx(()=>{fail(id);const row=read(id);if(row?.state==='sending')set(id,'upload-unknown');else if(row?.state==='known')set(id,'queued');});},
  queue(){return tx(()=>{for(const row of db.prepare("SELECT * FROM staging_upload_custody WHERE state='known'").all()){
   own(row);const intent=store.uploadLedger.read(row.intent);need(intent?.owner===row.owner&&intent.binding===row.binding,'STAGING_CUSTODY_SCOPE');
   if(['failed','removed'].includes(intent.state)||store.lifecycle.retired('owner',row.owner))set(row.intent,'queued');
  }});},
  recover(){return tx(()=>{for(const row of db.prepare("SELECT * FROM staging_upload_custody WHERE state IN ('sending','deleting')").all()){
   own(row);set(row.intent,row.state==='sending'?'upload-unknown':'delete-unknown');fail(row.intent);
  }service.queue();});},
  pending(){service.queue();return db.prepare("SELECT * FROM staging_upload_custody WHERE state='queued'").all();},
  beginDelete(id){return tx(()=>{const row=read(id);own(row);need(row.state==='queued'&&uuid(row.asset),'STAGING_CUSTODY_SCOPE');set(id,'deleting');return row;});},
  finishDelete(id,confirmed){return tx(()=>{const row=read(id);own(row);need(row.state==='deleting'&&typeof confirmed==='boolean','STAGING_CUSTODY_SCOPE');set(id,confirmed?'deleted':'delete-unknown');});},
  counts(){return Object.fromEntries(db.prepare('SELECT state,count(*) AS n FROM staging_upload_custody GROUP BY state').all().map(row=>[row.state,row.n]));},
 };
 return Object.freeze(service);
}
