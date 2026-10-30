import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createLifecycle,fingerprint} from '../jobs/lifecycle.mjs';
import {cartHash} from '../checkout/storefront.mjs';
import {STORE,variantForLab,decodeAuthority,inspectCart} from '../checkout/authority.js';
import {leaseEnvelope} from '../checkout/lease.mjs';
import {serializeAuthority} from '../checkout/projector.mjs';
import {installStagingGrantSchema,createStagingGrantPublication} from '../checkout/staging-grants.mjs';
const hex=n=>String(n).repeat(64),source={config_version:'f03-'+hex(2).slice(0,24),config_sha256:hex(2),price_version:'price-staging-test'};
const stamp=ms=>new Date(ms).toISOString().slice(0,19);
function grant(owner,{copies=1,message='',jobs=1}={}){
 return {cart:cartHash('cart-'+owner),owner:cartHash(owner),customer_id:null,binding:cartHash('binding-'+owner),generation:1,epoch:0,
  lines:Array.from({length:jobs},(_,index)=>({variant_id:variantForLab('miami'),unit_cents:40,file_count:1,shipping_eligible:true,location_id:'gid://shopify/Location/1',claims:{flow:'f05',job:owner+'-'+index,revision:hex(1),config:source.config_version,signature:hex(3),service:'photo',size:'4x6',paper:'matte',lab:'miami',message,borders:'',turnaround:'Standard',files:'1',size_mode:'fixed',width:'',height:'',process:'',scanning:'',negatives:''}}))};
}
function rig(t,{initialSchema=5}={}){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());const lifecycle=createLifecycle(db);installStagingGrantSchema(db);
 let time=Date.parse('2026-10-30T12:00:00Z'),remote={schema:5,store:STORE,...source,valid_on:'2026-10-30',lease:{token:hex(4),deadline:stamp(time),expires_at:time},grants:[]},version=0,publishes=0,armed=null;
 if(initialSchema===1){remote.schema=1;delete remote.lease;}
 const owners=new Map(),validated=[],events=[];let fail=null,wait=null;
 const context=()=>({release:{version:source.config_version,sha256:source.config_sha256},catalog:{version:source.price_version},shopDate:'2026-10-30',timezone:'UTC',field:{value:serializeAuthority(remote),compareDigest:String(version)}});
 const admin={read:async()=>context(),async reconcile(){const operation=lifecycle.startRecovery();remote={...remote,grants:[]};version++;lifecycle.finish(operation);}};
 const options={db,lifecycle,admin,source,now:()=>time,enabled:true,permit:()=>true,
  validateOwner:async row=>{validated.push(row.owner);const owned=owners.get(row.owner);return owned?.until===row.originalUntil&&owned.valid!==false&&fingerprint(owned.grant)===fingerprint(row.grant);},
  deadlineFor:(until)=>({expires_at:until,deadline:stamp(until)})};
 let armedGuard;options.armPublication=(prepared,guard)=>{armed=prepared;armedGuard=guard;};
 // The real transport consumes its guard inside the lifecycle publication.
 admin.publish=async prepared=>{
  assert.equal(prepared.context.field.compareDigest,String(version));assert.equal(armed,prepared);events.push('publish');publishes++;
  const operation=lifecycle.startPublication(prepared.ticket,prepared.value);armedGuard(operation);
  if(wait)await wait;if(fail==='before')throw Error('lost before send');remote=JSON.parse(prepared.value);version++;
  if(fail==='after')throw Error('lost response');lifecycle.finish(operation);
 };
 let service=createStagingGrantPublication(options);
 const add=(owner,{until=time+60000,body=grant(owner),guard=()=>{},guardPublication=()=>{},prepareHook}={})=>{
  owners.set(owner,{until,grant:body});return service.update({owner,originalUntil:until,guard,guardPublication,prepare:async selected=>{
   if(prepareHook)await prepareHook(selected);const ticket=lifecycle.beginPreparation(),authority={schema:5,store:STORE,...source,valid_on:'2026-10-30',lease:{token:hex(5),expires_at:until,deadline:stamp(until)},grants:[body]},value=serializeAuthority(authority);lifecycle.stage(ticket,value);
   return {ticket,context:selected,authority,value};
  }});
 };
 return {db,lifecycle,options,owners,validated,events,add,get service(){return service;},get time(){return time;},set time(value){time=value;},get remote(){return remote;},get publishes(){return publishes;},set fail(value){fail=value;},set wait(value){wait=value;},restart(){service=createStagingGrantPublication(options);return service;},async clearRemote(){const operation=lifecycle.startRecovery();remote={...remote,grants:[]};version++;lifecycle.finish(operation);},tamper(){remote={...remote,valid_on:'2026-10-29'};version++;}};
}
function inputFor(authority,owner){const g=authority.grants.find(row=>row.owner===cartHash(owner));return {leaseOwner:{lease:{value:leaseEnvelope(serializeAuthority(authority))}},shop:{localTime:{beforeDeadline:true}},cart:{binding:{value:g.binding},buyerIdentity:null,lines:g.lines.map((line,index)=>({id:'gid://shopify/CartLine/'+index,quantity:1,merchandise:{id:line.variant_id,product:{id:'gid://shopify/Product/15620086005871'}},sellingPlanAllocation:null,cost:{amountPerQuantity:{currencyCode:'USD'}},...Object.fromEntries(Object.entries(line.claims).map(([key,value])=>[key,{value:key==='signature'?`v3:${value}:1`:value}]))}))}};}

