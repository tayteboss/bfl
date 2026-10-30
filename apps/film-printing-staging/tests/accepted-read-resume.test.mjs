import test from 'node:test';
import assert from 'node:assert/strict';
import {createResourceSession} from '../theme/resource-session.js';
import {createPreparedCheckout} from '../theme/prepared-checkout.js';
import '../theme/film-printing-job.js';
const ORIGIN='https://bellows-film-printing-staging.myshopify.com',KEY='bfl:accepted-cart-session:v1';
const CART='gid://shopify/Cart/accepted-read-test?key=private-test',TOKEN='bflr1_'+ 'a'.repeat(43),OPAQUE='b'.repeat(43);
const money=n=>({amount:(n/100).toFixed(2),currencyCode:'USD'});
const p={_bfl_flow:'f05',_bfl_job:'existing-job',_bfl_revision:'1',_bfl_config:'config-1',_bfl_signature:'v3:'+ 'a'.repeat(64)+':2',Service:'photo',Sizes:'4x6',Location:'miami',Message:'Café 🎞️ — “test”','Files Uploaded':'1'};
function rig(t,{fault=null,state='accepted',operation=null}={}){
 const old=globalThis.location;globalThis.location={origin:ORIGIN};t.after(()=>{globalThis.location=old;});
 let now=1000000,session,flow;const initial={state,token:TOKEN,expires:now+60000,generation:1,prepared_generation:2,operation};
 const values=new Map([[KEY,JSON.stringify(initial)]]),calls={native:0,paths:[],mutations:0},storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)};
 const native=()=>({id:CART,lines:[{id:'native-line-1',quantity:2,cost:{totalAmount:money(80)}}],totalQuantity:2,cost:{totalAmount:money(80)}});
 const ajax=()=>({currency:'USD',items:[{key:'actual-ajax-key',variant_id:'67852705202287',quantity:2,properties:{...p},final_price:40,final_line_price:80}],item_count:2,total_price:80});
 const response=(value,{ok=true,status=200,stage}={})=>({ok,status,redirected:false,json:async()=>{if(fault===stage+'-body')throw TypeError('dropped response body');if(fault===stage+'-json')throw SyntaxError('malformed JSON');return structuredClone(value);}});
 let hook=null;
 const reject=stage=>{if(fault===stage)throw TypeError('private transport details');};
 const actions={getCart:async()=>{calls.native++;reject('native');const cart=native();if(fault==='native-shape')cart.totalQuantity=3;return {cart};}};
 const fetchImpl=async(url,options={})=>{
  const parsed=new URL(url,ORIGIN),path=parsed.pathname;calls.paths.push(path);
  if(path==='/api/2026-07/graphql.json'){calls.mutations++;throw Error('unexpected native mutation');}
  if(path==='/resource-proof/challenge'){
   assert.equal(options.headers.Authorization,`Bearer ${TOKEN}`);assert.equal(JSON.parse(options.body).action,'cart-capability');reject('challenge');
   return response({challenge:OPAQUE,verifier:OPAQUE,purpose:'bfl:resource-fresh-proof:v1',audience:ORIGIN+'/bfl-application-resources',action:'cart-capability',expires_in:30},{stage:'challenge'});
  }
  if(path==='/apps/bfl-staging/resource-proof'){reject('proxy');return response({ticket:OPAQUE},{stage:'proxy'});}
  if(path==='/checkout/resume'){
   assert.equal(options.headers.Authorization,`Bearer ${TOKEN}`);assert.equal(JSON.parse(options.body).cart_id,CART);
   await hook?.();reject('resume');
   if(fault==='price')return response({code:'CART_PRICE_UNVERIFIED'},{ok:false,status:403});
   if(['RESOURCE_REJECTED','DIAGNOSTIC_CLOSED','RESOURCE_CONTEXT_CHANGED','CHECKOUT_RESUME_REJECTED'].includes(fault))return response({code:fault},{ok:false,status:403});
   const result={resumed:true,cart_verified:false,checkout_ready:false,expires_at:initial.expires,items:[{id:'native-line-1',variant_id:'67852705202287',quantity:2,properties:{...p},subtotal_cents:80}]};
   if(fault==='resume-shape')delete result.resumed;
   return response(result,{stage:'resume'});
  }
  if(path==='/cart.js'){reject('ajax');const cart=ajax();if(fault==='ajax-claims')cart.items[0].properties.Message='changed';if(fault==='ajax-price')cart.total_price=1;return response(cart,{stage:'ajax'});}
  if(path==='/cart'){assert.equal(parsed.search,'?sections=cart-drawer');reject('sections');return response({'cart-drawer':'<div>Cart</div>'},{stage:'sections'});}
  if(path==='/uploads/intents'){throw TypeError('private upload failure');}
  if(path==='/resource-sessions/revoke')return response({revoked:true});
  assert.fail(`unexpected request ${path}`);
 };
 const open=()=>{session=createResourceSession({fetchImpl,now:()=>now,reloadStorage:storage,preparedMode:true});const restored=session.restore();flow=createPreparedCheckout(session,{actions,fetchImpl,now:()=>now,...(fault==='hash'?{expectedCartHash:'0'.repeat(64)}:{})});return restored;};
 open();
 return {initial,calls,storage,open,get session(){return session;},get flow(){return flow;},get saved(){return JSON.parse(storage.getItem(KEY));},set fault(value){fault=value;},set hook(value){hook=value;},advance:n=>{now+=n;}};
}
for(const stage of ['native','challenge','proxy','resume','price','ajax','sections','challenge-body','proxy-body','resume-body','ajax-body','sections-body'])test(`accepted ${stage} read failure retains exact custody for a fresh authenticated retry`,async t=>{
 const f=rig(t,{fault:stage});let failure;await assert.rejects(f.flow.initialize({resume:true}),error=>(failure=error,true));
 assert.equal(failure.acceptedReadRetry,true);assert.deepEqual(f.saved,f.initial);
 const calls=structuredClone(f.calls);await Promise.resolve();assert.deepEqual(f.calls,calls,'must not automatically retry');
 assert.equal(f.calls.mutations,0);assert.ok(!f.calls.paths.some(path=>/\/(issue|renew|bind|install|publish|jobs)$/.test(path)));
 f.fault=null;assert.deepEqual(f.open(),{state:'accepted',operation:null});const result=await f.flow.initialize({resume:true});
 assert.equal(result.resumed,true);assert.equal(result.cart.items[0].subtotal_cents,80);assert.deepEqual(f.saved,f.initial);assert.equal(f.calls.mutations,0);
 assert.ok(f.calls.paths.includes('/checkout/resume'));assert.match(globalThis.BFLPrintJob.customerError(failure),/Reload this page/);
});
for(const fault of ['RESOURCE_REJECTED','DIAGNOSTIC_CLOSED','RESOURCE_CONTEXT_CHANGED','CHECKOUT_RESUME_REJECTED','native-shape','resume-shape','hash','ajax-claims','ajax-price','challenge-json','proxy-json','resume-json','ajax-json','sections-json'])test(`${fault} rejection cannot retain accepted custody`,async t=>{
 const f=rig(t,{fault});await assert.rejects(f.flow.initialize({resume:true}),error=>!error.acceptedReadRetry);assert.deepEqual(f.saved,{state:'blocked'});assert.equal(f.calls.mutations,0);
 assert.throws(()=>f.open(),/RESOURCE_UNAVAILABLE/);
});
test('expiry during a transient accepted read does not extend or preserve the receipt',async t=>{
 const f=rig(t,{fault:'resume'});f.hook=()=>f.advance(60000);await assert.rejects(f.flow.initialize({resume:true}),error=>!error.acceptedReadRetry);assert.deepEqual(f.saved,{state:'blocked'});
});
for(const action of ['suspend','generation','mutation','revoke'])test(`intervening ${action} consumes the accepted restoration marker`,async t=>{
 const f=rig(t,{fault:'price'}),op={operation_id:'one-write',kind:'change',job:'existing-job',quantity:3};
 f.hook=async()=>{if(action==='suspend')f.session.suspend();if(action==='generation')f.session.rememberPreparationGeneration(3);if(action==='mutation')f.session.beginMutation(op);if(action==='revoke')await f.session.revoke();};
 await assert.rejects(f.flow.initialize({resume:true}),error=>!error.acceptedReadRetry);assert.notEqual(f.saved.state,'accepted');
 if(action==='mutation')assert.deepEqual(f.saved.operation,op);if(action==='generation')assert.equal(f.saved.prepared_generation,3);
 assert.equal(f.calls.mutations,0);
});
test('a direct request after accepted restore cannot later reconstruct an accepted receipt',async t=>{
 const f=rig(t,{fault:'price'});await assert.rejects(f.session.request('/uploads/intents',{}));assert.equal(f.saved.state,'pending');
 await assert.rejects(f.flow.initialize({resume:true}),error=>!error.acceptedReadRetry);assert.equal(f.saved.state,'pending');assert.equal(f.calls.mutations,0);
});
for(const state of ['initialized','uploads','prepared','pending'])test(`${state} custody is not promoted by a price verification failure`,async t=>{
 const f=rig(t,{state,fault:'price'});await assert.rejects(f.flow.initialize({resume:true}),error=>!error.acceptedReadRetry);assert.deepEqual(f.saved,{state:'blocked'});assert.equal(f.calls.mutations,0);
});
test('pending native operation and uncertain write retain no automatic retry advice',async t=>{
 const op={operation_id:'original-op',kind:'change',job:'existing-job',quantity:3},f=rig(t,{fault:'price',state:'pending',operation:op});
 await assert.rejects(f.flow.initialize({resume:true,recovery:{operation:op}}),error=>!error.acceptedReadRetry);assert.deepEqual(f.saved,{state:'blocked'});assert.equal(f.calls.mutations,0);
 assert.match(globalThis.BFLPrintJob.customerError({cartUncertain:true,acceptedReadRetry:true}),/contact us before trying again/);
});
test('invalid or expired stored credentials never create a restoration marker or new owner',t=>{
 const f=rig(t);for(const value of [{...f.initial,token:'invalid'},{...f.initial,expires:1},{...f.initial,operation:{unexpected:'value'}}]){
  f.storage.setItem(KEY,JSON.stringify(value));assert.throws(()=>f.open());assert.notEqual(f.saved.state,'accepted');
 }
 assert.deepEqual(f.calls.paths,[]);assert.equal(f.calls.mutations,0);
});
