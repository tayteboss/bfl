import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createPreparedCheckout,signatureForQuantity} from '../theme/prepared-checkout.js';
import {PRODUCT,VARIANT,VARIANTS_BY_LAB} from '../checkout/authority.js';
const CART='gid://shopify/Cart/mixed-test?key=private-test',printVariant=VARIANTS_BY_LAB.atlanta.split('/').at(-1),product=PRODUCT.split('/').at(-1);
const money=n=>({amount:(n/100).toFixed(2),currencyCode:'USD'});
const ordinary=(suffix='a')=>({nativeId:`ordinary-native-${suffix}`,key:`700001:ordinary-${suffix}`,variant:'700001',product:'700101',quantity:2,unit:1999,properties:{'Gift note':`Café 🎞️ ${suffix}`}});
const subtotal=row=>row.subtotal??row.quantity*row.unit;
async function rig(t,{rows=[ordinary()],initialize=true,resume=null}={}){
 const old=globalThis.location;globalThis.location={origin:'https://bellows-film-printing-staging.myshopify.com'};t.after(()=>{globalThis.location=old;});
 let clock=Date.now(),serial=0,items=structuredClone(rows),lost=false,writeFault=null,currentFault=null,ajaxFault=null,leaseExpires=clock+60000;
 const ownerExpires=clock+300000,jobs=new Map(),calls={writes:0,jobs:0,checkout:[],checkpoints:[],operations:[],payloads:[]};
 const native=()=>({id:CART,lines:items.map(row=>({id:row.nativeId,quantity:row.quantity,cost:{totalAmount:money(subtotal(row))}})),totalQuantity:items.reduce((n,row)=>n+row.quantity,0),cost:{totalAmount:money(items.reduce((n,row)=>n+subtotal(row),0))}});
 const ajax=()=>({currency:'USD',items:items.map(row=>({key:row.key,variant_id:row.variant,product_id:row.product,quantity:row.quantity,properties:structuredClone(row.properties),final_price:row.unit,final_line_price:subtotal(row)})),item_count:items.reduce((n,row)=>n+row.quantity,0),total_price:items.reduce((n,row)=>n+subtotal(row),0)});
 const selected=()=>({items:items.map(row=>({id:row.nativeId,variant_id:row.variant,quantity:row.quantity,properties:structuredClone(row.properties),subtotal_cents:subtotal(row)}))});
 const session={preparationGeneration:()=>calls.jobs,rememberPreparationGeneration(){},assertLive(){if(clock>=ownerExpires)throw Error('RESOURCE_EXPIRED');},beginMutation:value=>calls.operations.push(structuredClone(value)),checkpoint:(...value)=>calls.checkpoints.push(value),
  async request(path,input){assert.equal(path,'/jobs');const id=`job-${++calls.jobs}`,signature=String(calls.jobs).repeat(64),reference={id,revision:'1',config_version:'config-1',signature};const job={checkout_ready:false,reference,unit_price_cents:40,file_count:1,item:{id:printVariant,quantity:input.copies,properties:{_bfl_flow:'f05',_bfl_job:id,_bfl_revision:'1',_bfl_config:'config-1',_bfl_signature:signature,Service:'photo',Sizes:'4x6',Location:'atlanta',Message:'','Files Uploaded':'1'}}};jobs.set(id,job);return structuredClone(job);},
  async checkout(action,locate,input={}){
   calls.checkout.push(action);assert.equal(await locate(),CART);session.assertLive();
   if(action==='current'){const result=selected();currentFault?.(result);return result;}
   if(action==='resume_uploads')return {resumed_uploads:true,uploads:[{intent_id:'original-upload'}],...selected()};
   if(action==='resume')return {resumed:true,expires_at:leaseExpires,...selected()};
   if(action==='eligible'){const job=jobs.get(input.reference.id);return {...structuredClone(job),prepared:true,cart_verified:false,generation:input.generation,reservation:{operation_id:`operation-${job.reference.id}`,job_id:job.reference.id,owner_hash:'a'.repeat(64),cart_hash:'b'.repeat(64),generation:input.generation,expires_at:leaseExpires},expires_at:leaseExpires};}
   if(action==='cancel_preparation')return {cancelled:true,revoked:true};return {};
  }};
 const actions={getCart:async()=>({cart:native()})};
 const fetchImpl=async(path,options)=>{
  if(path==='/cart.js'){const result=ajax();ajaxFault?.(result);return Response.json(result);}
  if(path.startsWith('/cart?sections='))return Response.json({'cart-drawer':'<div>unchanged design</div>'});
  assert.equal(path,'/api/2026-07/graphql.json');calls.writes++;
  const {query,variables}=JSON.parse(options.body);calls.payloads.push(variables.lines);assert.equal(variables.i,CART);assert.equal(variables.lines.length,1);
  const kind=query.includes('cartLinesAdd(')?'add':query.includes('cartLinesUpdate(')?'change':'remove',line=variables.lines[0];
  if(kind==='add'){
   const properties=Object.fromEntries(line.attributes.map(item=>[item.key,item.value]));const job=jobs.get(properties._bfl_job);assert.ok(job);assert.equal(line.merchandiseId,`gid://shopify/ProductVariant/${printVariant}`);
   items.push({nativeId:`print-native-${++serial}`,key:`${printVariant}:print-${serial}`,variant:printVariant,product,quantity:line.quantity,unit:job.unit_price_cents,properties});
  }else{
   const key=kind==='remove'?line:line.viewKey,row=items.find(row=>row.key===key);assert.ok(row);assert.equal(row.properties._bfl_flow,'f05','only the protected target may be mutated');
   if(kind==='remove')items=items.filter(item=>item!==row);else{row.quantity=line.quantity;row.properties=Object.fromEntries(line.attributes.map(item=>[item.key,item.value]));row.key=`${printVariant}:print-${++serial}`;}
  }
  writeFault?.(items);if(lost){lost=false;throw Error('lost response');}
  const cart=native(),name=kind==='add'?'cartLinesAdd':kind==='change'?'cartLinesUpdate':'cartLinesRemove';
  return Response.json({data:{[name]:{cart:{id:CART,totalQuantity:cart.totalQuantity,lines:{nodes:cart.lines.map(({id,quantity})=>({id,quantity})),pageInfo:{hasNextPage:false}}},userErrors:[],warnings:[]}}});
 };
 const make=()=>createPreparedCheckout(session,{actions,fetchImpl,now:()=>clock});
 const flow=make();if(initialize)await flow.initialize(resume??{});
 return {flow,make,calls,ajax,native,selected,session,prepare:()=>flow.prepare({generation:calls.jobs+1,copies:2,message:'',request_key:`request-${calls.jobs+1}`}),
  get rows(){return items;},set rows(value){items=value;},advance:amount=>clock+=amount,get leaseExpires(){return leaseExpires;},
  set lost(value){lost=value;},set writeFault(value){writeFault=value;},set currentFault(value){currentFault=value;},set ajaxFault(value){ajaxFault=value;}};
}

