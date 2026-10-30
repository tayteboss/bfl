import test from 'node:test';
import assert from 'node:assert/strict';
import {fullRig} from '../../../fixtures/film-printing/f06p-engineering/full-rig.mjs';
import {createOwnedUploads} from '../theme/owned-uploads.js';
import {createCustomerCheckout} from '../theme/customer-checkout.js';
import {ATTRIBUTES} from '../checkout/authority.js';
import {cartTransformRun} from '../checkout/functions.js';

test('actual projector refresh repairs quantity and removal Function approval without changing jobs or expiry',async t=>{
 const f=await fullRig(t,{customerFlow:true,customerJobs:2,customerEdits:true}),session=f.clients.A.session;
 const act=action=>session.checkout(action,async()=>f.ids.A);
 await session.issue();await act('bind');await act('install');
 const settledEpoch=f.rows().authority_state[0].epoch;
 const client=createOwnedUploads({},session),ids=[];
 for(const [i,file] of f.inputFiles.entries()){
  const {intent_id}=await client.intent(`cart-edit-file-${i}`);
  ids.push((await client.bytes(intent_id,new Blob([file.bytes],{type:file.mime}))).asset_id);
 }
 const state=f.carts.get(f.ids.A),lines=[];
 for(const [index,asset_ids,copies] of [[0,ids.slice(0,2),3],[1,ids.slice(2),2]]){
  const job=await session.request('/jobs',{...f.plan.selection,asset_ids,copies,request_key:`cart-edit-job-${index}`});
  f.addJob(job.item);const line=state.cart.lines.nodes[0];line.id=`gid://shopify/CartLine/edit-${index}?cart=opaque-synthetic`;line.quantity=copies;
  lines.push(line);state.cart.lines.nodes=[...lines];state.cart.totalQuantity=lines.reduce((n,l)=>n+l.quantity,0);
  await act('publish');
  assert.equal(f.rows().authority_state[0].epoch,settledEpoch);
 }
 const bodies=f.rows().jobs.map(j=>j.body),expires=f.runtime.status().expires;
 const price=()=>cartTransformRun({shop:{authority:f.m.data.shop.authority,localTime:{date:JSON.parse(f.m.data.shop.authority.value).valid_on}},cart:{binding:{value:state.marker},buyerIdentity:{...state.cart.buyerIdentity,isAuthenticated:false},lines:state.cart.lines.nodes.map(l=>({...l,cost:{...l.cost,amountPerQuantity:{amount:'1.00',currencyCode:'USD'}},...Object.fromEntries(Object.entries(ATTRIBUTES).map(([alias,key])=>[alias,{value:l.attributes.find(a=>a.key===key)?.value??''}]))}))}}).operations;
 assert.equal(price().length,2);
 lines[1].quantity=3;state.cart.totalQuantity=6;
 assert.deepEqual(price(),[]); // Exact stale-quantity failure before refresh.
 await act('publish');assert.equal(price().length,2);
 assert.equal(f.rows().authority_state[0].epoch,settledEpoch);
 state.cart.lines.nodes=[lines[0]];state.cart.totalQuantity=3;
 assert.deepEqual(price(),[]); // Exact stale-membership failure observed in staging.
 await act('publish');assert.equal(price()[0].lineUpdate.price.adjustment.fixedPricePerUnit.amount,'0.80');
 assert.deepEqual(f.rows().jobs.map(j=>j.body),bodies);assert.equal(f.runtime.status().expires,expires);
 state.cart.lines.nodes=[];state.cart.totalQuantity=0;
 assert.equal((await act('publish')).state,'revoked');assert.deepEqual(JSON.parse(f.m.data.shop.authority.value).grants,[]);
 assert.ok(f.rows().authority_state[0].epoch>settledEpoch);
 await assert.rejects(act('publish'));assert.equal(f.runtime.status().expires,expires);
});

