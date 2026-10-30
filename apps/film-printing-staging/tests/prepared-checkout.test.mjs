import test from 'node:test';
import assert from 'node:assert/strict';
import {createPreparedCheckout,signatureForQuantity} from '../theme/prepared-checkout.js';
const STORE='bellows-film-printing-staging.myshopify.com',CART='gid://shopify/Cart/prepared-test?key=private-test',VARIANT='67852705202287';
const money=n=>({amount:(n/100).toFixed(2),currencyCode:'USD'});
async function rig(t,{fileCount=1,service='photo',specification=null}={}){
 const old=globalThis.location;globalThis.location={origin:`https://${STORE}`};t.after(()=>{globalThis.location=old;});
 let now=Date.now(),serial=0,rows=[],lost=false,ajaxFault=null,readHook=null,replyFault=null,nativeFault=null,graphFault=null,resumeExpiry=true;const ownerExpires=now+300000;
 const calls={read:0,write:0,sdkWrite:0,fetch:0,checkout:[],jobs:0,payloads:[],operations:[]},jobs=new Map();
 const reset=()=>{calls.read=calls.write=calls.sdkWrite=calls.fetch=0;calls.checkout=[];calls.payloads=[];};
 const native=()=>({id:CART,lines:rows.map(r=>({id:r.nativeId,quantity:r.quantity,cost:{totalAmount:money(r.unit*r.quantity)}})),totalQuantity:rows.reduce((s,r)=>s+r.quantity,0),cost:{totalAmount:money(rows.reduce((s,r)=>s+r.unit*r.quantity,0))}});
 const ajax=()=>({currency:'USD',items:rows.map(r=>({key:r.key,variant_id:VARIANT,quantity:r.quantity,properties:{...r.properties},final_price:r.unit,final_line_price:r.unit*r.quantity})),item_count:rows.reduce((s,r)=>s+r.quantity,0),total_price:rows.reduce((s,r)=>s+r.unit*r.quantity,0)});
 const applyWrite=async(payload,options)=>{
  calls.write++;calls.payloads.push(structuredClone(payload));assert.equal(payload.cartId,CART);assert.ok(options.signal instanceof AbortSignal);assert.equal(payload.lines.length,1);const line=payload.lines[0];
  if(line.merchandiseId){assert.equal(line.merchandiseId,`gid://shopify/ProductVariant/${VARIANT}`);const p=Object.fromEntries(line.attributes.map(a=>[a.key,a.value]));assert.ok(jobs.has(p._bfl_job));rows.push({nativeId:`native-line-${++serial}`,key:`${VARIANT}:ajax-${serial}`,quantity:line.quantity,properties:p,unit:jobs.get(p._bfl_job).unit_price_cents});}
  else{const r=rows.find(r=>r.key===line.viewKey);assert.ok(r,'must use actual Ajax key');r.quantity=line.quantity;if(line.attributes)r.properties=Object.fromEntries(line.attributes.map(a=>[a.key,a.value]));r.key=`${VARIANT}:ajax-${++serial}`;rows=rows.filter(r=>r.quantity);}
  if(lost){lost=false;throw Error('lost response');}const response={cart:native(),userErrors:[],warnings:[]};replyFault?.(response);return response;
 };
 const actions={getCart:async()=>{calls.read++;readHook?.();const cart=native();nativeFault?.(cart);return {cart};},updateCart:async(payload,options)=>{calls.sdkWrite++;return applyWrite(payload,options);}};
 let rememberedGeneration=0;
 const session={preparationGeneration:()=>rememberedGeneration,rememberPreparationGeneration(g){assert.ok(g>=rememberedGeneration);rememberedGeneration=g;},assertLive(){assert.ok(now<ownerExpires);},beginMutation(op){calls.operations.push(structuredClone(op));},checkpoint(){},
  async request(path,input){assert.equal(path,'/jobs');calls.jobs++;const id=`job-${calls.jobs}`,raw=String(calls.jobs).repeat(64),job={checkout_ready:false,reference:{id,revision:'1',config_version:'config-1',signature:raw},unit_price_cents:40,file_count:fileCount,item:{id:VARIANT,quantity:input.copies,properties:{_bfl_flow:'f05',_bfl_job:id,_bfl_revision:'1',_bfl_config:'config-1',_bfl_signature:raw,Service:service,Sizes:service==='darkroom'?'8x10':'4x6',Location:'miami',Message:input.message??'','Files Uploaded':String(fileCount),...(specification??{})}}};jobs.set(id,job);return structuredClone(job);},
  async checkout(action,locate,input={}){calls.checkout.push(action);assert.equal(await locate(),CART);if(action==='current')return {items:[]};if(action==='eligible'){const job=jobs.get(input.reference.id);return {...structuredClone(job),prepared:true,cart_verified:false,generation:input.generation,reservation:{operation_id:`operation-${job.reference.id}`,job_id:job.reference.id,owner_hash:'a'.repeat(64),cart_hash:'b'.repeat(64),generation:input.generation,expires_at:now+60000},expires_at:now+60000};}if(action==='cancel_preparation')return {cancelled:true,revoked:true};if(action==='resume')return {resumed:true,...(resumeExpiry?{expires_at:now+30000}:{}),items:rows.map(r=>({id:r.nativeId,variant_id:VARIANT,quantity:r.quantity,properties:{...r.properties},subtotal_cents:r.unit*r.quantity}))};return {};}
 };
 const fetchImpl=async (path,options)=>{calls.fetch++;let value;if(path==='/api/2026-07/graphql.json'){
  assert.equal(options.method,'POST');assert.equal(options.credentials,'same-origin');assert.equal(options.redirect,'error');assert.deepEqual(options.headers,{'Content-Type':'application/json'});
  const {query,variables}=JSON.parse(options.body);assert.equal(variables.i,CART);assert.equal(variables.c,'US');assert.equal(variables.l,'EN');assert.ok(!query.includes('cost')&&!query.includes('discountCodes'));assert.ok(query.includes('@inContext')&&query.includes('pageInfo{hasNextPage}'));
  const payload=await applyWrite({cartId:variables.i,lines:query.includes('cartLinesRemove(')?variables.lines.map(viewKey=>({viewKey,quantity:0})):variables.lines},options);payload.cart={id:payload.cart.id,totalQuantity:payload.cart.totalQuantity,lines:{nodes:payload.cart.lines.map(({id,quantity})=>({id,quantity})),pageInfo:{hasNextPage:false}}};
  const name=query.includes('cartLinesAdd(')?'cartLinesAdd':query.includes('cartLinesUpdate(')?'cartLinesUpdate':'cartLinesRemove';value={data:{[name]:payload}};graphFault?.(value);return {ok:true,redirected:false,json:async()=>value};
 }if(path==='/cart.js'){value=ajax();ajaxFault?.(value);}else{assert.equal(path,'/cart?sections=cart-drawer');value={'cart-drawer':'<div>Fixture</div>'};}return {ok:true,redirected:false,json:async()=>value};};
 const flow=createPreparedCheckout(session,{actions,fetchImpl,now:()=>now});await flow.initialize();
 return {flow,calls,prepare:()=>flow.prepare({generation:calls.jobs+1,copies:2,message:'',request_key:`request-${calls.jobs+1}`}),reset,native,ajax,get rows(){return rows;},advance:n=>{now+=n;},set lost(v){lost=v;},set ajaxFault(v){ajaxFault=v;},set readHook(v){readHook=v;},set resumeExpiry(v){resumeExpiry=v;},set replyFault(v){replyFault=v;},set nativeFault(v){nativeFault=v;},set graphFault(v){graphFault=v;}};
}
test('prepared Add uses parallel pre-reads, one write and actual Ajax claims plus sections',async t=>{
 const f=await rig(t),prepared=await f.prepare();f.reset();let started=false;const result=await f.flow.addPrepared({prepared,quantity:3,assertSelection(){},onWriteStarted(){started=true;}});
 assert.equal(started,true);assert.equal(result.accepted,true);assert.equal(f.calls.sdkWrite,0);assert.deepEqual([f.calls.read,f.calls.write,f.calls.fetch],[2,1,4]);assert.deepEqual(f.calls.checkout,[]);assert.equal(f.calls.jobs,1);
 assert.deepEqual(Object.keys(f.native().lines[0]).sort(),['cost','id','quantity']);assert.equal(result.cart.items[0].id,f.ajax().items[0].key);assert.equal(result.cart.items[0].properties._bfl_signature,signatureForQuantity(prepared.reference.signature,3));assert.equal(result.cart.items[0].subtotal_cents,120);
 await assert.rejects(f.flow.addPrepared({prepared,quantity:3}));assert.equal(f.calls.write,1);
});
test('equal-cost jobs edit fresh actual keys and preserve all immutable claims',async t=>{
 const f=await rig(t),a=await f.prepare();await f.flow.addPrepared({prepared:a,quantity:2});const b=await f.prepare();await f.flow.addPrepared({prepared:b,quantity:2});
 const key=f.rows[0].key,second=f.rows[1].key,prior={...f.rows[0].properties};f.reset();await f.flow.change({job:a.reference.id,quantity:4});
 assert.equal(f.calls.sdkWrite,0);assert.equal(f.calls.payloads[0].lines[0].viewKey,key);assert.notEqual(f.rows[0].key,key);assert.deepEqual(f.rows[0].properties,{...prior,_bfl_signature:signatureForQuantity(a.reference.signature,4)});assert.equal(f.rows[1].key,second);assert.deepEqual([f.calls.read,f.calls.write,f.calls.fetch],[2,1,4]);
 const next=f.rows[0].key;f.reset();await f.flow.change({job:a.reference.id,quantity:0});assert.equal(f.calls.payloads[0].lines[0].viewKey,next);assert.equal(f.rows[0].properties._bfl_job,b.reference.id);assert.equal(f.calls.jobs,2);assert.deepEqual(f.calls.checkout,[]);await f.flow.change({job:b.reference.id,quantity:0});assert.deepEqual(f.rows,[]);
});
test('matching native prices cannot hide forged Ajax claims or permit replay',async t=>{
 const f=await rig(t),p=await f.prepare();f.ajaxFault=c=>{if(c.items[0])c.items[0].properties.Message='forged';};f.reset();await assert.rejects(f.flow.addPrepared({prepared:p,quantity:2}));assert.equal(f.flow.canRetry(),false);await assert.rejects(f.flow.addPrepared({prepared:p,quantity:2}));assert.equal(f.calls.write,1);f.ajaxFault=null;assert.equal((await f.flow.recover()).accepted,true);assert.equal(f.calls.write,1);
});
test('lost native response is reconciled without a repeated write',async t=>{
 const f=await rig(t),p=await f.prepare();f.lost=true;f.reset();await assert.rejects(f.flow.addPrepared({prepared:p,quantity:2}));assert.equal(f.rows.length,1);assert.equal(f.flow.canRetry(),false);assert.equal(f.calls.operations.at(-1).kind,'add');await assert.rejects(f.flow.change({job:p.reference.id,quantity:3}));assert.equal(f.calls.write,1);assert.equal((await f.flow.recover()).cart.items[0].quantity,2);await assert.rejects(f.flow.addPrepared({prepared:p,quantity:2}));assert.equal(f.calls.write,1);
});
test('native continuity churn rejects before dispatch despite matching price',async t=>{const f=await rig(t),p=await f.prepare();await f.flow.addPrepared({prepared:p,quantity:2});f.rows[0].nativeId='replacement';f.reset();await assert.rejects(f.flow.change({job:p.reference.id,quantity:3}));assert.equal(f.calls.write,0);});
test('last-line removal rechecks original expiry after native pre-read',async t=>{const f=await rig(t),p=await f.prepare();await f.flow.addPrepared({prepared:p,quantity:2});f.reset();f.readHook=()=>{f.advance(60001);f.readHook=null;};await assert.rejects(f.flow.change({job:p.reference.id,quantity:0}));assert.equal(f.calls.write,0);});
test('authenticated recovery requires explicit finite eligibility expiry',async t=>{const f=await rig(t),p=await f.prepare();f.lost=true;await assert.rejects(f.flow.addPrepared({prepared:p,quantity:2}));f.resumeExpiry=false;await assert.rejects(f.flow.recover());assert.equal(f.flow.canRetry(),false);});
test('combined cart cap rejects Add and quantity before dispatch and permits exact boundary',async t=>{
 const f=await rig(t),a=await f.prepare();await f.flow.addPrepared({prepared:a,quantity:2500});const b=await f.prepare();f.reset();
 const operations=f.calls.operations.length;
 await assert.rejects(f.flow.addPrepared({prepared:b,quantity:2501}));assert.equal(f.calls.write,0);assert.equal(f.calls.operations.length,operations);assert.equal(f.flow.canRetry(),true);
 assert.equal((await f.flow.addPrepared({prepared:b,quantity:2500})).accepted,true);assert.equal(f.ajax().total_price,200000);
 f.reset();await assert.rejects(f.flow.change({job:a.reference.id,quantity:2501}));assert.equal(f.calls.write,0);assert.equal(f.flow.canRetry(),true);assert.equal(f.ajax().total_price,200000);
});

