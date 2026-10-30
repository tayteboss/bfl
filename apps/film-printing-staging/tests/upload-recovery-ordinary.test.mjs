import test from 'node:test';
import assert from 'node:assert/strict';
import {rig,id} from '../../../fixtures/film-printing/f06p-composition/rig.mjs';
import {createCheckoutComposition} from '../checkout/composition.mjs';
import {PRODUCT,VARIANT,VARIANTS_BY_LAB} from '../checkout/authority.js';

const ordinary=(suffix='one')=>({
 __typename:'CartLine',id:`gid://shopify/CartLine/ordinary-${suffix}?cart=synthetic`,quantity:2,
 attributes:[{key:'Service',value:'Develop Only'},{key:'Message',value:'Café 🎞️'},{key:'_timestamp',value:'synthetic-send-rolls'}],parentRelationship:null,sellingPlanAllocation:null,
 cost:{subtotalAmount:{amount:'5.00',currencyCode:'USD'}},
 merchandise:{__typename:'ProductVariant',id:'gid://shopify/ProductVariant/9990002',requiresComponents:false,product:{id:'gid://shopify/Product/9990001'}},
});
async function fixture(t,{lines=[ordinary()],onRecover}={}){
 const f=rig(t),token=f.issue();await f.bind(token);await f.install(token);
 f.state.cart.lines.nodes=structuredClone(lines);f.state.cart.totalQuantity=lines.reduce((sum,line)=>sum+line.quantity,0);
 const before={sessions:f.rows('resource_sessions'),owners:f.rows('checkout_owner_admissions'),bindings:f.rows('cart_checkout_bindings'),checks:f.state.checks,markerWrites:f.state.markerWrites};
 let recovered=0;const ticket=f.store.resourceSessions.authenticate(f.request(token)),uploads=[{receipt:{asset_id:'existing-complete-upload'},file:{name:'original-fixture.png'}}];
 const composition=createCheckoutComposition({...f.options,resumeUploads:async({ticket:received,guard})=>{
  recovered++;assert.deepEqual(received,ticket);guard();await onRecover?.(f,token);guard();return structuredClone(uploads);
 }});
 return {...f,token,ticket,uploads,before,composition,get recovered(){return recovered;},run:()=>composition.resume_uploads(f.input(token))};
}
test('upload recovery retains ordinary Send Rolls snapshots and the exact original owner/deadline without writes',async t=>{
 const first=ordinary(),second=ordinary('two');second.quantity=1;second.cost.subtotalAmount.amount='2.50';second.attributes=[];
 const f=await fixture(t,{lines:[first,second]}),result=await f.run();
 assert.deepEqual(result,{resumed_uploads:true,uploads:f.uploads,items:[
  {id:first.id,variant_id:'9990002',quantity:2,properties:Object.fromEntries(first.attributes.map(a=>[a.key,a.value])),subtotal_cents:500},
  {id:second.id,variant_id:'9990002',quantity:1,properties:{},subtotal_cents:250},
 ],cart_verified:false,checkout_ready:false});
 assert.equal(f.recovered,1);
 assert.deepEqual(f.rows('resource_sessions'),f.before.sessions);assert.deepEqual(f.rows('checkout_owner_admissions'),f.before.owners);assert.deepEqual(f.rows('cart_checkout_bindings'),f.before.bindings);
 assert.equal(f.state.checks,f.before.checks);assert.equal(f.state.markerWrites,f.before.markerWrites);assert.deepEqual(f.state.cart.lines.nodes,[first,second]);
 result.items[0].properties.Message='local edit';assert.equal(f.state.cart.lines.nodes[0].attributes[1].value,'Café 🎞️');
});
test('empty-cart upload recovery remains compatible',async t=>{
 const f=await fixture(t,{lines:[]}),result=await f.run();assert.deepEqual(result.items,[]);assert.equal(result.resumed_uploads,true);assert.equal(f.recovered,1);
});
for(const [name,change] of [
 ['protected product',line=>{line.merchandise.product.id=PRODUCT;}],
 ['historical print variant',line=>{line.merchandise.id=VARIANT;}],
 ...Object.entries(VARIANTS_BY_LAB).map(([lab,variant])=>[`${lab} print variant`,line=>{line.merchandise.id=variant;line.merchandise.product.id=PRODUCT;}]),
 ...['_bfl_flow','_bfl_job','_bfl_signature','_bfl_unknown'].map(key=>[key,line=>{line.attributes.push({key,value:key==='_bfl_flow'?'f05':'partial'});}]),
])test(`${name} cannot be treated as an ordinary upload-recovery cart`,async t=>{
 const line=ordinary();change(line);const f=await fixture(t,{lines:[line]});await assert.rejects(f.run());assert.equal(f.recovered,0);assert.equal(f.state.markerWrites,f.before.markerWrites);
});
for(const [name,change] of [
 ['quantity',f=>{f.state.cart.lines.nodes[0].quantity=3;f.state.cart.totalQuantity=3;}],
 ['price',f=>{f.state.cart.lines.nodes[0].cost.subtotalAmount.amount='5.01';}],
 ['properties',f=>{f.state.cart.lines.nodes[0].attributes[1].value='changed';}],
 ['variant',f=>{f.state.cart.lines.nodes[0].merchandise.id='gid://shopify/ProductVariant/9990003';}],
 ['binding marker',f=>{f.state.marker='b'.repeat(64);}],
])test(`an ordinary ${name} change during recovery rejects the response`,async t=>{
 const f=await fixture(t,{onRecover:change});await assert.rejects(f.run(),/UPLOAD_RECOVERY_CART_CHANGED/);assert.equal(f.recovered,1);assert.equal(f.state.checks,f.before.checks);assert.equal(f.state.markerWrites,f.before.markerWrites);
});
for(const cause of ['revoke','renew','proof age','owner expiry'])test(`${cause} during upload recovery cannot extend or reuse original authority`,async t=>{
 const f=await fixture(t,{onRecover:(f,token)=>{
  const s=f.store.resourceSessions,ticket=s.authenticate(f.request(token));
  if(cause==='revoke')s.revoke(ticket);
  if(cause==='renew')s.renew(ticket,f.proofs.observeFreshContext({request:f.request(token),proof:f.proof('renew',token),action:'renew',ticket}));
  if(cause==='proof age')f.clock.time+=30001;
  if(cause==='owner expiry')f.clock.time+=301000;
 }});
 await assert.rejects(f.run(),/REJECTED|FENCED|UNAVAILABLE|EXPIRED/);assert.equal(f.recovered,1);assert.equal(f.rows('resource_sessions').length,f.before.sessions.length);
});
test('a changed full cart capability or foreign owner cannot recover the ordinary cart uploads',async t=>{
 const f=await fixture(t),other=f.issue();
 await assert.rejects(f.composition.resume_uploads(f.input(f.token,id+'x')),/OWNER_REJECTED/);
 await assert.rejects(f.composition.resume_uploads(f.input(other)),/OWNER_UNAVAILABLE/);assert.equal(f.recovered,0);
});
