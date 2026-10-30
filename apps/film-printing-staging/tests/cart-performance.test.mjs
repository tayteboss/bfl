import test from 'node:test';
import assert from 'node:assert/strict';
import {createCustomerCheckout} from '../theme/customer-checkout.js';
import '../theme/film-printing-job.js';
import {createAdminTransport} from '../backend/admin.mjs';
import {CONTEXT_QUERY} from '../checkout/shopify.mjs';
import {STORE,APP,CLIENT} from '../configuration/schema.mjs';
import {SHOP,INSTALLATION} from '../backend/config.mjs';

test('identity-bearing Admin context is one request and rejects each wrong target',async()=>{
 const identity={shop:{id:SHOP,myshopifyDomain:STORE},currentAppInstallation:{id:INSTALLATION,app:{id:APP,apiKey:CLIENT}}};
 for(const change of [null,d=>d.shop.id='wrong',d=>d.shop.myshopifyDomain='wrong',d=>d.currentAppInstallation.id='wrong',d=>d.currentAppInstallation.app.id='wrong',d=>d.currentAppInstallation.app.apiKey='wrong']){
  let count=0;const value=structuredClone(identity);change?.(value);
  const api=createAdminTransport({store:STORE,app:APP,clientId:CLIENT,installation:INSTALLATION,adminToken:'test-only',mode:'disabled'},
   {fetchImpl:async()=>{count++;return new Response(JSON.stringify({data:value}),{headers:{'content-type':'application/json','x-shopify-api-version':'2026-10'}});}});
  if(change)await assert.rejects(api(CONTEXT_QUERY),/WRONG_TARGET/);else assert.deepEqual(await api(CONTEXT_QUERY),identity);
  assert.equal(count,1);
 }
});

test('complete controller add uses three authenticated reads; immutable snapshots and terminal removal preserve verification',async()=>{
 const cartId='gid://shopify/Cart/performance?key=private';let items=[],published=false,retired=false,currentReads=0,writes=0;
 const native=()=>({id:cartId,totalQuantity:items.reduce((n,l)=>n+l.quantity,0),lines:items.map(l=>({id:l.id,quantity:l.quantity,cost:{totalAmount:{amount:(l.subtotal_cents/100).toFixed(2),currencyCode:'USD'}}})),cost:{totalAmount:{amount:(items.reduce((n,l)=>n+l.subtotal_cents,0)/100).toFixed(2),currencyCode:'USD'}}});
 const actions={getCart:async()=>({cart:native()}),updateCart:async({lines})=>{
  writes++;const row=lines[0];if(row.merchandiseId)items=[{id:'line-1',variant_id:'67852705202287',quantity:row.quantity,properties:Object.fromEntries(row.attributes.map(p=>[p.key,p.value])),subtotal_cents:100*row.quantity}];
  else {items=items.filter(l=>lines.find(r=>r.id===l.id)?.quantity!==0);for(const l of items){l.quantity=lines.find(r=>r.id===l.id)?.quantity??l.quantity;l.subtotal_cents=l.quantity*(published?80:100);}}
  return {cart:native()};
 }};
 const session={checkout:async(action,locate)=>{assert.equal(await locate(),cartId);if(retired)throw Error('retired');
  if(action==='current'){currentReads++;return {items:structuredClone(items)};}
  if(action==='publish'){published=true;retired=!items.length;return {state:retired?'revoked':'published_unverified',items:structuredClone(items)};}return {};
 }};
 const checkout=createCustomerCheckout(session,{actions});await checkout.initialize();
 const snapshot=await checkout.cart();assert.throws(()=>snapshot.items.push({}),TypeError);currentReads=0;
 const controller=globalThis.BFLPrintJob.createController({...checkout,read:()=>({copies:3,asset_ids:['a','b']}),prepare:async()=>({checkout_ready:false,reference:{id:'job-1'},file_count:2,unit_price_cents:80,item:{id:'67852705202287',quantity:3,properties:{_bfl_job:'job-1'}}})});
 assert.equal((await controller.submit()).cart.items[0].subtotal_cents,240);assert.equal(currentReads,3);assert.equal(writes,2);
 const before=currentReads;assert.equal((await checkout.change({job:'job-1',quantity:0})).cart.items.length,0);assert.equal(currentReads-before,1);assert.equal(writes,3);
});

