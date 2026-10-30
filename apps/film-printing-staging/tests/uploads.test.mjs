import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,chmodSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,createHmac} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import vm from 'node:vm';
import {createJobStore,createJobService} from '../jobs/service.mjs';
import {createUploadcareAdapter,createUploadcareTransport,uploadBinding,uploadToken,restHeaders,MAX_IMAGE_BYTES} from '../uploads/uploadcare.mjs';
import {initializeDatabase,openDatabase,migrateUploads,migrateCartRefresh,migrateOrders,migrateOrderInbox} from '../backend/storage.mjs';
import {createRuntime} from '../backend/server.mjs';
import {INSTALLATION} from '../backend/config.mjs';
import {STORE,APP,CLIENT} from '../configuration/schema.mjs';
import {mockAdmin,now as adminNow} from '../../../fixtures/film-printing/f06d/mock-admin.mjs';
const dirs=[];after(()=>dirs.forEach(d=>rmSync(d,{recursive:true,force:true})));
function directory(){const d=mkdtempSync(join(tmpdir(),'bfl-f05b-'));chmodSync(d,0o700);dirs.push(d);return d;}
// Every owner, key, image byte sequence and provider response below is synthetic.
// fetchImpl never calls network. These fixtures do NOT establish upload acceptance.
const c={store:STORE,app:APP,publicKey:'synthetic-project-key',cdnOrigin:'https://synthetic.ucarecd.net',secret:'synthetic-provider-secret-value',
  delivery:{projectKey:'synthetic-project-key',origin:'https://synthetic.s.ucarecd.net',publicAccessDisabled:true,legacyAccessDisabled:true,signingSecret:'a'.repeat(64)},
  projectId:73,hookId:82,webhookUrl:'https://staging.invalid/hooks/uploadcare',webhookSecret:'s'.repeat(32)};
const image={bytes:Buffer.from('synthetic-image-bytes'),mime:'image/jpeg'};
const aid='11111111-2222-4333-8444-555555555555',bid='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const response=(value,status=200,headers={})=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json',...headers}});
function provider(){
 const p={calls:[],asset:aid,ready:true,removed:null,fail:false,alter:f=>f,beforeUpload:null,beforeInfo:null};
 p.fetch=async(url,options)=>{
  p.calls.push({url,options});
  if(p.fail)throw Error(c.secret);
  if(url==='https://api.uploadcare.com/project/')return response({pub_key:c.publicKey});
  if(url==='https://upload.uploadcare.com/base/') {if(p.beforeUpload)await p.beforeUpload();return response({file:p.asset});}
  if(url===`https://api.uploadcare.com/files/${p.asset}/`) {
   if(p.beforeInfo)await p.beforeInfo();
   return response(p.alter({uuid:p.asset,url:`https://api.uploadcare.com/files/${p.asset}/`,is_ready:p.ready,is_image:true,mime_type:image.mime,
    original_file_url:`${c.cdnOrigin}/${p.asset}/image.jpg`,datetime_removed:p.removed,datetime_uploaded:'2026-10-21T00:00:00Z',datetime_stored:'2026-10-21T00:00:00Z',size:image.bytes.length}));
  }
  throw Error('Unexpected synthetic destination');
 };
 return p;
}
function fixture(t){
 let time=Date.parse('2026-10-21T03:00:00Z');const now=()=>time,path=join(directory(),'test.sqlite');
 const store=createJobStore(path,{now});t.after(()=>store.close());const p=provider();
 const adapter=createUploadcareAdapter({store,config:c,enabled:true,fetchImpl:p.fetch,now});
 return {store,p,adapter,path,now,advance:n=>time+=n};
}
async function complete(f,key='request-0001') {const i=f.adapter.intent('owner-a',key);return f.adapter.upload('owner-a',i.intent_id,image);}
function deletion(asset=aid,patch={}) {
 const e={hook:{id:c.hookId,project:c.projectId,target_url:c.webhookUrl,event:'file.deleted',version:'0.7'},data:{uuid:asset,datetime_removed:'2026-10-21T01:00:00Z'},...patch};
 const raw=Buffer.from(JSON.stringify(e));return {raw,signature:'v1='+createHmac('sha256',c.webhookSecret).update(raw).digest('hex')};
}
function runtimeConfig(){return {store:STORE,app:APP,clientId:CLIENT,installation:INSTALLATION,dataDir:directory(),host:'127.0.0.1',port:0,
 origin:'http://127.0.0.1:6076',mode:'disabled',jobSecret:'synthetic-job-key'.repeat(3),sessionSecret:'synthetic-session-key'.repeat(3)};}
function mockApi(m){return async(q,v)=>{
 if(q.includes('BflActiveConfiguration'))return {shop:m.data.shop,currentAppInstallation:{...m.data.currentAppInstallation,metafield:m.data.currentAppInstallation.active}};
 if(q.includes('F05PriceCatalog'))return {currentAppInstallation:{metafield:m.data.currentAppInstallation.catalog}};
 return m.api(q,v);
};}