test('two independently validated owners merge and both actual Function readers retain exact prices',async t=>{
 const f=rig(t),first=f.time+60000,second=f.time+120000;await f.add('owner-a',{until:first});const a=structuredClone(f.remote.grants[0]);await f.add('owner-b',{until:second});
 assert.equal(f.remote.grants.length,2);assert.deepEqual(f.remote.grants[0],a);assert.equal(f.remote.lease.expires_at,first);
 for(const owner of ['owner-a','owner-b']){const result=inspectCart(inputFor(f.remote,owner));assert.equal(result.valid,true);assert.equal(result.lines[0].unit_cents,40);}
 assert.equal(f.service.status().owners,2);assert.ok(f.validated.filter(owner=>owner==='owner-a').length>=3);
});
test('expiry prunes only A and republishes unchanged B under B original deadline',async t=>{
 const f=rig(t),start=f.time;await f.add('owner-a',{until:start+60000});await f.add('owner-b',{until:start+120000});const b=structuredClone(f.remote.grants[1]),token=f.remote.lease.token;f.time=start+60000;
 await f.service.prune();assert.deepEqual(f.remote.grants,[b]);assert.equal(f.remote.lease.expires_at,start+120000);assert.notEqual(f.remote.lease.token,token);
 const rows=f.db.prepare('SELECT owner,original_until,state FROM staging_grant_versions ORDER BY owner,revision').all();assert.deepEqual(rows.map(r=>[r.owner,r.original_until,r.state]),[['owner-a',start+60000,'active'],['owner-a',start+60000,'retired'],['owner-b',start+120000,'active']]);
});
test('last expiry publishes EMPTY and never creates a replacement owner',async t=>{
 const f=rig(t);await f.add('a');f.time+=60000;await f.service.prune();assert.equal(f.remote.grants.length,0);assert.equal(f.service.status().owners,0);assert.equal(f.owners.size,1);assert.equal(f.publishes,2);
});
test('existing original expiry cannot be lengthened, shortened or revived',async t=>{
 const f=rig(t),until=f.time+60000;await f.add('a',{until});for(const changed of [until+1,until-1])await assert.rejects(f.add('a',{until:changed}),/OWNER_CHANGED/);
 f.time=until;await f.service.prune();await assert.rejects(f.add('a',{until:f.time+60000}),/OWNER_CHANGED/);assert.equal(f.publishes,2);
});
test('clean restart recovers exact grant registry and preserves another owner on edit',async t=>{
 const f=rig(t),until=f.time+60000;await f.add('a',{until});await f.add('b',{until:until+60000});const b=structuredClone(f.remote.grants[1]);f.restart();assert.equal((await f.service.verify()).verified,true);
 await f.add('a',{until,body:grant('a',{message:'new note'})});assert.deepEqual(f.remote.grants[1],b);assert.equal(f.remote.grants[0].lines[0].claims.message,'new note');assert.equal(f.service.status().revision,3);
});
test('concurrent callers serialize before context/projector creation, preventing lost grant updates',async t=>{
 const f=rig(t);await Promise.all([f.add('a'),f.add('b')]);assert.equal(f.remote.grants.length,2);assert.equal(f.publishes,2);assert.equal(f.lifecycle.state().operation,null);
});
test('lost publication response is durable across restart and is never retried',async t=>{
 const f=rig(t);await f.add('a');f.fail='after';await assert.rejects(f.add('b'),/lost response/);assert.equal(f.service.status().uncertain,true);const sends=f.publishes;
 f.restart();await assert.rejects(f.service.prune(),/PENDING|UNCERTAIN/);await assert.rejects(f.add('b'),/PENDING|UNCERTAIN/);assert.equal(f.publishes,sends);
 await assert.rejects(f.service.recoverCleared(),/PENDING|RECOVERY/);
 f.fail=null;await f.clearRemote();await f.service.recoverCleared();assert.equal(f.remote.grants.length,0);assert.equal(f.service.status().owners,0);assert.equal(f.service.status().uncertain,false);assert.equal(f.publishes,sends);
 assert.deepEqual(f.db.prepare('SELECT owner,state FROM staging_grant_versions WHERE state=? ORDER BY owner').all('suspended').map(r=>[r.owner,r.state]),[['a','suspended'],['b','suspended']]);
});
test('fresh proved resume can reauthorize only its suspended owner with the same original deadline',async t=>{
 const f=rig(t),until=f.time+60000;await f.add('a',{until});await f.add('b',{until});await f.clearRemote();await f.service.recoverCleared();await f.add('b',{until});assert.equal(f.remote.grants.length,1);assert.equal(f.remote.grants[0].owner,cartHash('b'));assert.equal(f.remote.lease.expires_at,until);
});
test('invalid surviving owner aborts before publish instead of silently dropping it',async t=>{
 const f=rig(t);await f.add('a');f.owners.get('a').valid=false;await assert.rejects(f.add('b'),/OWNER_UNVERIFIED/);assert.equal(f.remote.grants.length,1);assert.equal(f.publishes,1);assert.equal(f.service.status().uncertain,false);
});
test('unexpected remote projection or source changes cannot overwrite another writer',async t=>{
 const f=rig(t);await f.add('a');f.tamper();await assert.rejects(f.add('b'),/AUTHORITY_CHANGED/);assert.equal(f.publishes,1);
 assert.throws(()=>createStagingGrantPublication({...f.options,source:{...source,price_version:'changed'}}),/SOURCE_CHANGED/);
});
test('expiry during an awaited complete projection validation never publishes stale ownership',async t=>{
 const f=rig(t);f.options.validateOwner=async()=>{f.time+=60000;return true;};f.restart();await assert.rejects(f.add('a'),/OWNER_EXPIRED/);assert.equal(f.publishes,0);assert.equal(f.service.status().uncertain,false);
});
test('an invalid envelope beyond the earliest owner deadline cannot publish',async t=>{
 const f=rig(t);f.options.deadlineFor=until=>({deadline:stamp(until+1),expires_at:until+1});f.restart();await assert.rejects(f.add('a'),/LEASE_INVALID/);assert.equal(f.publishes,0);
});
test('total-line and exact authority byte ceilings reject admission without evicting existing carts',async t=>{
 const f=rig(t);await f.add('a');await assert.rejects(f.add('b',{body:grant('b',{jobs:8})}),/CAPACITY|PREPARATION/);assert.equal(f.publishes,1);assert.equal(f.remote.grants.length,1);
 let rejected=false;for(let n=0;n<8;n++){try{await f.add('long-owner-'+n,{body:grant('long-owner-'+n,{message:'x'.repeat(200)})});}catch(error){assert.match(error.message,/CAPACITY|INVALID_AUTHORITY|AUTHORITY_SIZE/);rejected=true;break;}}
 assert.equal(rejected,true);assert.equal(f.remote.grants.some(g=>g.owner===cartHash('a')),true);assert.ok(decodeAuthority(serializeAuthority(f.remote)));
});
test('retiring one exact owner preserves other owners and their original expiry',async t=>{
 const f=rig(t),until=f.time+60000;await f.add('a',{until});await f.add('b',{until:until+60000});await f.service.retire('a');assert.equal(f.remote.grants.length,1);assert.equal(f.remote.grants[0].owner,cartHash('b'));assert.equal(f.remote.lease.expires_at,until+60000);
});

