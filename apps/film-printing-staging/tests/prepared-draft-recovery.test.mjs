import test from 'node:test';
import assert from 'node:assert/strict';
import {fullRig} from '../../../fixtures/film-printing/f06v3-candidate/full-rig.mjs';
import {createResourceSession} from '../theme/resource-session.js';
import {quantitySignature} from '../checkout/quantity-signature.js';

async function rig(t){
 const f=await fullRig(t,{fullProduct:true});let selection,number=0,generation=0;
 const session=createResourceSession({now:()=>f.clock.time,preparedMode:true,fetchImpl:(url,options={})=>{
  if(new URL(url,'https://bellows-film-printing-staging.myshopify.com').pathname==='/checkout/resume_uploads')options={...options,body:JSON.stringify({...JSON.parse(options.body),selection})};
  return f.browserFetch(url,options);
 }});
 const act=(name,input={})=>session.checkout(name,async()=>f.ids.A,input);
 await session.issue();await act('bind');await act('install');
 async function upload(){const intent=await session.request('/uploads/intents',{request_key:`draft-file-${++number}`}),file=f.inputFiles[0];const receipt=await session.request(`/uploads/${intent.intent_id}/bytes`,new Blob([file.bytes],{type:file.mime}),{mime:file.mime});return {intent,receipt};}
 async function prepare(file){const job=await session.request('/jobs',{...f.plan.selection,copies:1,asset_ids:[file.receipt.asset_id],request_key:`draft-job-${++generation}`});return act('eligible',{reference:job.reference,generation});}
 async function add(prepared){const state=f.carts.get(f.ids.A),prior=state.cart.lines.nodes.slice();f.addJob({...prepared.item,properties:{...prepared.item.properties,_bfl_signature:quantitySignature(prepared.reference.signature,1)}});const line=state.cart.lines.nodes[0];line.id=`gid://shopify/CartLine/draft-${generation}`;line.quantity=1;state.cart.lines.nodes=[...prior,line];f.reprice();return act('resume',{operation:{kind:'add',operation_id:prepared.reservation.operation_id,job:prepared.reference.id,quantity:1}});}
 const operation=(p,kind='prepared')=>({kind,operation_id:p.reservation.operation_id,job:p.reference.id,generation:p.generation});
 return {...f,set hook(value){f.hook=value;},session,act,upload,prepare,add,operation,recover:file=>{selection={version:'uncommitted-v1',intent_ids:[file.intent.intent_id]};return act('resume_uploads');}};
}
test('cancelled first preparation is observed and its exact files recover with no pricing authority or lifetime extension',async t=>{
 const f=await rig(t),file=await f.upload(),p=await f.prepare(file),sessions=f.rows().resource_sessions;
 const held=await f.act('resume',{operation:f.operation(p)});assert.deepEqual(held.prepared_recovery,{reservation:p.reservation,state:'issued'});
 await assert.rejects(f.act('resume',{operation:f.operation(p,'cancel_preparation')}));
 await f.act('cancel_preparation',{reservation:held.prepared_recovery.reservation});
 const before=f.counts.admin_mutations,history=f.rows().jobs;
 const observed=await f.act('resume',{operation:f.operation(p,'cancel_preparation')});assert.equal(observed.prepared_recovery.state,'cancelled');assert.deepEqual(observed.items,[]);
 const recovered=await f.recover(file);assert.equal(recovered.expires_at,p.expires_at);assert.deepEqual(recovered.items,[]);assert.equal(recovered.uploads[0].receipt.asset_id,file.receipt.asset_id);
 assert.equal(f.counts.admin_mutations,before);assert.deepEqual(f.rows().resource_sessions,sessions);assert.deepEqual(f.rows().jobs,history);assert.deepEqual(JSON.parse(f.m.data.shop.authority.value).grants,[]);
});
test('prepared settlement requires exact job, generation and reservation and cannot observe issued B as cancelled',async t=>{
 const f=await rig(t),a=await f.prepare(await f.upload());await f.add(a);const b=await f.prepare(await f.upload()),before=f.counts.admin_mutations;
 for(const operation of [{...f.operation(b),job:a.reference.id},{...f.operation(b),generation:b.generation+1},{...f.operation(b),operation_id:a.reservation.operation_id},f.operation(b,'cancel_preparation')])await assert.rejects(f.act('resume',{operation}));
 assert.equal(f.counts.admin_mutations,before);assert.equal(f.rows().cart_prepared_jobs.find(r=>r.job_id===b.reference.id).state,'issued');assert.equal(f.rows().cart_prepared_jobs.find(r=>r.job_id===a.reference.id).state,'confirmed');
 assert.equal((await f.act('resume',{operation:f.operation(b)})).prepared_recovery.state,'issued');
});
test('a lost successful cancellation response is recovered by observation without repeating cancellation',async t=>{
 const f=await rig(t),a=await f.prepare(await f.upload());await f.add(a);const file=await f.upload(),b=await f.prepare(file);
 f.hook=async(stage,{path,status}={})=>{if(stage==='browser_response'&&status===200&&['/checkout/cancel_preparation','/checkout/continue'].includes(path))throw Error('generated lost cancellation response');};
 await assert.rejects(f.act('cancel_preparation',{reservation:b.reservation}));f.hook=null;
 const before=f.counts.admin_mutations,bodies=f.rows().jobs;
 const observed=await f.act('resume',{operation:f.operation(b,'cancel_preparation')});assert.equal(observed.prepared_recovery.state,'cancelled');assert.equal(observed.items[0].properties._bfl_job,a.reference.id);
 const recovered=await f.recover(file);assert.equal(recovered.uploads.length,1);assert.equal(recovered.expires_at,a.expires_at);assert.equal(f.counts.admin_mutations,before);assert.deepEqual(f.rows().jobs,bodies);
});
test('removed confirmed jobs never return their files as uncommitted drafts',async t=>{
 const f=await rig(t),old=await f.upload(),a=await f.prepare(old);await f.add(a);
 const state=f.carts.get(f.ids.A);state.cart.lines.nodes=[];f.reprice();await f.act('resume');
 const next=await f.upload(),before=f.counts.admin_mutations;
 await assert.rejects(f.recover(old));assert.equal((await f.recover(next)).uploads[0].receipt.asset_id,next.receipt.asset_id);assert.equal(f.counts.admin_mutations,before);
 assert.equal(f.rows().cart_prepared_jobs[0].state,'confirmed');
});
test('accepted B cannot be treated as an absent prepared draft',async t=>{
 const f=await rig(t),file=await f.upload(),p=await f.prepare(file);await f.add(p);const before=f.counts.admin_mutations;
 await assert.rejects(f.act('resume',{operation:f.operation(p)}));await assert.rejects(f.act('resume',{operation:f.operation(p,'cancel_preparation')}));await assert.rejects(f.recover(file));
 assert.equal(f.counts.admin_mutations,before);assert.equal(f.rows().cart_prepared_jobs[0].state,'confirmed');
});
test('original expiry rejects settlement observation and exact draft recovery without issuing a replacement owner',async t=>{
 const f=await rig(t),file=await f.upload(),p=await f.prepare(file);f.clock.time=p.expires_at;
 await assert.rejects(f.act('resume',{operation:f.operation(p)}));await assert.rejects(f.recover(file));assert.equal(f.rows().resource_sessions.length,1);
});

test('lost cancellation continuation remains unresolved and observation cannot repeat or promote it',async t=>{
 const f=await rig(t),a=await f.prepare(await f.upload());await f.add(a);const file=await f.upload(),b=await f.prepare(file);
 f.hook=async(stage,{path,status}={})=>{if(stage==='browser_response'&&status===202&&path==='/checkout/cancel_preparation')throw Error('generated lost continuation');};
 await assert.rejects(f.act('cancel_preparation',{reservation:b.reservation}));f.hook=null;const before=f.counts.admin_mutations;
 await assert.rejects(f.act('resume',{operation:f.operation(b,'cancel_preparation')}));await assert.rejects(f.recover(file));
 assert.equal(f.counts.admin_mutations,before);assert.equal(f.rows().cart_prepared_jobs.find(row=>row.job_id===b.reference.id).state,'cancelled');
});
