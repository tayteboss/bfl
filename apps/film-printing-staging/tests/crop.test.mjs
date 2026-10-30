import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createJobStore} from '../jobs/service.mjs';
import {createUploadcareAdapter} from '../uploads/uploadcare.mjs';
import {cropModifiers,signDelivery} from '../uploads/delivery.mjs';
import {STORE,APP} from '../configuration/schema.mjs';
import '../theme/completed-uploads.js';
import '../theme/upload-transport.js';
const id='11111111-2222-4333-8444-555555555555';
const config={store:STORE,app:APP,publicKey:'synthetic-project-key',cdnOrigin:'https://synthetic.ucarecd.net',secret:'synthetic-provider-secret-value',projectId:73,
 delivery:{projectKey:'synthetic-project-key',origin:'https://synthetic.s.ucarecd.net',publicAccessDisabled:true,legacyAccessDisabled:true,signingSecret:'a'.repeat(64)}};
const crop={left:10,top:20,width:40,height:30};
const hash=b=>createHash('sha256').update(b).digest('hex');
function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'bfl-crop-')),store=createJobStore(join(dir,'jobs.sqlite'));
 t.after(()=>{store.close();rmSync(dir,{recursive:true});});
 const original=Buffer.from('synthetic original'),png=Buffer.alloc(24);Buffer.from([137,80,78,71,13,10,26,10]).copy(png);png.write('IHDR',12);png.writeUInt32BE(40,16);png.writeUInt32BE(30,20);
 const state={urls:[],afterDownload:null};
 const fetchImpl=async(url)=>{
   state.urls.push(url);const json=v=>Response.json(v);
   if(url.endsWith('/project/'))return json({pub_key:config.publicKey});
   if(url.endsWith('/base/'))return json({file:id});
   if(url===`https://api.uploadcare.com/files/${id}/`)return json({uuid:id,url,is_ready:true,is_image:true,mime_type:'image/png',size:original.length,datetime_removed:null,datetime_uploaded:'2026-10-28T00:00:00Z',datetime_stored:'2026-10-28T00:00:00Z',original_file_url:`${config.cdnOrigin}/${id}/`,content_info:{image:{width:100,height:80}}});
   assert.equal(new URL(url).origin,config.delivery.origin);state.afterDownload?.();return new Response(png,{headers:{'content-type':'image/png'}});
 };
 const adapter=createUploadcareAdapter({store,config,enabled:true,fetchImpl});
 return {store,adapter,state,original,png};
}
async function upload(f){const r=f.adapter.intent('owner-a','request-crop-001');await f.adapter.upload('owner-a',r.intent_id,{bytes:f.original,mime:'image/png'});return r.intent_id;}
test('crop verifies exact derived bytes while preserving original ownership and ledger',async t=>{
 const f=fixture(t),intent=await upload(f),result=await f.adapter.crop('owner-a',intent,crop);
 assert.equal(result.file.sha256,hash(f.png));assert.equal(result.file.original.sha256,hash(f.original));assert.deepEqual(result.file.crop,crop);
 assert.equal(result.file.id,id);assert.equal(result.file.url,`${config.delivery.origin}/${id}/-/crop/40x30/10,20/-/format/png/`);
 assert.equal(f.store.uploadLedger.read(intent).digest,hash(f.original));assert.equal(f.store.uploadLedger.read(intent).asset,id);
 assert.deepEqual(f.store.uploads('owner-a',[id]),[{id,url:`${config.delivery.origin}/${id}/`}]);
 const path=new URL(result.url).pathname;assert.ok(new URL(result.url).searchParams.get('token').includes(`~acl=${path}~hmac=`));
 await assert.rejects(f.adapter.crop('owner-b',intent,crop));
 f.adapter.remove('owner-a',intent);await assert.rejects(f.adapter.crop('owner-a',intent,crop));
});
test('crop rejects oversized, fractional, extra-field and out-of-bounds rectangles',async t=>{
 const f=fixture(t),intent=await upload(f);
 for(const bad of [{...crop,width:0},{...crop,left:-1},{...crop,top:1.5},{...crop,url:'https://evil.invalid'},{...crop,width:100001},{...crop,width:100,height:80}])await assert.rejects(f.adapter.crop('owner-a',intent,bad));
 assert.equal(f.state.urls.filter(u=>u.startsWith(config.delivery.origin)).length,0);
 assert.throws(()=>cropModifiers({...crop,width:10000,height:10000}));
 assert.throws(()=>signDelivery(config,id,'crop',Date.now(),Date.now()+60000));
});
test('crop cannot return derivative after removal during download',async t=>{
 const f=fixture(t),intent=await upload(f);f.state.afterDownload=()=>f.adapter.remove('owner-a',intent);
 await assert.rejects(f.adapter.crop('owner-a',intent,crop));
});
test('uncertain crop blocks submission and cannot be replayed or cleared by status; removal is available',async()=>{
 let calls=0;let version=1;const receipt=()=>({schema:1,intent_id:id,asset_id:id,state:'complete',version:version++,expires_at:Date.now()+60000,checkout_ready:false});
 const client={intent:async()=>receipt(),bytes:async()=>receipt(),status:async()=>receipt(),crop:async()=>{calls++;throw Error('uncertain');},remove:async()=>({...receipt(),state:'removed',asset_id:null})};
 const transport=BFLUploadTransport.create({enabled:true,client,id:()=> 'request-crop-001'});
 await transport.select('file',new Blob(['x'],{type:'image/png'}));
 const work=transport.crop('file',Promise.resolve(crop));assert.ok(transport.snapshot().pending>0);await assert.rejects(work);
 await transport.refresh('file');await assert.rejects(transport.refreshCompleted());
 assert.throws(()=>transport.crop('file',crop));assert.equal(calls,1);
 await transport.remove('file');await transport.refreshCompleted();assert.equal(transport.snapshot().completedAssetIds.length,0);
});