test('mixed-case owner ordering survives restart byte-for-byte',async t=>{
 const f=rig(t);await f.add('owner_a');await f.add('owner_Z');const before=serializeAuthority(f.remote);f.restart();await f.service.verify();assert.equal(serializeAuthority(f.remote),before);
});
test('retained history cannot be updated/deleted or acquire a different original deadline',async t=>{
 const f=rig(t);await f.add('a');assert.throws(()=>f.db.prepare('UPDATE staging_grant_versions SET original_until=original_until+1').run(),/HISTORY_RETAINED/);
 assert.throws(()=>f.db.prepare('DELETE FROM staging_grant_versions').run(),/HISTORY_RETAINED/);
 const row=f.db.prepare('SELECT * FROM staging_grant_versions').get();assert.throws(()=>f.db.prepare('INSERT INTO staging_grant_versions VALUES (?,?,?,?,?,?)').run('a',2,row.original_until+1,'active',row.grant_value,f.time),/DEADLINE_IMMUTABLE/);
 assert.equal(f.service.owned('a').originalUntil,row.original_until);assert.equal(f.service.owned('missing'),null);
});

test('known owner invalidation clears then restores exact other owner without extending its deadline',async t=>{
 const f=rig(t),until=f.time+60000;await f.add('a',{until});await f.add('b',{until:until+60000});const b=structuredClone(f.remote.grants[1]);
 f.lifecycle.event('retire:a',{owner:'a'},()=>f.lifecycle.retire('owner','a'));
 await f.service.reconcileKnown({excludeOwners:['a'],authorizeInvalidations:events=>events.length===1&&events[0].id==='retire:a'});
 assert.deepEqual(f.remote.grants,[b]);assert.equal(f.remote.lease.expires_at,until+60000);assert.equal(f.service.status().owners,1);assert.equal(f.lifecycle.state().pending,0);
});
test('unknown invalidation cannot clear or restore any projection',async t=>{
 const f=rig(t);await f.add('a');const before=serializeAuthority(f.remote),sends=f.publishes;
 f.lifecycle.event('unknown:event',{},()=>{});await assert.rejects(f.service.reconcileKnown({authorizeInvalidations:()=>false}),/INVALIDATION_UNPROVEN/);
 assert.equal(serializeAuthority(f.remote),before);assert.equal(f.publishes,sends);assert.equal(f.lifecycle.state().pending,1);
});
test('known restoration lost response remains durable and never replays on another reconciliation',async t=>{
 const f=rig(t);await f.add('a');await f.add('b');f.lifecycle.event('retire:a',{},()=>{});f.fail='after';
 await assert.rejects(f.service.reconcileKnown({excludeOwners:['a'],authorizeInvalidations:()=>true}),/lost response/);const sends=f.publishes;
 f.restart();await assert.rejects(f.service.reconcileKnown({excludeOwners:['a'],authorizeInvalidations:()=>true}),/PUBLICATION_UNCERTAIN/);assert.equal(f.publishes,sends);assert.equal(f.service.status().uncertain,true);
});

