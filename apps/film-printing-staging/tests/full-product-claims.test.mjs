import test from 'node:test';
import assert from 'node:assert/strict';
import {FULL_PRODUCT_ATTRIBUTES,STORE,VARIANT,PRODUCT,VARIANTS_BY_LAB,variantForLab,decodeAuthority,decodeEligibility,inspectCart} from '../checkout/authority.js';
import {leaseEnvelope,leaseDeadline} from '../checkout/lease.mjs';
import {cartTransformRun,cartValidationsGenerateRun} from '../checkout/functions.js';
const hex=n=>String(n).repeat(64),copy=structuredClone;
function fixture(kind='photo',schema=4,lab='miami'){
 const claims={flow:'f05',job:'test-job',revision:hex(1),config:`f03-${hex(2).slice(0,24)}`,signature:hex(3),service:kind==='custom'?'fine_art':kind,size:kind==='custom'?'16x20':kind==='darkroom'?'8x10':'4x6',paper:'test-paper',lab,message:'',borders:'',turnaround:'Standard',files:kind==='darkroom'?'0':'2',size_mode:kind==='custom'?'custom':'fixed',width:kind==='custom'?'16':'',height:kind==='custom'?'20':'',process:kind==='darkroom'?'Color':'',scanning:kind==='darkroom'?'No':'',negatives:kind==='darkroom'?'Mail In':''};
 if(schema===3)for(const k of ['size_mode','width','height','process','scanning','negatives'])delete claims[k];
 const authority={schema,store:STORE,config_version:claims.config,config_sha256:hex(2),price_version:'price-fixture',valid_on:'2026-10-30',lease:{token:hex(4),deadline:'2026-10-30T12:04:00',expires_at:1793361840000},grants:[{cart:hex(5),owner:hex(6),customer_id:null,binding:hex(7),generation:1,epoch:1,lines:[{unit_cents:100,file_count:Number(claims.files),...([4,5].includes(schema)?{shipping_eligible:kind==='photo'}:{}),...(schema===5?{variant_id:variantForLab(lab)}:{}),location_id:'gid://shopify/Location/1',claims}]}]};
 const line={id:'gid://shopify/CartLine/test',quantity:2,merchandise:{id:schema===5?variantForLab(lab):VARIANT,product:{id:PRODUCT}},sellingPlanAllocation:null,cost:{amountPerQuantity:{currencyCode:'USD'},subtotalAmount:{amount:'2.00'}},...Object.fromEntries(Object.entries(claims).map(([key,value])=>[key,{value}]))};line.signature.value=`v3:${claims.signature}:2`;
 const input={buyerJourney:{step:'CHECKOUT_INTERACTION'},leaseOwner:{lease:{value:leaseEnvelope(JSON.stringify(authority))}},shop:{localTime:{beforeDeadline:true}},cart:{binding:{value:hex(7)},buyerIdentity:{isAuthenticated:false,customer:null},lines:[line],deliverableLines:[{id:'gid://shopify/DeliverableCartLine/test',job:{value:claims.job}}]}};
 return {authority,input};
}
const setAuthority=(input,a)=>input.leaseOwner.lease.value=leaseEnvelope(JSON.stringify(a));
for(const kind of ['photo','custom','darkroom'])test(`full product ${kind} claims authorize exact selection and quantity`,()=>{
 const {authority,input}=fixture(kind);assert.ok(decodeAuthority(JSON.stringify(authority)));assert.equal(decodeEligibility(input.leaseOwner.lease.value).schema,4);
 const checked=inspectCart(input);assert.equal(checked.valid,true);assert.equal(checked.lines[0].physical_count,kind==='darkroom'?null:4);
 assert.equal(cartTransformRun(input).operations[0].lineUpdate.price.adjustment.fixedPricePerUnit.amount,'1.00');assert.deepEqual(cartValidationsGenerateRun(input),{operations:[]});
 for(const alias of Object.keys(FULL_PRODUCT_ATTRIBUTES)){const altered=copy(input);altered.cart.lines[0][alias]={value:'changed'};assert.equal(inspectCart(altered).valid,false,alias);}
});
test('legacy fixed grants remain readable but cannot acquire unsigned new selections',()=>{
 const {authority,input}=fixture('photo',3);assert.ok(decodeAuthority(JSON.stringify(authority)));assert.equal(inspectCart(input).valid,true);
 for(const key of ['size_mode','width','height','process','scanning','negatives']){const altered=copy(input);altered.cart.lines[0][key]={value:'forged'};assert.equal(inspectCart(altered).valid,false,key);}
});
test('darkroom file count is exactly zero; upload services cannot use zero or unknown count',()=>{
 for(const kind of ['photo','custom','darkroom'])for(const count of [-1,0,1,1.5,null,'0',10001]){
  const {authority}=fixture(kind),line=authority.grants[0].lines[0];line.file_count=count;line.claims.files=String(count);
  assert.equal(Boolean(decodeAuthority(JSON.stringify(authority))),kind==='darkroom'?count===0:count===1,`${kind}/${count}`);
 }
});
test('custom mode binds both original oriented dimensions to the normalized size',()=>{
 const {authority,input}=fixture('custom');
 for(const change of [c=>c.width='016',c=>c.height='0',c=>c.width='45',c=>c.size='16x21',c=>c.height='1.5',c=>c.size_mode='fixed',c=>c.service='photo',c=>c.height='9007199254740992']){
  const a=copy(authority);change(a.grants[0].lines[0].claims);assert.equal(decodeAuthority(JSON.stringify(a)),null);
 }
 const a=copy(authority);Object.assign(a.grants[0].lines[0].claims,{width:'1',height:'1001',size:'1x1001'});assert.ok(decodeAuthority(JSON.stringify(a)));
 const i=copy(input);i.cart.lines[0].width.value='20';i.cart.lines[0].height.value='16';assert.equal(inspectCart(i).valid,false);
});
test('darkroom conditional scanning, process and negatives survive strict claims validation',()=>{
 const {authority}=fixture('darkroom');
 for(const changes of [{size:'12x16',scanning:'Yes'},{size:'8x10',scanning:''},{process:''},{process:'Black & White'},{negatives:''},{negatives:'Deliver later'},{size_mode:'custom'},{width:'8'}]){
  const a=copy(authority);Object.assign(a.grants[0].lines[0].claims,changes);assert.equal(decodeAuthority(JSON.stringify(a)),null,JSON.stringify(changes));
 }
 const a=copy(authority);Object.assign(a.grants[0].lines[0].claims,{size:'12x16',scanning:'',process:'Black and White',negatives:'Already at Bellows'});assert.ok(decodeAuthority(JSON.stringify(a)));
});
test('extended authority retains lease deadline, binding, buyer and combined-price guards',()=>{
 const {input,authority}=fixture('darkroom');
 for(const change of [i=>i.shop.localTime.beforeDeadline=false,i=>i.cart.binding.value=hex(8),i=>i.cart.lines[0].quantity=3,i=>i.cart.buyerIdentity={isAuthenticated:true,customer:{id:'gid://shopify/Customer/1'}},i=>i.leaseOwner.lease.value=i.leaseOwner.lease.value.replace('12:04:00','12:04:01')]){const i=copy(input);change(i);assert.equal(inspectCart(i).valid,false);}
 const a=copy(authority);a.grants[0].lines[0].unit_cents=100001;const i=copy(input);setAuthority(i,a);assert.equal(inspectCart(i).valid,false);
 const now=Date.parse('2026-10-30T12:00:00Z');assert.throws(()=>leaseDeadline(now,now,'UTC'),/LEASE_WINDOW/);assert.throws(()=>leaseDeadline(now+240001,now,'UTC'),/LEASE_WINDOW/);assert.equal(leaseDeadline(now+240000,now,'UTC').expires_at,now+240000);
});

