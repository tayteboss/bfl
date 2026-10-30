import test from 'node:test';
import assert from 'node:assert/strict';
import {persistentRig} from '../../../fixtures/film-printing/persistent-client-staging-20261030/rig.mjs';
import {quantitySignature} from '../checkout/quantity-signature.js';
import {createResourceSession} from '../theme/resource-session.js';

const darkroom={service:'Darkroom Prints',size:'8” × 10”',paper:'RC Matte',lab:'Chicago',options:{Process:'Color',Borders:'Borderless (Edge-to-edge)',Turnaround:'Standard (4-5 days)','Scanning Options':'Yes',Negatives:'Mail In'},asset_ids:[],copies:1,message:'Persistent edge fixture'};
const photo={service:'Photo Prints',size:'4x6',paper:null,lab:'Miami',copies:1,options:{Turnaround:'Standard (4-5 days)'},message:'Persistent asset fixture'};
const grants=f=>JSON.parse(f.m.data.shop.authority.value);
const plain=value=>JSON.parse(JSON.stringify(value));
const act=(f,role,name,input={})=>f.clients[role].session.checkout(name,async()=>f.ids[role],input);
async function initialize(f,role){await f.clients[role].session.issue();await act(f,role,'bind');await act(f,role,'install');}
async function prepare(f,role,key,generation=1,selection=darkroom){
 const job=await f.clients[role].session.request('/jobs',{...selection,request_key:key});return act(f,role,'eligible',{reference:job.reference,generation});
}
async function accept(f,role,p){
 const state=f.carts.get(f.ids[role]),prior=state.cart.lines.nodes.slice();
 f.addJob({...p.item,properties:{...p.item.properties,_bfl_signature:quantitySignature(p.reference.signature,p.item.quantity)}},role);
 const fresh=state.cart.lines.nodes[0];fresh.id=`gid://shopify/CartLine/${p.reference.id}?cart=generated-edge`;state.cart.lines.nodes=[...prior,fresh];f.reprice(role);
 await act(f,role,'resume',{operation:{kind:'add',job:p.reference.id,operation_id:p.reservation.operation_id,quantity:p.item.quantity}});return p;
}
async function add(f,role,key,generation=1,selection=darkroom){return accept(f,role,await prepare(f,role,key,generation,selection));}
async function upload(f,role,key){const session=f.clients[role].session,file=f.inputFiles[0],intent=await session.request('/uploads/intents',{request_key:key});return session.request(`/uploads/${intent.intent_id}/bytes`,new Blob([file.bytes],{type:file.mime}),{mime:file.mime});}


async function losePublication(f){
 await initialize(f,'A');let candidate;
 f.hook=async(stage,{query,variables}={})=>{if(stage==='after_admin'&&query?.startsWith('mutation')&&!candidate){const value=variables?.fields?.find(field=>field.key==='authority')?.value;if(value&&JSON.parse(value).grants.length){candidate=value;throw Error('generated lost publication response');}}};
 await assert.rejects(prepare(f,'A','resume-unknown-a'));assert.ok(candidate);f.hook=null;await f.runtime.tick();assert.equal(grants(f).grants.length,0);
 return {candidate,uncertain:f.rows().cart_prepared_jobs.find(row=>row.state==='uncertain')};
}

