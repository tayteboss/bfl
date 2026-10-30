import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {rig,id,origin,CAPABILITY_ACTION,deferred} from '../../../fixtures/film-printing/f06l/rig.mjs';
import {openCartCapability,createCartCapabilityTransport,CAPABILITY_MUTATION} from '../checkout/cart-capability.mjs';
import {createLifecycle} from '../jobs/lifecycle.mjs';
import {bindCurrentCart} from '../checkout/storefront.mjs';
import {STORE} from '../configuration/schema.mjs';
import {SHOP} from '../backend/config.mjs';
import {openDatabase,migrateCartCapability} from '../backend/storage.mjs';
import {createResourceSessions,SESSION_ONLY_PURPOSE,UPLOAD_ONLY_PURPOSE} from '../backend/resource-session.mjs';

test('F06L real HTTP/SQLite capability-only result never satisfies strict owner gate; encrypted exact custody',async t=>{
 const f=await rig(t),token=await f.issue(),result=await f.inspect(token);assert.equal(result.capability,'verified');assert.equal(result.cart_verified,false);assert.equal(result.customer_context,'unproven');assert.equal(f.state.writes,1);assert.equal(f.state.reads,2);
 const row=f.rows()[0];assert.equal(row.state,'capability_only');assert.equal(openCartCapability(row.sealed_cart,f.config.sessionSecret),id);assert.throws(()=>openCartCapability(row.sealed_cart,'wrong'.repeat(12)),/CUSTODY_REJECTED/);
 assert.equal(JSON.stringify(row).includes(id),false);assert.equal(readFileSync(join(f.config.dataDir,'jobs.sqlite')).includes(Buffer.from(id)),false);
 assert.equal(f.adapter.status(f.request(token),result.attempt_id).checkout_ready,false);
 await assert.rejects(bindCurrentCart({read:async()=>({id,customer_id:null}),verifyOwnership:f.adapter.verifyOwnership,owner:'test-owner',cart_id:id}),/CART_BUYER_PROOF_UNAVAILABLE/);
 assert.match(CAPABILITY_MUTATION,/lines:\[\]/);assert.doesNotMatch(CAPABILITY_MUTATION,/note\s*:/);
});

test('F06L prior owner/cart reservations forbid replay, foreign owner, key change and second cart without extra mutation',async t=>{
 const f=await rig(t),a=await f.issue(),b=await f.issue();await f.inspect(a);
 for(const [token,cart] of [[a,id],[b,id],[a,id+'x'],[a,id.replace('synthetic-cart','other-cart')],[b,id+'x']])await assert.rejects(f.inspect(token,cart),/REPLAY/);
 assert.equal(f.rows().length,1);assert.equal(f.state.writes,1);
});

test('F06L one-use proof is principal/action bound; absent, context-only and renewal proof cannot authorize',async t=>{
 const f=await rig(t),a=await f.issue(),b=await f.issue(),p=(await f.proof(CAPABILITY_ACTION,a)).body.proof;
 await assert.rejects(f.inspect(b,id,p),/BINDING/);await f.inspect(a,id,p);await assert.rejects(f.inspect(a,id,p),/PROOF_REJECTED/);
 await assert.rejects(f.inspect(undefined,id,p),/RESOURCE_REJECTED/);
 const renew=(await f.proof('renew',b)).body.proof;await assert.rejects(f.inspect(b,id,renew),/PROOF_REJECTED/);
 assert.equal(f.state.writes,1);
});

test('F06L default proof composition has no capability action',async t=>{
 const f=await rig(t,{cartCapability:false}),a=await f.issue();assert.equal((await f.proof(CAPABILITY_ACTION,a)).status,403);assert.equal(f.state.writes,0);
});