test('F05B server relay completes only exact owner/intent/POST response; no client UUID/metadata authority',async t=>{
 const f=fixture(t),i=f.adapter.intent('owner-a','request-0001');
 assert.deepEqual(f.adapter.intent('owner-a','request-0001'),i);
 await assert.rejects(f.adapter.upload('owner-b',i.intent_id,image),/UNAVAILABLE/);assert.equal(f.p.calls.length,0);
 const receipt=await f.adapter.upload('owner-a',i.intent_id,{...image,asset_id:bid,verified:true,owner:'owner-b',metadata:{owner:'owner-b'}});
 assert.equal(receipt.state,'complete');assert.equal(receipt.asset_id,aid);assert.equal(receipt.checkout_ready,false);
 assert.deepEqual(f.store.uploads('owner-a',[aid]),[{id:aid,url:`${c.delivery.origin}/${aid}/`}]);
 assert.throws(()=>f.store.uploads('owner-b',[aid]));
 assert.throws(()=>f.adapter.verifyUpload({owner:'owner-b',intent_id:i.intent_id}));
 assert.equal(f.adapter.verifyUpload({owner:'owner-a',intent_id:i.intent_id}).asset.id,aid);
 await assert.rejects(f.adapter.validate('owner-a',[bid]),/UNAVAILABLE/);
 assert.equal(f.p.calls.filter(x=>x.url.endsWith('/base/')).length,1);
 const form=f.p.calls.find(x=>x.url.endsWith('/base/')).options.body;
 assert.deepEqual([...form.keys()],['UPLOADCARE_PUB_KEY','UPLOADCARE_STORE','file']);
 assert.equal(form.get('UPLOADCARE_STORE'),'1');assert.equal(form.get('UPLOADCARE_PUB_KEY'),c.publicKey);
 assert.deepEqual(Buffer.from(await form.get('file').arrayBuffer()),image.bytes);
});
test('F05B default disabled transport and wrong staging/project identity fail before upload',async t=>{
 const f=fixture(t);let calls=0;
 const transport=createUploadcareTransport(c,{fetchImpl:async()=>{calls++;}});
 await assert.rejects(transport.info(aid),/DISABLED/);await assert.rejects(transport.upload('intent',image.bytes,image.mime),/DISABLED/);assert.equal(calls,0);
 const disabled=createUploadcareAdapter({store:f.store,config:c,fetchImpl:async()=>{calls++;}});
 assert.throws(()=>disabled.intent('owner-a','request-0001'),/DISABLED/);
 for(const patch of [{store:'1jukgy-dc.myshopify.com'},{app:'wrong'},{publicKey:'x\nheader'},{cdnOrigin:'https://evil.invalid'},{cdnOrigin:'https://synthetic.ucarecd.net@evil.invalid'}])assert.throws(()=>uploadBinding({...c,...patch}));
 const wrong=createUploadcareTransport(c,{enabled:true,fetchImpl:async()=>{calls++;return response({pub_key:'foreign-project'});}});
 await assert.rejects(wrong.upload('intent',image.bytes,image.mime),/PROJECT_MISMATCH/);assert.equal(calls,1);
});
test('F05B documented JWT raw derived key, endpoint/one operation limit, and REST canonical signature',()=>{
 const now=Date.parse('2026-10-21T03:00:00Z'),token=uploadToken(c.secret,'intent-uuid',now),[h,p,s]=token.split('.');
 assert.deepEqual(JSON.parse(Buffer.from(h,'base64url')),{alg:'HS256',typ:'JWT'});
 const payload=JSON.parse(Buffer.from(p,'base64url'));assert.equal(payload.exp-payload.iat,60);assert.equal(payload.jti,'intent-uuid');
 assert.deepEqual(payload.uc,{restrictions:{scope:['/base/'],limits:{operations:1}}});
 assert.equal(s,createHmac('sha256',createHash('sha256').update(c.secret).digest()).update(h+'.'+p).digest('base64url'));
 const headers=restHeaders(c.secret,c.publicKey,'/project/',now);
 const canonical=`GET\nd41d8cd98f00b204e9800998ecf8427e\napplication/json\nWed, 21 Oct 2026 03:00:00 GMT\n/project/`;
 assert.equal(headers.Authorization,`Uploadcare ${c.publicKey}:`+createHmac('sha1',c.secret).update(canonical).digest('hex'));
 assert.equal(headers.Accept,'application/vnd.uploadcare-v0.7+json');
});
test('F05B one payload per intent, exact duplicate retry is inert; altered bytes/type and foreign project reject',async t=>{
 const f=fixture(t),done=await complete(f),count=f.p.calls.length;
 assert.deepEqual(await f.adapter.upload('owner-a',done.intent_id,image),done);assert.equal(f.p.calls.length,count);
 await assert.rejects(f.adapter.upload('owner-a',done.intent_id,{...image,bytes:Buffer.from('different')}),/REPLAY_CONFLICT/);
 await assert.rejects(f.adapter.upload('owner-a',done.intent_id,{...image,mime:'image/png'}),/REPLAY_CONFLICT/);
 const other=createUploadcareAdapter({store:f.store,config:{...c,publicKey:'other-project',delivery:{...c.delivery,projectKey:'other-project'}},enabled:true,fetchImpl:f.p.fetch,now:f.now});
 assert.throws(()=>other.intent('owner-a','request-0001'),/PROJECT_CHANGED/);
 await assert.rejects(other.status('owner-a',done.intent_id),/UNAVAILABLE/);
 assert.throws(()=>f.adapter.intent('owner-a','short'));
});
test('F05B bounded one-file relay rejects empty/large/nonimage inputs and never follows client destinations',async t=>{
 const f=fixture(t),i=f.adapter.intent('owner-a','request-0001');
 for(const input of [{bytes:Buffer.alloc(0),mime:image.mime},{bytes:Buffer.alloc(MAX_IMAGE_BYTES+1),mime:image.mime},{bytes:image.bytes,mime:'image/svg+xml'},
  {bytes:'https://internal.invalid/secret',mime:image.mime},{uuid:aid,url:`${c.delivery.origin}/${aid}/`}])await assert.rejects(f.adapter.upload('owner-a',i.intent_id,input),/IMAGE_INVALID/);
 assert.equal(f.p.calls.length,0);
 await f.adapter.upload('owner-a',i.intent_id,{...image,url:'http://169.254.169.254'});
 assert.ok(f.p.calls.every(x=>['https://api.uploadcare.com/project/',`https://api.uploadcare.com/files/${aid}/`,'https://upload.uploadcare.com/base/'].includes(x.url)&&x.options.redirect==='error'));
});
test('F05B transport rejects redirects, oversized/chunked/bad/error responses and sanitizes secrets',async()=>{
 for(const make of [()=>response({},302),()=>response({},401),()=>response({},429),()=>response({},200,{'content-type':'text/html'}),
  ()=>response({},200,{'content-encoding':'gzip'}),()=>response({},200,{'content-length':'65537'}),()=>new Response('x'.repeat(65537),{headers:{'content-type':'application/json'}}),
  ()=>new Response('{',{headers:{'content-type':'application/json'}}),()=>{throw Error(c.secret);},
  ()=>{const r=response({pub_key:c.publicKey});Object.defineProperty(r,'redirected',{value:true});return r;}]) {
  const tr=createUploadcareTransport(c,{enabled:true,fetchImpl:async()=>make()});
  await assert.rejects(tr.info(aid),e=>e.code.startsWith('UPLOAD_')&&!e.message.includes(c.secret));
 }
});
test('F05B info alone, foreign returned UUID, mismatched file properties and malformed POST cannot complete',async t=>{
 for(const alter of [f=>({...f,uuid:bid}),f=>({...f,url:'https://evil.invalid/'}),f=>({...f,size:999}),f=>({...f,is_image:false}),
  f=>({...f,mime_type:'text/plain'}),f=>({...f,datetime_stored:null}),f=>({...f,is_ready:null}),f=>({...f,datetime_removed:'bad'}),f=>({...f,original_file_url:`https://foreign.ucarecd.net/${aid}/`}),f=>({...f,original_file_url:`${c.cdnOrigin}/${bid}/`})]) {
  const f=fixture(t);f.p.alter=alter;await assert.rejects(complete(f));assert.throws(()=>f.store.uploads('owner-a',[aid]));
 }
 const f=fixture(t),i=f.adapter.intent('owner-a','request-0001');
 assert.throws(()=>f.adapter.verifyUpload({owner:'owner-a',intent_id:i.intent_id,asset:{id:aid,state:'complete',verified:true}}));
 for(const value of [{file:aid,file2:bid},{file:'https://evil.invalid'},{file:bid.toUpperCase()}]) {
  const p=provider(),tr=createUploadcareTransport(c,{enabled:true,fetchImpl:async(u,o)=>u.endsWith('/base/')?response(value):p.fetch(u,o)});
  await assert.rejects(tr.upload(i.intent_id,image.bytes,image.mime),/PROVIDER_INVALID/);
 }
});
test('F05B pending -> complete is supported, expiry and failed status are terminal',async t=>{
 const f=fixture(t);f.p.ready=false;const r=await complete(f);assert.equal(r.state,'pending');assert.throws(()=>f.store.uploads('owner-a',[aid]));
 f.p.ready=true;assert.equal((await f.adapter.status('owner-a',r.intent_id)).state,'complete');
 f.advance(60000);assert.throws(()=>f.store.uploads('owner-a',[aid]),/REVALIDATION/);
 assert.equal((await f.adapter.status('owner-a',r.intent_id)).state,'complete');
 f.advance(539999);const last=await f.adapter.status('owner-a',r.intent_id);
 assert.equal(last.expires_at,f.store.uploadLedger.read(r.intent_id).expires);
 const delivery=await f.adapter.delivery('owner-a',r.intent_id);assert.equal(delivery.expires_at,last.expires_at);
 f.advance(1);assert.throws(()=>f.store.uploads('owner-a',[aid]),/REVALIDATION/);
 assert.equal((await f.adapter.status('owner-a',r.intent_id)).state,'failed');assert.equal(f.store.lifecycle.state().pending,1);
 await assert.rejects(f.adapter.delivery('owner-a',r.intent_id));
 const g=fixture(t),i=g.adapter.intent('owner-a','request-0001');g.advance(600000);
 await assert.rejects(g.adapter.upload('owner-a',i.intent_id,image),/EXPIRED/);assert.equal(g.p.calls.length,0);
});
test('F05B removed, failed and duplicate asset IDs cannot resurrect or move between owners',async t=>{
 const f=fixture(t),done=await complete(f);const removed=f.adapter.remove('owner-a',done.intent_id);
 assert.equal(removed.state,'removed');assert.deepEqual(f.adapter.remove('owner-a',done.intent_id),removed);
 const duplicate=await f.adapter.upload('owner-a',done.intent_id,image);assert.equal(duplicate.state,'removed');
 const i=f.adapter.intent('owner-b','request-other');await assert.rejects(f.adapter.upload('owner-b',i.intent_id,image),/ASSET_REUSED/);
 assert.throws(()=>f.store.uploads('owner-a',[aid]));assert.throws(()=>f.store.uploads('owner-b',[aid]));
 assert.equal(f.store.uploadLedger.owned('owner-a',done.intent_id,uploadBinding(c)).state,'removed');
});
test('F05B signed deletion exact raw bytes, signature, scope, project and topic; durable duplicate receipts',async t=>{
 const f=fixture(t);await complete(f);const d=deletion();
 for(const bad of [{...d,signature:d.signature+'x'},{...d,signature:'v1='+'0'.repeat(64)},{...d,raw:Buffer.concat([d.raw,Buffer.from(' ')])},
  {...d,raw:Buffer.alloc(65537)}])assert.throws(()=>f.adapter.deleted(bad));
 for(const field of ['id','project','target_url','event','version']) {
  const raw=JSON.parse(d.raw);raw.hook[field]='wrong';assert.throws(()=>f.adapter.deleted(deletion(aid,{hook:raw.hook})),/SCOPE/);
 }
 assert.equal(f.adapter.deleted(d).recorded,true);const epoch=f.store.lifecycle.state().epoch;
 assert.deepEqual(f.adapter.deleted(d),{recorded:true,checkout_ready:false});assert.equal(f.store.lifecycle.state().epoch,epoch);
 assert.throws(()=>f.store.uploads('owner-a',[aid]));assert.equal(f.store.lifecycle.state().pending,1);
});
test('F05B early deletion before asset binding prevents delayed completion; no fabricated owner from metadata',async t=>{
 const f=fixture(t);f.p.beforeUpload=async()=>f.adapter.deleted(deletion());
 const r=await complete(f);assert.equal(r.state,'removed');assert.throws(()=>f.store.uploads('owner-a',[aid]));
 assert.equal(f.p.calls.filter(x=>x.url.includes('/files/')).length,0);
});
test('F05B removal during file-info verification fences completion and does not downgrade terminal state',async t=>{
 const f=fixture(t);const i=f.adapter.intent('owner-a','request-0001');let began,release;
 const start=new Promise(r=>began=r),hold=new Promise(r=>release=r);f.p.beforeInfo=async()=>{began();await hold;};
 const work=f.adapter.upload('owner-a',i.intent_id,image);await start;f.adapter.remove('owner-a',i.intent_id);release();
 await assert.rejects(work,/STALE/);assert.equal(f.store.uploadLedger.read(i.intent_id).state,'removed');assert.equal(f.store.lifecycle.state().pending,1);
});
test('F05B one in-flight relay, immutable byte copy and coalesced concurrent status polls',async t=>{
 const f=fixture(t);let began,release;const start=new Promise(r=>began=r),hold=new Promise(r=>release=r);
 f.p.beforeUpload=async()=>{began();await hold;};const bytes=Buffer.from(image.bytes),i=f.adapter.intent('owner-a','request-0001');
 const work=f.adapter.upload('owner-a',i.intent_id,{bytes,mime:image.mime});await start;bytes.fill(0);
 await assert.rejects(f.adapter.upload('owner-a',i.intent_id,image),/BUSY/);release();const done=await work;
 const form=f.p.calls.find(x=>x.url.endsWith('/base/')).options.body;assert.deepEqual(Buffer.from(await form.get('file').arrayBuffer()),image.bytes);
 const count=f.p.calls.length;const [a,b]=await Promise.all([f.adapter.status('owner-a',done.intent_id),f.adapter.status('owner-a',done.intent_id)]);
 assert.deepEqual(a,b);assert.equal(f.p.calls.length-count,2);assert.equal(f.store.lifecycle.state().pending,0);
});
test('F05B unknown POST outcome is terminal and retry never issues a second provider upload',async t=>{
 const f=fixture(t);f.p.beforeUpload=async()=>{throw Error(c.secret);};const i=f.adapter.intent('owner-a','request-0001');
 await assert.rejects(f.adapter.upload('owner-a',i.intent_id,image),e=>!e.message.includes(c.secret));
 assert.equal(f.store.uploadLedger.read(i.intent_id).state,'failed');f.p.beforeUpload=null;
 assert.equal((await f.adapter.upload('owner-a',i.intent_id,image)).state,'failed');assert.equal(f.p.calls.filter(x=>x.url.endsWith('/base/')).length,1);
});
test('F05B complete asset failure/deletion revalidation invalidates immutable prepared job and fences authority',async t=>{
 const f=fixture(t),done=await complete(f),m=mockAdmin();
 const {createAuthorityAdmin}=await import('../checkout/shopify.mjs');const admin=createAuthorityAdmin(m.api,{writesEnabled:true,lifecycle:f.store.lifecycle,now:adminNow});
 const context=await admin.read();
 const jobs=createJobService({store:f.store,loader:{load:async()=>context.release},loadCatalog:async()=>context.catalog,secret:'synthetic-job-key'.repeat(3),validateUploads:(o,ids)=>f.adapter.validate(o,ids)});
 const selection={request_key:'job-request-001',copies:4,service:'Photo Prints',size:'4x6',paper:'synthetic-paper',lab:'miami',asset_ids:[done.asset_id],options:{}};
 const result=await jobs.prepare('owner-a',selection),body=f.store.get(result.reference.id,'owner-a');
 const {createCheckoutProjector}=await import('../checkout/projector.mjs');
 const {VARIANT,PRODUCT}=await import('../checkout/authority.js');
 const cart={id:'gid://shopify/Cart/synthetic-upload',store:STORE,owner:'owner-a',customer_id:null,complete:true,lines:[
  {id:'gid://shopify/CartLine/synthetic-upload',variant_id:VARIANT,product_id:PRODUCT,quantity:4,reference:result.reference,properties:result.item.properties}]};
 const projector=createCheckoutProjector({jobs,resolveCart:async()=>cart,loadContext:admin.read});
 const prepared=await projector.prepare({});await admin.publish(prepared);
 assert.equal(JSON.parse(m.data.shop.authority.value).grants.length,1);
 const ticket=f.store.lifecycle.beginPreparation();
 assert.equal(result.unit_price_cents,40);assert.equal(result.item.quantity,4);assert.equal(result.checkout_ready,false);
 f.p.removed='2026-10-21T03:00:10Z';await assert.rejects(jobs.resolve('owner-a',result.reference),/REMOVED/);
 assert.deepEqual(f.store.get(result.reference.id,'owner-a'),body);assert.equal(f.store.lifecycle.state().pending,1);
 assert.equal(JSON.parse(m.data.shop.authority.value).grants.length,1); // local invalidation is not remote clearing
 assert.throws(()=>f.store.lifecycle.stage(ticket,{}));await admin.reconcile();assert.equal(f.store.lifecycle.state().pending,0);
 assert.equal(JSON.parse(m.data.shop.authority.value).grants.length,0);await assert.rejects(admin.publish(prepared));
 await assert.rejects(jobs.resolve('owner-a',result.reference));
});
test('F05B configured provider outage invalidates known complete asset, no silent cached-success fallback',async t=>{
 const f=fixture(t),done=await complete(f);f.p.fail=true;
 await assert.rejects(f.adapter.validate('owner-a',[done.asset_id]),/PROVIDER_UNAVAILABLE/);
 assert.throws(()=>f.store.uploads('owner-a',[aid]));assert.equal(f.store.lifecycle.state().pending,1);
});
test('F05B explicit schema1 -> schema2 migration preserves immutable jobs, upload rows, pending events and DB identity',()=>{
 const cfg=runtimeConfig();cfg.databaseId=initializeDatabase(cfg);let storage=openDatabase(cfg);
 storage.store.recordUpload('owner-a',{id:'legacy-asset',state:'complete',verified:true,url:'https://example.invalid/legacy'});
 storage.store.lifecycle.event('pending-event-0001',{reason:'synthetic'},()=>{});storage.store.lifecycle.startRecovery();storage.close();
 const db=new DatabaseSync(join(cfg.dataDir,'jobs.sqlite'));
 db.prepare('INSERT INTO jobs VALUES (?,?,?,?,?)').run('legacy-job','owner-a','request-legacy','fp',JSON.stringify({id:'legacy-job',revision:'immutable'}));
 db.exec('DROP TABLE order_job_snapshots; DROP TABLE order_source_bindings; DROP TABLE order_deliveries; DROP TABLE order_observations; DROP TABLE order_consumptions; DROP TABLE order_inbox');
 const row=JSON.parse(db.prepare('SELECT value FROM runtime_identity').get().value);db.prepare('UPDATE runtime_identity SET value=?').run(JSON.stringify({...row,schema:1}));
 db.exec('DROP TABLE upload_intents; DROP TABLE upload_provider_deletions; DROP TABLE cart_refresh_requests; DROP TABLE cart_job_bindings');db.close();
 assert.throws(()=>openDatabase(cfg),/MIGRATION_REQUIRED/);
 assert.throws(()=>migrateUploads({...cfg,databaseId:'wrong'}),/IDENTITY/);
 assert.equal(migrateUploads(cfg).schema,2);assert.equal(migrateUploads(cfg).already_migrated,true);
 assert.throws(()=>openDatabase(cfg),/MIGRATION_REQUIRED/);assert.equal(migrateCartRefresh(cfg).schema,3);assert.equal(migrateOrders(cfg).schema,4);assert.equal(migrateOrderInbox(cfg).schema,5);
 storage=openDatabase(cfg);assert.equal(storage.store.get('legacy-job','owner-a').revision,'immutable');assert.equal(storage.store.uploads('owner-a',['legacy-asset']).length,1);
 assert.equal(storage.store.lifecycle.state().pending,1);assert.equal(storage.store.lifecycle.state().operation.kind,'recovery');
 assert.throws(()=>migrateUploads(cfg),/LOCKED/);storage.close();
 const bad=new DatabaseSync(join(cfg.dataDir,'jobs.sqlite'));bad.exec('DROP TABLE upload_provider_deletions');bad.close();
 assert.throws(()=>openDatabase(cfg),/SCHEMA_MISMATCH/);assert.throws(()=>migrateUploads(cfg),/SCHEMA_MISMATCH/);
});
test('F05B restart retains pending binding, terminal deletion, and turns interrupted sending into failed without resend',async()=>{
 const cfg=runtimeConfig();cfg.databaseId=initializeDatabase(cfg);const now=()=>Date.parse('2026-10-21T03:00:00Z');
 let s=openDatabase(cfg,{now}),p=provider(),a=createUploadcareAdapter({store:s.store,config:c,enabled:true,fetchImpl:p.fetch,now});
 p.ready=false;const i=a.intent('owner-a','request-0001');await a.upload('owner-a',i.intent_id,image);
 const sending=a.intent('owner-a','request-0002');s.store.uploadLedger.claim('owner-a',sending.intent_id,uploadBinding(c),{digest:'synthetic',size:20,mime:image.mime});
 a.deleted(deletion(bid));s.close();s=openDatabase(cfg,{now});a=createUploadcareAdapter({store:s.store,config:c,enabled:true,fetchImpl:p.fetch,now});
 assert.equal(s.store.uploadLedger.read(sending.intent_id).state,'failed');assert.equal(s.store.uploadLedger.read(i.intent_id).asset,aid);
 p.ready=true;assert.equal((await a.status('owner-a',i.intent_id)).state,'complete');
 a.deleted(deletion());s.close();s=openDatabase(cfg,{now});assert.throws(()=>s.store.uploads('owner-a',[aid]));assert.equal(s.store.lifecycle.state().pending,1);s.close();
});
test('F05B runtime uses existing authenticated owner boundary; no ownership from payload, unavailable by default',async t=>{
 const cfg=runtimeConfig();cfg.databaseId=initializeDatabase(cfg);const p=provider(),m=mockAdmin();
 const r=createRuntime(cfg,{api:mockApi(m),uploadcare:{config:c,enabled:true,fetchImpl:p.fetch},now:adminNow});t.after(()=>r.close());
 const request={headers:{origin:cfg.origin,cookie:r.session.issue('owner-a').split(';')[0]}};
 await assert.rejects(r.upload('intent',request,{request_key:'request-0001',owner:'owner-a'}),/OWNER_RESOLVER/);assert.equal(p.calls.length,0);
 await assert.rejects(r.upload('intent',{headers:{}},{request_key:'request-0001',owner:'owner-a'}),/OWNER_REJECTED/);
});
test('F05B runtime integrated job preparation, signed deletion, recovery, shutdown and retained readiness=false',async t=>{
 const cfg=runtimeConfig();cfg.mode='reconcile-only';cfg.databaseId=initializeDatabase(cfg);const p=provider(),m=mockAdmin();let contexts=0;
 const api=mockApi(m);const r=createRuntime(cfg,{api:async(q,v)=>{if(q.includes('F06DAuthorityContext'))contexts++;return api(q,v);},
  uploadcare:{config:c,enabled:true,fetchImpl:p.fetch},adapters:{resolveOwner:async({sessionOwner})=>sessionOwner},now:adminNow});t.after(()=>r.close());
 await r.start();await r.refresh();const headers={origin:cfg.origin,cookie:r.session.issue('owner-a').split(';')[0],'content-type':'application/json'},request={headers};
 const i=await r.upload('intent',request,{request_key:'request-0001'}),done=await r.upload('bytes',request,{intent_id:i.intent_id,...image});await r.refresh();
 const before=contexts;
 const res=await fetch(`http://127.0.0.1:${r.server.address().port}/jobs`,{method:'POST',headers,body:JSON.stringify({request_key:'job-request-001',copies:3,service:'Photo Prints',size:'4x6',paper:'synthetic-paper',lab:'miami',asset_ids:[done.asset_id],options:{},owner:'owner-b',unit_price_cents:1})});
 assert.equal(res.status,200);const result=await res.json();assert.equal(result.unit_price_cents,40);assert.equal(result.item.quantity,3);assert.equal(result.checkout_ready,false);assert.equal(contexts-before,1);
 const receipt=await r.receiveUploadDeletion(deletion());assert.equal(receipt.recorded,true);await r.refresh();
 await assert.rejects(r.jobs.resolve('owner-a',result.reference));assert.equal(r.status().ready,false);assert.equal(r.status().checkout_ready,false);
 const body=r.store.get(result.reference.id,'owner-a');await r.close();const s=openDatabase(cfg);assert.deepEqual(s.store.get(result.reference.id,'owner-a'),body);assert.throws(()=>s.store.uploads('owner-a',[aid]));s.close();
});
test('F05B browser receipt contract handles pending/failure/removal, duplicates, stale responses and expiration without UI',async t=>{
 const f=fixture(t),root={};vm.runInNewContext(readFileSync(new URL('../theme/completed-uploads.js',import.meta.url),'utf8'),root);
 const a=root.BFLUploadLifecycle.create({now:f.now});a.pending('selection');assert.equal(a.snapshot().pending,1);
 const i=f.adapter.intent('owner-a','request-0001');a.apply(i,'selection');assert.equal(a.snapshot().pending,1);
 const done=await f.adapter.upload('owner-a',i.intent_id,image);a.apply(done);assert.equal(a.snapshot().pending,0);assert.equal(a.snapshot().completedAssetIds[0],aid);
 a.apply(i);a.apply(done);assert.equal(a.snapshot().completedAssetIds.length,1);
 assert.throws(()=>a.apply({...done,asset_id:bid}));f.advance(60000);assert.equal(a.snapshot().pending,1);
 const removed=f.adapter.remove('owner-a',i.intent_id);a.apply(removed);a.apply(done);assert.equal(a.snapshot().completedAssetIds.length,0);
 assert.throws(()=>a.apply({...done,version:removed.version+1}));assert.equal(root.BFLCompletedUploads,undefined);
});
test('F05B upload transition and lifecycle outbox roll back together on writer failure',async t=>{
 const f=fixture(t),done=await complete(f),before=f.store.uploadLedger.read(done.intent_id),original=f.store.invalidateUpload;
 f.store.invalidateUpload=()=>{throw Error('synthetic disk write failure');};
 assert.throws(()=>f.adapter.remove('owner-a',done.intent_id));assert.deepEqual(f.store.uploadLedger.read(done.intent_id),before);
 assert.equal(f.store.lifecycle.state().pending,0);assert.equal(f.store.uploads('owner-a',[aid]).length,1);
 assert.throws(()=>f.adapter.deleted(deletion()));
 const db=new DatabaseSync(f.path);assert.equal(db.prepare('SELECT count(*) AS n FROM upload_provider_deletions').get().n,0);db.close();
 f.store.invalidateUpload=original;f.adapter.remove('owner-a',done.intent_id);assert.equal(f.store.lifecycle.state().pending,1);
});
test('F05B owner retirement during relay prevents completion; failed entries may be dismissed without resurrection',async t=>{
 const f=fixture(t),i=f.adapter.intent('owner-a','request-0001');
 f.p.beforeInfo=async()=>f.store.revoke({id:'retired-owner-0001',kind:'owner',owner:'owner-a'});
 await assert.rejects(f.adapter.upload('owner-a',i.intent_id,image),/OWNER_REJECTED/);
 assert.throws(()=>f.store.uploads('owner-a',[aid]));assert.equal(f.store.uploadLedger.read(i.intent_id).state,'failed');
 const g=fixture(t),j=g.adapter.intent('owner-a','request-0001');g.p.fail=true;await assert.rejects(g.adapter.upload('owner-a',j.intent_id,image));
 const root={};vm.runInNewContext(readFileSync(new URL('../theme/completed-uploads.js',import.meta.url),'utf8'),root);const ui=root.BFLUploadLifecycle.create({now:g.now});
 ui.apply(await g.adapter.status('owner-a',j.intent_id));assert.equal(ui.snapshot().failed,1);
 ui.apply(g.adapter.remove('owner-a',j.intent_id));assert.equal(ui.snapshot().failed,0);assert.equal(ui.snapshot().completedAssetIds.length,0);
});
test('F05B startup expires stale complete assets and leaves durable revocation pending even with transport absent',async()=>{
 const cfg=runtimeConfig();cfg.databaseId=initializeDatabase(cfg);let time=Date.parse('2026-10-21T03:00:00Z');const now=()=>time;
 let s=openDatabase(cfg,{now});const p=provider(),a=createUploadcareAdapter({store:s.store,config:c,enabled:true,fetchImpl:p.fetch,now});
 const i=a.intent('owner-a','request-0001');await a.upload('owner-a',i.intent_id,image);s.close();time+=600000;
 s=openDatabase(cfg,{now});assert.equal(s.store.uploadLedger.read(i.intent_id).state,'failed');assert.equal(s.store.lifecycle.state().pending,1);
 assert.throws(()=>s.store.uploads('owner-a',[aid]));s.close();
});
test('F05B provider configuration is snapshotted and invalid CDN URLs cannot redirect authority',async t=>{
 const f=fixture(t),settings={...c},a=createUploadcareAdapter({store:f.store,config:settings,enabled:true,fetchImpl:f.p.fetch,now:f.now});
 settings.publicKey='foreign';settings.secret='changed';settings.cdnOrigin='https://evil.invalid';
 const i=a.intent('owner-a','request-0001'),r=await a.upload('owner-a',i.intent_id,image);assert.equal(r.asset_id,aid);
 assert.equal(f.store.uploads('owner-a',[aid])[0].url,`${c.delivery.origin}/${aid}/`);
});
test('F05B unready provider asset can omit final image metadata; pending never counts as completion',async t=>{
 const f=fixture(t);f.p.alter=info=>({uuid:info.uuid,url:info.url,datetime_removed:null,is_ready:false});
 const done=await complete(f);assert.equal(done.state,'pending');assert.throws(()=>f.store.uploads('owner-a',[aid]));
 f.p.alter=info=>info;assert.equal((await f.adapter.status('owner-a',done.intent_id)).state,'complete');
});
test('F05B failed expiry sweep closes runtime work gate and reports disabled transport explicitly',async t=>{
 const cfg=runtimeConfig();cfg.mode='reconcile-only';cfg.databaseId=initializeDatabase(cfg);const m=mockAdmin();
 const r=createRuntime(cfg,{api:mockApi(m),uploadcare:{config:c},now:adminNow});t.after(()=>r.close());
 await r.refresh();assert.ok(r.status().gates.includes('UPLOAD_TRANSPORT_DISABLED'));
 r.store.uploadLedger.sweep=()=>{throw Error('synthetic storage failure');};await r.refresh();
 assert.equal(r.status().recovery,'UNAVAILABLE');await assert.rejects(r.prepareAuthority({owner:'owner-a'}),/RECOVERY_REQUIRED/);
});

