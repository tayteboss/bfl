import test from 'node:test';
import assert from 'node:assert/strict';
import {fullRig} from '../../../fixtures/film-printing/f06p-engineering/full-rig.mjs';
import {createCustomerCheckout} from '../theme/customer-checkout.js';

// Real resource client, proof/checkout HTTP handlers, SQLite and publisher.
// Shopify/provider responses are synthetic, as in the shared fullRig.
test('one-job customer HTTP flow can clear its last line after spending its positive publication',async t=>{
 const f=await fullRig(t,{customerFlow:true}),session=f.clients.A.session;
 await session.issue();
 let updates=0;const events=[],state=f.carts.get(f.ids.A);
 const actions={getCart:async()=>({cart:{id:f.ids.A,lines:state.cart.lines.nodes.map(l=>({...l,cost:{totalAmount:l.cost.subtotalAmount}})),totalQuantity:state.cart.totalQuantity,
   cost:{totalAmount:{amount:state.cart.lines.nodes.length?'4.80':'0.00',currencyCode:'USD'}}}}),
  updateCart:async({lines})=>{
   updates++;
   for(const line of lines){const target=state.cart.lines.nodes.find(x=>x.id===line.id);target.quantity=line.quantity;}
   state.cart.lines.nodes=state.cart.lines.nodes.filter(l=>l.quantity>0);
   state.cart.totalQuantity=state.cart.lines.nodes.reduce((n,l)=>n+l.quantity,0);
   return actions.getCart();
  }};
 const flow=createCustomerCheckout(session,{actions,observe:e=>events.push(e)});await flow.initialize();
 const asset_ids=[];
 for(const [i,file] of f.inputFiles.entries()){
  const {intent_id}=await session.request('/uploads/intents',{request_key:`removal-http-${i}`});
  const result=await session.request(`/uploads/${intent_id}/bytes`,new Blob([file.bytes],{type:file.mime}),{mime:file.mime});asset_ids.push(result.asset_id);
 }
 const job=await session.request('/jobs',{...f.plan.selection,asset_ids,request_key:'removal-http-job'});f.addJob(job.item);
 state.cart.lines.nodes[0].cost.subtotalAmount.amount='4.80';
 const lineId=state.cart.lines.nodes[0].id,input={reference:job.reference,lineId,quantity:4,unit_price_cents:120};
 await flow.publish(input);await flow.recalculate(input);
 const bodies=f.rows().jobs.map(x=>x.body),expires=f.runtime.status().expires;
 const result=await flow.change({job:job.reference.id,quantity:0});
 assert.equal(result.accepted,true);assert.deepEqual(result.cart.items,[]);
 assert.equal(updates,2);assert.equal((await actions.getCart()).cart.totalQuantity,0);
 assert.equal((await actions.getCart()).cart.cost.totalAmount.amount,'0.00');
 assert.deepEqual(JSON.parse(f.m.data.shop.authority.value).grants,[]);
 assert.deepEqual(f.rows().jobs.map(x=>x.body),bodies);assert.equal(f.runtime.status().expires,expires);
 assert.ok(events.some(e=>e.stage==='cart-edit'&&e.state==='verified'&&e.lines===0&&e.total===0));
 await assert.rejects(flow.change({job:job.reference.id,quantity:0}));assert.equal(updates,2);
});
