import test from 'node:test';
import assert from 'node:assert/strict';
import {fullRig} from '../../../fixtures/film-printing/f06v3-candidate/full-rig.mjs';
import {createResourceSession} from '../theme/resource-session.js';
import {quantitySignature} from '../checkout/quantity-signature.js';
const selection={service:'Fine Arts',size:'16” × 20”',paper:'Luster',lab:'Chicago',options:{Borders:'Borderless (Edge-to-edge)',Turnaround:'Standard (4-5 days)'},copies:1,message:''};
async function setup(t,{first=true,fullProduct=true}={}){
 const f=await fullRig(t,{fullProduct,sourceFlow:true});let requested;
 const fetchImpl=async(url,options={})=>{
  if(new URL(url,'https://bellows-film-printing-staging.myshopify.com').pathname==='/checkout/resume_uploads'&&requested!==undefined)options={...options,body:JSON.stringify({...JSON.parse(options.body),selection:requested})};
  return f.browserFetch(url,options);
 };
 const session=createResourceSession({fetchImpl,now:()=>f.clock.time,preparedMode:true});
 const act=(name,input={})=>session.checkout(name,async()=>f.ids.A,input);
 await session.issue();await act('bind');await act('install');let counter=0,generation=0;
 const upload=async(kind='local')=>{
  const intent=await session.request('/uploads/intents',{request_key:`recovery-upload-${++counter}`}),file=f.inputFiles[counter%f.inputFiles.length];
  const receipt=kind==='source'?await session.request(`/uploads/${intent.intent_id}/source`,{url:file.source_url}):await session.request(`/uploads/${intent.intent_id}/bytes`,new Blob([file.bytes],{type:file.mime}),{mime:file.mime});
  return {intent,receipt};
 };
 const prepare=async asset=>{
  const spec=fullProduct?selection:f.plan.selection;
  const job=await session.request('/jobs',{...spec,asset_ids:[asset.receipt.asset_id],request_key:`recovery-job-${++generation}`});
  return act('eligible',{reference:job.reference,generation});
 };
 const add=async prepared=>{
  const state=f.carts.get(f.ids.A),prior=state.cart.lines.nodes.slice();
  f.addJob({...prepared.item,properties:{...prepared.item.properties,_bfl_signature:quantitySignature(prepared.reference.signature,prepared.item.quantity)}});
  const fresh=state.cart.lines.nodes[0];fresh.quantity=prepared.item.quantity;fresh.id=`gid://shopify/CartLine/recovery-${prepared.reference.id}?cart=synthetic`;state.cart.lines.nodes=[...prior,fresh];f.reprice();
  return act('resume',{operation:{kind:'add',job:prepared.reference.id,operation_id:prepared.reservation.operation_id,quantity:prepared.item.quantity}});
 };
 let a=null;if(first){const asset=await upload(),prepared=await prepare(asset);await add(prepared);a={...asset,prepared};}
 return {...f,set hook(value){f.hook=value;},session,act,upload,prepare,add,a,recover:ids=>{requested={version:'uncommitted-v1',intent_ids:ids};return act('resume_uploads');},rawRecover:value=>{requested=value;return act('resume_uploads');}};
}
for(const kind of ['local','source'])test(`completed ${kind} selection B recovers exactly beside accepted A without transfer, publication, ownership or deadline changes`,async t=>{
 const f=await setup(t),b=await f.upload(kind),other=await f.upload();
 const before=f.rows(),counts={uploads:f.counts.uploads,admin_mutations:f.counts.admin_mutations},cart=structuredClone(f.carts.get(f.ids.A));
 const result=await f.recover([b.intent.intent_id]);
 assert.equal(result.upload_recovery,'uncommitted-v1');assert.equal(result.expires_at,f.a.prepared.expires_at);assert.equal(result.items.length,1);assert.equal(result.items[0].properties._bfl_job,f.a.prepared.reference.id);
 assert.deepEqual(result.uploads.map(u=>u.receipt.intent_id),[b.intent.intent_id]);assert.deepEqual(result.uploads.map(u=>u.receipt.asset_id),[b.receipt.asset_id]);assert.ok(!result.uploads.some(u=>u.receipt.intent_id===other.intent.intent_id));
 for(const name of ['resource_sessions','resource_admissions','checkout_owner_admissions','cart_checkout_bindings','jobs','cart_prepared_jobs'])assert.deepEqual(f.rows()[name],before[name],name);
 assert.equal(f.counts.uploads,counts.uploads);assert.equal(f.counts.admin_mutations,counts.admin_mutations);assert.deepEqual(f.carts.get(f.ids.A),cart);
});
test('initial completed source selection receives capability and recovers without a pricing lease',async t=>{
 const f=await setup(t,{first:false});assert.equal((await f.act('current')).upload_recovery,'uncommitted-v1');const b=await f.upload('source'),result=await f.recover([b.intent.intent_id]);
 assert.deepEqual(result.items,[]);assert.equal(result.uploads[0].receipt.asset_id,b.receipt.asset_id);assert.equal(f.rows().jobs.length,0);
});
test('issued B must settle exact authenticated cancellation before its selected files can recover with A',async t=>{
 const f=await setup(t),b=await f.upload(),prepared=await f.prepare(b);await assert.rejects(f.recover([b.intent.intent_id]));
 const resumed=await f.act('resume',{operation:{kind:'prepared',operation_id:prepared.reservation.operation_id,job:prepared.reference.id,generation:prepared.generation}});
 assert.deepEqual(resumed.prepared_recovery,{reservation:prepared.reservation,state:'issued'});
 const result=await f.act('cancel_preparation',{reservation:resumed.prepared_recovery.reservation});assert.equal(result.cancelled,true);
 const before=f.rows(),recovered=await f.recover([b.intent.intent_id]);assert.equal(recovered.items.length,1);assert.equal(recovered.items[0].properties._bfl_job,f.a.prepared.reference.id);assert.equal(recovered.expires_at,f.a.prepared.expires_at);
 assert.equal(recovered.uploads[0].receipt.asset_id,b.receipt.asset_id);assert.deepEqual(f.rows().jobs,before.jobs);assert.deepEqual(f.rows().cart_prepared_jobs,before.cart_prepared_jobs);
});
test('confirmed A files, unknown or malformed selections, and pending B never recover as a new selection',async t=>{
 const f=await setup(t),pending=await f.session.request('/uploads/intents',{request_key:'recovery-pending'});
 for(const value of [
  {version:'uncommitted-v1',intent_ids:[f.a.intent.intent_id]},
  {version:'uncommitted-v1',intent_ids:['00000000-0000-4000-8000-999999999999']},
  {version:'uncommitted-v1',intent_ids:[pending.intent_id]},
  {version:'uncommitted-v1',intent_ids:[]},
  {version:'uncommitted-v1',intent_ids:[pending.intent_id,pending.intent_id]},
  {version:'uncommitted-v1',intent_ids:[pending.intent_id],extra:true},
  {version:'other',intent_ids:[pending.intent_id]},
 ])await assert.rejects(f.rawRecover(value));
 assert.equal(f.rows().jobs.length,1);assert.equal(f.counts.uploads,1);
});
test('legacy source policy cannot opt into exact next-selection recovery',async t=>{
 const f=await setup(t,{first:false,fullProduct:false});assert.equal((await f.act('current')).upload_recovery,undefined);const b=await f.upload();await assert.rejects(f.recover([b.intent.intent_id]));
});
test('first prepared selection recovers after verified cancellation with no surviving print lines',async t=>{
 const f=await setup(t,{first:false}),b=await f.upload('source'),prepared=await f.prepare(b);
 const observed=await f.act('resume',{operation:{kind:'prepared',operation_id:prepared.reservation.operation_id,job:prepared.reference.id,generation:prepared.generation}});
 assert.equal(observed.prepared_recovery.state,'issued');await f.act('cancel_preparation',{reservation:observed.prepared_recovery.reservation});
 const recovery=await f.recover([b.intent.intent_id]);assert.deepEqual(recovery.items,[]);assert.equal(recovery.uploads[0].receipt.asset_id,b.receipt.asset_id);assert.equal(recovery.expires_at,prepared.expires_at);
});
test('full-product exact metadata supports the existing 1000-selection bound while rejecting larger input',async t=>{
 const f=await setup(t,{first:false});await f.upload();
 const ids=Array.from({length:1000},(_,i)=>`00000000-0000-4000-8000-${String(i+10000).padStart(12,'0')}`);
 await assert.rejects(f.recover(ids));assert.equal(f.journal().filter(e=>e.event==='action_failed').at(-1).code,'UPLOAD_RECOVERY_UNAVAILABLE');
 await assert.rejects(f.recover([...ids,'00000000-0000-4000-8000-999999999999']));assert.equal(f.journal().filter(e=>e.event==='action_failed').at(-1).code,'DIAGNOSTIC_BODY');
});
test('an uncertain remote import is not recovered or automatically reimported',async t=>{
 const f=await setup(t,{first:false}),intent=await f.session.request('/uploads/intents',{request_key:'unknown-source'});let imports=0;
 f.hook=async stage=>{if(stage==='source'){imports++;throw Error('synthetic interrupted source');}};
 await assert.rejects(f.session.request(`/uploads/${intent.intent_id}/source`,{url:f.inputFiles[0].source_url}));
 await assert.rejects(f.recover([intent.intent_id]));assert.equal(imports,1);assert.equal(f.counts.uploads,0);assert.equal(f.rows().jobs.length,0);
});
test('recovered completed source B can prepare again and Add once beside unchanged A after old B cancellation',async t=>{
 const f=await setup(t),b=await f.upload('source'),held=await f.prepare(b);
 const observed=await f.act('resume',{operation:{kind:'prepared',operation_id:held.reservation.operation_id,job:held.reference.id,generation:held.generation}});
 await f.act('cancel_preparation',{reservation:observed.prepared_recovery.reservation});
 const count=f.counts.uploads,recovered=await f.recover([b.intent.intent_id]);
 const next=await f.prepare({intent:b.intent,receipt:recovered.uploads[0].receipt});assert.notEqual(next.reference.id,held.reference.id);
 const result=await f.add(next);assert.equal(result.items.length,2);assert.deepEqual(new Set(result.items.map(item=>item.properties._bfl_job)),new Set([f.a.prepared.reference.id,next.reference.id]));
 assert.equal(result.expires_at,f.a.prepared.expires_at);assert.equal(f.counts.uploads,count);
 assert.equal(f.rows().cart_prepared_jobs.find(row=>row.job_id===held.reference.id).state,'cancelled');
 assert.equal(f.rows().cart_prepared_jobs.find(row=>row.job_id===next.reference.id).state,'confirmed');
});