test('first persistent publication accepts only the source operator initial schema1 EMPTY',async t=>{
 const f=rig(t,{initialSchema:1});await f.service.verify();await f.service.prune();assert.equal(f.publishes,0);await f.add('a');assert.equal(f.remote.schema,5);assert.equal(f.remote.grants.length,1);
});
test('known pre-publication invalidation clears schema1 EMPTY without inventing an eligibility lease',async t=>{
 const f=rig(t,{initialSchema:1});f.lifecycle.event('unused-upload',{},()=>{});await f.service.reconcileKnown({authorizeInvalidations:()=>true});assert.equal(f.publishes,0);assert.equal(f.remote.schema,1);await f.service.verify();await f.add('a');assert.equal(f.remote.schema,5);
});
test('releasing an empty cart suspends its grant, allows the same original owner, and retains other carts',async t=>{
 const f=rig(t),until=f.time+60000;await f.add('a',{until});await f.add('b');await f.service.release('a');assert.equal(f.service.owned('a').state,'suspended');assert.equal(f.remote.grants.length,1);await f.add('a',{until});assert.equal(f.remote.grants.length,2);assert.equal(f.service.owned('a').originalUntil,until);
});
test('combined capacity failure precedes a prepared reservation callback',async t=>{
 const f=rig(t);await f.add('a',{body:grant('a',{jobs:8})});let reserved=0;const owner='b',body=grant(owner);f.owners.set(owner,{until:f.time+60000,grant:body});
 await assert.rejects(f.service.update({owner,originalUntil:f.time+60000,beforeReserve:()=>reserved++,prepare:async context=>{const authority={...f.remote,grants:[body]},value=serializeAuthority(authority),ticket=f.lifecycle.beginPreparation();f.lifecycle.stage(ticket,value);return {context,authority,value,ticket};}}),/CAPACITY/);assert.equal(reserved,0);
});
