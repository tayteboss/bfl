import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createNativeCases} from '../theme/checkout-native-cases.js';

function setup(t,role='A',code='ACCESS_DENIED'){
 const old={Shopify:globalThis.Shopify,locator:globalThis.BFLPrintCartLocator};
 t.after(()=>{globalThis.Shopify=old.Shopify;globalThis.BFLPrintCartLocator=old.locator;});
 const cap=`gid://shopify/Cart/local-${role}?key=private-local-capability`,marker='a'.repeat(64),calls=[];
 let lines=[],serial=0,clock=1000;
 const cart=()=>({id:cap,lines:structuredClone(lines),totalQuantity:lines.reduce((n,l)=>n+l.quantity,0)});
 // Matches the retained actual F06N Shopify standard-actions implementation.
 const wire=()=>{const c=cart();return {...c,lines:{nodes:c.lines}};};
 globalThis.Shopify={actions:{getCart:async()=>({cart:wire()}),updateCart:async(input)=>{
  assert.equal(input.cartId,cap);calls.push(input);
  for(const l of input.lines){if(l.id){const i=lines.findIndex(x=>x.id===l.id);assert.ok(i>=0);if(l.quantity===0)lines.splice(i,1);else lines[i].quantity=l.quantity;}
   else lines.push({id:'local-line-'+(++serial),quantity:l.quantity,attributes:l.attributes??[]});}
  return {cart:wire(),userErrors:[],warnings:[]};
 }}};
 globalThis.BFLPrintCartLocator={locate:async()=>({cart_id:cap})};
 const item={id:'67852705202287',quantity:4,properties:{_bfl_job:'private-job',_bfl_signature:'private-signature'}};
 const control={run_id:'f06p-integrated-v1',product_id:'gid://shopify/Product/9990001',variant_id:'gid://shopify/ProductVariant/9990002',title:'F06P engineering control — f06p-integrated-v1',currency:'USD',price:'1.00',quantity:1,requires_shipping:false,tracked:false};
 const controlContractSha256=createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(control).filter(([key])=>!['product_id','variant_id'].includes(key)).sort(([a],[b])=>a.localeCompare(b))))).digest('hex');
 const client={act:async action=>action==='control'?{control}:action==='inspect'?{binding_value:role==='A'?marker:null,test_marker:marker}:{item}};
 let hostile=0;
 const native=createNativeCases({client,role,until:5000,cleanupUntil:635000,controlContractSha256,now:()=>clock,fetchImpl:async(url,opts)=>{
  assert.equal(url,'/api/2026-07/graphql.json');assert.equal(opts.credentials,'same-origin');assert.equal(opts.headers.Authorization,undefined);assert.ok(opts.body.includes(cap));hostile++;
  return new Response(JSON.stringify({errors:[{extensions:{code}}]}),{status:403});
 }});
 return {native,calls,cap,marker,cart,get hostile(){return hostile;},expire(){clock=5000;}};
}

test('native A sequence uses exact in-memory capability, finite ten mutations and distinct duplicate line',async t=>{
 const f=setup(t);const outputs=[];
 for(const a of ['control_add','control_remove'])outputs.push(await f.native.native(a));
 await f.native.resources();
 for(const a of ['add_job','quantity_changed','quantity_restored','remove_job','readd_job','duplicate_add','duplicate_remove','cleanup'])outputs.push(await f.native.native(a));
 assert.equal(f.calls.length,10);assert.equal(f.cart().lines.length,0);
 assert.ok(!JSON.stringify(outputs).includes(f.cap)&&!JSON.stringify(outputs).includes('private-signature'));
 await assert.rejects(f.native.native('control_add'));assert.equal(f.calls.length,10);
});

test('native B copies server-held job privately and is limited to four native mutations',async t=>{
 const f=setup(t,'B');for(const a of ['control_add','control_remove','add_job','cleanup'])await f.native.native(a);
 assert.equal(f.calls.length,4);assert.equal(f.cart().lines.length,0);await assert.rejects(f.native.native('add_job'));
});

test('hostile controls are tokenless and one attempt each; channel BAD_REQUEST cannot pass',async t=>{
 const f=setup(t);for(const a of ['overwrite','delete']){
  const result=await f.native.hostile(a);assert.equal(result.permission_candidate,true);assert.ok(!JSON.stringify(result).includes(f.cap)&&!JSON.stringify(result).includes(f.marker));
  await assert.rejects(f.native.hostile(a));
 }assert.equal(f.hostile,2);
 assert.deepEqual(await f.native.inspect(),{observed:true,marker_present:true,matches_initial:true,checkout_ready:false});
 const g=setup(t,'B','BAD_REQUEST');assert.equal((await g.native.hostile('copy')).permission_candidate,false);await assert.rejects(g.native.hostile('copy'));assert.equal(g.hostile,1);
 assert.deepEqual(await g.native.inspect(),{observed:true,marker_present:false,matches_initial:true,checkout_ready:false});
});

test('native actions reject expired window before cart access or mutation',async t=>{
 const f=setup(t);f.expire();await assert.rejects(f.native.native('control_add'));assert.equal(f.calls.length,0);
});

test('expiry allows exact known-line cleanup in memory while denying new native additions',async t=>{
 const f=setup(t);await f.native.resources();await f.native.native('add_job');f.expire();
 await assert.rejects(f.native.native('control_add'));assert.equal(f.cart().lines.length,1);
 await f.native.native('cleanup');assert.equal(f.cart().lines.length,0);assert.equal(f.calls.length,2);
});

test('native recalculation preserves quantity and attributes, confirms price by a fresh read, and runs once',async t=>{
 const f=setup(t);const actions=globalThis.Shopify.actions,update=actions.updateCart,read=actions.getCart;
 const priced=result=>({...result,cart:{...result.cart,cost:{totalAmount:{amount:'4.80',currencyCode:'USD'}}}});
 actions.updateCart=async input=>priced(await update(input));actions.getCart=async()=>priced(await read());
 await f.native.resources();await f.native.native('add_job');
 const before=f.cart().lines[0],result=await f.native.native('recalculate');
 assert.deepEqual(f.calls[1].lines,[{id:before.id,quantity:4}]);
 assert.deepEqual(f.cart().lines[0].attributes,before.attributes);
 assert.equal(result.total_amount,'4.80');assert.equal(result.currency,'USD');assert.equal(result.recalculated,true);
 await assert.rejects(f.native.native('recalculate'));assert.equal(f.calls.length,2);
 await f.native.native('cleanup');assert.equal(f.cart().lines.length,0);
});

test('native recalculation rejects a mismatching read without retrying and retains exact cleanup',async t=>{
 const f=setup(t);const actions=globalThis.Shopify.actions,update=actions.updateCart,read=actions.getCart;
 actions.updateCart=async input=>{const r=await update(input);return {...r,cart:{...r.cart,cost:{totalAmount:{amount:'4.80',currencyCode:'USD'}}}};};
 actions.getCart=async()=>{const r=await read();return {...r,cart:{...r.cart,cost:{totalAmount:{amount:'4.00',currencyCode:'USD'}}}};};
 await f.native.resources();await f.native.native('add_job');
 await assert.rejects(f.native.native('recalculate'));assert.equal(f.calls.length,2);
 await assert.rejects(f.native.native('recalculate'));assert.equal(f.calls.length,2);
 await f.native.native('cleanup');assert.equal(f.cart().lines.length,0);
});
