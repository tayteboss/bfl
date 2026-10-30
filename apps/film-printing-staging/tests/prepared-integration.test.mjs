import test from 'node:test';
import assert from 'node:assert/strict';
import {fullRig} from '../../../fixtures/film-printing/f06v3-candidate/full-rig.mjs';
import {createResourceSession} from '../theme/resource-session.js';
import '../theme/film-printing-job.js';
import {quantitySignature} from '../checkout/quantity-signature.js';
import {LEASE_OWNERS,leaseEnvelope} from '../checkout/lease.mjs';
const ownerRows=m=>LEASE_OWNERS.map(o=>o.alias==='leaseLab'?m.data[o.alias][0]:m.data[o.alias].nodes[0]);
const grants=f=>JSON.parse(f.m.data.shop.authority.value);
const jobAdmissions=f=>f.rows().resource_admissions.filter(r=>r.kind==='jobs');
const positiveWrites=f=>f.m.writes.filter(fields=>{const value=fields.find(x=>x.key==='authority')?.value;return value&&JSON.parse(value).grants.length;});
function addActual(f,prepared,quantity){
 f.addJob({...prepared.item,properties:{...prepared.item.properties,_bfl_signature:quantitySignature(prepared.reference.signature,quantity)}});
 const state=f.carts.get(f.ids.A),line=state.cart.lines.nodes[0];
 line.id='gid://shopify/CartLine/prepared-first?cart=opaque-synthetic';line.quantity=quantity;
 f.reprice();return line;
}
function changeActual(f,line,quantity){
 line.quantity=quantity;const signature=line.attributes.find(a=>a.key==='_bfl_signature');
 const raw=/^v3:([a-f0-9]{64}):/.exec(signature.value)[1];signature.value=quantitySignature(raw,quantity);f.reprice();
}
test('real V3 HTTP preserves admission, prices mutations, restores cancelled survivor, and expires every owner',async t=>{
 const f=await fullRig(t),session=f.clients.A.session,act=(action,input={})=>session.checkout(action,async()=>f.ids.A,input);
 await session.issue();await act('bind');await act('install');
 const state=f.carts.get(f.ids.A),assets=[];
 for(const [i,file] of f.inputFiles.entries()){
  const intent=await session.request('/uploads/intents',{request_key:`prepared-http-upload-${i}`});
  const result=await session.request(`/uploads/${intent.intent_id}/bytes`,new Blob([file.bytes],{type:file.mime}),{mime:file.mime});assets.push(result.asset_id);
 }
 const first={...f.plan.selection,asset_ids:assets.slice(0,2),copies:3,request_key:'prepared-http-first'};
 await assert.rejects(session.request('/jobs',{...first,request_key:'prepared-http-invalid',paper:'not-a-catalog-paper'}),error=>error.definitive===true);
 assert.equal(f.rows().jobs.length,0);assert.equal(jobAdmissions(f).length,0);assert.equal(f.rows().cart_prepared_jobs.length,0);
 const aJob=await session.request('/jobs',first),a=await act('eligible',{reference:aJob.reference,generation:1});
 assert.equal(a.prepared,true);assert.equal(a.item.properties._bfl_signature,a.reference.signature);assert.equal(a.item.quantity,3);assert.equal(a.unit_price_cents,80);assert.equal(a.file_count,2);
 assert.equal(state.cart.lines.nodes.length,0);assert.equal(f.rows().cart_prepared_jobs[0].state,'issued');assert.equal(f.rows().cart_job_bindings.length,1);assert.equal(jobAdmissions(f).length,1);
 const originalLease=structuredClone(grants(f).lease),firstAuthority=f.m.data.shop.authority.value;
 for(const owner of ownerRows(f.m))assert.equal(owner.lease.value,leaseEnvelope(firstAuthority));
 const writes=positiveWrites(f).length;
 await assert.rejects(act('eligible',{reference:aJob.reference,generation:1}));
 assert.equal(positiveWrites(f).length,writes);assert.equal(f.rows().cart_prepared_jobs.length,1);
 const line=addActual(f,a,3);
 const accepted=await act('resume',{operation:{kind:'add',job:a.reference.id,operation_id:a.reservation.operation_id,quantity:3}});
 assert.equal(accepted.resumed,true);assert.equal(accepted.items[0].subtotal_cents,240);assert.equal(accepted.expires_at,a.expires_at);assert.equal(f.rows().cart_prepared_jobs[0].state,'confirmed');
 const adminMutations=f.counts.admin_mutations;changeActual(f,line,5);
 const edited=await act('resume',{operation:{kind:'change',job:a.reference.id,operation_id:'synthetic-change-operation',quantity:5}});
 assert.equal(edited.items[0].quantity,5);assert.equal(edited.items[0].subtotal_cents,400);assert.equal(f.m.data.shop.authority.value,firstAuthority);assert.equal(f.counts.admin_mutations,adminMutations);
 const bJob=await session.request('/jobs',{...f.plan.selection,asset_ids:assets.slice(2),copies:2,request_key:'prepared-http-second'}),b=await act('eligible',{reference:bJob.reference,generation:2});
 assert.equal(b.expires_at,a.expires_at);assert.deepEqual(grants(f).lease,originalLease);assert.equal(grants(f).grants[0].lines.length,2);
 const bodies=f.rows().jobs.map(row=>row.body),epoch=f.rows().authority_state[0].epoch;
 const cancelled=await act('cancel_preparation',{reservation:b.reservation});assert.equal(cancelled.cancelled,true);assert.equal(cancelled.revoked,true);assert.ok(f.rows().authority_state[0].epoch>epoch);
 assert.deepEqual(grants(f).lease,originalLease);assert.deepEqual(grants(f).grants[0].lines.map(l=>l.claims.job),[a.reference.id]);
 for(const owner of ownerRows(f.m))assert.equal(owner.lease.value,leaseEnvelope(f.m.data.shop.authority.value));
 assert.equal(f.rows().cart_prepared_jobs.find(r=>r.job_id===b.reference.id).state,'cancelled');assert.equal(f.rows().cart_prepared_jobs.find(r=>r.job_id===a.reference.id).state,'confirmed');
 assert.equal(f.rows().cart_prepared_jobs.length,2);assert.equal(jobAdmissions(f).length,2);assert.equal(positiveWrites(f).length,3);
 const survived=await act('resume');assert.equal(survived.items.length,1);assert.equal(survived.items[0].subtotal_cents,400);
 // Changing details after background preparation must leave a replacement slot.
 await assert.rejects(session.request('/jobs',{...f.plan.selection,asset_ids:assets.slice(2),copies:2,message:'Rejected staging fixture note',request_key:'prepared-http-bad-note'}),error=>error.definitive===true);
 assert.equal(f.rows().jobs.length,2);
 const replacementJob=await session.request('/jobs',{...f.plan.selection,asset_ids:assets.slice(2),copies:2,request_key:'prepared-http-replacement'});
 const replacement=await act('eligible',{reference:replacementJob.reference,generation:3});
 assert.equal(replacement.expires_at,a.expires_at);assert.deepEqual(grants(f).lease,originalLease);
 assert.equal(f.rows().jobs.length,3);assert.equal(jobAdmissions(f).length,3);
 assert.deepEqual(f.rows().jobs.slice(0,2).map(row=>row.body),bodies);
 await assert.rejects(session.request('/jobs',{...first,request_key:'prepared-http-third-live'}));assert.equal(f.rows().jobs.length,3);
 f.addJob({...replacement.item,properties:{...replacement.item.properties,_bfl_signature:quantitySignature(replacement.reference.signature,2)}});
 const added=state.cart.lines.nodes.find(l=>l.attributes.some(a=>a.key==='_bfl_job'&&a.value===replacement.reference.id));state.cart.lines.nodes.unshift(line);added.id='gid://shopify/CartLine/prepared-replacement?cart=opaque-synthetic';added.quantity=2;f.reprice();
 assert.equal((await act('resume',{operation:{kind:'add',job:replacement.reference.id,operation_id:replacement.reservation.operation_id,quantity:2}})).items.length,2);
 const retained=f.m.data.shop.authority.value,mutations=f.counts.admin_mutations;state.cart.lines.nodes=[];state.cart.totalQuantity=0;f.reprice();
 const removed=await act('resume',{operation:{kind:'remove',job:a.reference.id,operation_id:'synthetic-remove-operation',quantity:0}});
 assert.deepEqual(removed.items,[]);assert.equal(removed.expires_at,a.expires_at);assert.equal(f.m.data.shop.authority.value,retained);assert.equal(f.counts.admin_mutations,mutations);
 assert.equal(f.rows().cart_checkout_bindings[0].state,'confirmed');assert.deepEqual(f.rows().jobs.slice(0,2).map(row=>row.body),bodies);
 await assert.rejects(session.request('/jobs',{...first,request_key:'prepared-http-after-removed-confirmed'}));
 f.clock.time=a.expires_at+1;await f.runtime.tick();assert.deepEqual(grants(f).grants,[]);assert.equal(f.rows().cart_checkout_bindings[0].state,'retired');
 for(const owner of ownerRows(f.m))assert.equal(owner.lease.value,leaseEnvelope(f.m.data.shop.authority.value));
});

