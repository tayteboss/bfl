import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {persistentRig,deferred} from '../../../fixtures/film-printing/persistent-client-staging-20261030/rig.mjs';
import {BINDING_QUERY} from '../checkout/cart-capability.mjs';
import {quantitySignature} from '../checkout/quantity-signature.js';
const selection={service:'Darkroom Prints',size:'8” × 10”',paper:'RC Matte',lab:'Chicago',options:{Process:'Color',Borders:'Borderless (Edge-to-edge)',Turnaround:'Standard (4-5 days)','Scanning Options':'Yes',Negatives:'Mail In'},asset_ids:[],copies:1,message:'Known current fixture'};
const plain=value=>JSON.parse(JSON.stringify(value));
const act=(f,action,input={},role='A',id=f.ids[role])=>f.clients[role].session.checkout(action,async()=>id,input);
const diagnose=f=>act(f,'resume',{operation:{kind:'recover_preparation'}});
async function init(f,role='A'){await f.clients[role].session.issue();await act(f,'bind',{},role);await act(f,'install',{},role);}
async function prepare(f,key,generation,role='A'){const job=await f.clients[role].session.request('/jobs',{...selection,request_key:key});return act(f,'eligible',{reference:job.reference,generation},role);}
async function confirm(f,p,role='A'){f.addJob({...p.item,properties:{...p.item.properties,_bfl_signature:quantitySignature(p.reference.signature,1)}},role);f.reprice(role);await act(f,'resume',{operation:{kind:'add',job:p.reference.id,operation_id:p.reservation.operation_id,quantity:1}},role);}
async function upload(f,key){const s=f.clients.A.session,file=f.inputFiles[0],intent=await s.request('/uploads/intents',{request_key:key});const result=await s.request(`/uploads/${intent.intent_id}/bytes`,new Blob([file.bytes],{type:file.mime}),{mime:file.mime});return {...intent,...result};}
const frozen=['resource_sessions','jobs','uploads','upload_intents','cart_prepared_jobs','staging_resource_state','staging_upload_custody','staging_grant_versions','staging_grant_publication','authority_state','cart_checkout_bindings'];
function unchanged(f,before){const after=f.rows();for(const name of frozen)assert.deepEqual(plain(after[name]),plain(before[name]),name);}
function mutate(f,fn){const db=new DatabaseSync(join(f.config.dataDir,'jobs.sqlite'));try{fn(db);}finally{db.close();}}