test('guest email customer association leaves all five Function outputs unchanged without granting account authority',async()=>{
 const functions=await import('../checkout/functions.js');
 const targets=['cartTransformRun','cartValidationsGenerateRun','cartFulfillmentConstraintsGenerateRun','cartDeliveryOptionsTransformRun','cartSpecificationValidationsGenerateRun'];
 for(const [kind,schema] of [['photo',3],['photo',4],['custom',4],['darkroom',4]]){
  const {authority,input}=fixture(kind,schema),expected=targets.map(target=>functions[target](input));
  for(const id of ['gid://shopify/Customer/123','gid://shopify/Customer/456']){
   const guest=copy(input);guest.cart.buyerIdentity={isAuthenticated:false,customer:{id}};
   assert.equal(inspectCart(guest).valid,true,`${kind}/${schema}/guest`);
   for(const [n,target] of targets.entries())assert.deepEqual(functions[target](guest),expected[n],`${kind}/${schema}/${target}`);
   for(const change of [i=>i.cart.binding.value=hex(8),i=>i.shop.localTime.beforeDeadline=false,i=>i.cart.lines[0].message.value='forged',i=>i.cart.lines[0].quantity=3]){
    const altered=copy(guest);change(altered);assert.equal(inspectCart(altered).valid,false);assert.deepEqual(functions.cartTransformRun(altered),{operations:[]});
   }
  }
  for(const authenticated of [true,undefined,null,0,'false',{}]){
   const unknown=copy(input);unknown.cart.buyerIdentity={isAuthenticated:authenticated,customer:{id:'gid://shopify/Customer/123'}};
   assert.equal(inspectCart(unknown).valid,false,`${kind}/${schema}/${authenticated}`);
   assert.deepEqual(functions.cartTransformRun(unknown),{operations:[]});
   assert.equal(functions.cartValidationsGenerateRun(unknown).operations.length,1);
   assert.equal(functions.cartSpecificationValidationsGenerateRun(unknown).operations.length,1);
  }
  const authenticated=copy(input),bound=copy(authority);bound.grants[0].customer_id='gid://shopify/Customer/123';setAuthority(authenticated,bound);
  authenticated.cart.buyerIdentity={isAuthenticated:true,customer:{id:'gid://shopify/Customer/123'}};assert.equal(inspectCart(authenticated).valid,true);
  const deliveryProjection=copy(authenticated);deliveryProjection.cart.buyerIdentity.customer={__typename:'Customer'};assert.equal(inspectCart(deliveryProjection).valid,false);
  for(const buyer of [{isAuthenticated:false,customer:{id:'gid://shopify/Customer/123'}},{isAuthenticated:true,customer:{id:'gid://shopify/Customer/456'}},{isAuthenticated:true,customer:null},{isAuthenticated:null,customer:{id:'gid://shopify/Customer/123'}}]){
   const wrong=copy(authenticated);wrong.cart.buyerIdentity=buyer;assert.equal(inspectCart(wrong).valid,false);
  }
 }
});