for(const count of [2,100])test(`${count} same files upload again after selection recovery, accepted-cart reload and empty cart within original deadlines`,async t=>{
 const f=await fullRig(t),saved=new Map(),reloadStorage={getItem:k=>saved.get(k)??null,setItem:(k,v)=>saved.set(k,v)};
 const originalNow=Date.now;Date.now=()=>f.clock.time;t.after(()=>{Date.now=originalNow;});
 const sessionFor=()=>createResourceSession({fetchImpl:f.browserFetch,now:()=>f.clock.time,preparedMode:true,reloadStorage});
 const selected=Array.from({length:count},(_,i)=>f.inputFiles[i%f.inputFiles.length]);
 if(count===100)f.hook=async(stage,{url,options}={})=>{if(stage==='provider'&&options.method==='POST'&&url.endsWith('/base/'))f.clock.time+=1600;};
 let first=sessionFor();await first.issue();
 const issued=f.rows().resource_sessions.at(-1);assert.equal(issued.expires-issued.created,600000);assert.equal(issued.deadline-issued.created,3600000);
 const action=(session,name,input={})=>session.checkout(name,async()=>f.ids.A,input);
 await action(first,'bind');await action(first,'install');
 const assets=[];
 for(const [i,file] of selected.entries()){
  const intent=await first.request('/uploads/intents',{request_key:`reload-generation-upload-${i}`});
  assets.push((await first.request(`/uploads/${intent.intent_id}/bytes`,new Blob([file.bytes],{type:file.mime}),{mime:file.mime})).asset_id);
 }
 const beforeRecovery=f.rows().resource_sessions;first.checkpoint('uploads');const recovered=sessionFor();assert.equal(recovered.restore().state,'uploads');
 const recovery=await action(recovered,'resume_uploads');assert.equal(recovery.uploads.length,count);assert.equal(f.counts.uploads,count);assert.deepEqual(f.rows().resource_sessions,beforeRecovery);first=recovered;
 const prepare=(session)=>async input=>{
  const {generation,...selection}=input;session.rememberPreparationGeneration(generation);
  const job=await session.request('/jobs',selection);
  return action(session,'eligible',{reference:job.reference,generation});
 };
 const controller=(session,selection,key)=>globalThis.BFLPrintJob.createPreparedController({
  read:()=>selection,id:()=>key,generationFloor:()=>session.preparationGeneration(),prepare:prepare(session),
  async addPrepared({prepared,quantity,assertSelection,onWriteStarted}){
   assertSelection();onWriteStarted();addActual(f,prepared,quantity);
   const accepted=await action(session,'resume',{operation:{kind:'add',job:prepared.reference.id,operation_id:prepared.reservation.operation_id,quantity}});
   session.checkpoint();return {accepted:true,cart:accepted};
  },
 });
 const a=await controller(first,{...f.plan.selection,asset_ids:assets,copies:3},'reload-first').submit();
 const before=f.rows().resource_sessions,expiry=a.cart.expires_at;
 const firstBody=f.rows().jobs[0].body;
 const resumed=sessionFor();assert.equal(resumed.restore().state,'accepted');
 assert.equal((await action(resumed,'resume')).items[0].subtotal_cents,count*3*40);
 const state=f.carts.get(f.ids.A);state.cart.lines.nodes=[];state.cart.totalQuantity=0;f.reprice();
 assert.deepEqual((await action(resumed,'resume')).items,[]);resumed.checkpoint();
 const repeated=[];
 for(const [i,file] of selected.entries()){
  const intent=await resumed.request('/uploads/intents',{request_key:`repeat-same-upload-${i}`});
  repeated.push((await resumed.request(`/uploads/${intent.intent_id}/bytes`,new Blob([file.bytes],{type:file.mime}),{mime:file.mime})).asset_id);
 }
 assert.ok(repeated.every(id=>!assets.includes(id)));
 const b=await controller(resumed,{...f.plan.selection,asset_ids:repeated,copies:3},'reload-second').submit();
 assert.equal(b.cart.items.length,1);assert.equal(b.cart.items[0].quantity,3);
 assert.equal(b.cart.items[0].subtotal_cents,count*3*40);assert.equal(b.cart.expires_at,expiry);
 assert.equal(f.counts.uploads,count*2);assert.equal(f.rows().jobs.length,2);assert.equal(f.rows().jobs[0].body,firstBody);
 assert.deepEqual(f.rows().jobs.map(r=>JSON.parse(r.body).files.map(f=>f.sha256)),[selected.map(f=>f.sha256),selected.map(f=>f.sha256)]);
 assert.deepEqual(f.rows().cart_prepared_jobs.map(r=>r.generation),[1,2]);
 assert.deepEqual(f.rows().resource_sessions,before);assert.equal(f.runtime.status().counts.issue,1);
 resumed.beginMutation({kind:'remove',job:b.cart.items[0].properties._bfl_job,quantity:0,operation_id:'pending-remove'});
 const pending=sessionFor();assert.equal(pending.restore().state,'pending');assert.equal(pending.preparationGeneration(),2);
 assert.throws(()=>pending.rememberPreparationGeneration(1),/RESOURCE_INPUT/);
});

