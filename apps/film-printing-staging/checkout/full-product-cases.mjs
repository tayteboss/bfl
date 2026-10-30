// Offline fixtures only; never publish these invented owners or claims.
import assert from 'node:assert/strict';
import {buildCases as legacyCases} from '../../../fixtures/film-printing/f06v3-candidate/cases.mjs';
import {FULL_PRODUCT_ATTRIBUTES,VARIANTS_BY_LAB,variantForLab,inspectCart,displayClaims} from './authority.js';
const ascii=value=>JSON.stringify(value).replace(/[\u007f-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
export async function buildCases({labVariants=false}={}){
 const legacy=await legacyCases(),cases=[...legacy.cases],original=new Set(cases.map(([name])=>name));
 const specificationExpected=new Map();
 const source=cases.find(([name])=>name==='valid')[1];
 function selection(kind,changes={}){
  const input=structuredClone(source),e=JSON.parse(input.leaseOwner.lease.value),l=e.authority.grants[0].lines[0];e.authority.schema=4;l.shipping_eligible=kind==='photo';
  Object.assign(l.claims,{size_mode:kind==='custom'?'custom':'fixed',width:kind==='custom'?'16':'',height:kind==='custom'?'20':'',process:kind==='darkroom'?'Color':'',scanning:kind==='darkroom'?'No':'',negatives:kind==='darkroom'?'Mail In':''});
  if(kind==='custom')Object.assign(l.claims,{service:'fine_art',size:'16x20'});
  if(kind==='darkroom'){l.file_count=0;Object.assign(l.claims,{service:'darkroom',size:'8x10',files:'0'});}
  Object.assign(l.claims,changes);input.leaseOwner.lease.value=ascii(e);
  if(kind!=='photo')for(const group of input.cart.deliveryGroups)group.selectedDeliveryOption={deliveryMethodType:'PICK_UP'};
  for(const alias of Object.keys(FULL_PRODUCT_ATTRIBUTES))input.cart.lines[0][alias]={value:alias==='signature'?`v3:${l.claims.signature}:${input.cart.lines[0].quantity}`:l.claims[alias]};
  return input;
 }
 function add(name,input,valid=true){assert.equal(inspectCart(input).valid,valid,name);cases.push([name,input]);}
 for(const [name,base] of [['v3',source],...['photo','custom','darkroom'].map(kind=>[`v4-${kind}`,selection(kind)])]){
  const absent=structuredClone(base);absent.cart.buyerIdentity=null;add(`${name}-null-buyer`,absent);
  const guest=structuredClone(base);guest.cart.buyerIdentity={isAuthenticated:false,customer:{id:'gid://shopify/Customer/123'}};add(`${name}-guest-associated-customer`,guest);
  for(const flag of [true]){
   const changed=structuredClone(guest);changed.cart.buyerIdentity.isAuthenticated=flag;add(`${name}-guest-authentication-${flag}`,changed,false);
  }
  const bound=structuredClone(guest),e=JSON.parse(bound.leaseOwner.lease.value);e.authority.grants[0].customer_id='gid://shopify/Customer/123';bound.leaseOwner.lease.value=ascii(e);
  bound.cart.buyerIdentity.isAuthenticated=true;add(`${name}-authenticated-customer`,bound);
  const guestNotAccount=structuredClone(bound);guestNotAccount.cart.buyerIdentity.isAuthenticated=false;add(`${name}-associated-guest-cannot-use-account-grant`,guestNotAccount,false);
  const nullAccount=structuredClone(bound);nullAccount.cart.buyerIdentity=null;add(`${name}-account-grant-null-buyer`,nullAccount,false);
  const different=structuredClone(bound);different.cart.buyerIdentity.customer.id='gid://shopify/Customer/456';add(`${name}-different-authenticated-customer`,different,false);
 }
 for(const kind of ['photo','custom','darkroom']){
  const valid=selection(kind);add(`v4-${kind}-valid`,valid);
  for(const alias of ['size_mode','width','height','process','scanning','negatives']){
   const input=structuredClone(valid);input.cart.lines[0][alias]={value:'forged'};add(`v4-${kind}-tamper-${alias}`,input,false);
  }
  for(const flag of ['equality','past']){const input=structuredClone(valid);input.shop.localTime.beforeDeadline=false;add(`v4-${kind}-deadline-${flag}`,input,false);}
 }
 for(const kind of ['custom','darkroom'])for(const step of ['CHECKOUT_INTERACTION','CHECKOUT_COMPLETION']){
  for(const method of ['SHIPPING','LOCAL','PICKUP_POINT','PICK_UP',null]){
   const input=selection(kind);input.buyerJourney={step};input.cart.deliveryGroups[0].selectedDeliveryOption=method===null?null:{deliveryMethodType:method};
   const name=`v4-${kind}-${step}-selected-${method}`;add(name,input);specificationExpected.set(name,method==='PICK_UP'||method===null&&step==='CHECKOUT_INTERACTION');
  }
  for(const variant of ['missing-group','duplicate-group','duplicate-line']){
   const input=selection(kind);input.buyerJourney={step};
   if(variant==='missing-group')input.cart.deliveryGroups=[];
   if(variant==='duplicate-group')input.cart.deliveryGroups.push(structuredClone(input.cart.deliveryGroups[0]));
   if(variant==='duplicate-line')input.cart.deliveryGroups[0].cartLines.push(structuredClone(input.cart.deliveryGroups[0].cartLines[0]));
   const name=`v4-${kind}-${step}-${variant}`;add(name,input);specificationExpected.set(name,variant==='missing-group'&&step==='CHECKOUT_INTERACTION');
  }
 }
 for(const literal of [false,true]){
  const input=selection('custom',{borders:'Borders (0.5” white)',message:'Café 🎞️'});
  if(literal)input.leaseOwner.lease.value=JSON.stringify(JSON.parse(input.leaseOwner.lease.value));
  add(`v4-unicode-${literal?'literal':'escaped'}`,input);
  const altered=structuredClone(input);altered.cart.lines[0].borders.value='Borders (0.5" white)';add(`v4-unicode-${literal?'literal':'escaped'}-tamper`,altered,false);
 }
 {
  const input=selection('custom'),e=JSON.parse(input.leaseOwner.lease.value);e.authority.grants[0].lines[0].claims.message='é'.repeat(1000);
  input.leaseOwner.lease.value=JSON.stringify(e);input.cart.lines[0].message.value='é'.repeat(1000);add('v4-unicode-escaped-budget-exceeded',input,false);
 }
 add('v4-custom-tall',selection('custom',{width:'1',height:'1001',size:'1x1001'}));
 {
  // The live D cart exercises a large unit price with Shopify's nullable buyer.
  const input=selection('custom',{width:'44',height:'60',size:'44x60',lab:'orlando',paper:'fibre',borders:'Borderless (Edge-to-edge)',turnaround:'Standard (4-5 days)',files:'1'});
  const e=JSON.parse(input.leaseOwner.lease.value),grant=e.authority.grants[0].lines[0];grant.unit_cents=19600;grant.file_count=1;grant.shipping_eligible=true;
  input.leaseOwner.lease.value=ascii(e);input.cart.buyerIdentity=null;input.cart.lines[0].quantity=3;
  input.cart.lines[0].signature.value=`v3:${grant.claims.signature}:3`;input.cart.lines[0].cost.subtotalAmount.amount='588.00';
  add('v4-custom-44x60-three-null-buyer',input);
 }

 for(const size of ['8x10','11x14','12x16','16x20'])for(const process of ['Color','Black and White'])for(const negatives of ['Already at Bellows','Drop Off','Mail In'])
  add(`v4-darkroom-${size}-${process}-${negatives}`,selection('darkroom',{size,process,negatives,scanning:['8x10','11x14'].includes(size)?'Yes':''}));
 if(labVariants){
  assert.deepEqual(Object.keys(VARIANTS_BY_LAB).sort(),['atlanta','chicago','miami','orlando']);assert.equal(new Set(Object.values(VARIANTS_BY_LAB)).size,4);
  function routed(lab,kind){
   const input=selection(kind,{lab}),e=JSON.parse(input.leaseOwner.lease.value),grant=e.authority.grants[0].lines[0];e.authority.schema=5;grant.variant_id=variantForLab(lab);
   input.leaseOwner.lease.value=ascii(e);input.cart.lines[0].merchandise.id=grant.variant_id;
   for(const group of input.cart.deliveryGroups)for(const line of group.cartLines)if(line.merchandise)line.merchandise.id=grant.variant_id;
   return input;
  }
  for(const lab of Object.keys(VARIANTS_BY_LAB))for(const kind of ['photo','custom','darkroom']){
   const base=routed(lab,kind);add(`v5-${lab}-${kind}-valid`,base);
   const absent=structuredClone(base);absent.cart.buyerIdentity=null;add(`v5-${lab}-${kind}-null-buyer`,absent);
   const guest=structuredClone(base);guest.cart.buyerIdentity={isAuthenticated:false,customer:{id:'gid://shopify/Customer/123'}};add(`v5-${lab}-${kind}-associated-guest`,guest);
  }
  for(const lab of Object.keys(VARIANTS_BY_LAB))for(const kind of ['photo','custom','darkroom']){
   const input=routed(lab,kind),e=JSON.parse(input.leaseOwner.lease.value),claims=e.authority.grants[0].lines[0].claims;
   claims.paper=kind==='photo'?'photo-premium-luster':kind==='darkroom'?'rc-matte':'fibre-paper';
   if(kind==='custom'){claims.width='20';claims.height='16';}
   input.leaseOwner.lease.value=ascii(e);const display=displayClaims(claims);
   for(const alias of Object.keys(FULL_PRODUCT_ATTRIBUTES))if(alias!=='signature')input.cart.lines[0][alias]={value:display[alias]};
   add(`v5-display-${lab}-${kind}`,input);
   for(const key of ['service','size','paper','lab']){
    const mixed=structuredClone(input);mixed.cart.lines[0][key].value=claims[key];add(`v5-display-${lab}-${kind}-mixed-${key}`,mixed,false);
   }
   if(kind==='custom'){const reversed=structuredClone(input);reversed.cart.lines[0].size.value='16" × 20" (Custom)';add(`v5-display-${lab}-custom-reversed`,reversed,false);}
  }
  const base=routed('chicago','custom');
  const swap=structuredClone(base);swap.cart.lines[0].merchandise.id=variantForLab('orlando');add('v5-actual-variant-swapped',swap,false);
  const wrongLab=structuredClone(base),bad=JSON.parse(wrongLab.leaseOwner.lease.value);bad.authority.grants[0].lines[0].variant_id=variantForLab('orlando');wrongLab.leaseOwner.lease.value=ascii(bad);add('v5-signed-variant-wrong-lab',wrongLab,false);
  for(const [name,variant] of [['missing',undefined],['null',null],['numeric',67852705202287],['unknown','gid://shopify/ProductVariant/999']]){
   const input=structuredClone(base),e=JSON.parse(input.leaseOwner.lease.value);e.authority.grants[0].lines[0].variant_id=variant;input.leaseOwner.lease.value=ascii(e);add(`v5-signed-variant-${name}`,input,false);
  }
  const old=selection('photo'),legacy=JSON.parse(old.leaseOwner.lease.value);legacy.authority.grants[0].lines[0].variant_id=variantForLab('miami');old.leaseOwner.lease.value=ascii(legacy);add('v5-legacy4-rejects-variant-field',old,false);
  for(const alias of Object.keys(FULL_PRODUCT_ATTRIBUTES)){
   const input=structuredClone(base);input.cart.lines[0][alias]={value:'forged'};add(`v5-tamper-${alias}`,input,false);
  }
  const authenticated=structuredClone(base),account=JSON.parse(authenticated.leaseOwner.lease.value);account.authority.grants[0].customer_id='gid://shopify/Customer/123';authenticated.leaseOwner.lease.value=ascii(account);authenticated.cart.buyerIdentity={isAuthenticated:true,customer:{id:'gid://shopify/Customer/123'}};add('v5-authenticated-exact-customer',authenticated);
  for(const [name,buyer] of [['null',null],['guest',{isAuthenticated:false,customer:{id:'gid://shopify/Customer/123'}}],['different',{isAuthenticated:true,customer:{id:'gid://shopify/Customer/456'}}]]){
   const input=structuredClone(authenticated);input.cart.buyerIdentity=buyer;add(`v5-account-${name}-rejected`,input,false);
  }
  for(const [name,change] of [['deadline',i=>i.shop.localTime.beforeDeadline=false],['binding',i=>i.cart.binding.value='f'.repeat(64)],['product',i=>i.cart.lines[0].merchandise.product.id='gid://shopify/Product/999'],['quantity',i=>i.cart.lines[0].quantity=3]]){
   const input=structuredClone(base);change(input);add(`v5-${name}-rejected`,input,false);
  }
  const mixed=routed('miami','photo'),e=JSON.parse(mixed.leaseOwner.lease.value);e.authority.grants[0].lines=[];mixed.cart.lines=[];mixed.cart.deliverableLines=[];mixed.cart.deliveryGroups=[];
  for(const [index,[lab,kind]] of [['miami','photo'],['chicago','custom'],['orlando','darkroom']].entries()){
   const one=routed(lab,kind),approved=JSON.parse(one.leaseOwner.lease.value).authority.grants[0].lines[0],line=one.cart.lines[0],deliverable=one.cart.deliverableLines[0],group=one.cart.deliveryGroups[0];
   approved.claims.job=`mixed-${lab}`;approved.location_id=`gid://shopify/Location/${index+1}`;line.job.value=approved.claims.job;line.id=`gid://shopify/CartLine/mixed-${lab}`;
   deliverable.job.value=approved.claims.job;deliverable.id=`gid://shopify/DeliverableCartLine/mixed-${lab}`;group.cartLines=[{...group.cartLines[0],id:line.id}];group.selectedDeliveryOption={deliveryMethodType:'PICK_UP'};
   e.authority.grants[0].lines.push(approved);mixed.cart.lines.push(line);mixed.cart.deliverableLines.push(deliverable);mixed.cart.deliveryGroups.push(group);
  }
  mixed.cart.buyerIdentity=null;mixed.leaseOwner.lease.value=ascii(e);add('v5-mixed-three-labs',mixed);
  const sameLab=structuredClone(mixed),same=JSON.parse(sameLab.leaseOwner.lease.value);same.authority.grants[0].lines[1].claims.lab='miami';same.authority.grants[0].lines[1].variant_id=variantForLab('miami');same.authority.grants[0].lines[1].location_id=same.authority.grants[0].lines[0].location_id;sameLab.cart.lines[1].lab.value='miami';sameLab.cart.lines[1].merchandise.id=variantForLab('miami');sameLab.leaseOwner.lease.value=ascii(same);add('v5-same-lab-two-jobs',sameLab);
  const swapped=structuredClone(mixed);[swapped.cart.lines[0].merchandise.id,swapped.cart.lines[1].merchandise.id]=[swapped.cart.lines[1].merchandise.id,swapped.cart.lines[0].merchandise.id];add('v5-mixed-swapped-variants',swapped,false);
  const padded=structuredClone(mixed),limit=JSON.parse(padded.leaseOwner.lease.value);let remaining=6000-ascii(limit.authority).length;assert.ok(remaining>=0);
  for(const [index,line] of limit.authority.grants[0].lines.entries()){
   const count=Math.min(remaining,2000-line.claims.message.length);line.claims.message+='x'.repeat(count);padded.cart.lines[index].message.value=line.claims.message;remaining-=count;
  }
  assert.equal(remaining,0);padded.leaseOwner.lease.value=ascii(limit);add('v5-authority-exact-byte-limit',padded);
  const overflow=structuredClone(padded);limit.authority.grants[0].lines.at(-1).claims.message+='x';overflow.cart.lines.at(-1).message.value=limit.authority.grants[0].lines.at(-1).claims.message;overflow.leaseOwner.lease.value=ascii(limit);add('v5-authority-over-byte-limit',overflow,false);
 }
 return {cases,close:()=>legacy.close(),assertOutput(name,target,input,output){
  if(target==='specification'){
   // The original validation independently covers all legacy fields. This
   // second target must enforce exactly the additional queried specification.
   const checked=inspectCart(input,{claimScope:'specification'}),allowed=input.buyerJourney?.step==='CART_INTERACTION'||checked.valid&&(specificationExpected.get(name)??true)||!checked.targeted.length;
   assert.equal(output.operations.length,allowed?0:1,`${name}/specification`);return;
  }
  if(original.has(name)||name==='historical-f06a-golden')return legacy.assertOutput(name,target,input,output);
  const checked=inspectCart(input,{claimScope:'base'}),allowed=checked.valid;
  if(target==='pricing'||target==='lab')assert.equal(output.operations.length,allowed?checked.lines.length:0,`${name}/${target}`);
  else if(target==='validation')assert.equal(output.operations.length,input.buyerJourney?.step==='CART_INTERACTION'||allowed?0:1,`${name}/validation`);
 }};
}