test('both validation targets collectively reject every altered selection field',async()=>{
 const {cartSpecificationValidationsGenerateRun}=await import('../checkout/functions.js');
 for(const kind of ['photo','custom','darkroom']){
  const {input}=fixture(kind);
  assert.deepEqual(cartSpecificationValidationsGenerateRun(input),{operations:[]});
  for(const key of Object.keys(FULL_PRODUCT_ATTRIBUTES)){
   const i=copy(input);i.cart.lines[0][key]={value:'tampered'};
   assert.ok(cartValidationsGenerateRun(i).operations.length||cartSpecificationValidationsGenerateRun(i).operations.length,`${kind}/${key}`);
  }
  input.shop.localTime.beforeDeadline=false;assert.ok(cartSpecificationValidationsGenerateRun(input).operations.length);
  input.buyerJourney={step:'CART_INTERACTION'};assert.deepEqual(cartSpecificationValidationsGenerateRun(input),{operations:[]});
 }
});

test('schema4 and schema5 lease publication require the fifth pinned Function owner and exact owner order',async()=>{
 const {leaseOwners,leaseFields}=await import('../checkout/lease.mjs');
 const specificationOwner={id:'gid://shopify/Validation/999',functionId:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'},expected=leaseOwners(specificationOwner);
 assert.equal(expected.length,5);assert.equal(expected.at(-1).handle,'full-product-specification');
 const owners=expected.map(o=>({id:o.id,field:null}));
 for(const schema of [4,5]){
  const value=JSON.stringify(fixture('darkroom',schema).authority);
  assert.equal(leaseFields(owners,value,{specificationOwner}).length,5);
  assert.throws(()=>leaseFields(owners.slice(0,4),value),/SPECIFICATION_OWNER_REQUIRED/);
  assert.throws(()=>leaseFields(owners.toReversed(),value,{specificationOwner}),/FUNCTION_OWNERS_REQUIRED/);
 }
 assert.throws(()=>leaseOwners({...specificationOwner,functionId:expected[0].functionId}),/SPECIFICATION_OWNER_REQUIRED/);
});


test('unverified shipping remains unavailable while native pickup and pricing can work',async()=>{
 const {cartDeliveryOptionsTransformRun}=await import('../checkout/functions.js');
 for(const [kind,eligible] of [['photo',true],['custom',false],['darkroom',false]]){
  const {input,authority}=fixture(kind);input.cart.deliveryGroups=[{cartLines:[{id:input.cart.lines[0].id}],deliveryOptions:[{handle:'pickup',deliveryMethodType:'PICK_UP'},{handle:'ship',deliveryMethodType:'SHIPPING',code:'BFL_SHIPPO_c355361391ae286b9b8d2d4bf6057208a9161b0a5865ac1956d083a9eb46a9c4'}]}];
  assert.deepEqual(cartDeliveryOptionsTransformRun(input).operations,eligible?[]:[{deliveryOptionHide:{deliveryOptionHandle:'ship'}}]);
  for(const value of [undefined,null,'true',1]){const a=copy(authority);a.grants[0].lines[0].shipping_eligible=value;assert.equal(decodeAuthority(JSON.stringify(a)),null);}
 }
});

test('fifth owner verification rejects disabled, missing, duplicate and changed validation identities',async()=>{
 const {leaseOwners,readFunctionOwners}=await import('../checkout/lease.mjs');
 const {APP}=await import('../configuration/schema.mjs');
 const specificationOwner={id:'gid://shopify/Validation/999',functionId:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'},owners=leaseOwners(specificationOwner),connection=nodes=>({nodes,pageInfo:{hasNextPage:false,hasPreviousPage:false}});
 const data={leaseFunctions:connection(owners.map(o=>({id:o.functionId,handle:o.handle,apiVersion:'2026-07',app:{id:APP}})))};
 for(const o of owners){const row={id:o.id,enabled:true,blockOnFailure:true,functionId:o.functionId,shopifyFunction:{id:o.functionId},function:{id:o.functionId},deliveryMethodTypes:['PICK_UP','SHIPPING'],lease:null};if(o.alias==='leaseLab')data[o.alias]=[row];else if(data[o.alias])data[o.alias].nodes.push(row);else data[o.alias]=connection([row]);}
 assert.equal(readFunctionOwners(data,{specificationOwner}).length,5);
 for(const change of [d=>d.leaseValidation.nodes.pop(),d=>d.leaseValidation.nodes[1].enabled=false,d=>d.leaseValidation.nodes[1].blockOnFailure=false,d=>d.leaseValidation.nodes[1].functionId='other',d=>d.leaseValidation.nodes[1]=copy(d.leaseValidation.nodes[0]),d=>d.leaseFunctions.nodes.at(-1).app.id='other']){
  const altered=copy(data);change(altered);assert.throws(()=>readFunctionOwners(altered,{specificationOwner}));
 }
 assert.throws(()=>readFunctionOwners(data),/FUNCTION_OWNER_CHANGED/);
});


test('pickup-only checkout rejects stale shipping and requires unique native pickup at completion',async()=>{
 const {cartSpecificationValidationsGenerateRun:validate}=await import('../checkout/functions.js');
 for(const kind of ['custom','darkroom'])for(const step of ['CHECKOUT_INTERACTION','CHECKOUT_COMPLETION',undefined,'UNKNOWN']){
  const {input}=fixture(kind);input.buyerJourney=step?{step}:undefined;
  const group={cartLines:[{id:input.cart.lines[0].id}],selectedDeliveryOption:{deliveryMethodType:'PICK_UP'}};
  input.cart.deliveryGroups=[group];assert.deepEqual(validate(input),{operations:[]});
  for(const method of ['SHIPPING','LOCAL','PICKUP_POINT','NONE','']){
   group.selectedDeliveryOption={deliveryMethodType:method};assert.equal(validate(input).operations.length,1,`${kind}/${step}/${method}`);
  }
  group.selectedDeliveryOption=null;assert.equal(validate(input).operations.length,step==='CHECKOUT_INTERACTION'?0:1);
  input.cart.deliveryGroups=[];assert.equal(validate(input).operations.length,step==='CHECKOUT_INTERACTION'?0:1);
  group.selectedDeliveryOption={deliveryMethodType:'PICK_UP'};
  input.cart.deliveryGroups=[group,copy(group)];assert.equal(validate(input).operations.length,1);
  input.cart.deliveryGroups=[group];group.cartLines.push(copy(group.cartLines[0]));assert.equal(validate(input).operations.length,1);
  input.buyerJourney={step:'CART_INTERACTION'};input.shop.localTime.beforeDeadline=false;assert.deepEqual(validate(input),{operations:[]});
 }
});
test('mixed delivery group must use pickup if any protected line lacks shipping eligibility',async()=>{
 const {cartSpecificationValidationsGenerateRun:validate}=await import('../checkout/functions.js');
 const {input,authority}=fixture('photo'),other=fixture('darkroom');
 const line=other.input.cart.lines[0],grant=other.authority.grants[0].lines[0];line.id='gid://shopify/CartLine/darkroom';line.job.value='darkroom-job';grant.claims.job='darkroom-job';
 input.cart.lines.push(line);authority.grants[0].lines.push(grant);setAuthority(input,authority);input.buyerJourney={step:'CHECKOUT_COMPLETION'};
 const group={cartLines:input.cart.lines.map(line=>({id:line.id})),selectedDeliveryOption:{deliveryMethodType:'SHIPPING'}};input.cart.deliveryGroups=[group];
 assert.equal(validate(input).operations.length,1);group.selectedDeliveryOption.deliveryMethodType='PICK_UP';assert.deepEqual(validate(input),{operations:[]});
});

test('diagnostic publication arming accepts schema5, schema4 and legacy3, rejects wrong schema and missing fifth owner',async()=>{
 const {createDiagnosticAdminTransport}=await import('../backend/diagnostic-admin.mjs');
 const {APP,CLIENT}=await import('../configuration/schema.mjs');const {SHOP,INSTALLATION}=await import('../backend/config.mjs');
 const config={store:STORE,app:APP,clientId:CLIENT,installation:INSTALLATION,mode:'reconcile-only'};
 const specificationOwner={id:'gid://shopify/Validation/999',functionId:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'};
 const lifecycle={state:()=>({epoch:1,pending:0,operation:null})};
 for(const schema of [3,4,5]){
  const transport=createDiagnosticAdminTransport(config,{lifecycle,eligibility:true,specificationOwner:schema>=4?specificationOwner:null,enabled:true,permit:()=>true});
  transport.arm({value:JSON.stringify(fixture('photo',schema).authority),ticket:{epoch:1,id:'ticket'}},()=>{});
  assert.throws(()=>transport.arm({value:JSON.stringify(fixture('photo',schema).authority),ticket:{epoch:1,id:'other'}},()=>{}),/DIAGNOSTIC_PREPARATION_REQUIRED/);
 }
 const unregistered=createDiagnosticAdminTransport(config,{lifecycle,eligibility:true,enabled:true,permit:()=>true});
 for(const schema of [4,5])assert.throws(()=>unregistered.arm({value:JSON.stringify(fixture('photo',schema).authority),ticket:{epoch:1,id:'missing'}},()=>{}),/DIAGNOSTIC_PREPARATION_REQUIRED/);
 assert.throws(()=>createDiagnosticAdminTransport(config,{lifecycle,eligibility:false,specificationOwner}),/SPECIFICATION_OWNER_REQUIRED/);
});


test('Shopify Unicode JSON roundtrip keeps exact claims and the ASCII-escaped byte budget',async()=>{
 const {serializeAuthority}=await import('../checkout/projector.mjs');
 const {sameAuthorityValue,sameLeaseValue,sameLeaseContext}=await import('../checkout/lease.mjs');
 const {authority,input}=fixture('custom');const claims=authority.grants[0].lines[0].claims;
 claims.borders='Borders (0.5” white)';claims.message='Café 🎞️';
 input.cart.lines[0].borders.value=claims.borders;input.cart.lines[0].message.value=claims.message;
 const escaped=serializeAuthority(authority),literal=JSON.stringify(JSON.parse(escaped));
 assert.notEqual(escaped,literal);assert.deepEqual(decodeAuthority(literal),decodeAuthority(escaped));assert.equal(sameAuthorityValue(literal,escaped),true);
 const lease=leaseEnvelope(escaped),storedLease=JSON.stringify(JSON.parse(lease));input.leaseOwner.lease.value=storedLease;
 assert.equal(sameLeaseValue(storedLease,lease),true);assert.equal(inspectCart(input).valid,true);
 const context=value=>({timezone:'UTC',functionOwners:[{id:'owner',field:{value,compareDigest:'digest',type:'json'}}]});
 assert.equal(sameLeaseContext(context(lease),context(storedLease)),true);
 const changed=context(storedLease);changed.functionOwners[0].field.compareDigest='other';assert.equal(sameLeaseContext(context(lease),changed),false);
 input.cart.lines[0].borders.value='Borders (0.5" white)';assert.equal(inspectCart(input).valid,false);
 assert.equal(sameLeaseValue(storedLease,storedLease.replace('0.5','1.5')),false);
 claims.message='é'.repeat(1000);assert.ok(JSON.stringify(authority).length<6000);assert.equal(decodeAuthority(JSON.stringify(authority)),null);
 const oversized={deadline:authority.lease.deadline,authority};assert.equal(decodeEligibility(JSON.stringify(oversized)),null);
 assert.equal(decodeAuthority(literal+'\n'),null);
 assert.equal(sameAuthorityValue('{','{'),false);assert.equal(sameLeaseValue('{','{'),false);
});


test('a queried null buyer is anonymous while missing or malformed identities remain rejected',async()=>{
 const functions=await import('../checkout/functions.js');
 const targets=['cartTransformRun','cartValidationsGenerateRun','cartFulfillmentConstraintsGenerateRun','cartDeliveryOptionsTransformRun','cartSpecificationValidationsGenerateRun'];
 for(const [kind,schema] of [['photo',3],['photo',4],['custom',4],['darkroom',4]]){
  const {input,authority}=fixture(kind,schema),expected=targets.map(target=>functions[target](input));input.cart.buyerIdentity=null;
  assert.equal(inspectCart(input).valid,true);for(const [i,target] of targets.entries())assert.deepEqual(functions[target](input),expected[i]);
  for(const mutate of [i=>delete i.cart.buyerIdentity,i=>i.cart.buyerIdentity=undefined,i=>i.cart.buyerIdentity={},i=>i.cart.buyerIdentity=[],i=>i.cart.buyerIdentity=0,i=>i.cart.buyerIdentity='false',i=>i.cart.buyerIdentity={isAuthenticated:null},i=>i.cart.buyerIdentity={isAuthenticated:true,customer:null},i=>i.cart.binding.value=hex(8),i=>i.shop.localTime.beforeDeadline=false,i=>i.cart.lines[0].message.value='forged',i=>i.cart.lines[0].quantity=3]){
   const invalid=copy(input);mutate(invalid);assert.equal(inspectCart(invalid).valid,false);assert.deepEqual(functions.cartTransformRun(invalid),{operations:[]});
  }
  const account=copy(authority);account.grants[0].customer_id='gid://shopify/Customer/123';setAuthority(input,account);assert.equal(inspectCart(input).valid,false);
 }
});
test('44 by 60 Custom at 196 dollars per copy permits three copies with a null guest buyer',()=>{
 const {input,authority}=fixture('custom'),grant=authority.grants[0].lines[0],line=input.cart.lines[0];
 Object.assign(grant.claims,{width:'44',height:'60',size:'44x60',lab:'orlando',files:'1'});grant.unit_cents=19600;grant.file_count=1;grant.shipping_eligible=true;
 for(const key of ['width','height','size','lab','files'])line[key].value=grant.claims[key];line.quantity=3;line.signature.value=`v3:${grant.claims.signature}:3`;line.cost.subtotalAmount.amount='588.00';input.cart.buyerIdentity=null;setAuthority(input,authority);
 assert.equal(inspectCart(input).valid,true);assert.equal(cartTransformRun(input).operations[0].lineUpdate.price.adjustment.fixedPricePerUnit.amount,'196.00');assert.deepEqual(cartValidationsGenerateRun(input),{operations:[]});
});


test('schema5 exact lab variants bind all full-product selections and buyer states',async()=>{
 const functions=await import('../checkout/functions.js');
 assert.deepEqual(Object.keys(VARIANTS_BY_LAB).sort(),['atlanta','chicago','miami','orlando']);assert.equal(VARIANTS_BY_LAB.miami,'gid://shopify/ProductVariant/68068335714415');assert.ok(!Object.values(VARIANTS_BY_LAB).includes(VARIANT));
 assert.equal(new Set(Object.values(VARIANTS_BY_LAB)).size,4);assert.equal(variantForLab('__proto__'),null);assert.equal(variantForLab('unknown'),null);
 for(const lab of Object.keys(VARIANTS_BY_LAB))for(const kind of ['photo','custom','darkroom']){
  const {authority,input}=fixture(kind,5,lab),line=authority.grants[0].lines[0];
  assert.equal(decodeAuthority(JSON.stringify(authority)).schema,5);assert.equal(decodeEligibility(input.leaseOwner.lease.value).schema,5);
  assert.equal(line.variant_id,VARIANTS_BY_LAB[lab]);assert.equal(inspectCart(input).valid,true);assert.equal(inspectCart(input).lines[0].physical_count,kind==='darkroom'?null:4);
  for(const buyer of [null,{isAuthenticated:false,customer:null},{isAuthenticated:false,customer:{id:'gid://shopify/Customer/123'}}]){
   const changed=copy(input);changed.cart.buyerIdentity=buyer;assert.equal(inspectCart(changed).valid,true);assert.equal(cartTransformRun(changed).operations.length,1);
  }
  for(const buyer of [{isAuthenticated:true,customer:{id:'gid://shopify/Customer/123'}},{},[],{isAuthenticated:null},undefined]){
   const changed=copy(input);changed.cart.buyerIdentity=buyer;assert.equal(inspectCart(changed).valid,false);
  }
  for(const key of Object.keys(FULL_PRODUCT_ATTRIBUTES)){
   const changed=copy(input);changed.cart.lines[0][key]={value:'forged'};assert.equal(inspectCart(changed).valid,false,`${lab}/${kind}/${key}`);
   assert.ok(functions.cartValidationsGenerateRun(changed).operations.length||functions.cartSpecificationValidationsGenerateRun(changed).operations.length);
  }
 }
});
test('schema5 wrong-lab or missing signed variants fail while schemas3/4 preserve their historical variant contract',()=>{
 for(const lab of Object.keys(VARIANTS_BY_LAB)){
  const {authority,input}=fixture('custom',5,lab),other=Object.values(VARIANTS_BY_LAB).find(v=>v!==VARIANTS_BY_LAB[lab]);
  for(const variant of [undefined,null,123,'67852705202287','gid://shopify/ProductVariant/999',other]){
   const a=copy(authority);a.grants[0].lines[0].variant_id=variant;assert.equal(decodeAuthority(JSON.stringify(a)),null,`${lab}/${variant}`);
  }
  for(const mutate of [i=>i.cart.lines[0].merchandise.id=other,i=>i.cart.lines[0].merchandise.product.id='gid://shopify/Product/999',i=>i.cart.lines[0].quantity=3,i=>i.cart.lines[0].signature.value='forged',i=>i.shop.localTime.beforeDeadline=false,i=>i.cart.binding.value=hex(8)]){
   const changed=copy(input);mutate(changed);assert.equal(inspectCart(changed).valid,false);assert.deepEqual(cartTransformRun(changed),{operations:[]});
  }
  const unknown=copy(authority);unknown.grants[0].lines[0].claims.lab='unknown';assert.equal(decodeAuthority(JSON.stringify(unknown)),null);
  for(const schema of [3,4]){
   const old=fixture('photo',schema,lab);assert.equal(inspectCart(old.input).valid,true);
   old.authority.grants[0].lines[0].variant_id=VARIANTS_BY_LAB[lab];assert.equal(decodeAuthority(JSON.stringify(old.authority)),null);
   old.input.cart.lines[0].merchandise.id=Object.values(VARIANTS_BY_LAB).find(v=>v!==VARIANT);assert.equal(inspectCart(old.input).valid,false);
  }
 }
});
test('schema5 mixed labs preserve separate lines, quantities, prices, and singleton fulfillment origins',async()=>{
 const functions=await import('../checkout/functions.js');
 const {authority,input}=fixture('photo',5,'miami');authority.grants[0].lines=[];input.cart.lines=[];input.cart.deliverableLines=[];input.cart.deliveryGroups=[];
 const cases=[['miami','photo',100,2],['chicago','custom',19600,3],['orlando','darkroom',6000,2]];
 for(const [index,[lab,kind,price,quantity]] of cases.entries()){
  const f=fixture(kind,5,lab),approved=f.authority.grants[0].lines[0],line=f.input.cart.lines[0];
  approved.claims.job=`mixed-${lab}`;approved.unit_cents=price;approved.shipping_eligible=true;approved.location_id=`gid://shopify/Location/${index+1}`;
  line.id=`gid://shopify/CartLine/mixed-${lab}`;line.quantity=quantity;line.job.value=approved.claims.job;line.signature.value=`v3:${approved.claims.signature}:${quantity}`;line.cost.subtotalAmount.amount=(price*quantity/100).toFixed(2);
  authority.grants[0].lines.push(approved);input.cart.lines.push(line);input.cart.deliverableLines.push({id:`gid://shopify/DeliverableCartLine/${lab}`,job:{value:approved.claims.job}});
  input.cart.deliveryGroups.push({cartLines:[{id:line.id}],selectedDeliveryOption:{deliveryMethodType:'SHIPPING'},deliveryOptions:[{handle:`shipping-${lab}`,deliveryMethodType:'SHIPPING',code:'BFL_SHIPPO_c355361391ae286b9b8d2d4bf6057208a9161b0a5865ac1956d083a9eb46a9c4'}]});
 }
 setAuthority(input,authority);input.cart.buyerIdentity=null;assert.equal(inspectCart(input).valid,true);
 assert.deepEqual(cartTransformRun(input).operations.map(op=>op.lineUpdate.price.adjustment.fixedPricePerUnit.amount),['1.00','196.00','60.00']);
 assert.deepEqual(functions.cartFulfillmentConstraintsGenerateRun(input).operations,cases.map(([lab],index)=>({deliverableLinesMustFulfillFromAdd:{deliverableLineIds:[`gid://shopify/DeliverableCartLine/${lab}`],locationIds:[`gid://shopify/Location/${index+1}`]}})));
 for(const target of ['cartValidationsGenerateRun','cartSpecificationValidationsGenerateRun','cartDeliveryOptionsTransformRun'])assert.deepEqual(functions[target](input),{operations:[]});
 const swapped=copy(input);[swapped.cart.lines[0].merchandise.id,swapped.cart.lines[1].merchandise.id]=[swapped.cart.lines[1].merchandise.id,swapped.cart.lines[0].merchandise.id];assert.equal(inspectCart(swapped).valid,false);
 const account=copy(authority);account.grants[0].customer_id='gid://shopify/Customer/123';setAuthority(input,account);
 assert.equal(inspectCart(input).valid,false);input.cart.buyerIdentity={isAuthenticated:true,customer:{id:'gid://shopify/Customer/123'}};assert.equal(inspectCart(input).valid,true);
 input.cart.buyerIdentity.customer.id='gid://shopify/Customer/456';assert.equal(inspectCart(input).valid,false);
});
