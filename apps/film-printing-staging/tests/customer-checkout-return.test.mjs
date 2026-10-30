import test from 'node:test';
import assert from 'node:assert/strict';
import {createCustomerCheckout} from '../theme/customer-checkout.js';

function returning({wrongLine=false}={}){
 let items=[{id:'line-1',variant_id:'67852705202287',quantity:2,properties:{_bfl_job:'job-1'},subtotal_cents:80}],updates=0;
 const actions={getCart:async()=>({cart:{id:'gid://shopify/Cart/return?key=private-test',lines:items.map(l=>({id:l.id,quantity:l.quantity,cost:{totalAmount:{amount:wrongLine?'0.79':'0.80',currencyCode:'USD'}}})),totalQuantity:items.length?2:0,cost:{totalAmount:{amount:items.length?'6.31':'0.00',currencyCode:'USD'}}}}),updateCart:async({lines})=>{updates++;assert.equal(lines[0].quantity,0);items=[];return actions.getCart();}};
 const session={checkpoint(){},suspend(){},checkout:async action=>action==='publish'?{state:'revoked'}:{resumed:true,items:structuredClone(items)}};
 return {flow:createCustomerCheckout(session,{actions}),get updates(){return updates;}};
}
test('checkout return verifies native print-line prices separately from shipping and can remove its final line',async()=>{
 const f=returning();const resumed=await f.flow.initialize({resume:true});assert.equal(resumed.resumed,true);assert.equal(resumed.cart.items[0].subtotal_cents,80);
 const result=await f.flow.change({job:'job-1',quantity:0});assert.equal(result.accepted,true);assert.deepEqual(result.cart.items,[]);assert.equal(f.updates,1);
});
test('shipping-inclusive total cannot conceal an incorrect native print-line price',async()=>{
 const f=returning({wrongLine:true});await assert.rejects(f.flow.initialize({resume:true}));assert.equal(f.updates,0);
});