test('ordinary-first cart adds a print once and preserves every ordinary native field',async t=>{
 const send={...ordinary('send'),variant:'700002',product:'700102',properties:{Service:'Send Rolls',_timestamp:'ordinary-send-rolls',_return_shipping_required:'true'}},f=await rig(t,{rows:[ordinary(),ordinary('b'),send]}),before=structuredClone(f.rows);
 const p=await f.prepare(),result=await f.flow.addPrepared({prepared:p,quantity:3});assert.equal(result.accepted,true);assert.equal(f.calls.writes,1);assert.deepEqual(f.rows.slice(0,3),before);assert.equal(result.cart.items.length,4);
 assert.deepEqual(f.calls.checkout,['bind','install','current','eligible']);assert.equal(f.calls.operations.length,1);assert.equal(f.calls.jobs,1);
 await assert.rejects(f.flow.addPrepared({prepared:p,quantity:3}));assert.equal(f.calls.writes,1);
});
test('mixed reload edits and removes only its signed job while exact ordinary snapshots survive',async t=>{
 const f=await rig(t),before=structuredClone(f.rows),p=await f.prepare();await f.flow.addPrepared({prepared:p,quantity:2});
 const restored=f.make(),result=await restored.initialize({resume:true});assert.equal(result.cart.items.length,2);assert.equal(f.calls.jobs,1);assert.equal(f.calls.checkout.filter(a=>a==='bind').length,1);
 await restored.change({job:p.reference.id,quantity:4});assert.equal(f.rows[1].properties._bfl_signature,signatureForQuantity(p.reference.signature,4));assert.deepEqual(f.rows[0],before[0]);
 await restored.change({job:p.reference.id,quantity:0});assert.deepEqual(f.rows,before);assert.equal(f.calls.writes,3);
 const onlyOrdinary=f.make();assert.equal((await onlyOrdinary.initialize({resume:true})).cart.items.length,1);assert.equal(f.calls.writes,3);
});
test('initialized and uploaded checkpoints retain ordinary carts without rebinding or replay',async t=>{
 for(const options of [{resumeEmpty:true},{resumeUploads:true}]){
  const f=await rig(t),before=structuredClone(f.rows),restored=f.make(),result=await restored.initialize(options);
  assert.equal(result.cart.items.length,1);assert.deepEqual(f.rows,before);assert.equal(f.calls.checkout.filter(a=>a==='bind').length,1);assert.equal(f.calls.writes,0);assert.equal(f.calls.jobs,0);
  if(options.resumeUploads)assert.deepEqual(result.uploads,[{intent_id:'original-upload'}]);
 }
});
test('ordinary native add, quantity, property and removal changes are authenticated before the next print edit',async t=>{
 const f=await rig(t),p=await f.prepare();await f.flow.addPrepared({prepared:p,quantity:2});
 const row=f.rows[0];row.quantity=3;row.key='700001:updated';row.properties['Gift note']='Changed ordinary note';row.unit=999;f.rows.push(ordinary('added'));
 const before=structuredClone(f.rows.filter(row=>!row.properties._bfl_job));await f.flow.change({job:p.reference.id,quantity:3});assert.deepEqual(f.rows.filter(row=>!row.properties._bfl_job),before);
 assert.equal(f.calls.checkout.filter(a=>a==='current').length,2);
 f.rows=f.rows.filter(row=>row.properties._bfl_job);await f.flow.change({job:p.reference.id,quantity:4});assert.equal(f.rows.length,1);assert.equal(f.calls.checkout.filter(a=>a==='current').length,3);
});
test('ordinary-first add admits a later ordinary item without rebinding and preserves rounded ordinary totals',async t=>{
 const a={...ordinary(),unit:499,subtotal:999},f=await rig(t,{rows:[a]}),p=await f.prepare();f.rows.push(ordinary('added'));
 const before=structuredClone(f.rows);await f.flow.addPrepared({prepared:p,quantity:2});assert.deepEqual(f.rows.slice(0,2),before);assert.equal(f.calls.writes,1);assert.equal(f.calls.checkout.filter(a=>a==='bind').length,1);
});
for(const bad of [
 ...[VARIANT,...Object.values(VARIANTS_BY_LAB)].map(id=>({variant:id.split('/').at(-1)})),
 {variant:'999999',product},...['_bfl_flow','_bfl_job','_bfl_signature','_bfl_unknown'].map(key=>({properties:{[key]:''}})),
])test(`a target or partial protected marker cannot enter ordinary initialization: ${JSON.stringify(bad)}`,async t=>{
 const f=await rig(t,{rows:[{...ordinary(),...bad}],initialize:false});await assert.rejects(f.flow.initialize());assert.equal(f.calls.writes,0);assert.deepEqual(f.calls.checkout,[]);
});
for(const change of [r=>{r.nativeId='different-print-id';},r=>{r.quantity=4;},r=>{r.properties.Message='forged';},r=>{r.properties._bfl_job='other-job';}])test('ordinary refresh never adopts changed protected membership, claims, quantity or native identity',async t=>{
 const f=await rig(t),p=await f.prepare();await f.flow.addPrepared({prepared:p,quantity:2});change(f.rows[1]);f.rows.push(ordinary('new'));
 await assert.rejects(f.flow.change({job:p.reference.id,quantity:3}));assert.equal(f.calls.writes,1);assert.equal(f.calls.operations.length,1);
});
for(const change of [r=>{r.quantity++;},r=>{r.unit++;},r=>{r.properties['Gift note']='changed during write';},r=>{r.variant='other';},r=>{r.product=product;},r=>{r.key='changed-key';},r=>{r.nativeId='changed-native';}])test('ordinary changes during a print write block after exactly one dispatch',async t=>{
 const f=await rig(t),p=await f.prepare();f.writeFault=rows=>change(rows[0]);
 await assert.rejects(f.flow.addPrepared({prepared:p,quantity:2}),error=>error.cartUncertain===true);assert.equal(f.calls.writes,1);assert.equal(f.flow.canRetry(),false);
 await assert.rejects(f.flow.addPrepared({prepared:p,quantity:2}));assert.equal(f.calls.writes,1);
});
test('lost mixed-cart write recovers the exact observed addition without replay',async t=>{
 const f=await rig(t),before=structuredClone(f.rows),p=await f.prepare();f.lost=true;await assert.rejects(f.flow.addPrepared({prepared:p,quantity:2}));assert.equal(f.calls.writes,1);
 assert.equal((await f.flow.recover()).accepted,true);assert.deepEqual(f.rows[0],before[0]);assert.equal(f.calls.writes,1);await assert.rejects(f.flow.addPrepared({prepared:p,quantity:2}));assert.equal(f.calls.writes,1);
});
test('mixed recovery keeps the original expiry and never writes at its deadline',async t=>{
 const f=await rig(t),p=await f.prepare();await f.flow.addPrepared({prepared:p,quantity:2});const expiry=f.leaseExpires;
 f.advance(59000);const restored=f.make();await restored.initialize({resume:true});assert.equal(f.leaseExpires,expiry);f.advance(1000);
 await assert.rejects(restored.change({job:p.reference.id,quantity:3}),/PREPARED_EXPIRED/);assert.equal(f.calls.writes,1);
});
test('authenticated ordinary/Ajax disagreement blocks restoration and emits no writes',async t=>{
 const f=await rig(t),p=await f.prepare();await f.flow.addPrepared({prepared:p,quantity:2});f.ajaxFault=cart=>{cart.items[0].properties['Gift note']='forged Ajax';};
 await assert.rejects(f.make().initialize({resume:true}));assert.equal(f.calls.writes,1);
});


