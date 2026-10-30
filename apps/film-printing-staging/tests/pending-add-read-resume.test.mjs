import test from 'node:test';
import assert from 'node:assert/strict';
import {createFilmPrintingForm} from '../theme/film-printing-form.js';
import {createPreparedCheckout} from '../theme/prepared-checkout.js';
const ORIGIN='https://bellows-film-printing-staging.myshopify.com',KEY='bfl:accepted-cart-session:v1';
const CART='gid://shopify/Cart/pending-read-test?key=private-test',TOKEN='bflr1_'+ 'a'.repeat(43),OPAQUE='b'.repeat(43);
const money=n=>({amount:(n/100).toFixed(2),currencyCode:'USD'});
const OPERATION={operation_id:'original-add',kind:'add',job:'existing-job',quantity:3};
const properties={_bfl_flow:'f05',_bfl_job:'existing-job',_bfl_revision:'1',_bfl_config:'config-1',_bfl_signature:'v3:'+ 'a'.repeat(64)+':3',Service:'fine_art',Sizes:'44x60',Paper:'fibre',Location:'orlando',Message:'','Files Uploaded':'1',_bfl_size_mode:'custom','Custom Width':'44','Custom Height':'60'};
function rig(t,{fault=null,state='pending',operation=OPERATION}={}){
 const old=globalThis.location;globalThis.location={origin:ORIGIN};t.after(()=>{globalThis.location=old;});
 let now=1000000,session,hook=null;
 const initial={state,token:TOKEN,expires:now+60000,generation:1,prepared_generation:2,operation:structuredClone(operation)};
 const values=new Map([[KEY,JSON.stringify(initial)]]),calls={native:0,paths:[],mutations:0,resumeOperations:[]},storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)};
 const native=()=>({id:CART,lines:[{id:'native-line-1',quantity:3,cost:{totalAmount:money(58800)}}],totalQuantity:3,cost:{totalAmount:money(58800)}});
 const ajax=()=>({currency:'USD',items:[{key:'actual-ajax-key',variant_id:'67852705202287',quantity:3,properties:{...properties},final_price:19600,final_line_price:58800}],item_count:3,total_price:58800});
 const response=(value,{ok=true,status=200,stage}={})=>({ok,status,redirected:false,json:async()=>{if(fault===stage+'-body')throw TypeError('dropped response body');if(fault===stage+'-json')throw SyntaxError('malformed JSON');return structuredClone(value);}});
 const reject=stage=>{if(fault===stage)throw TypeError('private transport details');};
 const actions={getCart:async()=>{calls.native++;reject('native');const cart=native();if(fault==='native-shape')cart.totalQuantity=4;return {cart};}};
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
   calls.resumeOperations.push(JSON.parse(options.body).operation);await hook?.();reject('resume');
   if(fault==='price')return response({code:'CART_PRICE_UNVERIFIED'},{ok:false,status:403});
   if(['RESOURCE_REJECTED','RESOURCE_EXPIRED','PREPARED_EXPIRED','DIAGNOSTIC_CLOSED','RESOURCE_CONTEXT_CHANGED','CHECKOUT_RESUME_REJECTED','PREPARED_UNCERTAIN'].includes(fault))return response({code:fault},{ok:false,status:403});
   const result={resumed:true,cart_verified:false,checkout_ready:false,expires_at:initial.expires,items:[{id:'native-line-1',variant_id:'67852705202287',quantity:3,properties:{...properties},subtotal_cents:58800}]};
   if(fault==='resume-shape')delete result.resumed;
   return response(result,{stage:'resume'});
  }
  if(path==='/cart.js'){reject('ajax');const cart=ajax();if(fault==='ajax-claims')cart.items[0].properties.Message='changed';if(fault==='ajax-price')cart.total_price=1;return response(cart,{stage:'ajax'});}
  if(path==='/cart'){assert.equal(parsed.search,'?sections=cart-drawer');reject('sections');return response({'cart-drawer':'<div>Cart</div>'},{stage:'sections'});}
  if(path==='/resource-sessions/revoke')return response({revoked:true});
  if(path==='/uploads/intents')throw TypeError('unknown upload request');
  assert.fail(`unexpected request ${path}`);
 };
 const open=()=>{
  const form=Object.assign(new EventTarget(),{dataset:{filmPrintingForm:''},querySelector:()=>null,querySelectorAll:()=>[],bflSelectionComplete:()=>false});
  return createFilmPrintingForm(form,{sessionOptions:{fetchImpl,now:()=>now,reloadStorage:storage,preparedMode:true},
   checkoutForSession:value=>{session=value;return createPreparedCheckout(session,{actions,fetchImpl,now:()=>now,...(fault==='hash'?{expectedCartHash:'0'.repeat(64)}:{})});}});
 };
 return {initial,calls,open,storage,get session(){return session;},get saved(){return JSON.parse(storage.getItem(KEY));},set fault(value){fault=value;},set hook(value){hook=value;},advance:n=>{now+=n;}};
}
for(const stage of ['native','challenge','proxy','resume','price','ajax','sections','challenge-body','proxy-body','resume-body','ajax-body','sections-body'])test(`product pending Add ${stage} read failure retains original operation and recovers once without replay`,async t=>{
 const f=rig(t,{fault:stage});let failure;await assert.rejects(f.open().issue(),error=>(failure=error,true));
 assert.equal(failure.cartUncertain,true);assert.notEqual(failure.acceptedReadRetry,true);assert.deepEqual(f.saved,f.initial);
 const calls=structuredClone(f.calls);await Promise.resolve();assert.deepEqual(f.calls,calls,'must not automatically retry');
 f.fault=null;const next=f.open(),result=await next.issue();
 assert.equal(result.resumed,true);assert.equal(result.cart.items.length,1);assert.equal(result.cart.items[0].quantity,3);assert.equal(result.cart.items[0].subtotal_cents,58800);
 assert.deepEqual(f.saved,{...f.initial,state:'accepted',operation:null});assert.deepEqual(result.selections,[]);assert.equal(next.snapshot().completedAssetIds.length,0);
 assert.equal(f.calls.mutations,0);assert.ok(f.calls.resumeOperations.every(op=>JSON.stringify(op)===JSON.stringify(OPERATION)));
 assert.ok(!f.calls.paths.some(path=>/\/(issue|renew|bind|install|publish|jobs|eligible)$/.test(path)));
});
for(const fault of ['RESOURCE_REJECTED','RESOURCE_EXPIRED','PREPARED_EXPIRED','DIAGNOSTIC_CLOSED','RESOURCE_CONTEXT_CHANGED','CHECKOUT_RESUME_REJECTED','PREPARED_UNCERTAIN','native-shape','resume-shape','hash','ajax-claims','ajax-price','challenge-json','proxy-json','resume-json','ajax-json','sections-json'])test(`${fault} retains unresolved pending Add custody without accepting or replaying it`,async t=>{
 const f=rig(t,{fault});await assert.rejects(f.open().issue(),error=>!error.acceptedReadRetry);assert.deepEqual(f.saved,f.initial);
 await assert.rejects(f.open().issue());assert.deepEqual(f.saved,f.initial);assert.equal(f.calls.mutations,0);assert.ok(!f.calls.paths.some(path=>/\/(issue|renew|bind|install|publish|jobs|eligible)$/.test(path)));
});
test('pending Add original deadline is retained and expiry during recovery rejects',async t=>{
 const f=rig(t,{fault:'resume'});f.hook=()=>f.advance(60000);await assert.rejects(f.open().issue());assert.deepEqual(f.saved,f.initial);assert.equal(f.calls.mutations,0);
});
for(const action of ['suspend','generation','mutation','revoke'])test(`intervening ${action} invalidates pending Add read custody`,async t=>{
 const f=rig(t,{fault:'price'}),newOperation={operation_id:'other-operation',kind:'change',job:'existing-job',quantity:2};
 f.hook=async()=>{if(action==='suspend')f.session.suspend();if(action==='generation')f.session.rememberPreparationGeneration(3);if(action==='mutation')f.session.beginMutation(newOperation);if(action==='revoke')await f.session.revoke();};
 await assert.rejects(f.open().issue(),error=>!error.cartUncertain);
 if(action==='mutation')assert.deepEqual(f.saved.operation,newOperation);
 if(action==='generation')assert.equal(f.saved.prepared_generation,3);
 assert.equal(f.calls.mutations,0);
});
for(const [name,state,operation] of [['prepared','prepared',OPERATION],['missing','pending',null],['change','pending',{...OPERATION,kind:'change'}],['remove','pending',{...OPERATION,kind:'remove',quantity:0}],['empty-id','pending',{...OPERATION,operation_id:''}],['zero','pending',{...OPERATION,quantity:0}],['overlimit','pending',{...OPERATION,quantity:10001}],['extra-field','pending',{...OPERATION,request_key:'other'}]])test(`${name} stored state cannot acquire pending Add read recovery`,async t=>{
 const f=rig(t,{fault:'price',state,operation});await assert.rejects(f.open().issue(),error=>!error.cartUncertain);assert.deepEqual(f.saved,['change','remove'].includes(name)?f.initial:{state:'blocked'});assert.equal(f.calls.mutations,0);
});
test('invalid credential or already expired pending Add cannot issue a replacement owner',async t=>{
 const f=rig(t);for(const value of [{...f.initial,token:'invalid'},{...f.initial,expires:1},{...f.initial,operation:{unexpected:'value'}}]){
  f.storage.setItem(KEY,JSON.stringify(value));await assert.rejects(f.open().issue());assert.deepEqual(f.saved,value.expires===1?value:{state:'blocked'});
 }
 assert.deepEqual(f.calls.paths,[]);assert.equal(f.calls.mutations,0);
});

test('a rejected concurrent request does not replace the pending Add or trigger its replay',async t=>{
 const f=rig(t,{fault:'price'});f.hook=()=>assert.rejects(f.session.request('/uploads/intents',{}),/RESOURCE_BUSY/);
 await assert.rejects(f.open().issue(),error=>error.cartUncertain===true);assert.deepEqual(f.saved,f.initial);assert.equal(f.calls.mutations,0);
});