function nativeRig(){
 let items=[],updates=0,published=false,fail=false,retired=false;
 const total=()=>items.reduce((n,l)=>n+l.subtotal_cents,0);
 const actions={getCart:async()=>({cart:{id:'gid://shopify/Cart/cart-edits?key=private-test',lines:items.map(l=>({id:l.id,quantity:l.quantity,cost:{totalAmount:{amount:(l.subtotal_cents/100).toFixed(2),currencyCode:'USD'}}})),totalQuantity:items.reduce((n,l)=>n+l.quantity,0),cost:{totalAmount:{amount:(total()/100).toFixed(2),currencyCode:'USD'}}}}),updateCart:async({lines})=>{
  updates++;if(fail)throw Error('unknown mutation');
  if(lines[0].merchandiseId){const l=lines[0];items.push({id:`line-${items.length+1}`,variant_id:'67852705202287',quantity:l.quantity,properties:Object.fromEntries(l.attributes.map(a=>[a.key,a.value])),subtotal_cents:0});published=false;}
  else for(const change of lines){const l=items.find(x=>x.id===change.id);if(l.quantity!==change.quantity)published=false;l.quantity=change.quantity;}
  items=items.filter(l=>l.quantity>0);
  for(const l of items)l.subtotal_cents=l.quantity*(published?(l.properties._bfl_job==='first'?80:40):100);
  return actions.getCart();
 }};
 const session={checkout:async action=>{if(retired)throw Error('OWNER_RETIRED');if(action==='current')return {items:structuredClone(items)};if(action==='publish'){published=true;retired=!items.length;return {state:items.length?'published_unverified':'revoked',items:structuredClone(items)};}return {};}};
 const flow=createCustomerCheckout(session,{actions});
 return {flow,get items(){return items;},get updates(){return updates;},set fail(v){fail=v;},total};
}
async function populate(f){
 await f.flow.initialize();
 for(const [id,quantity,unit,lineId] of [['first',3,80,'line-1'],['second',2,40,'line-2']]){
  await f.flow.add({id:'67852705202287',quantity,properties:{_bfl_job:id}});
  const input={reference:{id},lineId,quantity,unit_price_cents:unit};await f.flow.publish(input);await f.flow.recalculate(input);
 }
}
test('native cart edits republish, recalculate and verify all real prices; empty removal clears',async()=>{
 const f=nativeRig();await populate(f);
 assert.equal((await f.flow.change({job:'second',quantity:3})).accepted,true);assert.equal(f.total(),360);
 assert.equal((await f.flow.change({job:'second',quantity:0})).accepted,true);assert.equal(f.total(),240);assert.equal(f.items[0].quantity,3);
 assert.equal((await f.flow.change({job:'first',quantity:0})).accepted,true);assert.equal(f.total(),0);assert.equal(f.items.length,0);
});
test('uncertain cart edit cannot replay or be replaced by a different mutation',async()=>{
 const f=nativeRig();await populate(f);f.fail=true;const before=f.updates;
 await assert.rejects(f.flow.change({job:'second',quantity:3}));await assert.rejects(f.flow.change({job:'second',quantity:0}));assert.equal(f.updates,before+1);
});

test('customer target verification fails before source activation when publication or inventory differs',async()=>{
 const {verifyCustomerTarget}=await import('../backend/diagnostic-control.mjs');
 const {STORE,APP}=await import('../configuration/schema.mjs');
 const {SHOP,INSTALLATION}=await import('../backend/config.mjs');
 const value={shop:{id:SHOP,myshopifyDomain:STORE,currencyCode:'USD'},currentAppInstallation:{id:INSTALLATION,app:{id:APP}},product:{id:'gid://shopify/Product/15620086005871',title:'F00 Film Printing Test',status:'ACTIVE',onlineStoreUrl:null,hasOnlyDefaultVariant:true,variants:{nodes:[{id:'gid://shopify/ProductVariant/67852705202287',price:'1.00',inventoryItem:{tracked:false,requiresShipping:true}}],pageInfo:{hasNextPage:false}}}};
 assert.equal((await verifyCustomerTarget(async()=>value)).published,false);
 for(const change of [x=>x.shop.myshopifyDomain='1jukgy-dc.myshopify.com',x=>x.product.onlineStoreUrl=`https://${STORE}/products/f00-film-printing-test`,x=>x.product.variants.nodes[0].inventoryItem.tracked=true,x=>x.product.variants.nodes[0].id='gid://shopify/ProductVariant/999']){
  const changed=structuredClone(value);change(changed);await assert.rejects(verifyCustomerTarget(async()=>changed));
 }
});