for(const purpose of [SESSION_ONLY_PURPOSE,UPLOAD_ONLY_PURPOSE])test('F06L rejects '+purpose+' without promotion',async t=>{
 const f=await rig(t);await f.close();const db=new DatabaseSync(join(f.config.dataDir,'jobs.sqlite'));
 // Real purpose-specific issuer on the SAME test SQLite connection and lifecycle;
 // no credential modification or SQL purpose override.
 const s=createResourceSessions(db,createLifecycle(db),()=>f.clock.time,{sessionOnly:purpose===SESSION_ONLY_PURPOSE,uploadOnly:purpose===UPLOAD_ONLY_PURPOSE});
 const a=s.issue({id:'x'.repeat(43),customerId:null,observedAt:f.clock.time}).token;
 db.close();const g=await rig(t,{config:f.config,clock:f.clock});assert.equal((await g.proof(CAPABILITY_ACTION,a)).status,403);await assert.rejects(g.inspect(a),/RESOURCE_REJECTED/);assert.equal(g.state.writes,0);await g.close();
});

for(const customer of ['123',''])test('F06L customer association/changed fresh identity unavailable '+customer,async t=>{
 const f=await rig(t),a=await f.issue('123'),p=(await f.proof(CAPABILITY_ACTION,a,customer)).body.proof;
 await assert.rejects(f.inspect(a,id,p),/CUSTOMER_PROOF_UNAVAILABLE/);assert.equal(f.rows().length,0);assert.equal(f.state.writes,0);
});

for(const mode of ['incomplete','error','warning','lost','changed'])test('F06L '+mode+' cannot produce ownership; no retries',async t=>{
 const f=await rig(t,{mode}),a=await f.issue();await assert.rejects(f.inspect(a));assert.equal(f.rows()[0].state,['incomplete','error'].includes(mode)?'rejected':'unknown');
 await assert.rejects(f.inspect(a));assert.equal(f.state.writes,mode==='incomplete'?0:1);
});

for(const change of ['renew','revoke','expire','epoch','pending','operation','proof_age'])test('F06L async '+change+' fences pending mutation response and retains custody',async t=>{
 const f=await rig(t),a=await f.issue(),gate=deferred();f.state.gate=gate;
 const pending=f.inspect(a);while(f.state.writes===0)await new Promise(r=>setTimeout(r,5));
 const ticket=f.store.resourceSessions.authenticate(f.request(a));
 if(change==='renew'){const p=(await f.proof('renew',a)).body.proof;f.store.resourceSessions.renew(ticket,f.proofs.observeFreshContext({request:f.request(a),proof:p,action:'renew',ticket}));}
 if(change==='revoke')f.store.resourceSessions.revoke(ticket);
 if(change==='expire')f.clock.time+=300001;
 if(change==='proof_age')f.clock.time+=30001;
 if(change==='epoch'||change==='operation'){const op=f.store.lifecycle.startRecovery();if(change==='epoch')f.store.lifecycle.finish(op);}
 if(change==='pending')f.store.lifecycle.event('pending-test',{kind:'test'},()=>{});
 gate.resolve();await assert.rejects(pending);assert.equal(f.rows()[0].state,'unknown');assert.equal(f.state.writes,1);
 assert.equal(openCartCapability(f.rows()[0].sealed_cart,f.config.sessionSecret),id);
});

test('F06L restart retains unknown custody, capacity/history and no auto-recovery or resend',async t=>{
 const f=await rig(t,{mode:'lost'}),a=await f.issue();await assert.rejects(f.inspect(a));const before=f.rows();await f.close();
 const g=await rig(t,{config:f.config,clock:f.clock});assert.deepEqual(g.rows(),before);await assert.rejects(g.inspect(a),/UNKNOWN/);assert.equal(g.state.writes,0);
 assert.throws(()=>migrateCartCapability(f.config),/DATABASE_LOCKED/);await g.close();
});

test('F06L schema8 explicit opt-in; old executable cannot open or reset history',async t=>{
 const f=await rig(t);await f.issue();await f.close();assert.throws(()=>openDatabase(f.config,{resourceSessions:true}),/MIGRATION_REQUIRED/);
 assert.throws(()=>migrateCartCapability(f.config),/MIGRATION_REQUIRED/);
 const g=await rig(t,{config:f.config,clock:f.clock});assert.equal(g.rows().length,0);await g.close();
});

