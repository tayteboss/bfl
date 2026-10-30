import test from 'node:test';
import assert from 'node:assert/strict';
import {persistentRig} from '../../../fixtures/film-printing/persistent-client-staging-20261030/rig.mjs';
import {BINDING_QUERY} from '../checkout/cart-capability.mjs';
import {quantitySignature} from '../checkout/quantity-signature.js';
const darkroom={service:'Darkroom Prints',size:'8” × 10”',paper:'RC Matte',lab:'Chicago',options:{Process:'Color',Borders:'Borderless (Edge-to-edge)',Turnaround:'Standard (4-5 days)','Scanning Options':'Yes',Negatives:'Mail In'},asset_ids:[],copies:1,message:'Diagnosis fixture'};
const photo={service:'Photo Prints',size:'4x6',paper:null,lab:'Miami',copies:1,options:{Turnaround:'Standard (4-5 days)'},message:'Unreserved upload retained'};
const plain=x=>JSON.parse(JSON.stringify(x));
const act=(f,role,action,input={},id=f.ids[role])=>f.clients[role].session.checkout(action,async()=>id,input);
const diagnose=(f,role='A',input={kind:'recover_preparation'},id=f.ids[role])=>act(f,role,'resume',{operation:input},id);
async function initialize(f,role){await f.clients[role].session.issue();await act(f,role,'bind');await act(f,role,'install');}
async function prepare(f,role,key,generation){const job=await f.clients[role].session.request('/jobs',{...darkroom,request_key:key});return act(f,role,'eligible',{reference:job.reference,generation});}
const nativeAdd=(f,role,p)=>{f.addJob({...p.item,properties:{...p.item.properties,_bfl_signature:quantitySignature(p.reference.signature,p.item.quantity)}},role);f.reprice(role);};
const nativeEmpty=(f,role)=>{f.carts.get(f.ids[role]).cart.lines.nodes=[];f.reprice(role);};
async function orphan(t,{other=false,uploads=false}={}){
 const f=await persistentRig(t);await initialize(f,'A');
 const confirmed=await prepare(f,'A','diagnosis-known-a',1);nativeAdd(f,'A',confirmed);await act(f,'A','resume',{operation:{kind:'add',operation_id:confirmed.reservation.operation_id,job:confirmed.reference.id,quantity:1}});nativeEmpty(f,'A');
 const pending=await prepare(f,'A','diagnosis-orphan-a',2);nativeAdd(f,'A',pending);nativeEmpty(f,'A');
 let otherGrant,unreserved;
 if(other){await initialize(f,'B');const b=await prepare(f,'B','diagnosis-known-b',1);nativeAdd(f,'B',b);await act(f,'B','resume',{operation:{kind:'add',operation_id:b.reservation.operation_id,job:b.reference.id,quantity:1}});otherGrant=plain(JSON.parse(f.m.data.shop.authority.value).grants.find(g=>g.lines.some(line=>line.claims.job===b.reference.id)));}
 if(uploads){const file=f.inputFiles[0],s=f.clients.A.session,intent=await s.request('/uploads/intents',{request_key:'diagnosis-retained-upload'}),asset=await s.request(`/uploads/${intent.intent_id}/bytes`,new Blob([file.bytes],{type:file.mime}),{mime:file.mime});unreserved=await s.request('/jobs',{...photo,asset_ids:[asset.asset_id],request_key:'diagnosis-unreserved-photo'});}
 return {f,pending,confirmed,otherGrant,unreserved};
}

test('read-only diagnosis identifies only exact orphan ticket; cancellation preserves unreserved job/uploads and B',async t=>{
 const {f,pending,otherGrant,unreserved}=await orphan(t,{other:true,uploads:true});const before=f.rows(),counts={...f.counts};let nativeWrites=0;
 f.hook=async(stage,{query}={})=>{if(stage==='storefront'&&query.startsWith('mutation'))nativeWrites++;};
 const found=await diagnose(f);assert.equal(found.resumed,true);assert.equal(found.recovery,'cancel-issued-absent-v1');assert.deepEqual(found.reservation,pending.reservation);assert.equal(found.expires_at,pending.expires_at);assert.deepEqual(found.items,[]);
 for(const table of ['resource_sessions','jobs','uploads','upload_intents','cart_prepared_jobs','staging_resource_state','staging_grant_versions','staging_grant_publication'])assert.deepEqual(plain(f.rows()[table]),plain(before[table]));
 assert.equal(f.counts.admin_mutations,counts.admin_mutations);assert.equal(f.counts.provider,counts.provider);assert.equal(nativeWrites,0);
 const cancelled=await act(f,'A','cancel_preparation',{reservation:found.reservation});assert.equal(cancelled.cancelled,true);const operation={kind:'cancel_preparation',operation_id:found.reservation.operation_id,job:found.reservation.job_id,generation:found.reservation.generation};
 const current=await act(f,'A','resume',{operation});assert.equal(current.prepared_recovery.state,'cancelled');assert.deepEqual(current.items,[]);
 assert.equal(f.rows().cart_prepared_jobs.find(r=>r.job_id===pending.reference.id).state,'cancelled');assert.equal(f.rows().cart_prepared_jobs.some(r=>r.job_id===unreserved.reference.id),false);
 for(const table of ['resource_sessions','jobs','uploads','upload_intents','staging_resource_state'])assert.deepEqual(plain(f.rows()[table]),plain(before[table]));
 assert.deepEqual(JSON.parse(f.m.data.shop.authority.value).grants,[otherGrant]);assert.equal(f.counts.uploads,counts.uploads);assert.equal(f.counts.deletes,counts.deletes);assert.equal(nativeWrites,0);
});