test('immutable job captures the selected crop and rejects same-key crop changes',async t=>{
 const f=fixture(t),intent=await upload(f);let result=await f.adapter.crop('owner-a',intent,crop);
 const {mockAdmin,now}=await import('../../../fixtures/film-printing/f06d/mock-admin.mjs');
 const {createAuthorityAdmin}=await import('../checkout/shopify.mjs');const {createJobService}=await import('../jobs/service.mjs');
 const admin=createAuthorityAdmin(mockAdmin().api,{writesEnabled:true,lifecycle:f.store.lifecycle,now});const context=await admin.read();
 const service=createJobService({store:f.store,loader:{load:async()=>context.release},loadCatalog:async()=>context.catalog,secret:'synthetic-job-key'.repeat(3),validateUploads:(o,ids)=>f.adapter.validate(o,ids),resolveFiles:()=>[result.file]});
 const input={request_key:'job-crop-001',copies:2,service:'Photo Prints',size:'4x6',paper:'synthetic-paper',lab:'miami',asset_ids:[id],options:{}};
 const prepared=await service.prepare('owner-a',input),job=f.store.get(prepared.reference.id,'owner-a'),saved=JSON.stringify(job);
 assert.equal(job.files[0].sha256,hash(f.png));assert.deepEqual(job.files[0].crop,crop);assert.equal(job.files[0].original.sha256,hash(f.original));
 assert.equal(prepared.item.properties['Uploaded File 1'],job.files[0].url);assert.equal(prepared.file_count,1);assert.equal(prepared.item.quantity,2);
 assert.deepEqual((await service.prepare('owner-a',input)).reference,prepared.reference);
 result={file:{...result.file,crop:{...crop,left:11}}};await assert.rejects(service.prepare('owner-a',input),/IDEMPOTENCY_CONFLICT/);
 assert.equal(JSON.stringify(f.store.get(prepared.reference.id,'owner-a')),saved);
});
