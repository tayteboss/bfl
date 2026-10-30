import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {rig} from '../../../fixtures/film-printing/f06p-composition/rig.mjs';
import {selection} from '../../../fixtures/film-printing/f06c-continuation/synthetic.mjs';
import {createDiagnosticResources} from '../backend/diagnostic-resources.mjs';
import {createDiagnosticCustody} from '../backend/diagnostic-custody.mjs';
import {createUploadcareAdapter} from '../uploads/uploadcare.mjs';
import {ACTIVE_QUERY} from '../configuration/shopify.mjs';
import {STORE,APP} from '../configuration/schema.mjs';

const bytes=Buffer.from('generated-local-provider-protocol-test');
const files=Array.from({length:3},()=>({bytes,mime:'image/png',sha256:createHash('sha256').update(bytes).digest('hex')}));
const uploadConfig={store:STORE,app:APP,publicKey:'synthetic-public-key',projectId:699888,cdnOrigin:'https://synthetic.ucarecd.net',secret:'synthetic-api-secret'.repeat(3),delivery:{projectKey:'synthetic-public-key',origin:'https://synthetic.s.ucarecd.net',publicAccessDisabled:true,legacyAccessDisabled:true,signingSecret:'synthetic-delivery-secret'.repeat(3)}};
function setup(t){
 const f=rig(t),events=[],calls=[];let posts=0,hook,failInfo=false;
 const token=f.issue(),ticket=f.store.resourceSessions.authenticate(f.request(token));
 const custody=createDiagnosticCustody({store:f.store,append:e=>events.push(structuredClone(e))});
 const fetchImpl=async(url,options={})=>{
  calls.push({url,method:options.method});let body;
  if(url.endsWith('/project/'))body={pub_key:uploadConfig.publicKey};
  else if(options.method==='POST'){
   const asset=`00000000-0000-4000-8000-${String(++posts).padStart(12,'0')}`;if(hook)await hook();body={file:asset};
  }else {
   if(failInfo&&options.method==='GET')return new Response('{}',{status:503});
   const asset=url.split('/')[4];
   body={uuid:asset,url:`https://api.uploadcare.com/files/${asset}/`,datetime_removed:options.method==='DELETE'?'2026-10-21T00:00:00Z':null,is_ready:true,is_image:true,size:bytes.length,mime_type:'image/png',datetime_uploaded:'2026-10-21T00:00:00Z',datetime_stored:'2026-10-21T00:00:00Z',original_file_url:`https://synthetic.ucarecd.net/${asset}/test.png`};
  }
  return new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
 };
 const api=async query=>{
  if(query===ACTIVE_QUERY)return {shop:{myshopifyDomain:STORE},currentAppInstallation:{app:{id:APP},metafield:f.m.data.currentAppInstallation.active}};
  assert.match(query,/F05PriceCatalog/);return {currentAppInstallation:{metafield:f.m.data.currentAppInstallation.catalog}};
 };
 const resources=createDiagnosticResources({store:f.store,api,config:f.config,uploadConfig,files,selection,custody,enabled:true,permit:()=>true,fetchImpl,now:()=>f.clock.time});
 const input={owner:ticket.owner,ticket,guard:()=>f.store.resourceSessions.assert(ticket)};
 return {...f,token,ticket,custody,events,calls,fetchImpl,resources,input,set hook(fn){hook=fn;},set failInfo(value){failInfo=value;}};
}

test('three normal provider uploads complete and normal job signing runs; retired-owner cleanup deletes exact assets once',async t=>{
 const f=setup(t),old=f.rows('upload_custody');const result=await f.resources.prepare(f.input);
 assert.equal(result.item.quantity,4);assert.equal(result.item.properties['Files Uploaded'],'3');assert.equal(result.checkout_ready,false);
 assert.equal(f.rows('jobs').length,1);assert.deepEqual(f.custody.counts(),{known:3});assert.equal(f.calls.length,30);
 assert.deepEqual(f.rows('upload_custody'),old);await assert.rejects(f.resources.prepare(f.input),/DIAGNOSTIC_RESOURCES_CLOSED/);
 f.store.revoke({id:'test-expire-owner',kind:'owner',owner:f.ticket.owner});
 assert.deepEqual(await f.resources.cleanup(),{deleted:3});assert.equal(f.calls.length,36);
 await f.resources.cleanup();assert.equal(f.calls.length,36);
});

test('honestly unverified source fails normal validation before any provider send',async t=>{
 const f=setup(t),release=structuredClone(f.m.release);release.config.labs.find(l=>l.id==='miami').origin_status='staging_address_only';
 f.m.data.currentAppInstallation.active.value=JSON.stringify(release);
 await assert.rejects(f.resources.prepare(f.input),/origin not verified/);assert.equal(f.calls.length,0);assert.equal(f.rows('jobs').length,0);
});

test('late known provider response after real owner revocation is retained for exact deletion and never completes',async t=>{
 const f=setup(t);f.hook=()=>f.store.revoke({id:'test-race-owner',kind:'owner',owner:f.ticket.owner});
 await assert.rejects(f.resources.prepare(f.input));assert.deepEqual(f.custody.counts(),{queued:1});assert.equal(f.rows('jobs').length,0);
 assert.deepEqual(await f.resources.cleanup(),{deleted:1});assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
});