test('another cart, a present issued line, and native-operation-shaped diagnosis reject without confirmation',async t=>{
 const {f,pending}=await orphan(t);const before=plain(f.rows().cart_prepared_jobs),writes=f.counts.admin_mutations;
 await assert.rejects(diagnose(f,'A',{kind:'recover_preparation'},f.ids.B));
 await assert.rejects(diagnose(f,'A',{kind:'recover_preparation',operation_id:pending.reservation.operation_id,job:pending.reference.id,quantity:1}));
 nativeAdd(f,'A',pending);await assert.rejects(diagnose(f));assert.deepEqual(plain(f.rows().cart_prepared_jobs),before);assert.equal(f.counts.admin_mutations,writes);
});

for(const change of ['cart','marker'])test(`diagnosis rejects changed ${change} between its two reads without ledger mutation`,async t=>{
 const {f,pending}=await orphan(t);const before=plain(f.rows().cart_prepared_jobs),writes=f.counts.admin_mutations;let reads=0;
 f.hook=async(stage,{query}={})=>{if(stage==='storefront'&&query===BINDING_QUERY&&++reads===2){const state=f.carts.get(f.ids.A);if(change==='cart')nativeAdd(f,'A',pending);else state.marker='f'.repeat(64);}};
 await assert.rejects(diagnose(f));assert.equal(reads,2);assert.deepEqual(plain(f.rows().cart_prepared_jobs),before);assert.equal(f.counts.admin_mutations,writes);
});

test('uncertain publication/preparation never becomes a recoverable cancellation ticket',async t=>{
 const f=await persistentRig(t);await initialize(f,'A');let interrupted=false;
 f.hook=async(stage,{query,variables}={})=>{if(stage==='after_admin'&&query?.startsWith('mutation')&&!interrupted){const authority=variables?.fields?.find(field=>field.key==='authority');if(authority&&JSON.parse(authority.value).grants.length){interrupted=true;throw Error('lost publication');}}};
 await assert.rejects(prepare(f,'A','diagnosis-unknown-publish',1));f.hook=null;assert.equal(f.rows().cart_prepared_jobs[0].state,'uncertain');
 const before=plain(f.rows().cart_prepared_jobs);await assert.rejects(diagnose(f));assert.deepEqual(plain(f.rows().cart_prepared_jobs),before);
 await f.runtime.tick();const writes=f.counts.admin_mutations;await assert.rejects(diagnose(f));assert.deepEqual(plain(f.rows().cart_prepared_jobs),before);assert.equal(f.counts.admin_mutations,writes);
});

test('lost successful cancellation response is observed after restart without another cancellation or native write',async t=>{
 const {f}=await orphan(t,{other:true,uploads:true}),found=await diagnose(f);let lost=true;
 // The session completes the usual fresh-proof continuation; only its final
 // cancellation response is lost, never an original cart Add/Remove.
 f.hook=async(stage,{path,status}={})=>{if(stage==='browser_response'&&path==='/checkout/continue'&&status===200&&lost){lost=false;throw TypeError('lost completed cancellation response');}};
 await assert.rejects(act(f,'A','cancel_preparation',{reservation:found.reservation}));assert.equal(lost,false);f.hook=null;
 const before=f.rows(),writes=f.counts.admin_mutations,counts={...f.counts};await f.restart();
 const operation={kind:'cancel_preparation',operation_id:found.reservation.operation_id,job:found.reservation.job_id,generation:found.reservation.generation};
 const result=await act(f,'A','resume',{operation});assert.equal(result.prepared_recovery.state,'cancelled');assert.deepEqual(result.prepared_recovery.reservation,found.reservation);
 assert.equal(f.counts.admin_mutations,writes);assert.equal(f.counts.uploads,counts.uploads);assert.equal(f.counts.deletes,counts.deletes);assert.deepEqual(plain(f.rows().cart_prepared_jobs),plain(before.cart_prepared_jobs));
});

test('interrupted cancellation continuation is reconciled across restart without repeating cancellation',async t=>{
 const {f}=await orphan(t,{other:true,uploads:true}),found=await diagnose(f);let lost=true;
 f.hook=async(stage,{path,status}={})=>{if(stage==='browser_response'&&path==='/checkout/cancel_preparation'&&status===202&&lost){lost=false;throw TypeError('lost cancellation continuation');}};
 await assert.rejects(act(f,'A','cancel_preparation',{reservation:found.reservation}));assert.equal(lost,false);f.hook=null;
 const before=plain(f.rows().cart_prepared_jobs);assert.equal(before.find(row=>row.operation_id===found.reservation.operation_id).state,'cancelled');
 await f.restart();const writes=f.counts.admin_mutations;
 const operation={kind:'cancel_preparation',operation_id:found.reservation.operation_id,job:found.reservation.job_id,generation:found.reservation.generation};
 const result=await act(f,'A','resume',{operation});assert.equal(result.prepared_recovery.state,'cancelled');assert.deepEqual(plain(f.rows().cart_prepared_jobs),before);assert.equal(f.counts.admin_mutations,writes);
});
