import test from 'node:test';
import assert from 'node:assert/strict';
import {persistentRig} from '../../../fixtures/film-printing/persistent-client-staging-20261030/rig.mjs';
import {quantitySignature} from '../checkout/quantity-signature.js';

const darkroom={service:'Darkroom Prints',size:'8” × 10”',paper:'RC Matte',lab:'Chicago',options:{Process:'Color',Borders:'Borderless (Edge-to-edge)',Turnaround:'Standard (4-5 days)','Scanning Options':'Yes',Negatives:'Mail In'},asset_ids:[],copies:1,message:'Persistent integration fixture'};
const grants=f=>JSON.parse(f.m.data.shop.authority.value);
const act=(f,role,name,input={})=>f.clients[role].session.checkout(name,async()=>f.ids[role],input);
async function initialize(f,role){await f.clients[role].session.issue();await act(f,role,'bind');await act(f,role,'install');}
async function add(f,role,key){
 const session=f.clients[role].session,job=await session.request('/jobs',{...darkroom,request_key:key});
 const p=await act(f,role,'eligible',{reference:job.reference,generation:1});
 f.addJob({...p.item,properties:{...p.item.properties,_bfl_signature:quantitySignature(p.reference.signature,1)}},role);f.reprice(role);
 await act(f,role,'resume',{operation:{kind:'add',job:p.reference.id,operation_id:p.reservation.operation_id,quantity:1}});return p;
}
test('persistent actual HTTP composition keeps two carts isolated across hour boundary and SQLite restart',async t=>{
 const f=await persistentRig(t);await initialize(f,'A');const a=await add(f,'A','persistent-runtime-job-a');
 const before=f.rows().resource_sessions.map(row=>({...row})),authority=grants(f);assert.equal(authority.grants.length,1);
 await initialize(f,'B');assert.deepEqual(grants(f),authority);const b=await add(f,'B','persistent-runtime-job-b');
 assert.equal(grants(f).grants.length,2);assert.equal((await act(f,'A','resume')).items[0].subtotal_cents,4800);assert.equal((await act(f,'B','resume')).items[0].subtotal_cents,4800);
 const original=f.rows().resource_sessions.map(row=>({...row})),writes=f.counts.admin_mutations;f.clock.time+=3600001;
 await f.runtime.tick();assert.equal(grants(f).grants.length,2);await f.restart();assert.equal(f.counts.admin_mutations,writes);
 assert.deepEqual(f.rows().resource_sessions.map(row=>({...row})),original);assert.equal((await act(f,'A','resume')).items[0].subtotal_cents,4800);assert.equal((await act(f,'B','resume')).items[0].subtotal_cents,4800);
 f.carts.get(f.ids.A).cart.lines.nodes=[];f.reprice('A');await act(f,'A','resume',{operation:{kind:'remove',job:a.reference.id,operation_id:'persistent-native-remove-a',quantity:0}});
 assert.equal(grants(f).grants.length,1);assert.equal(grants(f).grants[0].lines[0].claims.job,b.reference.id);assert.equal((await act(f,'B','resume')).items[0].subtotal_cents,4800);
 assert.deepEqual({...f.rows().resource_sessions[0]},before[0]);
});