test('current Ajax claims are checked before a quantity write even when native costs match',async t=>{
 const f=await rig(t),p=await f.prepare();await f.flow.addPrepared({prepared:p,quantity:2});
 f.rows[0].properties.Message='changed elsewhere';f.reset();
 await assert.rejects(f.flow.change({job:p.reference.id,quantity:3}));assert.equal(f.calls.write,0);assert.equal(f.rows[0].properties.Message,'changed elsewhere');
});


test('omitted mutation prices use fresh parallel readback without replay and allow the next edit',async t=>{
 const f=await rig(t),p=await f.prepare();await f.flow.addPrepared({prepared:p,quantity:2});f.reset();
 f.replyFault=r=>{r.cart.lines[0].cost.totalAmount=money(80);r.cart.cost.totalAmount=money(80);};
 const result=await f.flow.change({job:p.reference.id,quantity:3});
 assert.equal(result.cart.items[0].subtotal_cents,120);assert.deepEqual([f.calls.read,f.calls.write,f.calls.fetch],[2,1,4]);
 assert.deepEqual(Object.keys(result).sort(),['accepted','cart','render']);
 f.replyFault=null;assert.equal((await f.flow.change({job:p.reference.id,quantity:2})).cart.items[0].subtotal_cents,80);assert.equal(f.calls.write,2);
});
for(const fault of ['identity','quantity','price'])test(`fresh native ${fault} disagreement remains blocked after one write`,async t=>{
 const f=await rig(t),p=await f.prepare();f.reset();
 f.nativeFault=c=>{if(!f.calls.write)return;if(fault==='identity')c.lines[0].id='different';if(fault==='quantity'){c.lines[0].quantity++;c.totalQuantity++;}if(fault==='price')c.lines[0].cost.totalAmount=money(1);};
 await assert.rejects(f.flow.addPrepared({prepared:p,quantity:2}));assert.equal(f.calls.write,1);assert.equal(f.flow.canRetry(),false);
});
test('expiry during fresh postwrite reads cannot checkpoint success or replay',async t=>{
 const f=await rig(t),p=await f.prepare();f.reset();f.readHook=()=>{if(f.calls.write)f.advance(60001);};
 await assert.rejects(f.flow.addPrepared({prepared:p,quantity:2}));assert.equal(f.calls.write,1);assert.equal(f.flow.canRetry(),false);
});
for(const fault of ['lost','warning','malformed'])test(`${fault} mutation response never starts postwrite recovery or a second write`,async t=>{
 const f=await rig(t),p=await f.prepare();f.reset();
 if(fault==='lost')f.lost=true;else f.replyFault=r=>{if(fault==='warning')r.warnings=['warning'];else r.cart.lines[0].quantity=0;};
 await assert.rejects(f.flow.addPrepared({prepared:p,quantity:2}));assert.equal(f.calls.write,1);assert.equal(f.calls.read,1);assert.equal(f.calls.fetch,2);assert.equal(f.flow.canRetry(),false);
});

