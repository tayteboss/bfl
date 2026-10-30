import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {persistentRig} from '../../../fixtures/film-printing/persistent-client-staging-20261030/rig.mjs';
import {createResourceSession} from '../theme/resource-session.js';
import {createFilmPrintingForm} from '../theme/film-printing-form.js';
import {createPreparedCheckout} from '../theme/prepared-checkout.js';
import {BINDING_DELETE,BINDING_MUTATION} from '../checkout/cart-capability.mjs';
const POLICY='bfl-persistent-staging-client-v1',key='bfl:accepted-cart-session:v1',hash=value=>createHash('sha256').update(value).digest('hex'),plain=x=>JSON.parse(JSON.stringify(x));
const darkroom={service:'Darkroom Prints',size:'8” × 10”',paper:'RC Matte',lab:'Chicago',options:{Process:'Color',Borders:'Borderless (Edge-to-edge)',Turnaround:'Standard (4-5 days)','Scanning Options':'Yes',Negatives:'Mail In'},asset_ids:[],copies:1,message:'Expired initialization fixture'};
const act=(f,role,action,input={})=>f.clients[role].session.checkout(action,async()=>f.ids[role],input);
async function fixture(t){
 const f=await persistentRig(t),data=new Map(),writes=[];
 const storage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};
 const options={fetchImpl:f.browserFetch,now:()=>f.clock.time,reloadStorage:storage,preparedMode:true,clientPolicy:POLICY,replaceCart:async()=>f.ids.A,verifyNewCart:async()=>f.ids.A};
 f.clients.A.session=createResourceSession(options);
 class Form extends EventTarget{dataset={filmPrintingForm:''};querySelector(){return null;}querySelectorAll(){return [];}}
 const actions={getCart:async()=>({cart:{id:f.ids.A,lines:[],totalQuantity:0,cost:{totalAmount:{amount:'0.00',currencyCode:'USD'}}}})};
 const ajax=async path=>({ok:true,redirected:false,json:async()=>path==='/cart.js'?{currency:'USD',items:[],item_count:0,total_price:0}:{'cart-drawer':'<div>Empty</div>'}});
 f.hook=async(stage,{query}={})=>{if(stage==='storefront'&&query.startsWith('mutation'))writes.push(query);};
 return Object.assign(f,{storage,options,writes,session:()=>createResourceSession(options),make:()=>createFilmPrintingForm(new Form(),{sessionOptions:options,checkoutForSession:s=>createPreparedCheckout(s,{actions,fetchImpl:ajax,now:()=>f.clock.time})})});
}
async function stage(f,kind){await f.clients.A.session.issue();if(kind!=='unbound')await act(f,'A','bind');if(kind==='confirmed')await act(f,'A','install');}
function editDb(f,fn){const db=new DatabaseSync(join(f.config.dataDir,'jobs.sqlite'));try{return fn(db);}finally{db.close();}}

for(const kind of ['unbound','bound','confirmed'])test(`next-day ${kind} initializing cart replaces once and preserves original session/attempt history`,async t=>{
 const f=await fixture(t);await stage(f,kind);const before=f.rows(),old=plain(before.resource_sessions[0]),attempts=plain(before.staging_capability_attempts),saved=f.storage.getItem(key),initial=f.writes.length;
 f.clock.time=old.deadline;await f.restart();const terminal=plain(f.rows().resource_sessions[0]);
 assert.equal(terminal.deadline,old.deadline);assert.equal(terminal.expires,old.expires);assert.equal(terminal.created,old.created);assert.equal(terminal.verifier,old.verifier);
 await f.make().issue();assert.equal(f.rows().resource_sessions.length,2);assert.deepEqual(plain(f.rows().resource_sessions.find(row=>row.owner===old.owner)),terminal);
 for(const row of attempts)assert.deepEqual(plain(f.rows().staging_capability_attempts.find(a=>a.id===row.id)),row);
 const replacement=f.rows().staging_cart_replacements[0];assert.equal(replacement.old_owner,old.owner);assert.equal(replacement.state,'issued');assert.equal(replacement.old_marker==='',kind!=='confirmed');
 assert.equal(f.writes.length-initial,kind==='confirmed'?3:2);assert.equal(f.writes.filter(q=>q===BINDING_DELETE).length,kind==='confirmed'?1:0);
 assert.equal(f.rows().staging_binding_history.length,kind==='confirmed'?1:0);assert.equal(JSON.parse(f.storage.getItem(key)).state,'initialized');
 const after=plain(f.rows().resource_sessions);await f.make().issue();assert.deepEqual(plain(f.rows().resource_sessions),after);
 f.storage.setItem(key,saved);await assert.rejects(f.session().replaceSession(f.ids.A));assert.deepEqual(plain(f.rows().resource_sessions),after);assert.equal(f.rows().staging_cart_replacements.length,1);
});