test('retirement during catalog lookup rejects before spending a customer job slot',async t=>{
 const f=await fullRig(t),session=f.clients.A.session,act=action=>session.checkout(action,async()=>f.ids.A);
 await session.issue();await act('bind');await act('install');const uploaded=[];
 for(const [n,file] of f.inputFiles.slice(0,2).entries()){
  const i=await session.request('/uploads/intents',{request_key:`catalog-race-${n}`});
  uploaded.push(await session.request(`/uploads/${i.intent_id}/bytes`,new Blob([file.bytes],{type:file.mime}),{mime:file.mime}));
 }
 let retired=false;f.hook=async(stage,{query}={})=>{if(stage==='after_admin'&&query.includes('F05PriceCatalog')&&!retired){retired=true;await session.request(`/uploads/${uploaded[0].intent_id}/remove`,{});}};
 await assert.rejects(session.request('/jobs',{...f.plan.selection,asset_ids:uploaded.map(r=>r.asset_id),copies:3,request_key:'retired-during-catalog'}));
 assert.equal(retired,true);assert.equal(f.rows().jobs.length,0);assert.equal(jobAdmissions(f).length,0);f.hook=null;
 for(let n=0;n<2;n++)await session.request('/jobs',{...f.plan.selection,asset_ids:[uploaded[1].asset_id],copies:n+2,request_key:`corrected-catalog-${n}`});
 assert.equal(f.rows().jobs.length,2);assert.equal(jobAdmissions(f).length,2);
});

