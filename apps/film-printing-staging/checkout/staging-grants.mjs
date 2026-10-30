import {randomBytes} from 'node:crypto';
import {need} from '../backend/config.mjs';
import {canonical,freeze} from '../configuration/config.mjs';
import {cartHash} from './storefront.mjs';
import {decodeAuthority,LAB_VARIANT_SCHEMA,MAX_GRANTS,MAX_LINES} from './authority.js';
import {serializeAuthority} from './projector.mjs';

// Additive service-only storage. Existing diagnostic owners and issued deadlines
// never acquire this membership. Versions retain every original deadline/grant.
export function installStagingGrantSchema(db){
 db.exec(`CREATE TABLE staging_grant_versions (
  owner TEXT NOT NULL, revision INTEGER NOT NULL, original_until INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active','retired','suspended')),
  grant_value TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(owner,revision));
 CREATE TRIGGER staging_grants_retained_update BEFORE UPDATE ON staging_grant_versions
 BEGIN SELECT RAISE(ABORT,'STAGING_GRANT_HISTORY_RETAINED'); END;
 CREATE TRIGGER staging_grants_retained_delete BEFORE DELETE ON staging_grant_versions
 BEGIN SELECT RAISE(ABORT,'STAGING_GRANT_HISTORY_RETAINED'); END;
 CREATE TRIGGER staging_grants_original_deadline BEFORE INSERT ON staging_grant_versions
 WHEN EXISTS(SELECT 1 FROM staging_grant_versions WHERE owner=NEW.owner AND original_until<>NEW.original_until)
 BEGIN SELECT RAISE(ABORT,'STAGING_OWNER_DEADLINE_IMMUTABLE'); END;
 CREATE TABLE staging_grant_publication (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1), source TEXT NOT NULL,
  revision INTEGER NOT NULL, published_value TEXT, pending TEXT);`);
}
const sources=a=>Object.fromEntries(['config_version','config_sha256','price_version'].map(key=>[key,a?.[key]]));
const equal=(a,b)=>canonical(a)===canonical(b);
const cleanState=lifecycle=>{const state=lifecycle.state();need(!state.pending&&!state.operation,'STAGING_AUTHORITY_PENDING');return state;};

