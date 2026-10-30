import test from 'node:test';
import assert from 'node:assert/strict';
import {createFilmPrintingForm} from '../theme/film-printing-form.js';
import {createResourceSession} from '../theme/resource-session.js';
import {createPreparedCheckout} from '../theme/prepared-checkout.js';
import {mountCustomerCart} from '../theme/customer-form.js';
const ORIGIN='https://bellows-film-printing-staging.myshopify.com',KEY='bfl:accepted-cart-session:v1',TOKEN='bflr1_'+'a'.repeat(43),OPAQUE='b'.repeat(43),CART='gid://shopify/Cart/selected-recovery?key=private-test';
const intent='00000000-0000-4000-8000-000000000001',asset='10000000-0000-4000-8000-000000000001';
const selection={version:'uncommitted-v1',intent_ids:[intent]},operation={kind:'prepared',operation_id:'draft-preparation',job:'draft-job',generation:2};
const money=n=>({amount:(n/100).toFixed(2),currencyCode:'USD'});
const tick=()=>new Promise(resolve=>setTimeout(resolve,5));
function rig(t,{state='uploads',ordinary=false,empty=false,withSelection=true,preparedState='issued',fault=null,capability=true}={}){
 const old={location:globalThis.location,document:globalThis.document};globalThis.location={origin:ORIGIN,hostname:new URL(ORIGIN).hostname};t.after(()=>Object.assign(globalThis,old));
 let now=Date.now(),serial=1,session,protocol,hook=null;
 const expires=now+60000,initial={state,token:TOKEN,expires,generation:1,prepared_generation:2,operation:state==='prepared'?operation:state==='pending'?{...operation,kind:'cancel_preparation'}:null,...(withSelection?{selection}:{} )};
 const values=new Map([[KEY,JSON.stringify(initial)]]),storage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};
 const calls={paths:[],mutations:0,cancel:0,resume:[],selections:[],bytes:0,sources:0,issues:0};
 const props={_bfl_flow:'f05',_bfl_job:'accepted-job',_bfl_revision:'1',_bfl_config:'configuration',_bfl_signature:'v3:'+'c'.repeat(64)+':2',Service:'darkroom',Sizes:'12x16',Paper:'rc_matte',Location:'atlanta',Message:'','Files Uploaded':'0',_bfl_size_mode:'fixed'};
 let rows=empty?[]:[ordinary?{id:'ordinary-native',key:'ordinary-key',variant_id:'700001',product_id:'700101',quantity:1,properties:{Service:'Send Rolls','Gift note':'Keep exactly 🎞️'},unit:500}:{id:'accepted-native',key:'accepted-key',variant_id:'68068358914159',product_id:'15620086005871',quantity:2,properties:props,unit:6000}];
 const native=()=>({id:CART,lines:rows.map(row=>({id:row.id,quantity:row.quantity,cost:{totalAmount:money(row.quantity*row.unit)}})),totalQuantity:rows.reduce((n,row)=>n+row.quantity,0),cost:{totalAmount:money(rows.reduce((n,row)=>n+row.quantity*row.unit,0))}});
 const items=()=>rows.map(({unit,key,product_id,...row})=>({...row,subtotal_cents:row.quantity*unit}));
 const ajax=()=>({currency:'USD',items:rows.map(row=>({...row,final_price:row.unit,final_line_price:row.quantity*row.unit})),total_price:rows.reduce((n,row)=>n+row.quantity*row.unit,0),item_count:rows.reduce((n,row)=>n+row.quantity,0)});
 const receipt=(id=intent,state='complete')=>({schema:1,intent_id:id,asset_id:state==='complete'?asset:null,version:serial++,state,expires_at:expires,checkout_ready:false});
 const ticket={operation_id:operation.operation_id,job_id:operation.job,generation:operation.generation,owner_hash:'a'.repeat(64),cart_hash:'b'.repeat(64),expires_at:expires};
 const response=value=>({ok:true,redirected:false,json:async()=>structuredClone(value)});
 const cap=()=>capability?{upload_recovery:'uncommitted-v1'}:{};
 const actions={getCart:async()=>{if(fault==='native')throw TypeError('read dropped');return {cart:native()};}};
 const fetchImpl=async(url,options={})=>{
  const path=new URL(url,ORIGIN).pathname;calls.paths.push(path);const body=options.body instanceof Blob?null:options.body?JSON.parse(options.body):{};
  if(path==='/resource-proof/challenge')return response({challenge:OPAQUE,verifier:OPAQUE,purpose:'bfl:resource-fresh-proof:v1',audience:ORIGIN+'/bfl-application-resources',action:body.action,expires_in:30});
  if(path==='/apps/bfl-staging/resource-proof')return response({ticket:OPAQUE});
  if(path==='/checkout/resume'){
   calls.resume.push(body.operation??null);await hook?.();
   if(fault==='resume')throw TypeError('read dropped');
   if(body.operation?.kind==='cancel_preparation'&&preparedState!=='cancelled')return {ok:false,json:async()=>({code:'CHECKOUT_RESUME_REJECTED'})};
   return response({resumed:true,expires_at:expires,items:items(),cart_verified:false,checkout_ready:false,...cap(),...(body.operation?{prepared_recovery:{reservation:{...ticket,...(fault==='ticket'?{job_id:'forged'}:{})},state:preparedState}}:{})});
  }
  if(path==='/checkout/cancel_preparation'){
   calls.cancel++;assert.deepEqual(body.reservation,ticket);assert.equal(JSON.parse(storage.getItem(KEY)).operation.kind,'cancel_preparation');
   if(fault!=='cancel-before')preparedState='cancelled';if(fault?.startsWith('cancel'))throw TypeError('uncertain cancellation');
   return response({cancelled:true,revoked:true,expires_at:expires,cart_verified:false,checkout_ready:false});
  }
  if(path==='/checkout/resume_uploads'){
   calls.selections.push(body.selection);assert.deepEqual(body.selection,selection);
   if(fault==='uploads')throw TypeError('read dropped');
   if(fault==='uploads-json')return {ok:true,json:async()=>{throw SyntaxError('invalid JSON');}};
   if(['RESOURCE_REJECTED','RESOURCE_EXPIRED','CHECKOUT_RESUME_REJECTED'].includes(fault))return {ok:false,json:async()=>({code:fault})};
   return response({resumed_uploads:true,uploads:[{receipt:receipt(),file:{name:'verified.png',type:'image/png',size:1}}],items:items(),expires_at:expires,cart_verified:false,checkout_ready:false,...cap()});
  }
  if(path==='/checkout/current')return response({items:items(),cart_verified:false,checkout_ready:false,...cap()});
  if(path==='/uploads/intents')return response(receipt(intent,'issued'));
  if(path.endsWith('/source')){calls.sources++;return response(receipt());}
  if(path.endsWith('/bytes')){calls.bytes++;return response(receipt());}
  if(path.endsWith('/status'))return response(receipt());
  if(path==='/cart.js')return response(ajax());
  if(path==='/cart')return response({'cart-drawer':'<div>Existing cart</div>'});
  if(path==='/api/2026-07/graphql.json'){
   calls.mutations++;const line=body.variables.lines[0],row=rows.find(row=>row.key===line.viewKey);assert.ok(row);row.quantity=line.quantity;row.properties=Object.fromEntries(line.attributes.map(({key,value})=>[key,value]));
   const cart=native();return response({data:{cartLinesUpdate:{cart:{id:CART,totalQuantity:cart.totalQuantity,lines:{nodes:cart.lines.map(({id,quantity})=>({id,quantity})),pageInfo:{hasNextPage:false}}},userErrors:[],warnings:[]}}});
  }
  if(path==='/resource-sessions/revoke')return response({revoked:true});
  if(path==='/resource-sessions/issue')calls.issues++;
  assert.fail('Unexpected path '+path);
 };
 const checkoutForSession=value=>{session=value;return protocol=createPreparedCheckout(session,{actions,fetchImpl,now:()=>now});};
 const open=()=>{const form=Object.assign(new EventTarget(),{dataset:{filmPrintingForm:''},querySelector:()=>null,querySelectorAll:()=>[],bflSelectionComplete:()=>false});return createFilmPrintingForm(form,{sessionOptions:{fetchImpl,now:()=>now,reloadStorage:storage,preparedMode:true},checkoutForSession});};
 const openCart=()=>{globalThis.document={querySelector:()=>({getSectionsToRender:()=>[{section:'cart-drawer'}],refreshOwnedCart:async()=>{}})};return mountCustomerCart({until:expires,sessionOptions:{fetchImpl,now:()=>now,reloadStorage:storage},checkoutForSession});};
 return {open,openCart,storage,calls,initial,expires,ticket,receipt,get session(){return session;},get protocol(){return protocol;},get saved(){return JSON.parse(storage.getItem(KEY));},get rows(){return rows;},set fault(value){fault=value;},set hook(value){hook=value;},advance:n=>now+=n};
}
for(const state of ['uploads','accepted','prepared','pending'])test(`${state} exact completed draft restores beside accepted A without native write or import`,async t=>{
 const f=rig(t,{state,preparedState:state==='pending'?'cancelled':'issued'}),before=structuredClone(f.rows),flow=f.open(),result=await flow.issue();
 assert.equal(result.selections.length,1);assert.deepEqual(flow.snapshot().completedAssetIds,[asset]);assert.deepEqual(f.rows,before);assert.equal(f.calls.cancel,state==='prepared'?1:0);assert.equal(f.calls.mutations,0);assert.equal(f.calls.bytes+f.calls.sources+f.calls.issues,0);
 assert.deepEqual(f.saved,{...f.initial,state:'uploads',operation:null});assert.deepEqual(f.calls.selections,[selection]);
});
for(const empty of [false,true])test('prepared draft cancelled with ordinary/empty cart restores completed selection',async t=>{
 const f=rig(t,{state:'prepared',ordinary:true,empty}),result=await f.open().issue();assert.equal(result.selections.length,1);assert.equal(result.cart.items.length,empty?0:1);assert.equal(f.calls.cancel,1);assert.equal(f.calls.mutations,0);
});
for(const fault of ['cancel-before','cancel-after'])test(`${fault} is never repeated on reload`,async t=>{
 const f=rig(t,{state:'prepared',fault});await assert.rejects(f.open().issue(),error=>error.cartUncertain===true);assert.equal(f.calls.cancel,1);assert.equal(f.saved.state,'pending');assert.equal(f.saved.operation.kind,'cancel_preparation');assert.deepEqual(f.saved.selection,selection);assert.equal(f.saved.expires,f.expires);
 f.fault=null;if(fault==='cancel-after'){assert.equal((await f.open().issue()).selections.length,1);}else await assert.rejects(f.open().issue());assert.equal(f.calls.cancel,1);assert.equal(f.calls.mutations,0);
});
for(const fault of ['native','uploads'])test(`completed draft ${fault} transient read retains original custody`,async t=>{
 const f=rig(t,{fault});await assert.rejects(f.open().issue(),error=>error.uploadReadRetry===true);assert.deepEqual(f.saved,f.initial);f.fault=null;assert.equal((await f.open().issue()).selections.length,1);assert.equal(f.calls.mutations,0);
});
for(const fault of ['RESOURCE_REJECTED','RESOURCE_EXPIRED','CHECKOUT_RESUME_REJECTED','uploads-json'])test(`${fault} cannot restore selection authority`,async t=>{
 const f=rig(t,{fault});await assert.rejects(f.open().issue(),error=>!error.uploadReadRetry);assert.deepEqual(f.saved,{state:'blocked'});assert.equal(f.calls.mutations,0);
});
test('forged prepared ticket and absent full-product capability cannot dispatch cancellation',async t=>{
 for(const options of [{fault:'ticket'},{capability:false}]){const f=rig(t,{state:'prepared',...options});await assert.rejects(f.open().issue());assert.equal(f.calls.cancel,0);assert.equal(f.calls.mutations,0);}
});
test('original expiry during authenticated prepared resume prevents cancellation',async t=>{
 const f=rig(t,{state:'prepared'});f.hook=()=>f.advance(60000);await assert.rejects(f.open().issue());assert.equal(f.calls.cancel,0);assert.equal(f.calls.mutations,0);
});
test('no-form cart keeps completed draft metadata through signed quantity change and product return',async t=>{
 const f=rig(t),cart=f.openCart();await cart.ready;await cart.changeCart({job:'accepted-job',quantity:3});assert.equal(f.calls.mutations,1);assert.equal(f.saved.state,'accepted');assert.deepEqual(f.saved.selection,selection);
 const restored=await f.open().issue();assert.equal(restored.selections.length,1);assert.equal(restored.cart.items[0].quantity,3);assert.equal(f.saved.expires,f.expires);assert.equal(f.calls.mutations,1);
});
for(const source of ['local','remote'])test(`accepted A then completed ${source} B persists exact selection and restores without another upload`,async t=>{
 const f=rig(t,{state:'accepted',withSelection:false}),flow=f.open();await flow.issue();
 const row=source==='local'?flow.select([new File(['x'],'fixture.png',{type:'image/png'})])[0]:flow.selectSource('https://ucarecdn.com/20000000-0000-4000-8000-000000000001/');
 await row.completion;flow.selectionReady(row.key);await tick();assert.equal(f.saved.state,'uploads');assert.deepEqual(f.saved.selection,selection);
 const before={bytes:f.calls.bytes,sources:f.calls.sources};const restored=await f.open().issue();assert.equal(restored.selections.length,1);assert.deepEqual({bytes:f.calls.bytes,sources:f.calls.sources},before);assert.equal(f.calls.mutations,0);
});
test('incomplete selection never acquires exact completed-selection metadata',async t=>{
 const f=rig(t,{state:'accepted',withSelection:false}),flow=f.open();await flow.issue();const row=flow.select([new File(['x'],'fixture.png',{type:'image/png'})])[0];assert.equal(f.saved.selection,undefined);await row.completion;assert.equal(f.saved.selection,undefined);assert.equal(f.calls.mutations,0);
});
test('pending Add cannot carry draft upload recovery metadata',async t=>{
 const f=rig(t,{state:'pending'});f.storage.setItem(KEY,JSON.stringify({...f.initial,operation:{kind:'add',operation_id:'add',job:'accepted-job',quantity:2}}));await assert.rejects(f.open().issue());assert.deepEqual(f.calls.paths,[]);assert.equal(f.calls.mutations,0);
});
test('selection metadata validates exact unique UUIDs and supports the existing 1000-file bound',async t=>{
 const f=rig(t);for(const ids of [[intent,intent],['invalid'],[],Array.from({length:1001},(_,i)=>`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`)]){
  f.storage.setItem(KEY,JSON.stringify({...f.initial,selection:{version:'uncommitted-v1',intent_ids:ids}}));await assert.rejects(f.open().issue());
 }
 const ids=Array.from({length:1000},(_,i)=>`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`);f.storage.setItem(KEY,JSON.stringify({...f.initial,selection:{version:'uncommitted-v1',intent_ids:ids}}));
 const session=createResourceSession({fetchImpl:()=>assert.fail(),now:()=>Date.now(),preparedMode:true,reloadStorage:f.storage});assert.equal(session.restore().selection.intent_ids.length,1000);assert.deepEqual(f.calls.paths,[]);
});
for(const action of ['suspend','generation','mutation','clear','remember'])test(`intervening ${action} invalidates exact-draft read recovery`,async t=>{
 const f=rig(t,{state:'accepted',fault:'uploads'});f.hook=()=>{if(action==='suspend')f.session.suspend();if(action==='generation')f.session.rememberPreparationGeneration(3);if(action==='mutation')f.session.beginMutation({kind:'change',operation_id:'other',job:'accepted-job',quantity:3});if(action==='clear')f.session.clearUploadSelection();if(action==='remember')f.session.rememberUploadSelection(selection);};
 await assert.rejects(f.open().issue(),error=>!error.uploadReadRetry&&!error.acceptedReadRetry);assert.equal(f.calls.cancel,0);assert.equal(f.calls.mutations,0);
});
test('late complete-preview checkpoint cannot replace a known prepared draft with uploads',async t=>{
 const f=rig(t,{state:'accepted',withSelection:false}),flow=f.open();await flow.issue();const row=flow.select([new File(['x'],'fixture.png',{type:'image/png'})])[0];await row.completion;
 f.session.checkpoint('prepared',operation);flow.selectionReady(row.key);await tick();assert.equal(f.saved.state,'prepared');assert.deepEqual(f.saved.operation,operation);assert.deepEqual(f.saved.selection,selection);
});
test('normal full-product cancellation uncertainty is recorded before send and never resent after reload',async t=>{
 const f=rig(t,{state:'accepted',withSelection:false}),flow=f.open();await flow.issue();f.session.rememberUploadSelection(selection);f.session.checkpoint('prepared',operation);f.fault='cancel-after';
 await assert.rejects(f.protocol.cancelPreparation({reference:{id:operation.job},reservation:f.ticket}),error=>error.cartUncertain===true);assert.equal(f.saved.state,'pending');assert.equal(f.saved.operation.kind,'cancel_preparation');assert.deepEqual(f.saved.selection,selection);
 f.fault=null;assert.equal((await f.open().issue()).selections.length,1);assert.equal(f.calls.cancel,1);assert.equal(f.calls.mutations,0);
});
test('legacy completed remote source remains outside exact selection recovery',async t=>{
 const f=rig(t,{state:'accepted',withSelection:false,capability:false}),flow=f.open();await flow.issue();const row=flow.selectSource('https://ucarecdn.com/20000000-0000-4000-8000-000000000001/');await row.completion;flow.selectionReady(row.key);await tick();assert.equal(f.saved.selection,undefined);assert.equal(f.saved.state,'pending');
});
test('accepted/ uploads metadata cannot conceal an unfinished operation',async t=>{
 const f=rig(t);for(const state of ['accepted','uploads']){f.storage.setItem(KEY,JSON.stringify({...f.initial,state,operation:{kind:'add',operation_id:'old-add',job:'accepted-job',quantity:2}}));await assert.rejects(f.open().issue());}assert.deepEqual(f.calls.paths,[]);
});
