import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,cpSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {digest} from '../configuration/config.mjs';
import {preparedPolicy,FULL_PRODUCT_CLIENT_POLICY} from '../checkout/prepared-limits.mjs';
import {createResourceSession} from '../theme/resource-session.js';

// An isolated source copy receives one generated local-test exact source pair.
// No generated IDs/catalog enter the real admission registry or a remote system.
function isolated(t){
 const directory=mkdtempSync(join(tmpdir(),'bfl-client-policy-test-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const app=fileURLToPath(new URL('../',import.meta.url)),target=join(directory,'app');
 cpSync(app,target,{recursive:true,filter:p=>!p.includes('/node_modules')&&!p.includes('/dist')&&!p.includes('/.shopify')&&!p.includes('/tests')});
 const read=name=>JSON.parse(readFileSync(new URL('../../../fixtures/film-printing/f06p-integration/'+name,import.meta.url)));
 const config=read('engineering-config-proposal.json'),legacy=read('engineering-catalog-proposal.json');
 const full={...legacy,product_semantics:{version:'bfl-full-product-selection-v1'}};
 const source=join(target,'configuration/engineering.mjs'),original=readFileSync(source,'utf8');
 assert.ok(original.includes('ENGINEERING_SOURCE_PINS=Object.freeze(['));
 writeFileSync(source,original.replace('ENGINEERING_SOURCE_PINS=Object.freeze([',
  'ENGINEERING_SOURCE_PINS=Object.freeze([Object.freeze('+JSON.stringify({config:digest(config),catalog:digest(full)})+'),'));
 writeFileSync(join(directory,'input.json'),JSON.stringify({config,legacy,full}));
 return {directory,target};
}

test('full client policy requires an actual admitted private scope, not constants or browser-like objects',()=>{
 assert.equal(preparedPolicy().preparations,8);assert.equal(preparedPolicy().ownerMs,600000);assert.equal(preparedPolicy().leaseMs,240000);
 assert.throws(()=>preparedPolicy({kind:'staging_engineering'}),/ENGINEERING_SCOPE/);
 assert.throws(()=>preparedPolicy(FULL_PRODUCT_CLIENT_POLICY),/ENGINEERING_SCOPE/);
 assert.equal(FULL_PRODUCT_CLIENT_POLICY.jobs,64);assert.equal(FULL_PRODUCT_CLIENT_POLICY.cartLines,8);
});

test('new exact-source client owners have fixed one-hour deadlines and 64 admissions while old owners/history remain unchanged',t=>{
 const f=isolated(t);
 const worker=String.raw`
 import assert from 'node:assert/strict';
 import {readFileSync} from 'node:fs';
 import {DatabaseSync} from 'node:sqlite';
 import {randomBytes} from 'node:crypto';
 import {createLifecycle,fingerprint} from './app/jobs/lifecycle.mjs';
 import {createResourceSessions,installResourceSchema} from './app/backend/resource-session.mjs';
 import {STOREFRONT_ORIGIN} from './app/backend/storefront-session.mjs';
 import {prepareEngineeringSources,createEngineeringScope} from './app/configuration/engineering.mjs';
 import {preparedPolicy,preparedOwnerPolicy} from './app/checkout/prepared-limits.mjs';
 import {installPreparedSchema,createPreparedLedger} from './app/checkout/prepared-ledger.mjs';
 import {leaseDeadline} from './app/checkout/lease.mjs';
 import {installUploadSchema,createUploadLedger} from './app/uploads/ledger.mjs';
 import {createPreparedPublication} from './app/checkout/prepared-publication.mjs';
 import {cartHash} from './app/checkout/storefront.mjs';
 import {createDiagnosticAdminTransport} from './app/backend/diagnostic-admin.mjs';
 import {STORE,APP,CLIENT} from './app/configuration/schema.mjs';
 import {SHOP,INSTALLATION} from './app/backend/config.mjs';
 const {config,legacy,full}=JSON.parse(readFileSync(new URL('./input.json',import.meta.url)));
 const identity={shop:{id:SHOP,myshopifyDomain:STORE},currentAppInstallation:{id:INSTALLATION,app:{id:APP,apiKey:CLIENT}}};
 let clock=1000;
 const create=(catalog,until)=>createEngineeringScope({...prepareEngineeringSources({config,catalog,issuedAt:1000,until}),identity,now:()=>clock});
 const sourceScope=create(full,3601000),oldScope=create(legacy,1201000),policy=preparedPolicy(sourceScope);
 assert.equal(policy.ownerMs,3600000);assert.equal(policy.publications,128);
 assert.throws(()=>create(legacy,3601000),/ENGINEERING_WINDOW/);assert.throws(()=>create(full,3601001),/ENGINEERING_WINDOW/);
 const db=new DatabaseSync(':memory:'),lifecycle=createLifecycle(db);installResourceSchema(db);installPreparedSchema(db);
 db.exec('CREATE TABLE checkout_owner_admissions(owner TEXT PRIMARY KEY,created INTEGER,cart TEXT,binding TEXT);CREATE TABLE jobs(id TEXT PRIMARY KEY,owner TEXT,body TEXT);CREATE TABLE cart_checkout_bindings(cart_hash TEXT,owner_hash TEXT,identity_hash TEXT,marker TEXT,state TEXT);CREATE TABLE cart_job_bindings(job_id TEXT PRIMARY KEY,cart_hash TEXT,owner_hash TEXT)');
 const sessions=createResourceSessions(db,lifecycle,()=>clock,{checkoutOwner:true}),proof=()=>({id:randomBytes(32).toString('base64url'),observedAt:clock,customerId:null});
 const request=token=>({headers:{origin:STOREFRONT_ORIGIN,authorization:'Bearer '+token}});
 const old=sessions.issue(proof(),{ttlMs:600000}),oldTicket=sessions.authenticate(request(old.token));
 const oldBefore={...sessions.assert(oldTicket)};
 assert.throws(()=>sessions.issue(proof(),{ttlMs:3600000,sourceScope:oldScope}),/RESOURCE_SESSION_POLICY/);
 const issued=sessions.issue(proof(),{ttlMs:policy.ownerMs,sourceScope}),ticket=sessions.authenticate(request(issued.token));
 assert.equal(issued.client_policy,'bfl-full-product-client-v1');assert.equal(issued.expires_in,3600);
 const before={...sessions.assert(ticket)};assert.equal(before.expires,3601000);assert.equal(before.deadline,3601000);
 assert.deepEqual({...sessions.assert(oldTicket)},oldBefore);
 assert.equal(preparedOwnerPolicy(db,oldTicket.owner,sourceScope).preparations,8);
 assert.equal(preparedOwnerPolicy(db,ticket.owner,sourceScope).preparations,64);
 assert.equal(sessions.clientPolicy(ticket,sourceScope),'bfl-full-product-client-v1');assert.equal(sessions.clientPolicy(oldTicket,sourceScope),null);
 installUploadSchema(db);
 const uploads=createUploadLedger(db,{lifecycle,recordUpload(){},invalidateUpload(){}},()=>clock),binding='synthetic-project';
 const oldUpload=uploads.create(oldTicket.owner,'old-upload-0001',binding),newUpload=uploads.create(ticket.owner,'full-upload-0001',binding,{sourceScope});
 assert.equal(oldUpload.expires,601000);assert.equal(newUpload.expires,3601000);
 assert.equal(uploads.create(oldTicket.owner,'old-upload-0002',binding,{sourceScope}).expires,601000);
 assert.deepEqual(uploads.create(oldTicket.owner,'old-upload-0001',binding,{sourceScope}),oldUpload);
 assert.equal(uploads.create(ticket.owner,'full-upload-0001',binding).expires,newUpload.expires);
 uploads.claim(ticket.owner,newUpload.id,binding,{digest:'a'.repeat(64),size:1,mime:'image/png'});
 const boundUpload=uploads.bind(ticket.owner,newUpload.id,binding,'11111111-2222-4333-8444-555555555555');
 const completedUpload=uploads.complete(ticket.owner,newUpload.id,binding,boundUpload.version,'https://fixture.invalid/image');
 assert.equal(completedUpload.expires,3601000);assert.equal(completedUpload.checked_until,61000);
 // A different exact source contract cannot promote this owner's policy receipt.
 const other=create(full,3600000);assert.equal(preparedOwnerPolicy(db,ticket.owner,other).preparations,8);
 for(let n=0;n<64;n++)sessions.admit(ticket,'jobs','full-request-'+n,{sourceScope});
 sessions.admit(ticket,'jobs','full-request-0',{sourceScope});
 assert.throws(()=>sessions.admit(ticket,'jobs','full-request-64',{sourceScope}),/RESOURCE_ADMISSION_LIMIT/);
 for(let n=0;n<16;n++)sessions.admit(oldTicket,'jobs','old-request-'+n,{sourceScope});
 assert.throws(()=>sessions.admit(oldTicket,'jobs','old-request-16',{sourceScope}),/RESOURCE_ADMISSION_LIMIT/);
 assert.throws(()=>sessions.renew(ticket,proof()),/RESOURCE_SESSION_POLICY/);assert.deepEqual({...sessions.assert(ticket)},before);
 const originalLease=leaseDeadline(3601000,clock,'UTC',{sourceScope});assert.equal(originalLease.expires_at,3601000);
 assert.throws(()=>leaseDeadline(3601000,clock,'UTC'),/LEASE_WINDOW/);assert.throws(()=>leaseDeadline(3601001,clock,'UTC',{sourceScope}),/LEASE_WINDOW/);
 const ledger=createPreparedLedger(db,lifecycle,{now:()=>clock});
 const oldPublisher=createPreparedPublication({store:{preparedCart:ledger,resourceSessions:sessions},jobs:{},admin:{read(){throw Error('old owner must reject before admin read');}},prepareAuthority(){},currentOwner:()=>oldTicket,now:()=>clock,until:3601000,publicationLimit:128,enabled:true,permit:()=>true,armPublication(){},sourceScope});
 await assert.rejects(oldPublisher.eligible({resourceTicket:oldTicket,guard(){}}),/PREPARED_CLIENT_OWNER_REQUIRED/);
 function reserve(owner,n,expires,scope){
  const cart={id:'gid://shopify/Cart/'+owner+'?key=synthetic-key',owner,complete:true,binding_id:'synthetic-binding',customer_id:null},marker='a'.repeat(64);
  if(!db.prepare('SELECT 1 FROM cart_checkout_bindings WHERE cart_hash=?').get(cartHash(cart.id)))db.prepare('INSERT INTO cart_checkout_bindings VALUES (?,?,?,?,?)').run(cartHash(cart.id),cartHash(owner),fingerprint({owner,binding:cart.binding_id,customer:null}),marker,'confirmed');
  const reference={id:owner+'-job-'+n,revision:n.toString(16).padStart(64,'0'),signature:'c'.repeat(64),config_version:'test-config'};
  db.prepare('INSERT OR IGNORE INTO jobs VALUES (?,?,?)').run(reference.id,owner,JSON.stringify(reference));
  return ledger.reserve(owner,cart,marker,reference,'b'.repeat(64),n,expires,{sourceScope:scope});
 }
 for(let n=1;n<=64;n++){const r=reserve(ticket.owner,n,3601000,sourceScope);ledger.issue(r.ticket,'d'.repeat(64));ledger.confirm(r.ticket,'e'.repeat(64));}
 assert.throws(()=>reserve(ticket.owner,65,3601000,sourceScope),/PREPARATION_LIMIT/);
 const first=reserve(oldTicket.owner,1,200000,sourceScope);ledger.issue(first.ticket,'d'.repeat(64));ledger.confirm(first.ticket,'e'.repeat(64));reserve(oldTicket.owner,2,200000,sourceScope);
 assert.throws(()=>reserve(oldTicket.owner,3,200000,sourceScope),/CUSTOMER_JOB_SPENT/);
 assert.equal(db.prepare('SELECT count(*) AS n FROM cart_prepared_jobs WHERE owner_hash=?').get(cartHash(ticket.owner)).n,64);
 const admin=createDiagnosticAdminTransport({store:STORE,app:APP,clientId:CLIENT,installation:INSTALLATION},{lifecycle,enabled:true,permit:()=>true,publicationLimit:4,fetchImpl:()=>{throw Error('network forbidden');}});
 assert.throws(()=>admin.activateFullProduct(oldScope),/DIAGNOSTIC_CLIENT_POLICY/);admin.activateFullProduct(sourceScope);
 assert.throws(()=>admin.activateFullProduct(sourceScope),/DIAGNOSTIC_CLIENT_POLICY/);
 clock=1801000;assert.equal(sessions.authenticate(request(issued.token)).owner,ticket.owner);
 uploads.sweep();assert.equal(uploads.read(oldUpload.id).state,'failed');assert.equal(uploads.read(newUpload.id).state,'complete');
 const refreshedUpload=uploads.complete(ticket.owner,newUpload.id,binding,uploads.read(newUpload.id).version,'https://fixture.invalid/image');
 assert.equal(refreshedUpload.expires,3601000);assert.equal(refreshedUpload.checked_until,clock+60000);
 const lateUpload=uploads.create(ticket.owner,'full-upload-late',binding,{sourceScope});assert.equal(lateUpload.expires,3601000);
 assert.equal(sessions.assert(ticket).expires,before.expires);assert.equal(sessions.assert(ticket).deadline,before.deadline);
 assert.throws(()=>sessions.authenticate(request(old.token)),/RESOURCE_REJECTED/);
 clock=3601000;assert.throws(()=>sessions.authenticate(request(issued.token)),/RESOURCE_REJECTED/);
 assert.throws(()=>uploads.create(ticket.owner,'full-after-expiry',binding,{sourceScope}),/ENGINEERING_EXPIRED/);
 uploads.sweep();assert.equal(uploads.read(newUpload.id).state,'failed');assert.equal(uploads.read(lateUpload.id).state,'failed');
 assert.equal(uploads.read(newUpload.id).expires,3601000);assert.equal(uploads.read(oldUpload.id).expires,601000);
 assert.throws(()=>sessions.renew(ticket,proof()),/RESOURCE_REJECTED/);assert.throws(()=>preparedPolicy(sourceScope),/ENGINEERING_EXPIRED/);
 assert.equal(db.prepare('SELECT count(*) AS n FROM cart_prepared_jobs WHERE owner_hash=?').get(cartHash(ticket.owner)).n,64);
 assert.deepEqual({...db.prepare('SELECT * FROM resource_sessions WHERE owner=?').get(oldTicket.owner)},oldBefore);
 assert.equal(db.prepare('SELECT expires FROM resource_sessions WHERE owner=?').get(ticket.owner).expires,3601000);
 db.close();process.stdout.write(JSON.stringify({full_jobs:64,cart_lines:8,publication_limit:128,fixed_expiry:3601000,old_rows_unchanged:true}));
 `;
 writeFileSync(join(f.directory,'worker.mjs'),worker);
 const result=spawnSync(process.execPath,[join(f.directory,'worker.mjs')],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).old_rows_unchanged,true);
});


test('browser admits only explicitly tagged prepared one-hour sessions and expires without renewal',async t=>{
 const original=globalThis.location,origin='https://bellows-film-printing-staging.myshopify.com';
 globalThis.location={origin};t.after(()=>{if(original===undefined)delete globalThis.location;else globalThis.location=original;});
 for(const [preparedMode,expires,tag,accepted] of [[true,3600,true,true],[true,3600,false,false],[true,3601,true,false],[false,3600,true,false],[true,600,false,true]]){
  let clock=1000;const paths=[],opaque='a'.repeat(43),fetchImpl=async(url,init)=>{
   const path=new URL(url,origin).pathname;paths.push(path);
   if(path==='/resource-proof/challenge')return Response.json({challenge:opaque,verifier:opaque,purpose:'bfl:resource-fresh-proof:v1',audience:origin+'/bfl-application-resources',action:JSON.parse(init.body).action,expires_in:30});
   if(path==='/apps/bfl-staging/resource-proof')return Response.json({ticket:opaque});
   if(path==='/resource-proof/exchange')return Response.json({proof:opaque,expires_in:30});
   if(path==='/resource-sessions/issue')return Response.json({token:'bflr1_'+opaque,resource_only:true,cart_verified:false,checkout_ready:false,generation:1,expires_in:expires,...(tag?{client_policy:'bfl-full-product-client-v1'}:{})});
   if(path==='/resource-sessions/revoke')return Response.json({revoked:true});
   throw Error('unexpected request');
  };
  const session=createResourceSession({preparedMode,fetchImpl,now:()=>clock});
  if(!accepted){await assert.rejects(session.issue(),/RESOURCE_UNAVAILABLE/);continue;}
  assert.equal((await session.issue()).expires_at,clock+expires*1000);
  clock+=expires*1000-1;session.assertLive();clock++;
  assert.throws(()=>session.assertLive(),/RESOURCE_EXPIRED/);
  assert.equal(paths.filter(p=>p==='/resource-sessions/issue').length,1);
  assert.ok(!paths.some(p=>p==='/resource-sessions/renew'));
 }
});