test('valid replacement credential is immediately initializing and survives reload before bind',async t=>{
 const f=await fixture(t);await stage(f,'unbound');f.clock.time=f.rows().resource_sessions[0].deadline;const receipt=await f.session().replaceSession(f.ids.A),record=JSON.parse(f.storage.getItem(key));
 assert.equal(record.state,'initializing');assert.equal(record.expires,receipt.expires_at);assert.equal(record.operation,null);assert.equal(f.writes.length,0);
 await f.make().issue();assert.equal(f.rows().resource_sessions.length,2);assert.equal(f.writes.length,2);assert.equal(JSON.parse(f.storage.getItem(key)).state,'initialized');
});

for(const kind of ['unbound','bound','confirmed'])test(`lost ${kind} terminal replacement response cannot issue another owner or replay deletion`,async t=>{
 const f=await fixture(t);await stage(f,kind);const old=plain(f.rows().resource_sessions[0]),saved=f.storage.getItem(key);f.clock.time=old.deadline;let lost=true;
 f.options.fetchImpl=async(url,options)=>{const response=await f.browserFetch(url,options);if(lost&&new URL(url,globalThis.location.origin).pathname==='/checkout/replace_session'){lost=false;throw TypeError('lost replacement receipt');}return response;};
 await assert.rejects(f.session().replaceSession(f.ids.A));const count=f.writes.length;assert.equal(JSON.parse(f.storage.getItem(key)).operation.kind,'replace_session');assert.equal(f.rows().resource_sessions.length,2);
 await assert.rejects(f.session().replaceSession(f.ids.A));f.storage.setItem(key,saved);await assert.rejects(f.session().replaceSession(f.ids.A));assert.equal(f.rows().resource_sessions.length,2);assert.equal(f.writes.length,count);
 assert.deepEqual(plain(f.rows().resource_sessions.find(row=>row.owner===old.owner)),old);assert.equal(f.rows().staging_cart_replacements.length,1);
});

