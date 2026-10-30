import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {assertEngineeringJob} from '../configuration/engineering.mjs';
import {resolveSelection,isFullProductCatalog} from './selection.mjs';
import {jobProperties} from './properties.mjs';
import { freeze, verifyRelease } from '../configuration/config.mjs';
import { normalizeJob, normalizeSize, requireValue } from '../shipping/packing.mjs';
import { createQuoteService } from '../shipping/quote.mjs';
import { createLifecycle } from './lifecycle.mjs';
import {createResourceSessions,UPLOAD_ONLY_PURPOSE,SESSION_ONLY_PURPOSE} from '../backend/resource-session.mjs';
import {createOwnedCartLedger} from '../checkout/owned-cart.mjs';
import {createCartCapabilityLedger} from '../checkout/cart-capability.mjs';
import {createUploadCustody} from '../uploads/custody.mjs';
import {createUploadLedger,installUploadSchema} from '../uploads/ledger.mjs';
import {createRefreshLedger,installRefreshSchema} from '../checkout/refresh-ledger.mjs';
import {createOrderInbox,installOrderInbox} from '../orders/inbox.mjs';
import {createOrderLedger,installOrderSchema} from '../orders/ledger.mjs';
import {createCartBindingLedger,installCartBindingSchema} from '../checkout/cart-binding.mjs';
import {createPreparedLedger} from '../checkout/prepared-ledger.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonical = value => JSON.stringify(Object.entries(value ?? {}).sort(([a],[b])=>a.localeCompare(b)));
const integer = n => Number.isSafeInteger(n) && n > 0 && n <= 10000;
const identifier = s => typeof s === 'string' && /^[a-zA-Z0-9_-]{8,100}$/.test(s);

