import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {STORE,PRODUCT,VARIANT,VARIANTS_BY_LAB,FULL_PRODUCT_ATTRIBUTES,displayClaims,claimValuesMatch,inspectCart,decodeAuthority} from '../checkout/authority.js';
import {jobProperties} from '../jobs/properties.mjs';
import {jobClaims} from '../checkout/job-eligibility.mjs';
import {leaseEnvelope} from '../checkout/lease.mjs';
import {expandFullProductCatalog} from '../pricing/compact-catalog.mjs';
import * as functions from '../checkout/functions.js';
const hex=n=>String(n).repeat(64),services={photo:'Photo Prints',fine_art:'Fine Arts',darkroom:'Darkroom Prints'},aliases=Object.keys(FULL_PRODUCT_ATTRIBUTES);
function fixture(kind='custom',{schema=5,lab='chicago',paper=kind==='darkroom'?'rc-matte':kind==='photo'?'photo-premium-luster':'fibre-paper',width=20,height=16}={}){
 const job={id:'display-job',revision:hex(1),config_version:'f03-'+hex(2).slice(0,24),service:kind==='custom'?'fine_art':kind==='fixed'?'fine_art':kind,size:kind==='custom'?[width,height].sort((a,b)=>a-b).join('x'):kind==='darkroom'?'12x16':kind==='fixed'?'16x20':'4x6',paper,lab,message:'Café 🎞️ — “print”',
  size_mode:kind==='custom'?'custom':'fixed',custom_dimensions:kind==='custom'?{width,height}:null,copies:2,completed_asset_ids:kind==='darkroom'?[]:['display-asset'],
  options:{Turnaround:'Standard (4-5 days)',...(kind!=='photo'?{Borders:'Borders (0.5” white)'}:{}),...(kind==='darkroom'?{Process:'Color',Negatives:'Mail In'}:{})},variant_id:(schema===5?VARIANTS_BY_LAB[lab]:VARIANT).split('/').at(-1)};
 const ref={id:job.id,revision:job.revision,config_version:job.config_version,signature:hex(3)},claims=jobClaims(job,ref,{full:true});
 const authority={schema,store:STORE,config_version:job.config_version,config_sha256:hex(2),price_version:'display-test',valid_on:'2026-10-30',lease:{token:hex(4),deadline:'2026-10-30T12:04:00',expires_at:1793361840000},grants:[{cart:hex(5),owner:hex(6),customer_id:null,binding:hex(7),generation:1,epoch:1,lines:[{unit_cents:2600,file_count:job.completed_asset_ids.length,shipping_eligible:true,...(schema===5?{variant_id:VARIANTS_BY_LAB[lab]}:{}),location_id:'gid://shopify/Location/1',claims}]}]};
 const props=jobProperties(job,ref),line={id:'gid://shopify/CartLine/display',quantity:2,merchandise:{id:'gid://shopify/ProductVariant/'+job.variant_id,product:{id:PRODUCT}},sellingPlanAllocation:null,cost:{amountPerQuantity:{currencyCode:'USD'},subtotalAmount:{amount:'52.00'}},...Object.fromEntries(aliases.map(alias=>[alias,{value:alias==='signature'?`v3:${ref.signature}:2`:props[FULL_PRODUCT_ATTRIBUTES[alias]]??''}]))};
 const input={buyerJourney:{step:'CHECKOUT_INTERACTION'},leaseOwner:{lease:{value:leaseEnvelope(JSON.stringify(authority))}},shop:{localTime:{beforeDeadline:true}},cart:{binding:{value:hex(7)},buyerIdentity:null,lines:[line],deliverableLines:[{id:'gid://shopify/DeliverableCartLine/display',job:{value:job.id}}],deliveryGroups:[{cartLines:[{id:line.id}],selectedDeliveryOption:{deliveryMethodType:'PICK_UP'},deliveryOptions:[{deliveryMethodType:'PICK_UP',handle:'pickup'}]}]}};
 return {job,ref,claims,props,authority,input};
}
const canonicalInput=f=>{const input=structuredClone(f.input);for(const key of aliases)input.cart.lines[0][key]={value:key==='signature'?`v3:${f.ref.signature}:2`:f.claims[key]};return input;};
for(const lab of Object.keys(VARIANTS_BY_LAB))for(const kind of ['photo','fixed','custom','darkroom'])test(`${lab}/${kind} customer labels preserve canonical jobs, signatures and all five Function outputs`,()=>{
 const f=fixture(kind,{lab}),before=JSON.stringify(f.job),canonical=canonicalInput(f);
 assert.ok(decodeAuthority(JSON.stringify(f.authority)));assert.equal(inspectCart(f.input).valid,true);assert.equal(inspectCart(canonical).valid,true);
 assert.equal(f.props.Service,services[f.job.service]);assert.equal(f.props.Location,lab[0].toUpperCase()+lab.slice(1));
 assert.equal(f.props.Sizes,kind==='custom'?'20" × 16" (Custom)':f.job.size.split('x').map(v=>v+'”').join(' × '));
 assert.equal(JSON.stringify(f.job),before);assert.deepEqual(jobClaims(f.job,f.ref,{full:true}),f.claims);assert.equal(f.props._bfl_signature,f.ref.signature);
 assert.deepEqual(Object.keys(f.props),Object.keys(jobProperties(f.job,f.ref,{canonical:true})),'no new visible/private properties');
 for(const fn of Object.values(functions))assert.deepEqual(fn(f.input),fn(canonical));
 for(const key of aliases){const bad=structuredClone(f.input);bad.cart.lines[0][key].value+=' altered';assert.equal(inspectCart(bad).valid,false,key);assert.ok(functions.cartValidationsGenerateRun(bad).operations.length||functions.cartSpecificationValidationsGenerateRun(bad).operations.length,key);}
});
test('all source-derived fixed and custom paper/location labels are exact and fully covered',()=>{
 const catalog=expandFullProductCatalog(JSON.parse(readFileSync(new URL('../../../fixtures/film-printing/full-product-lab-routing-20261030/engineering-catalog-proposal.json',import.meta.url))));
 for(const row of catalog.rows){const claims={service:row.service,size:row.size,paper:row.paper,lab:row.lab,size_mode:'fixed'},labels=displayClaims(claims);assert.ok(labels);assert.equal(labels.lab,row.lab_input);assert.equal(labels.paper,row.paper_input??'premium luster paper');assert.equal(labels.service,services[row.service]);}
 for(const row of catalog.custom_rules){const labels=displayClaims({...row,size:'16x20',width:'20',height:'16'});assert.equal(labels.paper,row.paper_input);assert.equal(labels.lab,row.lab_input);assert.equal(labels.size,'20" × 16" (Custom)');}
});
test('partial canonical/human mixtures reject without case/space/Unicode normalization',()=>{
 const f=fixture();for(const key of ['service','size','paper','lab']){
  const human=structuredClone(f.input);human.cart.lines[0][key].value=f.claims[key];assert.equal(inspectCart(human).valid,false,key);
  const old=canonicalInput(f);old.cart.lines[0][key].value=f.props[FULL_PRODUCT_ATTRIBUTES[key]];assert.equal(inspectCart(old).valid,false,key);
 }
 for(const [key,value] of [['service','fine arts'],['paper','Fibre paper'],['lab','Chicago '],['size','16" × 20" (Custom)'],['size','20” × 16” (Custom)'],['borders','Borders (0.5" white)'],['message','Café 🎞️ — “print”']]){const changed=structuredClone(f.input);changed.cart.lines[0][key].value=value;assert.equal(inspectCart(changed).valid,false,`${key}/${value}`);}
});
test('fixed and Custom remain distinct even with the same canonical normalized dimensions',()=>{
 const custom=fixture(),fixed=fixture('fixed');assert.equal(custom.claims.size,fixed.claims.size);assert.notEqual(custom.props.Sizes,fixed.props.Sizes);
 for(const [f,size] of [[custom,fixed.props.Sizes],[fixed,custom.props.Sizes]]){f.input.cart.lines[0].size.value=size;assert.equal(inspectCart(f.input).valid,false);}
 const portrait=fixture('custom',{width:16,height:20});assert.equal(portrait.props.Sizes,'16" × 20" (Custom)');assert.equal(inspectCart(portrait.input).valid,true);
});
test('schema4 historical contracts retain canonical properties and reject new display labels',()=>{
 const old=fixture('custom',{schema:4}),modern=fixture();assert.equal(old.props.Service,'fine_art');assert.equal(old.props.Sizes,'16x20');assert.equal(inspectCart(old.input).valid,true);
 for(const key of ['service','size','paper','lab'])old.input.cart.lines[0][key]=modern.input.cart.lines[0][key];assert.equal(inspectCart(old.input).valid,false);
});
test('display labels do not weaken binding, identity, quantity, expiry, variant or price guards',()=>{
 const f=fixture();for(const change of [i=>i.shop.localTime.beforeDeadline=false,i=>i.cart.binding.value=hex(8),i=>i.cart.lines[0].quantity=3,i=>i.cart.lines[0].merchandise.id=VARIANTS_BY_LAB.orlando,i=>i.cart.buyerIdentity={isAuthenticated:true,customer:{id:'gid://shopify/Customer/1'}}]){const input=structuredClone(f.input);change(input);assert.equal(inspectCart(input).valid,false);assert.deepEqual(functions.cartTransformRun(input),{operations:[]});}
 const price=structuredClone(f.input);price.cart.lines[0].cost.subtotalAmount.amount='2.00';assert.equal(functions.cartValidationsGenerateRun(price).operations.length,1);
});
test('unmapped display identifiers cannot acquire aliases and canonical comparisons remain exact',()=>{
 const claims=fixture().claims;for(const [key,value] of [['service','constructor'],['paper','toString'],['lab','__proto__']]){const altered={...claims,[key]:value};assert.equal(displayClaims(altered),null);assert.equal(claimValuesMatch(k=>displayClaims(claims)[k],altered,aliases,{display:true}),false);}
});

test('historical canonical and new human lines coexist under the same schema5 authority',()=>{
 const old=fixture('photo',{lab:'miami'}),fresh=fixture('custom',{lab:'chicago'});
 const input=canonicalInput(old),authority=structuredClone(old.authority),line=structuredClone(fresh.input.cart.lines[0]),claim=structuredClone(fresh.authority.grants[0].lines[0]);
 claim.claims.job='new-display-job';line.job.value=claim.claims.job;line.id='gid://shopify/CartLine/new-display';authority.grants[0].lines.push(claim);input.cart.lines.push(line);
 input.leaseOwner.lease.value=leaseEnvelope(JSON.stringify(authority));
 assert.equal(inspectCart(input).valid,true);assert.equal(functions.cartTransformRun(input).operations.length,2);
 input.cart.lines[1].lab.value='chicago';assert.equal(inspectCart(input).valid,false);
});
