// F06M local HTTP/SQLite regressions. Shopify responses/signatures are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import {rig,id} from '../../../fixtures/film-printing/f06l/rig.mjs';
import {PRODUCT,VARIANT} from '../checkout/authority.js';
const ordinary=()=>({__typename:'CartLine',id:'gid://shopify/CartLine/f06m-synthetic-line',quantity:1,parentRelationship:null,attributes:[{key:'service',value:'ordinary'}],sellingPlanAllocation:null,cost:{subtotalAmount:{amount:'1.00',currencyCode:'USD'}},merchandise:{__typename:'ProductVariant',id:'gid://shopify/ProductVariant/123',requiresComponents:false,product:{id:'gid://shopify/Product/123'}}});
function setLine(f){f.state.current.totalQuantity=1;f.state.current.lines.nodes=[ordinary()];}
for(const type of ['product','variant','attribute'])test('F06M printing '+type+' rejects before remote mutation and cannot reuse reservation',async t=>{
 const f=await rig(t),a=await f.issue();setLine(f);const l=f.state.current.lines.nodes[0];
 if(type==='product')l.merchandise.product.id=PRODUCT;
 if(type==='variant')l.merchandise.id=VARIANT;
 if(type==='attribute')l.attributes.push({key:'_bfl_job',value:'synthetic'});
 await assert.rejects(f.inspect(a),/CART_PRINTING_PROOF_UNAVAILABLE/);assert.equal(f.state.writes,0);assert.equal(f.rows()[0].state,'rejected');
 f.state.current.lines.nodes=[ordinary()];await assert.rejects(f.inspect(a),/REPLAY/);assert.equal(f.state.writes,0);
});
for(const kind of ['partial','quantity','duplicate','bundle','customer'])test('F06M nonempty '+kind+' before-state remains unavailable',async t=>{
 const f=await rig(t),a=await f.issue();setLine(f);const c=f.state.current,l=c.lines.nodes[0];
 if(kind==='partial')c.lines.pageInfo.hasNextPage=true;
 if(kind==='quantity')c.totalQuantity=2;
 if(kind==='duplicate')c.lines.nodes.push(structuredClone(l));
 if(kind==='bundle')l.merchandise.requiresComponents=true;
 if(kind==='customer')c.buyerIdentity.customer={id:'gid://shopify/Customer/123'};
 await assert.rejects(f.inspect(a));assert.equal(f.state.writes,0);assert.equal(f.rows()[0].state,'rejected');
});
for(const kind of ['missing_attributes','cost','customer','quantity'])test('F06M nonempty mutation '+kind+' keeps unknown custody, never ownership',async t=>{
 const f=await rig(t),a=await f.issue();setLine(f);
 f.state.alter=(write,s)=>{if(!write)return;const c=s.current,l=c.lines.nodes[0];
  if(kind==='missing_attributes')delete l.attributes;
  if(kind==='cost')l.cost.subtotalAmount.amount='2.00';
  if(kind==='customer')c.buyerIdentity.customer={id:'gid://shopify/Customer/123'};
  if(kind==='quantity'){l.quantity=2;c.totalQuantity=2;}
 };
 await assert.rejects(f.inspect(a));assert.equal(f.state.writes,1);assert.equal(f.rows()[0].state,'unknown');
 await assert.rejects(f.adapter.verifyOwnership(),/BUYER_PROOF_UNAVAILABLE/);await assert.rejects(f.inspect(a));assert.equal(f.state.writes,1);
});
test('F06M successful nonempty reservation remains capability-only across restart and cannot be promoted',async t=>{
 const f=await rig(t),a=await f.issue();setLine(f);const result=await f.inspect(a),rows=f.rows();
 assert.equal(result.buyer_association_basis,'private_token_and_accepted_full_key');assert.equal(result.cart_verified,false);await f.close();
 const g=await rig(t,{config:f.config,clock:f.clock});assert.deepEqual(g.rows(),rows);assert.equal(g.adapter.status(g.request(a),result.attempt_id).customer_context,'unproven');
 await assert.rejects(g.adapter.verifyOwnership(),/BUYER_PROOF_UNAVAILABLE/);await assert.rejects(g.inspect(a,id),/REPLAY/);assert.equal(g.state.writes,0);await g.close();
});