test('ordinary removal shifting indexes still routes the rendered print quantity through the signed adapter',async t=>{
 const f=await rig(t),p=await f.prepare();await f.flow.addPrepared({prepared:p,quantity:2});f.rows=f.rows.filter(row=>row.properties._bfl_job);
 const print=f.rows[0],renderedItem={dataset:{bflFlow:'f05'},querySelector:selector=>selector.startsWith('cart-remove-button')?{dataset:{key:print.key}}:{dataset:{index:'1'}}};
 const flow={mode:'prepared-unit-v3',ready:Promise.resolve(),resolveCartItem:f.flow.resolveCartItem,changeCart:f.flow.change},drawer={getAttribute:()=>null,classList:{contains:()=>false},setPending(){}};
 const source=readFileSync(new URL('../../../assets/cart.js',import.meta.url),'utf8'),method=source.slice(source.indexOf('  async changeOwnedCart('),source.indexOf('  async refreshOwnedCart('));
 const target=vm.runInNewContext('({'+method+'})',{window:{routes:{cart_url:'/cart'},BFLPrintJob:{forForm:()=>null,forCart:()=>flow}},document:{querySelector:()=>null,getElementById:()=>({})},fetch:()=>assert.fail('no ordinary fallback')});
 let renders=0;Object.assign(target,{querySelectorAll:()=>[renderedItem],closest:()=>drawer,enableLoading(){},disableLoading(){},refreshOwnedCart:async()=>renders++});
 assert.equal(await target.changeOwnedCart({line:1},3),true);assert.equal(f.calls.writes,2);assert.equal(f.rows[0].quantity,3);assert.equal(f.rows[0].properties._bfl_signature,signatureForQuantity(p.reference.signature,3));assert.equal(renders,1);
});