for(const fault of ['top-error','missing-errors','missing-warnings','truncated','wrong-cart','duplicate-lines','wrong-total'])test(`direct add ${fault} response blocks without fallback`,async t=>{
 const f=await rig(t),p=await f.prepare();f.reset();f.graphFault=r=>{const a=r.data.cartLinesAdd,c=a.cart;
  if(fault==='top-error')r.errors=[{message:'failure'}];if(fault==='missing-errors')delete a.userErrors;if(fault==='missing-warnings')delete a.warnings;
  if(fault==='truncated')c.lines.pageInfo.hasNextPage=true;if(fault==='wrong-cart')c.id='gid://shopify/Cart/other?key=other';
  if(fault==='duplicate-lines'){c.lines.nodes.push({...c.lines.nodes[0]});c.totalQuantity*=2;}if(fault==='wrong-total')c.totalQuantity++;
 };
 await assert.rejects(f.flow.addPrepared({prepared:p,quantity:2}));assert.equal(f.calls.write,1);assert.equal(f.calls.read,1);assert.equal(f.flow.canRetry(),false);
 await assert.rejects(f.flow.addPrepared({prepared:p,quantity:2}));assert.equal(f.calls.write,1);
});

for(const quantity of [0,3])for(const fault of ['lost','warning','wrong-cart'])test(`direct edit ${quantity} ${fault} blocks without SDK fallback or replay`,async t=>{
 const f=await rig(t),p=await f.prepare();await f.flow.addPrepared({prepared:p,quantity:2});f.reset();
 if(fault==='lost')f.lost=true;else f.graphFault=r=>{const a=Object.values(r.data)[0];if(fault==='warning')a.warnings=[{code:'unexpected'}];else a.cart.id='gid://shopify/Cart/other?key=other';};
 await assert.rejects(f.flow.change({job:p.reference.id,quantity}));assert.equal(f.calls.write,1);assert.equal(f.calls.sdkWrite,0);assert.equal(f.calls.read,1);assert.equal(f.flow.canRetry(),false);
 await assert.rejects(f.flow.change({job:p.reference.id,quantity}));assert.equal(f.calls.write,1);
});