test('F05C private delivery rejects legacy public-only composition and preserves old intent binding',async t=>{
 const f=fixture(t),legacy={...c};delete legacy.delivery;
 const binding=uploadBinding(legacy),old=f.store.uploadLedger.create('owner-a','legacy-key',binding);
 assert.throws(()=>createUploadcareAdapter({store:f.store,config:legacy,enabled:true,fetchImpl:f.p.fetch}),/PRIVATE_DELIVERY_REQUIRED/);
 assert.throws(()=>f.adapter.intent('owner-a','legacy-key'),/PROJECT_CHANGED/);
 await assert.rejects(f.adapter.status('owner-a',old.id),/UNAVAILABLE/);
 for(const patch of [{publicAccessDisabled:false},{legacyAccessDisabled:false},{projectKey:'foreign'},{origin:c.cdnOrigin},{origin:'https://bad.invalid/path'},{origin:'https://user:pass@bad.invalid'},{origin:'https://bad.invalid:8443'}])
  assert.throws(()=>createUploadcareAdapter({store:f.store,config:{...c,delivery:{...c.delivery,...patch}},enabled:true}),/UPLOAD_/);
 assert.throws(()=>uploadBinding({...c,publicKey:'a6c28a58daf426c6c6ec'}),/TARGET_INVALID/);
});
test('F05C exact-path signed delivery is owner-bound, transient, bounded, and transform-separated',async t=>{
 const f=fixture(t),r=await complete(f),count=f.p.calls.length;
 await assert.rejects(f.adapter.delivery('owner-b',r.intent_id),/UNAVAILABLE/);assert.equal(f.p.calls.length,count);
 const original=await f.adapter.delivery('owner-a',r.intent_id,'original');
 const preview=await f.adapter.delivery('owner-a',r.intent_id,'preview');
 for(const [value,path] of [[original,`/${aid}/`],[preview,`/${aid}/-/resize/640x/`]]) {
  const u=new URL(value.url);assert.equal(u.origin,c.delivery.origin);assert.equal(u.pathname,path);
  const body=`exp=${Math.floor(f.now()/1000)+30}~acl=${path}`;
  assert.equal(u.searchParams.get('token'),body+'~hmac='+createHmac('sha256',Buffer.from(c.delivery.signingSecret,'hex')).update(body).digest('hex'));
  assert.equal(value.expires_at,f.now()+30000);assert.equal(value.checkout_ready,false);
 }
 assert.ok(!JSON.stringify(f.store.uploads('owner-a',[aid])).includes('token='));
 await assert.rejects(f.adapter.delivery('owner-a',r.intent_id,'../other'),/DELIVERY_INVALID/);
 f.adapter.remove('owner-a',r.intent_id);await assert.rejects(f.adapter.delivery('owner-a',r.intent_id),/NOT_COMPLETE/);
 // Existing signed URLs are bearer capabilities until expiry; local removal
 // stops NEW signatures but cannot recall a URL already issued by the CDN.
 assert.ok(original.expires_at>f.now());
});
test('F05C delivery revalidation and retired owner prevent signing; nested config cannot mutate',async t=>{
 const f=fixture(t),settings={...c,delivery:{...c.delivery}};
 const a=createUploadcareAdapter({store:f.store,config:settings,enabled:true,fetchImpl:f.p.fetch,now:f.now});
 const i=a.intent('owner-a','private-key');await a.upload('owner-a',i.intent_id,image);
 settings.delivery.origin='https://evil.invalid';settings.delivery.signingSecret='0'.repeat(64);
 assert.equal(new URL((await a.delivery('owner-a',i.intent_id)).url).origin,c.delivery.origin);
 f.p.beforeInfo=async()=>f.store.revoke({id:'retire-during-sign',kind:'owner',owner:'owner-a'});
 await assert.rejects(a.delivery('owner-a',i.intent_id));
});
test('F05C operator-pinned secure custom origin and secure REST URL are accepted without CDN fetch',async t=>{
 const f=fixture(t),config={...c,delivery:{...c.delivery,origin:'https://private.staging.invalid'}};
 f.p.alter=x=>({...x,original_file_url:`${config.delivery.origin}/${aid}/image.jpg`});
 const a=createUploadcareAdapter({store:f.store,config,enabled:true,fetchImpl:f.p.fetch,now:f.now});
 const i=a.intent('owner-a','custom-key');await a.upload('owner-a',i.intent_id,image);
 assert.equal(new URL((await a.delivery('owner-a',i.intent_id)).url).origin,config.delivery.origin);
 assert.ok(f.p.calls.every(x=>!x.url.includes('private.staging.invalid')));
});
test('F05C observed REST vendor JSON is accepted only for pinned API version and destination',async()=>{
 const types=['application/vnd.uploadcare-v0.7+json','application/vnd.uploadcare-v0.7+json; charset=utf-8'];
 for(const type of types){
  const tr=createUploadcareTransport(c,{enabled:true,fetchImpl:async url=>response(url.endsWith('/project/')?{pub_key:c.publicKey}:{uuid:aid},200,{'content-type':type})});
  assert.equal((await tr.info(aid)).uuid,aid);
 }
 for(const type of ['application/vnd.uploadcare-v0.6+json','application/vnd.other+json']){
  const tr=createUploadcareTransport(c,{enabled:true,fetchImpl:async()=>response({pub_key:c.publicKey},200,{'content-type':type})});
  await assert.rejects(tr.info(aid),/PROVIDER_INVALID/);
 }
 const tr=createUploadcareTransport(c,{enabled:true,fetchImpl:async url=>response(url.endsWith('/project/')?{pub_key:c.publicKey}:{file:aid},200,{'content-type':'application/vnd.uploadcare-v0.7+json'})});
 await assert.rejects(tr.upload('intent',image.bytes,image.mime),/PROVIDER_INVALID/);
});