// Trusted in-process composition supplies validation and projector callbacks.
// No HTTP body may choose a source, original deadline, owner or prepared grant.
// The one global Function envelope expires at/before the earliest surviving
// owner's original deadline; replacing that envelope never changes those dates.
export function createStagingGrantPublication({db,lifecycle,admin,source,validateOwner,deadlineFor,armPublication,
 now=Date.now,maxOwnerMs=86400000,enabled=false,permit=()=>false}){
 need(db&&lifecycle&&typeof admin?.read==='function'&&typeof admin.publish==='function'&&
  typeof validateOwner==='function'&&typeof deadlineFor==='function'&&typeof armPublication==='function'&&
  Number.isSafeInteger(maxOwnerMs)&&maxOwnerMs>0,'STAGING_PUBLICATION_REQUIRED');
 const sourceValue=canonical(source);
 need(Object.keys(source??{}).sort().join(',')==='config_sha256,config_version,price_version'&&
  /^f03-[a-f0-9]{24}$/.test(source.config_version)&&/^[a-f0-9]{64}$/.test(source.config_sha256)&&typeof source.price_version==='string','STAGING_SOURCE_CHANGED');
 lifecycle.transaction(()=>{
  const saved=db.prepare('SELECT source FROM staging_grant_publication WHERE singleton=1').get();
  if(saved)need(saved.source===sourceValue,'STAGING_SOURCE_CHANGED');
  else db.prepare('INSERT INTO staging_grant_publication VALUES (1,?,0,NULL,NULL)').run(sourceValue);
 });
 let running=Promise.resolve();
 const serial=work=>{const next=running.then(work,work);running=next.catch(()=>{});return next;};
 const gate=()=>need(enabled===true&&permit(),'STAGING_SERVICE_CLOSED');
 const state=()=>db.prepare('SELECT * FROM staging_grant_publication WHERE singleton=1').get();
 const heads=()=>db.prepare(`SELECT v.* FROM staging_grant_versions v JOIN
  (SELECT owner,MAX(revision) AS revision FROM staging_grant_versions GROUP BY owner) h
  ON v.owner=h.owner AND v.revision=h.revision ORDER BY v.owner`).all().map(row=>({...row,grant:JSON.parse(row.grant_value)}));
 const contextAuthority=context=>{
  const a=decodeAuthority(context?.field?.value);
  const saved=state(),initial=saved.published_value===null||decodeAuthority(saved.published_value)?.schema===1;
  need(a&&(a.schema===LAB_VARIANT_SCHEMA||initial&&a.schema===1&&a.grants.length===0)&&equal(sources(a),source)&&
   context.release?.version===source.config_version&&context.release.sha256===source.config_sha256&&context.catalog?.version===source.price_version,'STAGING_SOURCE_CHANGED');
  return a;
 };
 const assertCurrent=context=>{
  gate();cleanState(lifecycle);const saved=state();need(!saved.pending,'STAGING_PUBLICATION_UNCERTAIN');
  const a=contextAuthority(context);
  if(saved.published_value===null)need(a.grants.length===0,'STAGING_AUTHORITY_CHANGED');
  else need(equal(a,decodeAuthority(saved.published_value)),'STAGING_AUTHORITY_CHANGED');
  return a;
 };
 const append=entry=>{
  const prior=db.prepare('SELECT MAX(revision) AS revision FROM staging_grant_versions WHERE owner=?').get(entry.owner).revision??0;
  db.prepare('INSERT INTO staging_grant_versions VALUES (?,?,?,?,?,?)').run(entry.owner,prior+1,entry.original_until,entry.state,canonical(entry.grant),now());
 };
 const checked=async(entries,context,guard)=>{
  for(const entry of entries){
   gate();guard();need(Number.isSafeInteger(entry.original_until)&&entry.original_until>now()&&entry.grant.owner===cartHash(entry.owner),'STAGING_OWNER_EXPIRED');
   need(await validateOwner(freeze({owner:entry.owner,originalUntil:entry.original_until,grant:structuredClone(entry.grant)}),context)===true,'STAGING_OWNER_UNVERIFIED');
   gate();guard();need(entry.original_until>now(),'STAGING_OWNER_EXPIRED');
  }
 };
 const commit=async({context,base,entries,changes,ticket,beforeReserve,guard=()=>{},guardPublication=()=>{}})=>{
  assertCurrent(context);guard();
  need(entries.length<=MAX_GRANTS&&entries.reduce((sum,row)=>sum+row.grant.lines.length,0)<=MAX_LINES,'STAGING_GRANT_CAPACITY');
  need(new Set(entries.map(row=>row.grant.cart)).size===entries.length&&new Set(entries.map(row=>row.grant.binding)).size===entries.length,'STAGING_CART_CONFLICT');
  await checked(entries,context,guard);cleanState(lifecycle);
  const earliest=entries.length?Math.min(...entries.map(row=>row.original_until)):null;
  const lease=earliest===null?base.lease:deadlineFor(earliest,now(),context.timezone);
  need(lease&&Number.isSafeInteger(lease.expires_at)&&typeof lease.deadline==='string'&&
   (earliest===null||lease.expires_at>now()&&lease.expires_at<=earliest),'STAGING_LEASE_INVALID');
  const authority={...base,valid_on:context.shopDate,lease:{token:randomBytes(32).toString('hex'),deadline:lease.deadline,expires_at:lease.expires_at},grants:entries.map(row=>row.grant)};
  const value=serializeAuthority(authority);need(decodeAuthority(value),'STAGING_GRANT_CAPACITY');
  if(beforeReserve)await beforeReserve();gate();guard();cleanState(lifecycle);
  ticket??=lifecycle.beginPreparation();lifecycle.stage(ticket,value);
  const prepared=freeze({authority,value,context,ticket,checkout_ready:false});
  const previous=state(),pending=canonical({revision:previous.revision+1,value,changes});
  lifecycle.transaction(()=>{
   gate();guard();cleanState(lifecycle);const current=state();
   need(current.revision===previous.revision&&!current.pending&&current.published_value===previous.published_value,'STAGING_AUTHORITY_CHANGED');
   db.prepare('UPDATE staging_grant_publication SET pending=? WHERE singleton=1').run(pending);
  });
  // From reservation onward, any rejection stays durable and blocks a resend.
  // Even a crash after remote success requires observation/reconciliation first.
  armPublication(prepared,op=>{gate();guardPublication(op);need(state().pending===pending,'STAGING_PUBLICATION_UNCERTAIN');});
  await admin.publish(prepared);gate();guard();
  const after=await admin.read();gate();guard();
  need(equal(contextAuthority(after),authority),'STAGING_AUTHORITY_CHANGED');
  await checked(entries,after,guard);
  lifecycle.transaction(()=>{
   gate();guard();cleanState(lifecycle);need(state().pending===pending,'STAGING_PUBLICATION_UNCERTAIN');
   for(const entry of changes)append(entry);
   db.prepare('UPDATE staging_grant_publication SET revision=?,published_value=?,pending=NULL WHERE singleton=1').run(previous.revision+1,value);
  });
  return freeze({published:true,authority,expires_at:lease.expires_at,checkout_ready:false});
 };
 const live=()=>heads().filter(row=>row.state==='active');
 const mutation=({removeOwner,suspend=false,prepare,beforeReserve,owner,originalUntil,guard=()=>{},guardPublication=()=>{}}={})=>serial(async()=>{
  gate();guard();cleanState(lifecycle);need(!state().pending,'STAGING_PUBLICATION_UNCERTAIN');
  const context=await admin.read();guard();const base=assertCurrent(context),all=live(),entries=[],changes=[];
  for(const row of all){
   if(row.original_until<=now()||row.owner===removeOwner)changes.push({...row,state:row.original_until>now()&&suspend?'suspended':'retired'});
   else entries.push(row);
  }
  let ticket,projectionBase=base;
  if(prepare){
   need(typeof owner==='string'&&owner.length>0&&owner.length<=200&&Number.isSafeInteger(originalUntil)&&originalUntil>now()&&originalUntil<=now()+maxOwnerMs,'STAGING_OWNER_INVALID');
   const prior=heads().find(row=>row.owner===owner);
   need(!prior||prior.original_until===originalUntil&&prior.state!=='retired','STAGING_OWNER_CHANGED');
   const prepared=await prepare(context);gate();guard();
   const a=decodeAuthority(prepared?.value);
   need(a?.schema===LAB_VARIANT_SCHEMA&&equal(sources(a),source)&&a.grants.length===1&&
    a.grants[0].owner===cartHash(owner)&&prepared.context===context&&a.lease.expires_at<=originalUntil,'STAGING_PREPARATION_INVALID');
   const row={owner,original_until:originalUntil,grant:a.grants[0],state:'active'};
   if(prior)need(prior.grant.cart===row.grant.cart&&prior.grant.binding===row.grant.binding&&prior.grant.customer_id===row.grant.customer_id,'STAGING_OWNER_CHANGED');
   const index=entries.findIndex(entry=>entry.owner===owner);if(index>=0)entries.splice(index,1);
   entries.push(row);changes.push(row);ticket=prepared.ticket;projectionBase=a;
  }
  if(!changes.length)return freeze({published:false,checkout_ready:false});
  return commit({context,base:projectionBase,entries:entries.sort((a,b)=>a.owner<b.owner?-1:a.owner>b.owner?1:0),changes,ticket,beforeReserve,guard,guardPublication});
 });
 return Object.freeze({
  update(input){need(typeof input?.prepare==='function','STAGING_PREPARATION_REQUIRED');return mutation(input);},
  retire(owner,options={}){need(typeof owner==='string'&&owner.length>0,'STAGING_OWNER_INVALID');return mutation({...options,removeOwner:owner});},
  release(owner,options={}){need(typeof owner==='string'&&owner.length>0,'STAGING_OWNER_INVALID');return mutation({...options,removeOwner:owner,suspend:true});},
  prune(options={}){return mutation(options);},
  async verify(){return serial(async()=>{gate();cleanState(lifecycle);const context=await admin.read();const a=assertCurrent(context),entries=live();need(equal(a.grants,entries.map(row=>row.grant)),'STAGING_AUTHORITY_CHANGED');await checked(entries,context,()=>{});return {verified:true,checkout_ready:false};});},
  // Known owner/job invalidations use the existing whole-projection CAS clear,
  // then independently verify and restore only exact unaffected grants. Unknown
  // publication outcomes never enter this path or replay their pending value.
  reconcileKnown({excludeOwners=[],excludeJobs=[],authorizeInvalidations,afterClear,guard=()=>{},guardPublication=()=>{}}={}){return serial(async()=>{
   gate();need(!state().pending&&!lifecycle.state().operation,'STAGING_PUBLICATION_UNCERTAIN');
   need(Array.isArray(excludeOwners)&&Array.isArray(excludeJobs)&&typeof authorizeInvalidations==='function','STAGING_INVALIDATION_REQUIRED');
   const events=lifecycle.pendingEvents();need(events.length>0&&await authorizeInvalidations(events)===true,'STAGING_INVALIDATION_UNPROVEN');gate();
   need(equal(events,lifecycle.pendingEvents()),'STAGING_INVALIDATION_CHANGED');
   const previous=live(),saved=state();await admin.reconcile();gate();cleanState(lifecycle);
   const context=await admin.read(),base=contextAuthority(context);need(base.grants.length===0,'STAGING_RECOVERY_REQUIRED');
   const entries=[],changes=[];
   for(const row of previous){
    const lines=row.grant.lines.filter(line=>!excludeJobs.includes(line.claims.job));
    const retained=row.original_until>now()&&!excludeOwners.includes(row.owner)&&lines.length>0;
    const next={...row,grant:{...row.grant,lines:retained?lines:row.grant.lines},state:retained?'active':row.original_until>now()&&!excludeOwners.includes(row.owner)?'suspended':'retired'};
    changes.push(next);if(retained)entries.push(next);
   }
   lifecycle.transaction(()=>{
    cleanState(lifecycle);need(state().revision===saved.revision&&!state().pending,'STAGING_AUTHORITY_CHANGED');
    for(const row of previous)append({...row,state:row.original_until>now()?'suspended':'retired'});
    db.prepare('UPDATE staging_grant_publication SET revision=revision+1,published_value=? WHERE singleton=1').run(serializeAuthority(base));
   });
   // Old request-epoch guards cannot survive recovery. The caller's guard here
   // must reauthenticate the same principal, never rebase the old proof ticket.
   if(afterClear)await afterClear();gate();guard();
   if(!entries.length){lifecycle.transaction(()=>{cleanState(lifecycle);for(const row of changes)append(row);});return freeze({published:false,reconciled:true,checkout_ready:false});}
   return commit({context,base,entries,changes,guard,guardPublication});
  });},
  // Called only AFTER ordinary CAS recovery has proven EMPTY. This does not
  // authorize any retained cart; each suspended owner needs its own new proof.
  recoverCleared(){return serial(async()=>{
   gate();cleanState(lifecycle);const context=await admin.read(),a=contextAuthority(context);need(a.grants.length===0,'STAGING_RECOVERY_REQUIRED');
   lifecycle.transaction(()=>{gate();cleanState(lifecycle);const saved=state(),pending=saved.pending?JSON.parse(saved.pending):null;
    const retained=new Map(live().map(row=>[row.owner,row]));
    for(const row of pending?.changes??[])if(row.state==='active')retained.set(row.owner,row);
    for(const row of retained.values())append({...row,state:row.original_until<=now()?'retired':'suspended'});
    db.prepare('UPDATE staging_grant_publication SET revision=revision+1,published_value=?,pending=NULL WHERE singleton=1').run(serializeAuthority(a));
   });return {reconciled:true,suspended:true,checkout_ready:false};
  });},
  authority(){const saved=state();need(!saved.pending,'STAGING_PUBLICATION_UNCERTAIN');return saved.published_value===null?null:freeze(decodeAuthority(saved.published_value));},
  owned(owner){const row=heads().find(entry=>entry.owner===owner);return row?freeze({owner:row.owner,originalUntil:row.original_until,state:row.state,grant:structuredClone(row.grant)}):null;},
  status(){const saved=state();return {revision:saved.revision,uncertain:saved.pending!==null,owners:live().length,lines:live().reduce((n,row)=>n+row.grant.lines.length,0),checkout_ready:false};},
 });
}
