// Synthetic offline cases only; never publish these authorities.
import {scenario,replaceAuthority} from '../f06a/synthetic.mjs';
import {MAX_BYTES,ATTRIBUTES,inspectCart} from '../../../apps/film-printing-staging/checkout/authority.js';
import {serializeAuthority} from '../../../apps/film-printing-staging/checkout/projector.mjs';
export async function buildCases() {
const single=await scenario(),multiple=await scenario({count:8}),customer=await scenario({customer:'gid://shopify/Customer/123'});
const large=structuredClone(multiple.input);
for(let i=0;i<192;i++)large.cart.lines.push({id:`gid://shopify/CartLine/ordinary-${i}`,quantity:1,merchandise:{id:'gid://shopify/ProductVariant/999',product:{id:'gid://shopify/Product/999'}},sellingPlanAllocation:null,cost:{amountPerQuantity:{currencyCode:'USD'},subtotalAmount:{amount:'1.00'}}});
const boundary=structuredClone(large);boundary.cart.lines=boundary.cart.lines.slice(0,20);
const padded=structuredClone(boundary),manifest=JSON.parse(padded.shop.authority.value);
const padding='x'.repeat(MAX_BYTES-padded.shop.authority.value.length);
manifest.grants[0].lines[0].claims.message+=padding;padded.cart.lines[0].message.value+=padding;padded.shop.authority.value=serializeAuthority(manifest);
const unrelated=structuredClone(large);unrelated.cart.lines=unrelated.cart.lines.slice(8);unrelated.cart.deliverableLines=[];unrelated.cart.deliveryGroups[0].cartLines=[{id:unrelated.cart.lines[0].id,merchandise:unrelated.cart.lines[0].merchandise}];
const cases=[['valid',single.input],['eight-jobs',multiple.input],['20-line-boundary',boundary],['6000-byte-20-line-boundary',padded],['200-line-cart-denied',large],['192-unrelated-lines',unrelated],['customer',customer.input]];
for(const [name,change] of Object.entries({
 'cart-bootstrap':i=>{i.shop.authority=null;i.buyerJourney.step='CART_INTERACTION';},
 'checkout-interaction':i=>{i.shop.authority=null;i.buyerJourney.step='CHECKOUT_INTERACTION';},
 'missing-authority':i=>i.shop.authority=null,
 'expired':i=>i.shop.localTime.date='2026-10-22',
 'quantity-change':i=>i.cart.lines[0].quantity=5,
 'replay':i=>i.cart.lines[0].id='gid://shopify/CartLine/another-cart',
 'spec-change':i=>i.cart.lines[0].lab.value='other',
 'no-price':i=>i.cart.lines[0].cost.subtotalAmount.amount='1.00',
 'no-lab-map':i=>i.cart.deliverableLines=[],
 'revoked':i=>replaceAuthority(i,a=>a.grants=[]),
 'unrelated':i=>{i.cart.lines=[{id:'other',quantity:1,merchandise:{id:'gid://shopify/ProductVariant/999',product:{id:'gid://shopify/Product/999'}},sellingPlanAllocation:null,cost:{amountPerQuantity:{currencyCode:'USD'},subtotalAmount:{amount:'1.00'}}}];i.cart.deliverableLines=[];i.cart.deliveryGroups[0].cartLines=[{id:'other',merchandise:i.cart.lines[0].merchandise}];},
})) {const input=structuredClone(single.input);change(input);cases.push([name,input]);}

const add=(name,source,change)=>{const i=structuredClone(source);change(i);cases.push([name,i]);};
for(const alias of Object.keys(ATTRIBUTES)) add(`claim-${alias}`,single.input,i=>i.cart.lines[0][alias]={value:'forged'});
for(const [name,change] of Object.entries({
 'duplicate-line':i=>i.cart.lines.push(structuredClone(i.cart.lines[0])),
 'wrong-variant':i=>i.cart.lines[0].merchandise.id='gid://shopify/ProductVariant/9',
 'wrong-product':i=>i.cart.lines[0].merchandise.product.id='gid://shopify/Product/9',
 'wrong-currency':i=>i.cart.lines[0].cost.amountPerQuantity.currencyCode='AUD',
 'selling-plan':i=>i.cart.lines[0].sellingPlanAllocation={sellingPlan:{id:'gid://shopify/SellingPlan/1'}},
 'quantity-zero':i=>i.cart.lines[0].quantity=0,
 'quantity-negative':i=>i.cart.lines[0].quantity=-1,
 'quantity-overflow':i=>i.cart.lines[0].quantity=10001,
 'missing-journey-step':i=>{i.buyerJourney.step=null;i.shop.authority=null;},
 'guest-now-customer':i=>i.cart.buyerIdentity={isAuthenticated:true,customer:{id:'gid://shopify/Customer/123'}},
 'duplicate-lab-map':i=>i.cart.deliverableLines.push(structuredClone(i.cart.deliverableLines[0])),
 'subtotal-negative':i=>i.cart.lines[0].cost.subtotalAmount.amount='-4.80',
 'subtotal-exponent':i=>i.cart.lines[0].cost.subtotalAmount.amount='4.8e0',
 'subtotal-precision':i=>i.cart.lines[0].cost.subtotalAmount.amount='4.800',
 'subtotal-leading-zeros':i=>i.cart.lines[0].cost.subtotalAmount.amount='0004.80',
 'subtotal-overflow':i=>i.cart.lines[0].cost.subtotalAmount.amount='999999999999999999999',
 'reordered-lines':i=>i.cart.lines.reverse(),
})) add(name,name==='reordered-lines'?multiple.input:single.input,change);
for(const [name,buyer] of Object.entries({'customer-logged-out':{isAuthenticated:false,customer:{id:'gid://shopify/Customer/123'}},'customer-wrong':{isAuthenticated:true,customer:{id:'gid://shopify/Customer/456'}},'customer-absent':null})) add(name,customer.input,i=>i.cart.buyerIdentity=buyer);
for(const [name,change] of Object.entries({
 'schema':a=>a.schema=2,'store':a=>a.store='wrong.myshopify.com','hash':a=>a.config_sha256='a'.repeat(64),
 'root-extra':a=>a.extra=true,'grant-extra':a=>a.grants[0].extra=true,'line-extra':a=>a.grants[0].lines[0].extra=true,
 'claims-extra':a=>a.grants[0].lines[0].claims.extra='x','claims-missing':a=>delete a.grants[0].lines[0].claims.paper,
 'owner':a=>a.grants[0].owner='bad','cart':a=>a.grants[0].cart='bad','customer':a=>a.grants[0].customer_id='bad',
 'duplicate-grant':a=>a.grants.push(structuredClone(a.grants[0])),
 'price-zero':a=>a.grants[0].lines[0].unit_cents=0,'price-fractional':a=>a.grants[0].lines[0].unit_cents=1.5,
 'price-overflow':a=>a.grants[0].lines[0].unit_cents=Number.MAX_SAFE_INTEGER,
 'quantity-fractional':a=>a.grants[0].lines[0].quantity=1.5,
 'files-zero':a=>a.grants[0].lines[0].file_count=0,'files-mismatch':a=>a.grants[0].lines[0].claims.files='2',
 'location':a=>a.grants[0].lines[0].location_id='bad','line-id':a=>a.grants[0].lines[0].id='bad',
 'revision':a=>a.grants[0].lines[0].claims.revision='bad','signature':a=>a.grants[0].lines[0].claims.signature='bad',
 'config-cutover':a=>{a.config_sha256='b'.repeat(64);a.config_version='f03-'+a.config_sha256.slice(0,24);},
 'future':a=>a.valid_on='2026-10-22','date-unicode':a=>a.valid_on='123é56789',
 'service':a=>a.grants[0].lines[0].claims.service='darkroom','size':a=>a.grants[0].lines[0].claims.size='1.x2',
 'message-length':a=>a.grants[0].lines[0].claims.message='x'.repeat(2001),
 'message-type':a=>a.grants[0].lines[0].claims.message=23,
 'null-grant':a=>a.grants=[null], 'null-line':a=>a.grants[0].lines=[null],
 'null-claims':a=>a.grants[0].lines[0].claims=null,
})) add(`authority-${name}`,single.input,i=>replaceAuthority(i,change));
for(const [name,raw] of Object.entries({'malformed':'not-json','truncated':'{"schema":','array':'[]','number':'42','empty':'','oversize':' '.repeat(6001),'deep':'['.repeat(200)+'0'+']'.repeat(200)})) add(`authority-${name}`,single.input,i=>i.shop.authority={value:raw});
add('aggregate-ceiling',multiple.input,i=>replaceAuthority(i,a=>a.grants[0].lines.forEach(l=>l.unit_cents=30000)));
add('duplicate-job',multiple.input,i=>replaceAuthority(i,a=>a.grants[0].lines[1].claims.job=a.grants[0].lines[0].claims.job));
add('missing-job-subset',multiple.input,i=>i.cart.lines.pop());
add('unicode-exact',single.input,i=>{i.cart.lines[0].message={value:'Print ✓ café 📷'};replaceAuthority(i,a=>a.grants[0].lines[0].claims.message=i.cart.lines[0].message.value);});
add('current-copies-reauthorized',single.input,i=>{i.cart.lines[0].quantity=5;i.cart.lines[0].cost.subtotalAmount.amount='6.00';replaceAuthority(i,a=>a.grants[0].lines[0].quantity=5);});
add('200-target-last',large,i=>i.cart.lines.reverse());
add('21-line-denied',large,i=>i.cart.lines=i.cart.lines.slice(0,21));
add('200-unrelated-lines',unrelated,i=>{for(let n=192;n<200;n++)i.cart.lines.push({...structuredClone(i.cart.lines[0]),id:`gid://shopify/CartLine/ordinary-${n}`});});
add('send-rolls-with-companion',unrelated,i=>{i.cart.lines=i.cart.lines.slice(0,2);i.cart.lines[0]._return_shipping_required={value:'true'};i.cart.lines[1]._role={value:'return_shipping'};i.shop.authority=null;});
add('mixed-send-rolls-valid',boundary,i=>{i.cart.lines[8]._return_shipping_required={value:'true'};i.cart.lines[9]._role={value:'return_shipping'};});
add('delivery-unrelated-group',single.input,i=>i.cart.deliveryGroups.push({cartLines:[{id:'ordinary',merchandise:{id:'gid://shopify/ProductVariant/999',product:{id:'gid://shopify/Product/999'}}}],deliveryOptions:[{handle:'ordinary-shipping',deliveryMethodType:'SHIPPING'}]}));
add('200-unrelated-deliverables',single.input,i=>{for(let n=0;n<199;n++)i.cart.deliverableLines.push({id:`gid://shopify/DeliverableCartLine/ordinary-${n}`,job:null});});
// Exercise realistic large delivery/deliverable projections, not just cart.lines.
add('200-unrelated-full-mapping',unrelated,i=>{
 for(let n=192;n<200;n++)i.cart.lines.push({...structuredClone(i.cart.lines[0]),id:`gid://shopify/CartLine/ordinary-${n}`});
 i.cart.deliverableLines=i.cart.lines.map((l,n)=>({id:`gid://shopify/DeliverableCartLine/ordinary-${n}`,job:null}));
 i.cart.deliveryGroups[0].cartLines=i.cart.lines.map(l=>({id:l.id,merchandise:l.merchandise}));
});
add('200-unrelated-100-groups',unrelated,i=>{
 for(let n=192;n<200;n++)i.cart.lines.push({...structuredClone(i.cart.lines[0]),id:`gid://shopify/CartLine/ordinary-${n}`});
 i.cart.deliveryGroups=Array.from({length:100},(_,n)=>({cartLines:i.cart.lines.slice(n*2,n*2+2).map(l=>({id:l.id,merchandise:l.merchandise})),deliveryOptions:[]}));
});
add('200-unrelated-200-groups',unrelated,i=>{
 i.shop.authority=null;
 for(let n=192;n<200;n++)i.cart.lines.push(structuredClone(i.cart.lines[0]));
 i.cart.lines.forEach((l,n)=>l.id=`gid://shopify/CartLine/${n}`);
 i.cart.deliveryGroups=i.cart.lines.map(l=>({cartLines:[{id:l.id,merchandise:l.merchandise}],deliveryOptions:[{handle:'s',deliveryMethodType:'SHIPPING'}]}));
});
add('eight-grants-last-matches',multiple.input,i=>{
 const all=JSON.parse(i.shop.authority.value),original=all.grants[0];
 original.lines.forEach(l=>l.claims.message='');
 all.grants=original.lines.map((l,n)=>({...structuredClone(original),cart:n.toString(16).repeat(64),lines:[l]}));
 i.shop.authority.value=serializeAuthority(all);i.cart.lines=i.cart.lines.slice(-1);i.cart.lines[0].message={value:''};
 i.cart.deliverableLines=i.cart.deliverableLines.slice(-1);i.cart.deliveryGroups[0].cartLines=i.cart.deliveryGroups[0].cartLines.slice(-1);
});
// Padding happens after query projection, making the serialized input exactly
// 127,900 bytes for each target. No runtime assertion is treated as diagnostic.
add('near-128k-valid-mixed',boundary,()=>{});
add('near-128k-unrelated',unrelated,()=>{});
add('near-128k-denied-target-last',large,i=>i.cart.lines.reverse());
for(const name of ['eight-grants-last-matches','unicode-exact','current-copies-reauthorized','mixed-send-rolls-valid']) {
 if(!inspectCart(cases.find(([n])=>n===name)[1]).valid) throw Error(`${name} must exercise valid authority`);
}
return {cases,close(){single.store.close();multiple.store.close();customer.store.close();}};
}
export function padInput(input,bytes=127900) {
 for(const l of input.cart.lines.filter(l=>l.merchandise?.id!=='gid://shopify/ProductVariant/67852705202287')) {
  for(const key of ['message','paper','size','signature','revision','config','job','lab','borders','turnaround','files','service']) {
   if(Buffer.byteLength(JSON.stringify(input))>=bytes) break;
   l[key]={value:''};
   const remaining=bytes-Buffer.byteLength(JSON.stringify(input));
   if(remaining<0) throw Error('padding overhead exceeded target');
   l[key].value='x'.repeat(Math.min(remaining,2000));
  }
 }
 if(Buffer.byteLength(JSON.stringify(input))!==bytes) throw Error('padding failed');
 return input;
}
