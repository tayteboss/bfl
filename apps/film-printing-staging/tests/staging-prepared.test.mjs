import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomBytes,randomUUID} from 'node:crypto';
import {configuration} from '../../../fixtures/film-printing/f06p-composition/rig.mjs';
import {migrateCheckoutComposition,migratePreparedCart,openDatabase} from '../backend/storage.mjs';
import {preparePersistentStagingSources,createPersistentStagingScope} from '../configuration/engineering.mjs';
import {verifyRelease} from '../configuration/config.mjs';
import {installStagingCartSchema,createStagingCartLedgers} from '../checkout/staging-cart.mjs';
import {installStagingGrantSchema,createStagingGrantPublication} from '../checkout/staging-grants.mjs';
import {installStagingPreparedSchema,createStagingPreparedPublication} from '../checkout/staging-prepared-publication.mjs';
import {createEligibilityProjector} from '../checkout/eligibility-projector.mjs';
import {decodeCatalog} from '../checkout/shopify.mjs';
import {emptyAuthority,serializeAuthority} from '../checkout/projector.mjs';
import {leaseDeadline} from '../checkout/lease.mjs';
import {resolveSelection} from '../jobs/selection.mjs';
import {quantitySignature} from '../checkout/quantity-signature.js';
import {STOREFRONT_ORIGIN} from '../backend/storefront-session.mjs';
import {STORE,APP,CLIENT} from '../configuration/schema.mjs';
import {SHOP,INSTALLATION} from '../backend/config.mjs';
const identity={shop:{id:SHOP,myshopifyDomain:STORE},currentAppInstallation:{id:INSTALLATION,app:{id:APP,apiKey:CLIENT}}};
const hex=n=>String(n).repeat(64);
function setup(t){
 const config=configuration(t);migrateCheckoutComposition(config);migratePreparedCart(config);const clock={time:1793332800000};
 const read=name=>JSON.parse(readFileSync(new URL('../../../fixtures/film-printing/full-product-lab-routing-20261030/'+name,import.meta.url)));
 const source=preparePersistentStagingSources({config:read('engineering-config-proposal.json'),catalog:read('engineering-catalog-proposal.json'),issuedAt:clock.time});
 const sourceScope=createPersistentStagingScope({...source,identity,now:()=>clock.time}),release=verifyRelease(JSON.parse(source.releaseValue),{sourceScope}),catalog=decodeCatalog(source.catalogValue);
 let db;let h=openDatabase(config,{resourceSessions:true,checkoutOwner:true,preparedCart:true,persistentSourceScope:sourceScope,now:()=>clock.time,configureStore(store,d){db=d;installStagingCartSchema(db);installStagingGrantSchema(db);installStagingPreparedSchema(db);Object.assign(store,createStagingCartLedgers({db,store,sourceScope,now:()=>clock.time}));}});config.localClosers.push(h.close);
 let store=h.store,s=store.resourceSessions;const proof=()=>({id:randomBytes(32).toString('base64url'),observedAt:clock.time,customerId:null}),request=token=>({headers:{origin:STOREFRONT_ORIGIN,authorization:'Bearer '+token}});
 let remote={...emptyAuthority(release,catalog,'2026-10-30',{sourceScope}),schema:5,lease:{token:hex(9),deadline:'2026-10-30T00:00:00',expires_at:clock.time}},version=0,armed,armedGuard,publishes=0,fail=false;
 const context=()=>({release,catalog,shopDate:'2026-10-30',timezone:'UTC',field:{value:serializeAuthority(remote),compareDigest:String(version)}});
 const admin={read:async()=>context(),async reconcile(){const op=store.lifecycle.startRecovery();remote={...remote,grants:[]};version++;store.lifecycle.finish(op);},async publish(prepared){assert.equal(armed,prepared);const op=store.lifecycle.startPublication(prepared.ticket,prepared.value);armedGuard(op);publishes++;remote=JSON.parse(prepared.value);version++;if(fail)throw Error('lost');store.lifecycle.finish(op);}};
 const jobs={authorityLifecycle:store.lifecycle,async resolveForCheckout(owner,references){return references.map(r=>{const row=db.prepare('SELECT body FROM jobs WHERE owner=? AND id=?').get(owner,r.id);assert.ok(row);const job=JSON.parse(row.body);assert.equal(job.revision,r.revision);assert.equal(job.config_version,r.config_version);return job;});}};
 const registryOptions={db,lifecycle:store.lifecycle,admin,source:{config_version:release.version,config_sha256:release.sha256,price_version:catalog.version},validateOwner:async()=>true,deadlineFor:(expiry,now,timezone)=>leaseDeadline(expiry,now,timezone,{sourceScope}),armPublication(p,g){armed=p;armedGuard=g;},now:()=>clock.time,enabled:true,permit:()=>true};
 let registry=createStagingGrantPublication(registryOptions),publisher;
 const makePublisher=()=>createStagingPreparedPublication({db,store,jobs,admin,registry,prepareAuthority:createEligibilityProjector({jobs,sourceScope}).prepare,sourceScope,now:()=>clock.time,enabled:true,permit:()=>true});publisher=makePublisher();
 const client=n=>{
  const receipt=s.issue(proof(),{ttlMs:86400000,sourceScope}),token=receipt.token;let ticket=s.authenticate(request(token));
  const id='gid://shopify/Cart/persistent-'+n+'?key=synthetic-key-'+n,a=store.checkoutCapability.reserve({ticket,cart_id:id,proofId:randomBytes(32).toString('base64url'),created:clock.time,sealed:'test-custody'});store.checkoutOwner.reserve(ticket,a);store.checkoutCapability.sending(a,'snapshot');store.checkoutOwner.complete(ticket,a);store.checkoutCapability.finish(a,'capability_only');
  const cart={id,store:STORE,owner:ticket.owner,binding_id:a,customer_id:null,complete:true,lines:[],updated_at:'now'},marker=store.cartBinding.reserve(cart),epoch=store.cartBinding.sending(cart,marker);store.cartBinding.confirm(cart,marker,epoch);
  const input=()=>{ticket=s.authenticate(request(token));return {resourceTicket:ticket,cart:structuredClone(cart),marker,readCurrent:async()=>structuredClone(cart),guard:()=>s.assert(ticket),guardPublication:op=>store.lifecycle.assertOperation(op)};};
  let generation=0;
  const prepare=async()=>{
   const selected=resolveSelection(catalog,{service:'Darkroom Prints',size:'8” × 10”',paper:'RC Matte',lab:'Chicago',copies:1,message:'',options:{Process:'Color',Borders:'Borderless (Edge-to-edge)',Turnaround:'Standard (4-5 days)','Scanning Options':'No',Negatives:'Mail In'}},{completedFileCount:0});
   const id='job_'+randomUUID().replaceAll('-',''),job={...selected.spec,id,revision:hex(1),config_version:release.version,price_version:catalog.version,variant_id:selected.variant_id,billing_basis:selected.billing_basis,unit_price_cents:selected.unit_price_cents,completed_asset_ids:[],files:[],copies:1};
   db.prepare('INSERT INTO jobs VALUES (?,?,?,?,?)').run(id,cart.owner,'request-'+id,hex(3),JSON.stringify(job));const reference={id,revision:job.revision,config_version:release.version,signature:hex(2)};
   return publisher.eligible({...input(),reference,generation:++generation});
  };
  const add=p=>{cart.lines.push({id:'gid://shopify/CartLine/'+p.reference.id,variant_id:'gid://shopify/ProductVariant/'+p.item.id,product_id:'gid://shopify/Product/15620086005871',quantity:p.item.quantity,properties:{...p.item.properties,_bfl_signature:quantitySignature(p.reference.signature,p.item.quantity)},reference:p.reference,selling_plan:false,subtotal_cents:p.unit_price_cents*p.item.quantity});return publisher.assertResume(input().resourceTicket,cart,marker,{kind:'add',job:p.reference.id,operation_id:p.reservation.operation_id,quantity:p.item.quantity});};
  return {cart,marker,input,prepare,add,get ticket(){return input().resourceTicket;}};
 };
 return {get db(){return db;},get store(){return store;},clock,client,get publisher(){return publisher;},get registry(){return registry;},get remote(){return remote;},get publishes(){return publishes;},set fail(v){fail=v;},restart(reopen=false){if(reopen){h.close();h=openDatabase(config,{resourceSessions:true,checkoutOwner:true,preparedCart:true,persistentSourceScope:sourceScope,now:()=>clock.time,configureStore(next,d){db=d;Object.assign(next,createStagingCartLedgers({db,store:next,sourceScope,now:()=>clock.time}));}});config.localClosers.push(h.close);store=h.store;s=store.resourceSessions;jobs.authorityLifecycle=store.lifecycle;registryOptions.db=db;registryOptions.lifecycle=store.lifecycle;}registry=createStagingGrantPublication(registryOptions);publisher=makePublisher();}};
}
test('durable two-cart Add/resume, clean restart, cancellation and removal preserve independent grants',async t=>{
 const f=setup(t),a=f.client('a'),b=f.client('b'),pa=await a.prepare();a.add(pa);const pb=await b.prepare();b.add(pb);assert.equal(f.remote.grants.length,2);
 f.restart(true);f.publisher.assertResume(a.ticket,a.cart,a.marker);f.publisher.assertResume(b.ticket,b.cart,b.marker);assert.equal(f.publisher.references(a.cart.owner).length,1);
 const candidate=await a.prepare(),beforeB=structuredClone(f.remote.grants.find(g=>g.cart!==f.registry.owned(a.cart.owner).grant.cart));
 await f.publisher.cancel({...a.input(),reservation:candidate.reservation,afterClear:async()=>a.input()});assert.equal(f.remote.grants.length,2);assert.deepEqual(f.remote.grants.find(g=>g.cart===beforeB.cart),beforeB);
 a.cart.lines=[];await f.publisher.observeCurrent(a.input());assert.equal(f.remote.grants.length,1);assert.equal(f.registry.owned(a.cart.owner).state,'suspended');assert.equal(f.publisher.assertResume(a.ticket,a.cart,a.marker).expires_at,pa.expires_at);
 const again=await a.prepare();assert.equal(again.expires_at,pa.expires_at);a.add(again);assert.equal(f.remote.grants.length,2);
 assert.equal(f.db.prepare('SELECT count(*) AS n FROM staging_prepared_references').get().n,4);
});
test('pending issued candidate retains its grant through actual empty cart observation',async t=>{
 const f=setup(t),a=f.client('pending'),p=await a.prepare();const sends=f.publishes;await f.publisher.observeCurrent(a.input());assert.equal(f.publishes,sends);assert.equal(f.remote.grants[0].lines[0].claims.job,p.reference.id);
 f.restart();const recovery=f.publisher.assertResume(a.ticket,a.cart,a.marker,{kind:'prepared',operation_id:p.reservation.operation_id,job:p.reference.id,generation:1});assert.equal(recovery.prepared_recovery.state,'issued');a.add(p);
});
test('unknown publication remains durable and is never republished after restart',async t=>{
 const f=setup(t),a=f.client('lost');f.fail=true;await assert.rejects(a.prepare(),/lost/);const sends=f.publishes;f.restart();await assert.rejects(a.prepare(),/UNCERTAIN|FENCED/);assert.equal(f.publishes,sends);assert.equal(f.db.prepare('SELECT state FROM cart_prepared_jobs').get().state,'uncertain');
});
test('confirmed removed print frees capacity while durable old references cannot reappear as uploads',async t=>{
 const f=setup(t),a=f.client('capacity');let first;
 let capacity;for(let i=0;i<9;i++){try{const p=await a.prepare();first??=p;a.add(p);}catch(error){assert.match(error.message,/UNVERIFIED_CART|CAPACITY|AUTHORITY_SIZE|INVALID_AUTHORITY/);capacity=i;break;}}assert.ok(capacity>1&&capacity<=8);
 assert.equal(f.db.prepare("SELECT count(*) AS n FROM cart_prepared_jobs WHERE state='uncertain'").get().n,0);
 a.cart.lines.shift();await f.publisher.observeCurrent(a.input());assert.equal(f.remote.grants[0].lines.length,capacity-1);const p=await a.prepare();a.add(p);assert.equal(f.remote.grants[0].lines.length,capacity);assert.ok(f.publisher.references(a.cart.owner).some(r=>r.id===first.reference.id));
});
