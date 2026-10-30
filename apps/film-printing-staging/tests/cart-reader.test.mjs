import test from 'node:test';
import assert from 'node:assert/strict';
import {createStorefrontReader,parseCurrentCart,bindCurrentCart,cartHash,CART_QUERY} from '../checkout/storefront.mjs';
import {STORE} from '../checkout/authority.js';
import {SHOP} from '../backend/config.mjs';
import {id,owner,customer,proof,response,cartResponse,fixture} from '../../../fixtures/film-printing/f06c-continuation/synthetic.mjs';
import {now} from '../../../fixtures/film-printing/f06d/mock-admin.mjs';
const config={store:STORE,shopId:SHOP,privateToken:'synthetic-secret-only'.repeat(3),enabled:true};
const input={cart_id:id,buyerIp:'127.0.0.1'};
test('F06C reader defaults disabled, requires exact target, credential and trusted buyer IP before any request',async()=>{
 let calls=0;const options={fetchImpl:async()=>{calls++;return response(cartResponse());}};
 await assert.rejects(createStorefrontReader({...config,enabled:false},options)(input),/DISABLED/);
 await assert.rejects(createStorefrontReader({...config,privateToken:null},options)(input),/CREDENTIAL/);
 assert.throws(()=>createStorefrontReader({...config,store:'1jukgy-dc.myshopify.com'}),/WRONG_SHOP/);
 assert.throws(()=>createStorefrontReader({...config,shopId:'wrong'}),/WRONG_SHOP/);
 for(const cart_id of ['ajax-token',id.split('?')[0],id+'&key=x',id.replace('synthetic-cart','')])await assert.rejects(createStorefrontReader(config,options)({...input,cart_id}),/LOCATOR/);
 await assert.rejects(createStorefrontReader(config,options)({cart_id:id}),/BUYER_IP/);assert.equal(calls,0);
});
test('F06C exact read-only endpoint/query/version preserves opaque ID and sends private credentials only to staging',async()=>{
 let seen;const read=createStorefrontReader(config,{fetchImpl:async(url,options)=>{seen={url,options};return response(cartResponse());}});
 const result=await read({...input,query:'mutation forged',owner:'forged',complete:true});
 assert.equal(seen.url,`https://${STORE}/api/2026-07/graphql.json`);assert.equal(seen.options.redirect,'error');
 assert.deepEqual(JSON.parse(seen.options.body),{query:CART_QUERY,variables:{id}});
 assert.equal(seen.options.headers['Shopify-Storefront-Private-Token'],config.privateToken);
 assert.equal(seen.options.headers['Shopify-Storefront-Buyer-IP'],'127.0.0.1');
 assert.equal(result.id,id);assert.equal(result.complete,true);assert.equal(result.owner,undefined);
 assert.equal(result.customer_context,'unproven');assert.equal(result.checkout_ready,false);
});
test('F06C HTTP/errors/redirect/version/content/oversize/timeout fail once with sanitized fixed errors',async()=>{
 const cases=[()=>response(cartResponse(),{},400),()=>response(cartResponse(),{'x-shopify-api-version':'2026-10'}),
  ()=>response(cartResponse(),{'content-type':'text/html'}),()=>response(cartResponse(),{'content-encoding':'gzip'}),
  ()=>new Response('{bad-secret'),()=>response({data:cartResponse().data,errors:[{message:id}]}),
  ()=>response({data:cartResponse().data,errors:null}),()=>{throw Error(id+config.privateToken);}];
 for(const get of cases){let calls=0;await assert.rejects(createStorefrontReader(config,{fetchImpl:async()=>{calls++;return get();}})(input),e=>!e.message.includes('synthetic'));assert.equal(calls,1);}
 await assert.rejects(createStorefrontReader(config,{maxBytes:8,fetchImpl:async()=>response(cartResponse())})(input),/TOO_LARGE/);
 await assert.rejects(createStorefrontReader(config,{timeoutMs:5,fetchImpl:async(_,o)=>new Promise((_,reject)=>o.signal.addEventListener('abort',()=>reject(Error(id))))})(input),/UNAVAILABLE/);
 const redirected=response(cartResponse());Object.defineProperty(redirected,'redirected',{value:true});
 await assert.rejects(createStorefrontReader(config,{fetchImpl:async()=>redirected})(input),/UNAVAILABLE/);
});
test('F06C rejects incomplete/redacted/foreign cart and shop responses instead of filling missing fields',()=>{
 for(const mutate of [d=>d.data.shop.id='wrong',d=>d.data.cart=null,d=>d.data.cart.id=id.replace('key-only','wrong-key'),
  d=>delete d.data.cart.buyerIdentity.customer,d=>d.data.cart.buyerIdentity.customer={},d=>d.data.cart.buyerIdentity.purchasingCompany={},
  d=>d.data.cart.lines.pageInfo.hasNextPage=true,d=>delete d.data.cart.lines.pageInfo.hasPreviousPage,d=>d.data.cart.lines.nodes=null,
  d=>d.data.cart.totalQuantity=1,d=>d.data.cart.updatedAt=null]){
   const d=cartResponse();mutate(d);assert.throws(()=>parseCurrentCart(d,id));
 }
});
test('F06C complete parser retains every property/current quantity and exact CartLine suffix; rejects unsupported bundles and partial lines',async t=>{
 const f=await fixture();t.after(()=>f.store.close());const parsed=parseCurrentCart(f.data,id);
 assert.equal(parsed.lines[0].id,f.data.data.cart.lines.nodes[0].id);assert.equal(parsed.lines[0].quantity,4);
 assert.equal(parsed.lines[0].reference.signature,f.prepared.reference.signature);assert.equal(parsed.lines[0].subtotal_cents,480);
 assert.equal(Object.keys(parsed.lines[0].properties).length,f.data.data.cart.lines.nodes[0].attributes.length);
 for(const mutate of [l=>l.id='gid://shopify/CartLine/?cart=x',l=>l.id+='\n',l=>l.__typename='ComponentizableCartLine',l=>l.parentRelationship={},l=>delete l.parentRelationship,
  l=>l.merchandise.__typename='Unknown',l=>l.merchandise.requiresComponents=true,l=>delete l.merchandise.product,
  l=>l.sellingPlanAllocation={},l=>delete l.sellingPlanAllocation,l=>l.quantity=1.5,l=>l.quantity=10001,
  l=>l.attributes.push(l.attributes[0]),l=>l.attributes=null,l=>l.cost.subtotalAmount.currencyCode='AUD',
  l=>l.cost.subtotalAmount.amount='NaN',l=>l.cost.subtotalAmount.amount='0.001']) {
   const d=structuredClone(f.data);mutate(d.data.cart.lines.nodes[0]);assert.throws(()=>parseCurrentCart(d,id));
 }
 const d=structuredClone(f.data);d.data.cart.lines.nodes.push(d.data.cart.lines.nodes[0]);assert.throws(()=>parseCurrentCart(d,id));
 d.data.cart.lines.nodes=Array(21).fill(d.data.cart.lines.nodes[0]);assert.throws(()=>parseCurrentCart(d,id),/INCOMPLETE/);
});
test('F06C null customer plus a key is never guest proof; missing/mismatched/stale/redacted binding evidence rejects',async()=>{
 const cart=parseCurrentCart(cartResponse(),id),args={read:async()=>cart,request:{},owner,cart_id:id,now:()=>now().getTime()};
 await assert.rejects(bindCurrentCart(args),/PROOF_UNAVAILABLE/);
 for(const patch of [{},{capability:'unknown'},{customer_context:'redacted'},{owner:'other'},{cart_hash:cartHash(id+'wrong')},
  {store:'other'},{customer_id:customer},{kind:'customer'},{binding_id:''},{verified_at:now().getTime()+1},{expires_at:now().getTime()},
  {expires_at:now().getTime()+60001}]) {
   const evidence=Object.keys(patch).length?{...proof({owner,cart}),...patch}:null;
   await assert.rejects(bindCurrentCart({...args,verifyOwnership:async()=>evidence}),/OWNER_REJECTED/);
 }
 const bound=await bindCurrentCart({...args,verifyOwnership:proof});assert.equal(bound.owner,owner);assert.equal(bound.checkout_ready,false);
});
test('F06C customer binding requires matching independently authenticated customer plus capability proof',async()=>{
 const d=cartResponse();d.data.cart.buyerIdentity.customer={id:customer};const cart=parseCurrentCart(d,id);
 const args={read:async()=>cart,request:{},owner,cart_id:id,now:()=>now().getTime()};
 await assert.rejects(bindCurrentCart({...args,verifyOwnership:async()=>({...proof({owner,cart}),customer_id:null})}),/OWNER_REJECTED/);
 assert.equal((await bindCurrentCart({...args,verifyOwnership:proof})).customer_id,customer);
 // Structurally successful read with a wrong opaque key still needs independent
 // capability proof. Echoed ID/null customer is deliberately insufficient.
 const bad=id.replace('key-only','wrong-key');d.data.cart.id=bad;
 await assert.rejects(bindCurrentCart({...args,cart_id:bad,read:async()=>parseCurrentCart(d,bad),verifyOwnership:()=>proof({owner,cart})}),/OWNER_REJECTED/);
});