test('F06M ordinary nonempty strict cart supports capability observation without ownership promotion',async t=>{
 const f=await rig(t),a=await f.issue();f.state.current.totalQuantity=1;f.state.current.lines.nodes=[{__typename:'CartLine',id:'gid://shopify/CartLine/synthetic-line',quantity:1,parentRelationship:null,attributes:[],sellingPlanAllocation:null,cost:{subtotalAmount:{amount:'1.00',currencyCode:'USD'}},merchandise:{__typename:'ProductVariant',id:'gid://shopify/ProductVariant/123',requiresComponents:false,product:{id:'gid://shopify/Product/123'}}}];
 const result=await f.inspect(a);assert.equal(f.state.writes,1);assert.equal(f.state.reads,2);
 assert.equal(result.buyer_association,'no_customer_account');assert.equal(result.customer_context,'unproven');
 assert.equal(f.rows()[0].state,'capability_only');await assert.rejects(f.adapter.verifyOwnership(),/BUYER_PROOF_UNAVAILABLE/);
});

test('F06L transport disabled by default; exact store, IP and bounded malformed responses',async()=>{
 let n=0;const cfg={store:STORE,shopId:SHOP,privateToken:'synthetic'.repeat(8)};
 await assert.rejects(createCartCapabilityTransport(cfg,{fetchImpl:()=>{n++;}}).read({cart_id:id,buyerIp:'127.0.0.1'}),/DISABLED/);assert.equal(n,0);
 assert.throws(()=>createCartCapabilityTransport({...cfg,store:'other.myshopify.com'}),/WRONG_SHOP/);
 for(const reply of [()=>new Response('{}',{status:500}),()=>new Response('{malformed'),()=>new Response(JSON.stringify({errors:[{message:id}]}),{headers:{'content-type':'application/json','x-shopify-api-version':'2026-07'}})]){
 await assert.rejects(createCartCapabilityTransport({...cfg,enabled:true},{fetchImpl:reply}).read({cart_id:id,buyerIp:'127.0.0.1'}),e=>!e.message.includes(id));}
});

test('F06L prior refresh/cart-job ownership cannot be adopted by a new capability reservation',async t=>{
 const f=await rig(t),a=await f.issue();await f.close();
 const {cartHash}=await import('../checkout/storefront.mjs');const db=new DatabaseSync(join(f.config.dataDir,'jobs.sqlite'));
 db.prepare('INSERT INTO cart_job_bindings VALUES (?,?,?)').run('prior-job',cartHash(id),cartHash('prior-owner'));db.close();
 const g=await rig(t,{config:f.config,clock:f.clock});await assert.rejects(g.inspect(a),/EXISTING_BINDING/);assert.equal(g.state.writes,0);await g.close();
});

test('F06L pending/unknown lifecycle blocks before admission and remains intact across migration/restart',async t=>{
 const f=await rig(t),a=await f.issue();const op=f.store.lifecycle.startRecovery();f.store.lifecycle.event('retained-pending',{kind:'test'},()=>{});const before=f.store.lifecycle.state();
 await assert.rejects(f.inspect(a));assert.equal(f.rows().length,0);await f.close();
 const g=await rig(t,{config:f.config,clock:f.clock});assert.deepEqual(g.store.lifecycle.state(),before);assert.equal(g.store.lifecycle.state().operation.id,op.id);await assert.rejects(g.inspect(a));assert.equal(g.state.writes,0);await g.close();
});

test('F06L durable bounded reservation exhaustion rejects without reset',async t=>{
 const f=await rig(t),a=await f.issue();await f.close();const db=new DatabaseSync(join(f.config.dataDir,'jobs.sqlite'));
 const put=db.prepare('INSERT INTO cart_capability_attempts VALUES (?,?,?,?,?,?,?,?,?,?,NULL)');
 for(let i=0;i<256;i++)put.run('attempt-'+i,'owner-'+i,'cart-'+i,'locator-'+i,'proof-'+i,1,0,f.clock.time,'rejected','synthetic-retained-custody');db.close();
 const g=await rig(t,{config:f.config,clock:f.clock});await assert.rejects(g.inspect(a),/CAPACITY/);assert.equal(g.rows().length,256);assert.equal(g.state.writes,0);await g.close();
});