// Private server storage. No HTTP route writes upload completion or pricing.
// The uploader adapter must verify provider completion AND session ownership before recording.
export function createJobStore(path,{now=Date.now,sessionOnly=false,uploadOnly=false,cartOwner=false,bindingCandidate=false,checkoutOwner=false,persistentSourceScope=null,configureStore}={}) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL;
    PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS uploads (owner TEXT, id TEXT, state TEXT, url TEXT, PRIMARY KEY(owner,id));
    CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, owner TEXT, request_key TEXT, fingerprint TEXT, body TEXT, UNIQUE(owner,request_key));`);
  const lifecycle=createLifecycle(db);
  // Local candidate opt-in only. No runtime option or actual schema9 migration.
  if(bindingCandidate)installCartBindingSchema(db);
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='upload_intents'").get())installUploadSchema(db);
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='cart_refresh_requests'").get())installRefreshSchema(db);
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='order_job_snapshots'").get())installOrderSchema(db);
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='order_inbox'").get())installOrderInbox(db);
  const hasCustody=!!db.prepare("SELECT 1 FROM sqlite_master WHERE name='upload_custody'").get();
  const uploadOwner=owner=>hasCustody&&db.prepare('SELECT purpose FROM resource_sessions WHERE owner=?').get(owner)?.purpose===UPLOAD_ONLY_PURPOSE;
  const invalidate=(id,event,mutate)=>{
    if(!uploadOwner(event.owner))return lifecycle.event(id,event,mutate);
    return lifecycle.transaction(()=>{
      // Immutable purpose plus SQL job exclusion proves no checkout grant can
      // reference these owners. Provider cleanup remains separately durable.
      requireValue(!db.prepare('SELECT 1 FROM jobs WHERE owner=?').get(event.owner),'UPLOAD_AUTHORITY_CONFLICT');
      const kind=event.kind,target=event.asset_id??event.id??'';
      if(lifecycle.retired(kind,event.owner,kind==='owner'?'':target))return {recorded:true,checkout_ready:false};
      mutate();
      db.prepare('UPDATE authority_state SET epoch=epoch+1 WHERE singleton=1').run();
      return {recorded:true,checkout_ready:false};
    });
  };
  const ownerAvailable = owner => requireValue(!lifecycle.retired('owner',owner),'OWNER_REVOKED');
  const readJob=(id,owner)=>{
    const row=db.prepare('SELECT body FROM jobs WHERE id=? AND owner=?').get(id,owner);
    requireValue(row,'JOB_UNAVAILABLE');return freeze(JSON.parse(row.body));
  };
  const store = {
    lifecycle,
    recordUpload(owner, asset) {
      return lifecycle.transaction(()=>{
        requireValue(typeof owner === 'string' && owner && identifier(asset.id) && ['complete','pending','failed','removed'].includes(asset.state), 'INVALID_UPLOAD');
        requireValue(asset.state !== 'complete' || (asset.verified === true && /^https:\/\//.test(asset.url)), 'UNVERIFIED_UPLOAD');
        ownerAvailable(owner);
        const write=()=>db.prepare('INSERT INTO uploads VALUES (?,?,?,?) ON CONFLICT(owner,id) DO UPDATE SET state=excluded.state,url=excluded.url').run(owner,asset.id,asset.state,asset.url ?? '');
        if(asset.state==='complete') {
          requireValue(!lifecycle.retired('upload',owner,asset.id),'UPLOAD_RETIRED');
          const prior=db.prepare('SELECT * FROM uploads WHERE owner=? AND id=?').get(owner,asset.id);
          requireValue(prior?.state!=='complete' || prior.url===asset.url,'UPLOAD_ID_REUSE');
          write(); return {recorded:true,checkout_ready:false};
        }
        const prior=db.prepare('SELECT state FROM uploads WHERE owner=? AND id=?').get(owner,asset.id);
        if(prior?.state==='complete' || asset.state==='removed' || asset.state==='failed' || lifecycle.retired('upload',owner,asset.id)) {
          // Terminal identity; a late completion can never resurrect this asset.
          // The local state change and outbox entry commit together.
          return invalidate(`upload:${hash([owner,asset.id])}`,{kind:'upload',owner,id:asset.id},()=>{
            lifecycle.retire('upload',owner,asset.id); write();
          });
        }
        write();return {recorded:true,checkout_ready:false};
      });
    },
    invalidateUpload(event) {
      requireValue(event.kind==='upload' && typeof event.owner==='string' && event.owner && identifier(event.asset_id) && ['removed','failed'].includes(event.state),'EVENT_SCOPE');
      return lifecycle.transaction(()=>{
        const retire=()=>{
          requireValue(db.prepare('SELECT 1 FROM uploads WHERE owner=? AND id=?').get(event.owner,event.asset_id),'UPLOAD_UNAVAILABLE');
          lifecycle.retire('upload',event.owner,event.asset_id);
          db.prepare('UPDATE uploads SET state=?,url=? WHERE owner=? AND id=?').run(event.state,'',event.owner,event.asset_id);
        };
        // A selection absent from every immutable job cannot have a checkout
        // grant. Retire it atomically without fencing unrelated queued files.
        // Job save checks the same tombstone in this SQLite transaction domain.
        const referenced=db.prepare("SELECT 1 FROM jobs, json_each(jobs.body,'$.completed_asset_ids') a WHERE jobs.owner=? AND a.value=? LIMIT 1").get(event.owner,event.asset_id);
        if(checkoutOwner&&!referenced){retire();return {recorded:true,checkout_ready:false};}
        return invalidate(event.id,event,retire);
      });
    },
    uploads(owner, ids) {
      ownerAvailable(owner);
      requireValue(Array.isArray(ids) && ids.length > 0 && ids.length <= 1000 && ids.every(identifier) && new Set(ids).size === ids.length, 'INVALID_COMPLETED_ASSETS');
      return ids.map(id => {
        store.uploadLedger.assertUsable(owner,id);
        const row = db.prepare('SELECT * FROM uploads WHERE owner=? AND id=?').get(owner,id);
        requireValue(row?.state === 'complete', 'UPLOAD_UNAVAILABLE');
        return {id:row.id,url:row.url};
      });
    },
    get(id, owner) {
      ownerAvailable(owner);
      requireValue(!lifecycle.retired('job',owner,id),'JOB_REVOKED');
      return readJob(id,owner);
    },
    getForRevocation:readJob,
    save(owner, key, fingerprint, job, sources) {return lifecycle.transaction(()=>{
      ownerAvailable(owner);
      if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='resource_sessions'").get())
        requireValue(![UPLOAD_ONLY_PURPOSE,SESSION_ONLY_PURPOSE].includes(db.prepare('SELECT purpose FROM resource_sessions WHERE owner=?').get(owner)?.purpose),'UPLOAD_ONLY');
      requireValue(job.completed_asset_ids.every(id=>!lifecycle.retired('upload',owner,id)),'UPLOAD_UNAVAILABLE');
      const inserted=db.prepare('INSERT OR IGNORE INTO jobs VALUES (?,?,?,?,?)').run(job.id,owner,key,fingerprint,JSON.stringify(job));
      if(inserted.changes&&sources)store.orders.capture(job,sources.release,sources.catalog,sources.sourceScope);
      const row = db.prepare('SELECT * FROM jobs WHERE owner=? AND request_key=?').get(owner,key);
      requireValue(row?.fingerprint === fingerprint, 'IDEMPOTENCY_CONFLICT');
      return freeze(JSON.parse(row.body));
    });},
    // Internal authenticated event receiver only. Ownership is checked again
    // inside the transaction; job bodies/revisions are never edited or deleted.
    revoke(event) {
      requireValue(['job','owner','order'].includes(event.kind) && typeof event.owner==='string' && event.owner,'EVENT_SCOPE');
      return invalidate(event.id,event,()=>{
        if(event.kind==='owner')lifecycle.retire('owner',event.owner);
        else for(const reference of event.references) {
          const row=db.prepare('SELECT body FROM jobs WHERE id=? AND owner=?').get(reference.id,event.owner);
          requireValue(row && JSON.parse(row.body).revision===reference.revision,'JOB_UNAVAILABLE');
          lifecycle.retire('job',event.owner,reference.id);
        }
      });
    },
    close() { db.close(); },
  };
  store.uploadLedger=createUploadLedger(db,store,now);
  store.cartRefresh=createRefreshLedger(db,lifecycle);
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='cart_prepared_jobs'").get())store.preparedCart=createPreparedLedger(db,lifecycle,{now});
  if(bindingCandidate||checkoutOwner)store.cartBinding=createCartBindingLedger(db,lifecycle);
  store.orders=createOrderLedger(db,store);
  store.orderInbox=createOrderInbox(db,store,now);
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='resource_sessions'").get())
    store.resourceSessions=createResourceSessions(db,lifecycle,now,{sessionOnly,uploadOnly,cartOwner,checkoutOwner,persistentSourceScope,retireUploadOwner:owner=>{
      invalidate('upload-owner:'+owner,{kind:'owner',owner},()=>lifecycle.retire('owner',owner));
      store.uploadCustody.retire(owner);
    }});
  if(hasCustody)store.uploadCustody=createUploadCustody(db,store,now);
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='cart_capability_attempts'").get())store.cartCapability=createCartCapabilityLedger(db,lifecycle);
  if(cartOwner)store.ownedCart=createOwnedCartLedger(db,lifecycle,store.resourceSessions);
  if(checkoutOwner){
    store.checkoutCapability=createCartCapabilityLedger(db,lifecycle,{checkout:true});
    store.checkoutOwner=createOwnedCartLedger(db,lifecycle,store.resourceSessions,{checkout:true});
  }
  if(configureStore)try{configureStore(store,db);}catch(error){db.close();throw error;}
  return store;
}

// An opaque signed reference identifies an immutable server record, never client price/spec data.
export function createJobService({store, loader, loadCatalog, secret, checkoutProjection, validateUploads, resolveFiles, sourceScope, beforeSave}) {
  requireValue(store && typeof loader?.load === 'function' && typeof loadCatalog === 'function' && typeof secret === 'string' && secret.length >= 32, 'MISSING_SERVER_DEPENDENCY');
  const sign = job => createHmac('sha256',secret).update(`${job.id}:${job.revision}:${job.config_version}`).digest('hex');
  const ownedAssets=(owner,ids,service)=>{
    if(service==='darkroom'){
      requireValue(Array.isArray(ids)&&ids.length===0,'INVALID_COMPLETED_ASSETS');
      return [];
    }
    return store.uploads(owner,ids);
  };
  const check = async (owner, reference, validateConfig = true) => {
    requireValue(typeof owner === 'string' && owner.length > 0 && identifier(reference?.id) && /^[a-f0-9]{64}$/.test(reference?.signature), 'UNAUTHENTICATED_JOB');
    const job = store.get(reference.id,owner);
    if(sourceScope)assertEngineeringJob(sourceScope,owner,job);
    requireValue(timingSafeEqual(Buffer.from(sign(job),'hex'),Buffer.from(reference.signature,'hex')), 'UNAUTHENTICATED_JOB');
    requireValue(reference.revision === job.revision && reference.config_version === job.config_version, 'JOB_REVISION_MISMATCH');
    if (validateConfig) {
      const release=verifyRelease(await loader.load({expectedVersion:job.config_version}),{sourceScope});
      requireValue(release.version === job.config_version && release.sha256 === job.config_sha256, 'VERSION_MISMATCH');
    }
    if(validateUploads&&job.service!=='darkroom')await validateUploads(owner,job.completed_asset_ids);
    ownedAssets(owner,job.completed_asset_ids,job.service); // Removed/failed assets revoke reuse.
    return job;
  };
  const service = {
    authorityLifecycle: store.lifecycle,
    verifyRevocation(owner,reference) {
      requireValue(typeof owner==='string' && owner && identifier(reference?.id) && /^[a-f0-9]{64}$/.test(reference?.signature),'UNAUTHENTICATED_JOB');
      const job=store.getForRevocation(reference.id,owner);
      requireValue(timingSafeEqual(Buffer.from(sign(job),'hex'),Buffer.from(reference.signature,'hex')),'UNAUTHENTICATED_JOB');
      requireValue(reference.revision===job.revision && reference.config_version===job.config_version,'JOB_REVISION_MISMATCH');
      return job;
    },
    async prepare(owner, input) {
      requireValue(typeof owner === 'string' && owner.length > 0, 'UNAUTHENTICATED_JOB');
      requireValue(identifier(input?.request_key) && integer(input.copies), 'INVALID_JOB');
      const release=verifyRelease(await loader.load(),{sourceScope});
      // Exact catalog rows are server-loaded approved prices, never DOM data-price or an asset JSON fallback.
      const catalog=await loadCatalog();
      requireValue(catalog?.currency === 'USD' && typeof catalog.version === 'string' && catalog.version.length > 0 && catalog.store === release.config.store && Array.isArray(catalog.rows), 'PRICE_UNAVAILABLE');
      requireValue(Array.isArray(input.asset_ids),'INVALID_COMPLETED_ASSETS');
      const selected=resolveSelection(catalog,input,{completedFileCount:input.asset_ids.length});
      if(validateUploads&&selected.spec.service!=='darkroom')await validateUploads(owner,input.asset_ids);
      const assets=ownedAssets(owner,input.asset_ids,selected.spec.service);
      const unit=selected.unit_price_cents;
      const spec={...selected.spec,completed_asset_ids:assets.map(a=>a.id).sort(),
        ...(isFullProductCatalog(catalog)?{billing_basis:selected.billing_basis}:{})};
      const files=resolveFiles?await resolveFiles(owner,assets):assets;
      requireValue(files.length===assets.length&&files.every((f,i)=>f.id===assets[i].id),'INVALID_COMPLETED_ASSETS');
      const fingerprint=hash(files.some(f=>f.crop||f.source)?{...spec,files}:spec);
      const body={...spec,id:randomUUID(),config_version:release.version,config_sha256:release.sha256,
        price_version:catalog.version,unit_price_cents:unit,variant_id:selected.variant_id,files:files.map(a=>({...a})),currency:'USD'};
      if(validateUploads&&body.service!=='darkroom')await validateUploads(owner,body.completed_asset_ids);
      const job=store.lifecycle.transaction(()=>{
        ownedAssets(owner,body.completed_asset_ids,body.service); // Recheck retirement after async catalog/file reads, before admission.
        beforeSave?.(owner,input,body);
        if(sourceScope)assertEngineeringJob(sourceScope,owner,body);
        body.revision=hash(body);
        return store.save(owner,input.request_key,fingerprint,body,{release,catalog,sourceScope});
      });
      await check(owner,{id:job.id,revision:job.revision,config_version:job.config_version,signature:sign(job)});
      const reference={id:job.id,revision:job.revision,config_version:job.config_version,signature:sign(job)};
      // F06 must publish and verify Function-accessible authority before any Shopify cart addition.
      const ready=typeof checkoutProjection === 'function' && await checkoutProjection(job) === true;
      return freeze({reference,checkout_ready:ready,unit_price_cents:job.unit_price_cents,file_count:job.completed_asset_ids.length,
        item:{id:job.variant_id,quantity:job.copies,properties:jobProperties(job,reference,{includeUploads:true})}});
    },
    resolve:(owner,reference)=>check(owner,reference),
    // Server-only batch resolution against the projector's single fresh snapshot.
    // This does not publish authority or make the F05 form checkout-ready.
    async resolveForCheckout(owner,references,release) {
      verifyRelease(release,{sourceScope});
      const jobs=await Promise.all(references.map(reference=>check(owner,reference,false)));
      requireValue(jobs.every(job=>job.config_version===release.version && job.config_sha256===release.sha256),'VERSION_MISMATCH');
      return jobs;
    },
    // resolveCart must authenticate a current cart read; copies and actual groups never come from the request body.
    quoteService({resolveCart,provider}) {
      requireValue(!sourceScope,'ENGINEERING_QUOTE_DISABLED');
      requireValue(typeof resolveCart==='function','MISSING_SERVER_DEPENDENCY');
      return createQuoteService({loader,provider,resolveRequest:async (request,{signal})=>{
        const cart=await resolveCart(request,{signal});
        requireValue(typeof cart?.owner==='string' && Array.isArray(cart.lines) && cart.lines.length>0,'UNVERIFIED_CART');
        const jobs=await Promise.all(cart.lines.map(async line=>{
          requireValue(integer(line.quantity),'INVALID_COPIES');
          const job=await check(cart.owner,line.reference,false);
          requireValue(String(line.variant_id)===job.variant_id,'VARIANT_MISMATCH');
          return {...job,copies:line.quantity};
        }));
        return {currency:'USD',jobs,groups:cart.groups};
      }});
    },
  };
  return service;
}
