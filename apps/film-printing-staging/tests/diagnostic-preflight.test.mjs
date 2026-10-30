import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeCases} from '../theme/checkout-native-cases.js';
import {registerCheckoutDiagnostic} from '../theme/checkout-diagnostic.js';

function setup(t){
 const names=['Shopify','BFLPrintCartLocator','location','document'],old=Object.fromEntries(names.map(k=>[k,globalThis[k]]));
 t.after(()=>{for(const k of names){if(old[k]===undefined)delete globalThis[k];else globalThis[k]=old[k];}});
 const state={id:'gid://shopify/Cart/generated-preflight?key=generated-private',reads:0,mutations:0,requests:0,clock:1000,quantity:0,flat:false};
 globalThis.location={origin:'https://bellows-film-printing-staging.myshopify.com',hostname:'bellows-film-printing-staging.myshopify.com'};
 globalThis.Shopify={theme:{id:189196533871,role:'unpublished'},actions:{getCart:async()=>{state.reads++;return {cart:{id:state.id,totalQuantity:state.quantity,lines:state.flat?[]:{nodes:[]}}};},updateCart:async()=>{state.mutations++;throw Error('must not mutate');}}};
 globalThis.BFLPrintCartLocator={locate:async()=>({cart_id:state.id})};
 const client={act:async()=>{state.requests++;throw Error('must not issue or fetch');}};
 const make=(role='A')=>createNativeCases({client,role,until:5000,now:()=>state.clock});
 return {state,make};
}
test('read-only preflight consumes two bounded native reads and exposes no raw capability or owner claim',async t=>{
 const {state,make}=setup(t),native=make();const first=await native.preflight('initial');
 assert.equal(first.empty,true);assert.equal(first.controller_memory_retained,false);
 const second=await native.preflight('recheck');assert.equal(second.controller_memory_retained,true);
 assert.match(first.cart_comparison_sha256,/^[a-f0-9]{64}$/);assert.equal(first.cart_comparison_sha256,second.cart_comparison_sha256);
 assert.equal(second.cart_verified,false);assert.equal(second.checkout_ready,false);
 assert.ok(!JSON.stringify([first,second]).includes(state.id)&&!JSON.stringify(second).includes('generated-private'));
 await assert.rejects(native.preflight('recheck'));assert.equal(state.reads,2);assert.equal(state.mutations,0);assert.equal(state.requests,0);
});
test('A/B comparison excludes access keys but private continuity still requires the exact full capability',async t=>{
 const {state,make}=setup(t),a=make('A');const original=state.id,first=await a.preflight('initial');
 state.id=original.replace('generated-private','different-private-key');const same=await make('B').preflight('initial');
 assert.equal(same.cart_comparison_sha256,first.cart_comparison_sha256);
 await assert.rejects(a.preflight('recheck'));
 state.id='gid://shopify/Cart/another-generated-cart?key=different-private-key';const different=await make('B').preflight('initial');
 assert.notEqual(different.cart_comparison_sha256,first.cart_comparison_sha256);
 const output=JSON.stringify([first,same,different]);for(const value of ['gid://','generated-preflight','another-generated-cart','generated-private','different-private-key'])assert.equal(output.includes(value),false);
 assert.equal(state.mutations,0);assert.equal(state.requests,0);
});
test('comparison rejects ambiguous or unsupported native identity shapes without decoding or aliasing',async t=>{
 const {state,make}=setup(t);
 for(const id of ['gid://shopify/Cart/a%2Fb?key=secret','gid://shopify/Cart/a/b?key=secret','gid://shopify/Cart/a?key=one&key=two','gid://shopify/Cart/a?other=x&key=one','gid://shopify/Cart/a?key=one#fragment','gid://shopify/Cart/a?key=','gid://shopify/Cart/?key=one','gid://shopify/Cart/..?key=one','gid://shopify/Cart/abc=?key=one','gid://user@shopify/Cart/a?key=one','gid://SHOPIFY/Cart/a?key=one','gid://shopify/Cart/a?key=one%20two','gid://shopify/Cart/a?key=one\n','gid://shopify/Cart/'+'a'.repeat(4096)+'?key=one']){
  state.id=id;await assert.rejects(make().preflight('initial'));
 }
 assert.equal(state.mutations,0);assert.equal(state.requests,0);
});
test('recreated controller and changed exact capability cannot claim continuity',async t=>{
 const {state,make}=setup(t),native=make();await native.preflight('initial');
 await assert.rejects(make().preflight('recheck'));assert.equal(state.reads,1);
 state.id='gid://shopify/Cart/changed?key=other-generated-private';await assert.rejects(native.preflight('recheck'));assert.equal(state.mutations,0);
});
test('missing actions, expired window and inconsistent native summaries fail closed',async t=>{
 const {state,make}=setup(t);state.quantity=1;await assert.rejects(make().preflight('initial'));
 state.quantity=0;state.flat=true;assert.equal((await make().preflight('initial')).empty,true);
 state.clock=5000;const before=state.reads;await assert.rejects(make().preflight('initial'));assert.equal(state.reads,before);
 state.clock=1000;delete globalThis.Shopify.actions.updateCart;await assert.rejects(make().preflight('initial'));assert.equal(state.reads,before);
});
test('preflight-only page tool rejects forged mutating actions without resource/network activity',async t=>{
 const {state}=setup(t);let tool;
 globalThis.document={modelContext:{registerTool:async value=>{tool=value;}}};
 const until=Date.now()+60000,r=await registerCheckoutDiagnostic({until,cleanupUntil:until+630000,runId:'f06p-integrated-v1',preflightOnly:true,options:{fetchImpl:async()=>{state.requests++;throw Error('network forbidden');}}});
 t.after(()=>r.close());assert.deepEqual(tool.inputSchema.properties.action.enum,['preflight','preflight_recheck','close']);assert.equal(tool.annotations.readOnlyHint,true);
 for(const action of ['issue','bind','install','control_add','resources','publish','cleanup','hostile_overwrite'])await assert.rejects(tool.execute({action}));
 const result=JSON.parse(await tool.execute({action:'preflight'}));assert.equal(result.empty,true);assert.match(result.cart_comparison_sha256,/^[a-f0-9]{64}$/);
 const output=JSON.stringify(result);for(const secret of [state.id,'generated-preflight','generated-private'])assert.equal(output.includes(secret),false);
 assert.equal(JSON.parse(await tool.execute({action:'preflight_recheck'})).controller_memory_retained,true);
 await tool.execute({action:'close'});await assert.rejects(tool.execute({action:'preflight'}));assert.equal(state.requests,0);assert.equal(state.mutations,0);
});

