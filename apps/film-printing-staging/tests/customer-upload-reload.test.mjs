import test from 'node:test';
import assert from 'node:assert/strict';
import {fullRig} from '../../../fixtures/film-printing/f06p-engineering/full-rig.mjs';
import {createResourceSession} from '../theme/resource-session.js';
import {createCustomerCheckout} from '../theme/customer-checkout.js';
import {createOwnedUploads} from '../theme/owned-uploads.js';
import '../theme/completed-uploads.js';
import '../theme/upload-transport.js';

async function selected(t){
 const f=await fullRig(t,{customerFlow:true,customerJobs:2,customerEdits:true}),data=new Map();
 const saved={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)};
 const session=()=>createResourceSession({fetchImpl:f.browserFetch,now:()=>f.clock.time,reloadStorage:saved});
 const original=session();await original.issue();const act=(action,id=f.ids.A)=>original.checkout(action,async()=>id);
 await act('bind');await act('install');
 const uploads=createOwnedUploads({},original),receipts=[];
 for(const [i,file] of f.inputFiles.slice(0,2).entries()){
  const {intent_id}=await uploads.intent('selection-reload-'+i);
  receipts.push(await uploads.bytes(intent_id,new Blob([file.bytes],{type:file.mime})));
 }
 original.checkpoint('uploads');
 return Object.assign(f,{saved,session,original,act,uploads,receipts});
}
test('completed local selection resumes without upload, admission, deadline or job replay and creates one exact immutable job',async t=>{
 const f=await selected(t),before=f.rows(),uploads=f.counts.uploads;
 const restored=f.session();assert.equal(restored.restore(),'uploads');
 const actions={getCart:async()=>({cart:{id:f.ids.A,lines:[],totalQuantity:0}}),updateCart:async()=>{assert.fail('resume must not mutate cart');}};
 const result=await createCustomerCheckout(restored,{actions}).initialize({resumeUploads:true});
 assert.deepEqual(result.uploads.map(r=>r.receipt.asset_id),f.receipts.map(r=>r.asset_id));
 assert.deepEqual(result.uploads.map(r=>r.file.sha256),f.inputFiles.slice(0,2).map(r=>r.sha256));
 const after=f.rows();for(const key of ['resource_sessions','resource_admissions','checkout_owner_admissions','jobs'])assert.deepEqual(after[key],before[key]);
 assert.equal(f.counts.uploads,uploads);assert.equal(f.runtime.status().counts.issue,1);assert.equal(f.runtime.status().counts.bind,1);
 const transport=globalThis.BFLUploadTransport.create({enabled:true,client:createOwnedUploads({},restored),lifecycle:globalThis.BFLUploadLifecycle.create({now:()=>f.clock.time})});
 const rows=transport.restore(result.uploads);assert.equal(rows.length,2);assert.equal(transport.snapshot().displayCompletedCount,2);assert.equal(transport.snapshot().pending,0);
 await transport.refreshCompleted();
 const job=await restored.request('/jobs',{...f.plan.selection,asset_ids:transport.snapshot().completedAssetIds,copies:3,request_key:'restored-selection-job'});
 assert.deepEqual(JSON.parse(f.rows().jobs[0].body).files.map(f=>f.sha256).sort(),f.inputFiles.slice(0,2).map(f=>f.sha256).sort());
 assert.equal(job.item.quantity,3);assert.equal(f.rows().jobs.length,1);assert.equal(f.counts.uploads,uploads);
 await assert.rejects(f.act('resume_uploads')); // no recovery beyond first submission
});
test('copied completed IDs and marker in a different full cart cannot recover the original selection',async t=>{
 const f=await selected(t),copied=structuredClone(f.carts.get(f.ids.A));copied.cart.id=f.ids.B;f.carts.set(f.ids.B,copied);
 await assert.rejects(f.act('resume_uploads',f.ids.B));await assert.rejects(f.act('resume_uploads',f.ids.A.split('?')[0]));
 assert.equal((await f.act('resume_uploads')).uploads.length,2);assert.equal(f.counts.uploads,2);
});
test('pending upload and uncertain crop remain blocked despite forged browser checkpoint',async t=>{
 const f=await selected(t);await f.uploads.intent('pending-third-local');
 f.original.checkpoint('uploads');await assert.rejects(f.act('resume_uploads'));assert.equal(f.counts.uploads,2);
});
test('uncertain crop excludes a completed selection even when original asset remains',async t=>{
 const f=await selected(t);f.hook=async(stage)=>{if(stage==='provider')throw Error('uncertain crop');};
 await assert.rejects(f.uploads.crop(f.receipts[0].intent_id,{left:0,top:0,width:8,height:8}));f.hook=null;
 await assert.rejects(f.act('resume_uploads'));assert.equal(f.counts.uploads,2);
});
test('revoked and expired original authority cannot be replaced by saved upload metadata',async t=>{
 for(const action of ['revoke','expire'])await t.test(action,async t=>{
  const f=await selected(t),saved=f.saved.getItem('bfl:accepted-cart-session:v1');
  if(action==='revoke')await f.original.revoke();else f.clock.time+=301000;
  const value=JSON.parse(saved);value.expires=f.clock.time+60000;f.saved.setItem('bfl:accepted-cart-session:v1',JSON.stringify(value));
  const restored=f.session();assert.equal(restored.restore(),'uploads');await assert.rejects(restored.checkout('resume_uploads',async()=>f.ids.A));assert.equal(f.runtime.status().counts.issue,1);
 });
});
test('uncertain local request invalidates saved recovery before send with no automatic retry',async t=>{
 const f=await selected(t);let sends=0;
 const next=createResourceSession({reloadStorage:f.saved,now:()=>f.clock.time,fetchImpl:async()=>{sends++;assert.throws(()=>f.session().restore());throw Error('lost');}});
 assert.equal(next.restore(),'uploads');await assert.rejects(next.request('/uploads/intents',{request_key:'next-local-file'}));assert.equal(sends,1);assert.throws(()=>f.session().restore());
});