for(const state of ['rejected','unknown'])test(`expired ${state} capability attempt stays spent`,async t=>{
 const f=await fixture(t);await f.clients.A.session.issue();let once=true;f.hook=async(stage,{query}={})=>{if(stage==='storefront'&&once&&(state==='rejected'?!query.startsWith('mutation'):query.startsWith('mutation'))){once=false;throw Error('interrupted capability');}};
 await assert.rejects(act(f,'A','bind'));const before=plain(f.rows().staging_capability_attempts);assert.equal(before[0].state,state);f.clock.time=f.rows().resource_sessions[0].deadline;
 await assert.rejects(f.make().issue());assert.equal(f.rows().resource_sessions.length,1);assert.equal(f.rows().staging_cart_replacements.length,0);assert.deepEqual(plain(f.rows().staging_capability_attempts),before);
});
for(const state of ['reserved','sending','retired'])test(`expired ${state} marker reservation cannot be treated as absent`,async t=>{
 const f=await fixture(t);await stage(f,'confirmed');editDb(f,db=>db.prepare('UPDATE cart_checkout_bindings SET state=?').run(state));const before=plain(f.rows().cart_checkout_bindings),writes=f.writes.length;f.clock.time=f.rows().resource_sessions[0].deadline;
 await assert.rejects(f.make().issue());assert.equal(f.rows().resource_sessions.length,1);assert.equal(f.rows().staging_cart_replacements.length,0);assert.equal(f.writes.length,writes);assert.deepEqual(plain(f.rows().cart_checkout_bindings),before);
});
for(const kind of ['upload','job','preparation','grant'])test(`no-marker replacement rejects retained ${kind} history`,async t=>{
 const f=await fixture(t);await stage(f,'bound');const owner=f.rows().resource_sessions[0].owner;
 if(kind==='upload')await f.clients.A.session.request('/uploads/intents',{request_key:'expired-init-retained-upload'});
 if(kind==='job')await f.clients.A.session.request('/jobs',{...darkroom,request_key:'expired-init-retained-job'});
 if(kind==='preparation')editDb(f,db=>db.prepare('INSERT INTO cart_prepared_jobs (operation_id,job_id,owner_hash,cart_hash,binding_hash,reference_hash,selection_hash,generation,epoch,expires_at,state) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('retained-operation','retained-job',hash(owner),hash(f.ids.A),'a'.repeat(64),'b'.repeat(64),'c'.repeat(64),1,0,f.clock.time+86400000,'cancelled'));
 if(kind==='grant')editDb(f,db=>db.prepare('INSERT INTO staging_grant_versions VALUES (?,?,?,?,?,?)').run(owner,1,f.clock.time+86400000,'retired','{}',f.clock.time));
 const before=f.rows(),writes=f.writes.length;f.clock.time=before.resource_sessions[0].deadline;await assert.rejects(f.make().issue());assert.equal(f.rows().resource_sessions.length,1);assert.equal(f.rows().staging_cart_replacements.length,0);assert.equal(f.writes.length,writes);
 for(const table of ['jobs','upload_intents','cart_prepared_jobs','staging_grant_versions'])assert.deepEqual(plain(f.rows()[table]),plain(before[table]));
});

test('unbound old credential cannot take over a previously bound native cart',async t=>{
 const f=await fixture(t);await stage(f,'unbound');await f.clients.B.session.issue();await act(f,'B','bind');const before=plain(f.rows().staging_capability_attempts),writes=f.writes.length;f.clock.time=f.rows().resource_sessions[0].deadline;
 await assert.rejects(f.session().replaceSession(f.ids.B));assert.equal(f.rows().resource_sessions.length,2);assert.equal(f.rows().staging_cart_replacements.length,0);assert.equal(f.writes.length,writes);assert.deepEqual(plain(f.rows().staging_capability_attempts),before);
});

test('expired initializing replacement preserves another active cart and its exact remaining grant',async t=>{
 const f=await fixture(t);await stage(f,'bound');const old=plain(f.rows().resource_sessions[0]);f.clock.time+=3600000;await f.clients.B.session.issue();await act(f,'B','bind');await act(f,'B','install');
 const job=await f.clients.B.session.request('/jobs',{...darkroom,request_key:'independent-next-day-b'});await act(f,'B','eligible',{reference:job.reference,generation:1});const grant=JSON.parse(f.m.data.shop.authority.value).grants[0],b=plain(f.rows().resource_sessions[1]);
 f.clock.time=old.deadline;await f.make().issue();assert.deepEqual(JSON.parse(f.m.data.shop.authority.value).grants,[grant]);assert.deepEqual(plain(f.rows().resource_sessions.find(row=>row.owner===b.owner)),b);assert.equal(f.rows().resource_sessions.length,3);
});


test('the one-shot tokenless recovery tombstone survives a legitimate next-day replacement',async t=>{
 const f=await fixture(t),original=JSON.stringify({state:'blocked'});f.storage.setItem(key,original);await f.session().recoverUnbound();
 assert.equal(JSON.parse(f.storage.getItem(key)).initialization_recovery,original);f.clock.time=f.rows().resource_sessions[0].deadline;
 await f.session().replaceSession(f.ids.A);assert.equal(JSON.parse(f.storage.getItem(key)).initialization_recovery,original);assert.equal(JSON.parse(f.storage.getItem(key)).state,'initializing');
 await f.make().issue();assert.equal(JSON.parse(f.storage.getItem(key)).initialization_recovery,original);assert.equal(f.rows().resource_sessions.length,2);
});


for(const kind of ['unbound','confirmed'])test(`repeated next-day interruption retains exact ${kind} issued lineage without replay`,async t=>{
 const f=await fixture(t);await stage(f,kind);const initial=plain(f.rows().resource_sessions),attempts=plain(f.rows().staging_capability_attempts);
 // Each replacement is left unbound until its own independent deadline.
 for(let day=0;day<3;day++){
  const before=plain(f.rows().resource_sessions),old=before.at(-1);f.clock.time=old.deadline;
  await f.session().replaceSession(f.ids.A);assert.equal(f.rows().resource_sessions.length,before.length+1);
  assert.deepEqual(plain(f.rows().resource_sessions.slice(0,-1)),before);assert.deepEqual(plain(f.rows().staging_capability_attempts),attempts);
  assert.equal(JSON.parse(f.storage.getItem(key)).state,'initializing');
 }
 const replacements=plain(f.rows().staging_cart_replacements);assert.equal(replacements.length,3);assert.ok(replacements.every(r=>r.state==='issued'));
 assert.equal(f.writes.filter(q=>q===BINDING_DELETE).length,kind==='confirmed'?1:0);
 await f.make().issue();assert.equal(f.rows().resource_sessions.length,4);assert.equal(JSON.parse(f.storage.getItem(key)).state,'initialized');
 for(const row of initial)assert.deepEqual(plain(f.rows().resource_sessions.find(r=>r.owner===row.owner)),row);
 for(const row of attempts)assert.deepEqual(plain(f.rows().staging_capability_attempts.find(r=>r.id===row.id)),row);
 assert.deepEqual(plain(f.rows().staging_cart_replacements),replacements);
 assert.equal(f.writes.filter(q=>q===BINDING_MUTATION).length,kind==='confirmed'?2:1);
});


test('an unbound replacement credential stays pinned to its exact issued native cart',async t=>{
 const f=await fixture(t);await stage(f,'unbound');f.clock.time=f.rows().resource_sessions[0].deadline;await f.session().replaceSession(f.ids.A);
 const fresh=f.session();assert.equal(fresh.restore().state,'initializing');const writes=f.writes.length;
 await assert.rejects(fresh.checkout('bind',async()=>f.ids.B));assert.equal(f.writes.length,writes);assert.equal(f.rows().staging_capability_attempts.length,0);
 await fresh.checkout('bind',async()=>f.ids.A);assert.equal(f.rows().staging_capability_attempts.length,1);assert.equal(f.writes.length,writes+1);
});