function staggeredProofs(t,{step=2000,removed=false,beforeInfo=()=>{}}={}) {
 const f=fixture(t),ids=[aid,bid],intents=[],originalExpires=[];
 for(const [i,asset] of ids.entries()){
  const r=f.store.uploadLedger.create('owner-a',`staggered-${i}`,uploadBinding(c));
  f.store.uploadLedger.claim('owner-a',r.id,uploadBinding(c),{digest:createHash('sha256').update(image.bytes).digest('hex'),size:image.bytes.length,mime:image.mime});
  const pending=f.store.uploadLedger.bind('owner-a',r.id,uploadBinding(c),asset);
  f.store.uploadLedger.complete('owner-a',r.id,uploadBinding(c),pending.version,`${c.delivery.origin}/${asset}/`);
  intents.push(r.id);originalExpires.push(r.expires);
 }
 // First row has one second left; second is already stale.
 const db=new DatabaseSync(f.path);
 db.prepare('UPDATE upload_intents SET checked_until=? WHERE id=?').run(f.now()+1000,intents[0]);
 db.prepare('UPDATE upload_intents SET checked_until=? WHERE id=?').run(f.now()-1,intents[1]);db.close();
 const calls=[];
 const adapter=createUploadcareAdapter({store:f.store,config:c,enabled:true,now:f.now,concurrency:4,fetchImpl:async url=>{
  calls.push(url);
  if(url.endsWith('/project/'))return response({pub_key:c.publicKey});
  const asset=ids.find(id=>url===`https://api.uploadcare.com/files/${id}/`);assert.ok(asset);
  f.advance(step);await beforeInfo({f,asset,intents});
  return response({uuid:asset,url,mime_type:image.mime,size:image.bytes.length,is_ready:true,is_image:true,
   datetime_removed:removed?'2026-10-21T04:00:00Z':null,datetime_uploaded:'2026-10-21T00:00:00Z',datetime_stored:'2026-10-21T00:00:00Z',original_file_url:`${c.cdnOrigin}/${asset}/image.jpg`});
 }});
 return {...f,adapter,ids,intents,originalExpires,calls};
}
test('maintenance tolerates proof aging during a partial pass without granting aggregate use or extending intent expiry',async t=>{
 const f=staggeredProofs(t),prior=f.store.uploadLedger.read(f.intents[0]).checked_until;
 await f.adapter.refresh('owner-a',f.ids);
 assert.equal(f.store.uploadLedger.read(f.intents[0]).checked_until,prior);
 assert.throws(()=>f.store.uploads('owner-a',f.ids),/REVALIDATION_REQUIRED/);
 assert.deepEqual(f.intents.map(id=>f.store.uploadLedger.read(id).expires),f.originalExpires);
 assert.equal(f.calls.filter(url=>url.includes('/files/')).length,1);
 assert.equal(f.calls.some(url=>url.endsWith('/base/')),false);
 assert.ok(f.intents.every(id=>f.store.uploadLedger.read(id).state==='complete'));
});
test('strict validation refreshes the entire mixed-age set and retains the final aggregate check',async t=>{
 const f=staggeredProofs(t);await f.adapter.validate('owner-a',f.ids,{fresh:false});
 assert.equal(f.calls.filter(url=>url.includes('/files/')).length,2);
 assert.equal(f.store.uploads('owner-a',f.ids).length,2);
 assert.deepEqual(f.intents.map(id=>f.store.uploadLedger.read(id).expires),f.originalExpires);
});
test('maintenance cannot revive removal, foreign owners, original expiry or provider deletion',async t=>{
 const f=staggeredProofs(t);
 await assert.rejects(f.adapter.refresh('owner-b',f.ids),/UNAVAILABLE/);assert.equal(f.calls.length,0);
 f.adapter.remove('owner-a',f.intents[0]);await assert.rejects(f.adapter.refresh('owner-a',f.ids),/NOT_COMPLETE/);
 const expired=staggeredProofs(t);expired.advance(600000);
 await assert.rejects(expired.adapter.refresh('owner-a',expired.ids),/NOT_COMPLETE/);assert.equal(expired.calls.length,0);
 const deleted=staggeredProofs(t,{removed:true});await assert.rejects(deleted.adapter.refresh('owner-a',deleted.ids),/REMOVED/);
 assert.equal(deleted.store.uploadLedger.read(deleted.intents[1]).state,'removed');
});
test('maintenance cannot promote a row removed during its probe',async t=>{
 const f=staggeredProofs(t,{beforeInfo:({f,intents})=>f.adapter.remove('owner-a',intents[1])});
 await assert.rejects(f.adapter.refresh('owner-a',f.ids),/STALE/);
 assert.equal(f.store.uploadLedger.read(f.intents[1]).state,'removed');
});
test('a strict batch that outlives its first refreshed proof remains unavailable',async t=>{
 const f=staggeredProofs(t,{step:0});let count=0;
 // One worker creates a real stagger: each later probe consumes over a proof lifetime.
 const adapter=createUploadcareAdapter({store:f.store,config:c,enabled:true,now:f.now,concurrency:1,fetchImpl:async url=>{
  if(url.endsWith('/project/'))return response({pub_key:c.publicKey});
  const asset=f.ids[count++];f.advance(61000);
  return response({uuid:asset,url,mime_type:image.mime,size:image.bytes.length,is_ready:true,is_image:true,datetime_removed:null,
   datetime_uploaded:'2026-10-21T00:00:00Z',datetime_stored:'2026-10-21T00:00:00Z',original_file_url:`${c.cdnOrigin}/${asset}/image.jpg`});
 }});
 await assert.rejects(adapter.validate('owner-a',f.ids,{fresh:false}),/REVALIDATION_REQUIRED/);
 assert.deepEqual(f.intents.map(id=>f.store.uploadLedger.read(id).expires),f.originalExpires);
});
test('a queued strict probe re-reads a row already refreshed by a concurrent status request',async t=>{
 const f=staggeredProofs(t);let crossed=false,adapter;
 adapter=createUploadcareAdapter({store:f.store,config:c,enabled:true,now:f.now,concurrency:1,fetchImpl:async url=>{
  if(url.endsWith('/project/'))return response({pub_key:c.publicKey});
  const asset=f.ids.find(id=>url.includes(id));assert.ok(asset);
  if(asset===aid&&!crossed){crossed=true;await adapter.status('owner-a',f.intents[1]);}
  return response({uuid:asset,url,mime_type:image.mime,size:image.bytes.length,is_ready:true,is_image:true,datetime_removed:null,
   datetime_uploaded:'2026-10-21T00:00:00Z',datetime_stored:'2026-10-21T00:00:00Z',original_file_url:`${c.cdnOrigin}/${asset}/image.jpg`});
 }});
 await adapter.validate('owner-a',f.ids,{fresh:false});assert.equal(crossed,true);
 assert.equal(f.store.uploads('owner-a',f.ids).length,2);
 assert.ok(f.intents.every(id=>f.store.uploadLedger.read(id).state==='complete'));
});
for(const outcome of ['refresh','removed','expired'])test(`job admission rechecks proofs aged during catalog lookup: ${outcome}`,async t=>{
 const f=fixture(t),done=await complete(f),m=mockAdmin();
 const {createAuthorityAdmin}=await import('../checkout/shopify.mjs');
 const context=await createAuthorityAdmin(m.api,{writesEnabled:true,lifecycle:f.store.lifecycle,now:adminNow}).read();
 f.advance(59000);let admissions=0,catalogRead=false;
 const jobs=createJobService({store:f.store,loader:{load:async()=>context.release},loadCatalog:async()=>{
  if(!catalogRead){catalogRead=true;f.advance(outcome==='expired'?600000:2000);if(outcome==='removed')f.p.removed='2026-10-21T04:00:00Z';}
  return context.catalog;
 },secret:'synthetic-job-key'.repeat(3),beforeSave:()=>admissions++,validateUploads:(o,ids)=>f.adapter.validate(o,ids,{fresh:false})});
 const selection={request_key:'aged-during-catalog',copies:4,service:'Photo Prints',size:'4x6',paper:'synthetic-paper',lab:'miami',asset_ids:[done.asset_id],options:{}};
 if(outcome==='refresh'){const result=await jobs.prepare('owner-a',selection);assert.equal(result.file_count,1);assert.equal(admissions,1);}
 else {await assert.rejects(jobs.prepare('owner-a',selection));assert.equal(admissions,0);const db=new DatabaseSync(f.path);assert.equal(db.prepare('SELECT count(*) AS n FROM jobs').get().n,0);db.close();}
});