test('fresh authenticated B reload restores confirmed uploaded jobs after unknown A without reupload or native replay',async t=>{
 const f=await persistentRig(t),saved=new Map(),reloadStorage={getItem:key=>saved.get(key)??null,setItem:(key,value)=>saved.set(key,value)};
 const freshB=()=>createResourceSession({fetchImpl:f.browserFetch,now:()=>f.clock.time,preparedMode:true,clientPolicy:'bfl-persistent-staging-client-v1',reloadStorage});
 f.clients.B.session=freshB();await initialize(f,'B');const asset=await upload(f,'B','resume-b-upload'),b=await add(f,'B','resume-b-job',1,{...photo,asset_ids:[asset.asset_id]});f.clients.B.session.checkpoint('accepted');
 const beforeB=plain(grants(f).grants[0]),sessions=plain(f.rows().resource_sessions),uploads=f.counts.uploads;
 const {candidate,uncertain}=await losePublication(f);assert.ok(uncertain);assert.equal(f.rows().staging_grant_versions.findLast(row=>row.owner===sessions[0].owner).state,'suspended');
 // A fresh independent owner can be admitted while B has not provided its own proof.
 f.ids.C='gid://shopify/Cart/generated-resume-C?key=private-generated-C';f.carts.set(f.ids.C,{cart:{...structuredClone(f.carts.get(f.ids.A).cart),id:f.ids.C},marker:null});
 f.clients.C={session:createResourceSession({fetchImpl:f.browserFetch,now:()=>f.clock.time,preparedMode:true,clientPolicy:'bfl-persistent-staging-client-v1'})};
 await initialize(f,'C');const c=await add(f,'C','resume-fresh-c'),beforeC=plain(grants(f).grants[0]);assert.equal(beforeC.lines[0].claims.job,c.reference.id);
 const history=plain(f.rows().cart_prepared_jobs);await f.restart();const writes=f.counts.admin_mutations;let nativeMutations=0;
 f.hook=async(stage,{query}={})=>{if(stage==='storefront'&&query.startsWith('mutation'))nativeMutations++;};
 f.clients.B.session=freshB();assert.equal(f.clients.B.session.restore().state,'accepted');const restored=await act(f,'B','resume');
 assert.equal(restored.resumed,true);assert.equal(restored.expires_at,b.expires_at);assert.equal(restored.items.length,1);assert.equal(restored.items[0].subtotal_cents,40);
 const restoredB=grants(f).grants.find(g=>g.lines.some(line=>line.claims.job===b.reference.id));assert.deepEqual(restoredB.lines,beforeB.lines);
 for(const key of ['cart','owner','binding','customer_id','generation'])assert.equal(restoredB[key],beforeB[key]);
 assert.deepEqual(grants(f).grants.find(g=>g.lines.some(line=>line.claims.job===c.reference.id)),beforeC);
 assert.equal(f.counts.admin_mutations,writes+1);assert.equal(nativeMutations,0);assert.equal(f.counts.uploads,uploads);assert.deepEqual(plain(f.rows().cart_prepared_jobs),history);
 assert.deepEqual(plain(f.rows().resource_sessions.filter(row=>row.owner===sessions[0].owner)),sessions);
 assert.equal(f.m.writes.filter(fields=>fields.find(field=>field.key==='authority')?.value===candidate).length,1);
 await assert.rejects(act(f,'A','resume'));assert.equal(f.rows().cart_prepared_jobs.find(row=>row.operation_id===uncertain.operation_id).state,'uncertain');
 const verifiedWrites=f.counts.admin_mutations;await act(f,'B','resume');await f.restart();await act(f,'B','resume');assert.equal(f.counts.admin_mutations,verifiedWrites);
});

test('suspended confirmed cart requires unchanged claims and a normal resume with no pending mutation',async t=>{
 const f=await persistentRig(t);await initialize(f,'B');const b=await add(f,'B','resume-claims-b');await losePublication(f);const writes=f.counts.admin_mutations;
 await assert.rejects(act(f,'B','resume',{operation:{kind:'add',job:b.reference.id,operation_id:b.reservation.operation_id,quantity:1}}));assert.equal(f.counts.admin_mutations,writes);
 const line=f.carts.get(f.ids.B).cart.lines.nodes[0],attribute=line.attributes.find(row=>row.key==='Message');assert.ok(attribute);const value=attribute.value;attribute.value='changed after clear';
 await assert.rejects(act(f,'B','resume'));assert.equal(f.counts.admin_mutations,writes);assert.equal(grants(f).grants.length,0);attribute.value=value;
 assert.equal((await act(f,'B','resume')).items[0].subtotal_cents,4800);assert.equal(f.counts.admin_mutations,writes+1);
});

test('suspended owner with an issued native candidate cannot restore or retry that preparation',async t=>{
 const f=await persistentRig(t);await initialize(f,'B');await add(f,'B','resume-issued-b');const candidate=await prepare(f,'B','resume-issued-pending',2);await losePublication(f);
 const writes=f.counts.admin_mutations;await assert.rejects(act(f,'B','resume'));assert.equal(f.counts.admin_mutations,writes);assert.equal(grants(f).grants.length,0);
 assert.equal(f.rows().cart_prepared_jobs.find(row=>row.operation_id===candidate.reservation.operation_id).state,'issued');
});

test('suspended confirmed photo job cannot be restored after provider asset removal',async t=>{
 const f=await persistentRig(t);await initialize(f,'B');const asset=await upload(f,'B','resume-removed-upload');await add(f,'B','resume-removed-job',1,{...photo,asset_ids:[asset.asset_id]});await losePublication(f);
 f.hook=async(stage,{url,body}={})=>{if(stage==='provider_info'&&url===`https://api.uploadcare.com/files/${asset.asset_id}/`)body.datetime_removed='2026-10-30T05:01:01Z';};
 f.clock.time+=61000;await f.runtime.tick();assert.equal(f.rows().upload_intents.find(row=>row.asset===asset.asset_id).state,'removed');const writes=f.counts.admin_mutations;
 await assert.rejects(act(f,'B','resume'));assert.equal(f.counts.admin_mutations,writes);assert.equal(grants(f).grants.length,0);
});