test('darkroom zero-upload receipt preserves all signed claims through add, quantity, recovery and removal',async t=>{
 const specification={_bfl_size_mode:'fixed','Custom Width':'','Custom Height':'',Process:'Color','Scanning Options':'Yes',Negatives:'Mail In'};
 const f=await rig(t,{fileCount:0,service:'darkroom',specification}),p=await f.prepare();assert.equal(p.file_count,0);
 await f.flow.addPrepared({prepared:p,quantity:2});for(const [key,value] of Object.entries(specification))assert.equal(f.rows[0].properties[key],value);
 await f.flow.change({job:p.reference.id,quantity:3});assert.equal(f.rows[0].properties['Files Uploaded'],'0');
 f.lost=true;await assert.rejects(f.flow.change({job:p.reference.id,quantity:4}));assert.equal((await f.flow.recover()).cart.items[0].quantity,4);
 await f.flow.change({job:p.reference.id,quantity:0});assert.deepEqual(f.rows,[]);
});
test('photo zero-upload and darkroom fabricated upload count fail before native write',async t=>{
 for(const [service,fileCount] of [['photo',0],['darkroom',1]]){
  const f=await rig(t,{fileCount,service,specification:{_bfl_size_mode:'fixed'}});await assert.rejects(f.prepare());assert.equal(f.calls.write,0);
 }
});
test('a changed darkroom visible specification rejects quantity before native write',async t=>{
 const f=await rig(t,{fileCount:0,service:'darkroom',specification:{_bfl_size_mode:'fixed',Process:'Color','Scanning Options':'No',Negatives:'Mail In'}}),p=await f.prepare();
 await f.flow.addPrepared({prepared:p,quantity:2});f.rows[0].properties.Process='Black and White';f.reset();await assert.rejects(f.flow.change({job:p.reference.id,quantity:3}));assert.equal(f.calls.write,0);
});

test('human Darkroom labels retain zero-file Add, edit, pending recovery and remove behavior',async t=>{
 const specification={Service:'Darkroom Prints',Sizes:'12” × 16”',Paper:'RC Matte',Location:'Chicago',_bfl_size_mode:'fixed','Custom Width':'','Custom Height':'',Process:'Color','Scanning Options':'',Negatives:'Mail In'};
 const f=await rig(t,{fileCount:0,service:'darkroom',specification}),p=await f.prepare();await f.flow.addPrepared({prepared:p,quantity:2});await f.flow.change({job:p.reference.id,quantity:3});
 f.lost=true;await assert.rejects(f.flow.change({job:p.reference.id,quantity:4}));const recovered=await f.flow.recover();assert.equal(recovered.cart.items[0].properties.Service,'Darkroom Prints');assert.equal(recovered.cart.items[0].properties.Sizes,'12” × 16”');assert.equal(recovered.cart.items[0].quantity,4);
 await f.flow.change({job:p.reference.id,quantity:0});assert.deepEqual(f.rows,[]);
});