test('customer proof exchange is consumed inside checkout; replay and expiry still reject',async t=>{
 const {fullRig}=await import('../../../fixtures/film-printing/f06p-engineering/full-rig.mjs');
 const {createResourceSession}=await import('../theme/resource-session.js');
 const f=await fullRig(t,{customerFlow:true});let exchanges=0,last,expire=false;
 const session=createResourceSession({now:()=>f.clock.time,fetchImpl:async(url,options)=>{
  if(url.endsWith('/resource-proof/exchange'))exchanges++;
  if(url.endsWith('/checkout/bind'))last={url,options:structuredClone(options)};
  if(expire&&url.endsWith('/checkout/current'))f.clock.time+=30001;
  return f.browserFetch(url,options);
 }});
 await session.issue();assert.equal(exchanges,1);
 await session.checkout('bind',async()=>f.ids.A);assert.equal(exchanges,1);
 const replay=await f.browserFetch(last.url,last.options);assert.equal(replay.status,403);
 await session.checkout('install',async()=>f.ids.A);assert.equal(exchanges,1);
 expire=true;await assert.rejects(session.checkout('current',async()=>f.ids.A));
 assert.equal(exchanges,1);
});

test('confirmed stale pricing gets one recalculation; uncertainty, changed claims and expiry never replay',async()=>{
 for(const mode of ['settles','unknown','changed','expired']){
  let item,writes=0,published=false;
  const native=()=>({id:'gid://shopify/Cart/stale-price?key=private',totalQuantity:item?.quantity??0,lines:item?[{id:item.id,quantity:item.quantity,cost:{totalAmount:{amount:(item.subtotal_cents/100).toFixed(2),currencyCode:'USD'}}}]:[],cost:{totalAmount:{amount:((item?.subtotal_cents??0)/100).toFixed(2),currencyCode:'USD'}}});
  const actions={getCart:async()=>({cart:native()}),updateCart:async({lines})=>{
   writes++;if(writes===3&&mode==='unknown')throw Error('unknown result');
   const l=lines[0];if(l.merchandiseId)item={id:'line',quantity:l.quantity,variant_id:'67852705202287',properties:Object.fromEntries(l.attributes.map(a=>[a.key,a.value])),subtotal_cents:300};
   if(writes===3)item.subtotal_cents=240;
   return {cart:native()};
  }};
  const session={assertLive(){if(mode==='expired'&&writes===2)throw Error('RESOURCE_EXPIRED');},checkout:async action=>{
   if(action==='publish'){published=true;return {state:'published_unverified',items:[structuredClone(item)]};}
   if(action==='current'){
    const rows=item?[structuredClone(item)]:[];
    if(mode==='changed'&&published&&writes===2)rows[0].properties._bfl_job='foreign-job';
    return {items:rows};
   }return {};
  }};
  const checkout=createCustomerCheckout(session,{actions});await checkout.initialize();
  const controller=globalThis.BFLPrintJob.createController({...checkout,read:()=>({copies:3,asset_ids:['a','b']}),prepare:async()=>({checkout_ready:false,reference:{id:'job'},file_count:2,unit_price_cents:80,item:{id:'67852705202287',quantity:3,properties:{_bfl_job:'job'}}})});
  if(mode==='settles'){assert.equal((await controller.submit()).cart.items[0].subtotal_cents,240);assert.equal(writes,3);}
  else {await assert.rejects(controller.submit());const count=writes;await assert.rejects(controller.submit());assert.equal(writes,count);assert.equal(writes,mode==='unknown'?3:2);}
 }
});