test('fresh bound empty owner diagnoses read-only with its unchanged original deadline',async t=>{
 const f=await persistentRig(t);await init(f);const before=f.rows(),counts={...f.counts};let nativeWrites=0;f.hook=async(stage,{query}={})=>{if(stage==='storefront'&&query.startsWith('mutation'))nativeWrites++;};
 const result=await diagnose(f);assert.equal(result.recovery,'known-current-v1');assert.equal(result.resumed,true);assert.deepEqual(result.items,[]);assert.equal(result.reservation,undefined);assert.equal(result.expires_at,before.resource_sessions[0].deadline);unchanged(f,before);
 assert.equal(nativeWrites,0);assert.equal(f.counts.admin_mutations,counts.admin_mutations);assert.equal(f.counts.provider,counts.provider);
});
test('confirmed history, cancelled draft and removed final upload recover empty current without changes to B',async t=>{
 const f=await persistentRig(t);await init(f);const prior=await prepare(f,'known-history-one',1);await confirm(f,prior);
 f.carts.get(f.ids.A).cart.lines.nodes=[];f.reprice('A');await act(f,'resume',{operation:{kind:'remove',job:prior.reference.id,operation_id:'known-history-remove',quantity:0}});
 const draft=await prepare(f,'known-cancelled-draft',2);await act(f,'cancel_preparation',{reservation:draft.reservation});
 const asset=await upload(f,'known-last-upload');await f.clients.A.session.request(`/uploads/${asset.intent_id}/remove`,{});await f.runtime.tick();
 await init(f,'B');const other=await prepare(f,'known-cart-b',1,'B');await confirm(f,other,'B');
 const before=f.rows(),authority=f.m.data.shop.authority.value,counts={...f.counts};let nativeWrites=0;f.hook=async(stage,{query}={})=>{if(stage==='storefront'&&query.startsWith('mutation'))nativeWrites++;};
 const result=await diagnose(f);assert.equal(result.recovery,'known-current-v1');assert.equal(result.expires_at,prior.expires_at);assert.deepEqual(result.items,[]);unchanged(f,before);assert.equal(f.m.data.shop.authority.value,authority);
 assert.equal(nativeWrites,0);for(const key of ['admin_mutations','uploads','deletes','provider'])assert.equal(f.counts[key],counts[key]);
});
test('known-current accepts actual confirmed print lines and their completed original assets',async t=>{
 const f=await persistentRig(t);await init(f);await upload(f,'known-complete-original');const p=await prepare(f,'known-current-line',1);await confirm(f,p);
 const before=f.rows(),counts={...f.counts},result=await diagnose(f);assert.equal(result.recovery,'known-current-v1');assert.equal(result.items.length,1);assert.equal(result.items[0].subtotal_cents,4800);assert.equal(result.expires_at,p.expires_at);unchanged(f,before);assert.equal(f.counts.admin_mutations,counts.admin_mutations);
});
test('issued unsent intent stays blocked until its explicit confirmed removal',async t=>{
 const f=await persistentRig(t);await init(f);const s=f.clients.A.session,intent=await s.request('/uploads/intents',{request_key:'known-issued-unsent'}),before=f.rows();await assert.rejects(diagnose(f));unchanged(f,before);
 await s.request(`/uploads/${intent.intent_id}/remove`,{});assert.equal((await diagnose(f)).recovery,'known-current-v1');
});
test('unknown provider send cannot be converted into clean current custody',async t=>{
 const f=await persistentRig(t);await init(f);f.hook=async(stage,{options}={})=>{if(stage==='provider'&&options.method==='POST')throw TypeError('unknown provider send');};
 await assert.rejects(upload(f,'known-unknown-send'));f.hook=null;assert.ok(f.rows().staging_upload_custody.some(row=>row.state==='upload-unknown'));const before=f.rows();await assert.rejects(diagnose(f));unchanged(f,before);
});
test('active resource request prevents diagnosis before any native cart read',async t=>{
 const f=await persistentRig(t);await init(f);const entered=deferred(),release=deferred();let blocked=true;
 f.hook=async(stage,{options}={})=>{if(stage==='provider'&&options.method==='POST'&&blocked){entered.resolve();await release.promise;}};
 const transfer=upload(f,'known-active-upload');await entered.promise;const before=f.counts.storefront;await assert.rejects(diagnose(f));assert.equal(f.counts.storefront,before);blocked=false;release.resolve();await transfer;assert.equal((await diagnose(f)).recovery,'known-current-v1');
});
for(const flag of ['sourcePending','verifying','cropPending'])test(`unfinished persisted ${flag} is not treated as settled`,async t=>{
 const f=await persistentRig(t);await init(f);const asset=await upload(f,'known-persisted-'+flag);
 mutate(f,db=>{const row=db.prepare('SELECT owner,body FROM staging_resource_state').get(),body=JSON.parse(row.body);body.intents.find(r=>r.id===asset.intent_id)[flag]=true;db.prepare('UPDATE staging_resource_state SET body=? WHERE owner=?').run(JSON.stringify(body),row.owner);});
 const before=f.rows();await assert.rejects(diagnose(f));unchanged(f,before);
});
for(const change of ['cart','marker'])test(`known-current rejects changed ${change} across its two authenticated reads`,async t=>{
 const f=await persistentRig(t);await init(f);const p=await prepare(f,'known-changed-'+change,1);await confirm(f,p);const before=f.rows();let reads=0;
 f.hook=async(stage,{query}={})=>{if(stage==='storefront'&&query===BINDING_QUERY&&++reads===2){const state=f.carts.get(f.ids.A);if(change==='cart'){state.cart.lines.nodes=[];f.reprice('A');}else state.marker='f'.repeat(64);}};
 await assert.rejects(diagnose(f));assert.equal(reads,2);unchanged(f,before);
});
test('wrong cart, expired original and uncertain prepared state remain blocked',async t=>{
 const f=await persistentRig(t);await init(f);const p=await prepare(f,'known-uncertain-history',1);await confirm(f,p);const before=f.rows();
 await assert.rejects(act(f,'resume',{operation:{kind:'recover_preparation'}},'A',f.ids.B));unchanged(f,before);
 mutate(f,db=>db.prepare("UPDATE cart_prepared_jobs SET state='uncertain' WHERE job_id=?").run(p.reference.id));const uncertain=f.rows();await assert.rejects(diagnose(f));unchanged(f,uncertain);
 f.clock.time=before.resource_sessions[0].deadline;await assert.rejects(diagnose(f));assert.deepEqual(plain(f.rows().resource_sessions),plain(before.resource_sessions));
});


test('known queued deletion of a removed asset is safe, but uncertain deletion remains blocked',async t=>{
 const f=await persistentRig(t);await init(f);const asset=await upload(f,'known-queued-deletion');await f.clients.A.session.request(`/uploads/${asset.intent_id}/remove`,{});
 mutate(f,db=>db.prepare("UPDATE staging_upload_custody SET state='queued' WHERE intent=?").run(asset.intent_id));
 let before=f.rows();assert.equal((await diagnose(f)).recovery,'known-current-v1');unchanged(f,before);
 for(const state of ['deleting','delete-unknown']){
  mutate(f,db=>db.prepare('UPDATE staging_upload_custody SET state=? WHERE intent=?').run(state,asset.intent_id));before=f.rows();await assert.rejects(diagnose(f));unchanged(f,before);
 }
});