test('live longer customer session cannot revive the original expired pricing lease for a second Add',async t=>{
 const f=await fullRig(t),session=f.clients.A.session,act=(name,input={})=>session.checkout(name,async()=>f.ids.A,input);
 await session.issue();await act('bind');await act('install');
 const file=f.inputFiles[0],intent=await session.request('/uploads/intents',{request_key:'fixed-lease-upload'});
 const uploaded=await session.request(`/uploads/${intent.intent_id}/bytes`,new Blob([file.bytes],{type:file.mime}),{mime:file.mime});
 const selection={...f.plan.selection,asset_ids:[uploaded.asset_id],copies:3};
 const first=await session.request('/jobs',{...selection,request_key:'fixed-lease-first'});
 const prepared=await act('eligible',{reference:first.reference,generation:1});
 addActual(f,prepared,3);await act('resume',{operation:{kind:'add',job:first.reference.id,operation_id:prepared.reservation.operation_id,quantity:3}});
 const state=f.carts.get(f.ids.A);state.cart.lines.nodes=[];state.cart.totalQuantity=0;f.reprice();
 await act('resume',{operation:{kind:'remove',job:first.reference.id,operation_id:'fixed-lease-remove',quantity:0}});
 const issued=f.rows().resource_sessions,body=f.rows().jobs[0].body,originalLease=structuredClone(grants(f).lease);
 f.clock.time=prepared.expires_at+1;assert.ok(issued[0].expires>f.clock.time);
 const second=await session.request('/jobs',{...selection,request_key:'fixed-lease-second'});
 await assert.rejects(act('eligible',{reference:second.reference,generation:2}));
 assert.equal(state.cart.lines.nodes.length,0);assert.equal(f.rows().cart_prepared_jobs.length,1);
 assert.equal(f.rows().cart_prepared_jobs[0].expires_at,prepared.expires_at);
 assert.equal(f.rows().jobs[0].body,body);assert.deepEqual(f.rows().resource_sessions,issued);
 assert.ok(!grants(f).grants.length||JSON.stringify(grants(f).lease)===JSON.stringify(originalLease));
});