test('preflight hash failures and final cancellation retain only fixed evidence and no extra reads',async t=>{
 for(const mode of ['hash rejection','hash cancellation','hash expiry'])await t.test(mode,async t=>{
  const {state}=setup(t),abort=new AbortController();
  const native=createNativeCases({client:{},role:'B',until:5000,now:()=>state.clock,signal:abort.signal});
  const originalDigest=crypto.subtle.digest.bind(crypto.subtle),secret='generated-hash-secret';
  t.mock.method(crypto.subtle,'digest',async(...args)=>{
   if(mode==='hash rejection')throw Object.assign(Error(secret),{stage:secret,reason:secret});
   const result=await originalDigest(...args);if(mode==='hash cancellation')abort.abort();else state.clock=5000;return result;
  });
  await assert.rejects(native.preflight('initial'),/DIAGNOSTIC_NATIVE_UNAVAILABLE/);
  const failure=native.preflightFailure();assert.ok(Object.isFrozen(failure));assert.ok(Object.isFrozen(failure.construction_methods));
  assert.equal(failure.stage,mode==='hash rejection'?'comparison_hash':'final_guard');assert.equal(failure.reason,mode==='hash rejection'?'unavailable':mode==='hash cancellation'?'cancelled':'expired');
  assert.equal(JSON.stringify(failure).includes(secret),false);assert.equal(JSON.stringify(failure).includes(state.id),false);
  assert.equal(state.reads,1);await assert.rejects(native.preflight('initial'));assert.equal(state.reads,1);assert.equal(state.mutations,0);assert.equal(state.requests,0);
 });
});

test('unreadable observational methods cannot substitute behavior or leak getter failures',async t=>{
 const {state,make}=setup(t),native=make(),secret='generated-entry-secret';
 Object.defineProperty(Shopify,'actions',{configurable:true,get(){throw Object.assign(Error(secret),{preflight:{stage:secret}});}});
 // The original captured actions and locator remain usable; the extra observation
 // must not introduce a new failure or substitute the current global reference.
 assert.equal((await native.preflight('initial')).empty,true);assert.equal(state.reads,1);assert.equal(native.preflightFailure(),null);
 state.quantity=1;await assert.rejects(native.preflight('recheck'));const failure=native.preflightFailure();
 assert.equal(failure.stage,'native_summary');assert.equal(failure.reason,'unavailable');
 assert.deepEqual(failure.current_methods,{observed:false,get_cart:false,update_cart:false});
 assert.equal(JSON.stringify(failure).includes(secret),false);assert.equal(state.reads,2);assert.equal(state.mutations,0);assert.equal(state.requests,0);
});