test('form restores selection/count and removal without raw files or a second transfer; synchronous pending work blocks checkpoint',async t=>{
 const {createFilmPrintingForm}=await import('../theme/film-printing-form.js');
 const f=await fullRig(t,{customerFlow:true,customerJobs:2,customerEdits:true}),data=new Map();
 const saved={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)};
 const create=globalThis.BFLUploadLifecycle.create;globalThis.BFLUploadLifecycle.create=()=>create({now:()=>f.clock.time});
 t.after(()=>{globalThis.BFLUploadLifecycle.create=create;});
 class Form extends EventTarget{dataset={filmPrintingForm:''};querySelector(){return null;}querySelectorAll(){return [];}}
 const actions={getCart:async()=>({cart:{id:f.ids.A,lines:[],totalQuantity:0}}),updateCart:async()=>assert.fail('unexpected native write')};
 const make=()=>createFilmPrintingForm(new Form(),{sessionOptions:{fetchImpl:f.browserFetch,now:()=>f.clock.time,reloadStorage:saved},checkoutForSession:session=>createCustomerCheckout(session,{actions})});
 const flow=make();await flow.issue();
 const rows=flow.select(f.inputFiles.slice(0,2).map((f,i)=>new File([f.bytes],`fixture${i}.png`,{type:f.mime})));
 assert.equal(JSON.parse(saved.getItem('bfl:accepted-cart-session:v1')).state,'blocked');
 await Promise.all(rows.map(r=>r.completion));for(const row of rows)await flow.selectionReady(row.key);
 assert.equal(JSON.parse(saved.getItem('bfl:accepted-cart-session:v1')).state,'uploads');
 const restored=make(),receipt=await restored.issue();assert.equal(receipt.selections.length,2);
 for(const row of receipt.selections)await restored.selectionReady(row.key);
 assert.equal(restored.snapshot().displayCompletedCount,2);assert.equal(restored.snapshot().pending,0);assert.equal(f.counts.uploads,2);
 await restored.remove(receipt.selections[0].key);assert.equal(restored.snapshot().displayCompletedCount,1);assert.equal(f.counts.uploads,2);
});