test('cart rendering matches ordinary keys, variants and properties even when their totals coincide',async()=>{
 const source=readFileSync(new URL('../../../assets/cart.js',import.meta.url),'utf8'),method=source.slice(source.indexOf('  async refreshOwnedCart('),source.indexOf('  async updateQuantityByIndex('));
 const a={key:'a',variant_id:'700001',quantity:2,properties:{Note:'first'},final_line_price:80},b={...a,key:'b',properties:{Note:'second'}},expected={items:[a,b].map(row=>({...row,subtotal_cents:row.final_line_price}))};
 for(const mismatch of [null,'key','variant','properties']){
  const current={items:structuredClone([a,b]),total_price:160,item_count:4};if(mismatch==='key')current.items[1].key='c';if(mismatch==='variant')current.items[1].variant_id='700002';if(mismatch==='properties')current.items[1].properties.Note='wrong';
  let renders=0;const target=vm.runInNewContext('({'+method+'})',{window:{routes:{cart_url:'/cart'}},document:{},fetch:async()=>({ok:true,json:async()=>current}),publish(){},PUB_SUB_EVENTS:{cartUpdate:'cart'}});
  Object.assign(target,{getSectionsToRender:()=>[],refreshSections:()=>renders++});
  if(mismatch)await assert.rejects(target.refreshOwnedCart(expected));else await target.refreshOwnedCart(expected);assert.equal(renders,mismatch?0:1);
 }
});