test('durable sending/deleting states become terminal unknown after recovery with no provider retry',async t=>{
 const f=setup(t);f.custody.admitOwner(f.ticket);
 const uploader=createUploadcareAdapter({store:f.store,config:uploadConfig,enabled:true,fetchImpl:f.fetchImpl,now:()=>f.clock.time,custody:f.custody});
 const intent=uploader.intent(f.ticket.owner,'crash-upload-intent');
 f.store.uploadLedger.claim(f.ticket.owner,intent.intent_id,uploader.binding,{digest:files[0].sha256,size:bytes.length,mime:'image/png'});
 f.custody.start(intent.intent_id,uploader.binding);
 const restarted=createDiagnosticCustody({store:f.store,append:e=>f.events.push(e),history:f.events});restarted.recover();
 assert.deepEqual(restarted.counts(),{'upload-unknown':1});assert.equal(restarted.pending().length,0);assert.throws(()=>restarted.start(intent.intent_id,uploader.binding));
 const g=setup(t);await g.resources.prepare(g.input);g.store.revoke({id:'crash-delete-owner',kind:'owner',owner:g.ticket.owner});
 const [row]=g.custody.pending();g.custody.beginDelete(row.intent);
 const recovered=createDiagnosticCustody({store:g.store,append:e=>g.events.push(e),history:g.events});recovered.recover();
 assert.equal(recovered.counts()['delete-unknown'],1);assert.equal(recovered.pending().length,2);assert.throws(()=>recovered.beginDelete(row.intent));
 assert.equal(g.calls.filter(c=>c.method==='DELETE').length,0);
});

test('bounded maintenance rechecks real provider metadata past the original proof deadline without duplicate work',async t=>{
 const f=setup(t);await f.resources.prepare(f.input);const initial=f.calls.length;
 await f.resources.maintain();assert.equal(f.calls.length,initial);
 for(let i=1;i<=4;i++){
  f.clock.time+=20000;
  await Promise.all([f.resources.maintain(),f.resources.maintain()]);
  assert.equal(f.calls.length,initial+i*6); // project and file GET for each asset
  for(const row of f.rows('upload_intents'))assert.equal(row.checked_until,f.clock.time+60000);
 }
 assert.equal(f.calls.filter(x=>x.method==='POST').length,3);
 assert.equal(f.rows('jobs').length,1);
});

test('an expired provider observation requires real revalidation while original owner and intent deadlines remain fixed',async t=>{
 const f=setup(t);await f.resources.prepare(f.input);
 const intents=f.rows('upload_intents'),owner=f.rows('resource_sessions')[0],jobs=f.rows('jobs'),before=f.calls.length;
 f.clock.time+=60000;
 for(const row of intents)assert.throws(()=>f.store.uploadLedger.assertUsable(row.owner,row.asset),/UPLOAD_REVALIDATION_REQUIRED/);
 await f.resources.maintain();assert.equal(f.calls.length,before+6);
 assert.ok(f.calls.slice(before).every(call=>call.method==='GET'));
 for(const original of intents){
  const row=f.rows('upload_intents').find(row=>row.id===original.id);
  assert.equal(row.state,'complete');assert.equal(row.asset,original.asset);assert.equal(row.expires,original.expires);
  assert.equal(row.checked_until,f.clock.time+60000);f.store.uploadLedger.assertUsable(row.owner,row.asset);
 }
 const current=f.rows('resource_sessions')[0];
 assert.equal(current.expires,owner.expires);assert.equal(current.deadline,owner.deadline);assert.equal(current.generation,owner.generation);
 assert.deepEqual(f.rows('jobs'),jobs);await f.resources.maintain();assert.equal(f.calls.length,before+6);
});

test('maintenance cannot renew a retired or expired owner',async t=>{
 for(const mode of ['retired','expired-owner'])await t.test(mode,async t=>{
  const f=setup(t);await f.resources.prepare(f.input);const before=f.calls.length,owner=f.rows('resource_sessions')[0];
  if(mode==='retired'){f.store.revoke({id:'maintenance-retired-owner',kind:'owner',owner:f.ticket.owner});f.clock.time+=20000;}
  else f.clock.time=owner.expires;
  await assert.rejects(f.resources.maintain());assert.equal(f.calls.length,before);
  await f.resources.maintain();assert.equal(f.calls.length,before);
  const current=f.rows('resource_sessions')[0];assert.equal(current.expires,owner.expires);assert.equal(current.deadline,owner.deadline);
 });
});

test('uncertain provider revalidation fails closed once and cleanup still deletes the exact owned files',async t=>{
 const f=setup(t);await f.resources.prepare(f.input);f.clock.time+=20000;f.failInfo=true;
 await assert.rejects(f.resources.maintain());const calls=f.calls.length;
 assert.ok(f.rows('upload_intents').some(row=>row.state==='failed'));
 await f.resources.maintain();assert.equal(f.calls.length,calls);
 f.failInfo=false;f.store.revoke({id:'maintenance-cleanup-owner',kind:'owner',owner:f.ticket.owner});
 assert.deepEqual(await f.resources.cleanup(),{deleted:3});
});
