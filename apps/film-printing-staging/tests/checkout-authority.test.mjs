import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {scenario,replaceAuthority} from '../../../fixtures/film-printing/f06p-candidate/synthetic.mjs';
import {ATTRIBUTES,decodeAuthority,inspectCart,MAX_BYTES,VARIANT,PRODUCT} from '../checkout/authority.js';
import {serializeAuthority,revokeAuthority,emptyAuthority} from '../checkout/projector.mjs';
import {createAuthorityAdmin,authorityCutoverField} from '../checkout/shopify.mjs';
import {cartTransformRun as price,cartValidationsGenerateRun as validate,cartFulfillmentConstraintsGenerateRun as lab,cartDeliveryOptionsTransformRun as delivery} from '../checkout/functions.js';
import {APP} from '../configuration/schema.mjs';
const copy=structuredClone;
async function fixture(t,options){const s=await scenario(options);t.after(()=>s.store.close());return s;}
function blocked(input) {
 assert.equal(inspectCart(input).valid,false);
 assert.deepEqual(price(input),{operations:[]});
 assert.equal(validate(input).operations[0].validationAdd.errors.length,input.cart.lines.filter(l=>l.merchandise?.id===VARIANT||l.flow).length);
 assert.deepEqual(lab(input),{operations:[]});
 assert.equal(delivery(input).operations.length,3);
}
test('V2 synthetic completed files x current copies price once, route native pickup, shipping stays unavailable',async t=>{
 const s=await fixture(t);assert.equal(s.prepared.checkout_ready,false);assert.equal(s.preparations[0].checkout_ready,false);
 assert.equal(inspectCart(s.input).lines[0].physical_count,12);
 assert.equal(price(s.input).operations[0].lineUpdate.price.adjustment.fixedPricePerUnit.amount,'1.20');
 assert.deepEqual(validate(s.input),{operations:[]});
 assert.deepEqual(lab(s.input).operations[0].deliverableLinesMustFulfillFromAdd,{deliverableLineIds:['gid://shopify/DeliverableCartLine/offline-0'],locationIds:['gid://shopify/Location/92443803759']});
 assert.deepEqual(delivery(s.input).operations.map(o=>o.deliveryOptionHide.deliveryOptionHandle),['flat','carrier']);
});
test('V2 forged, tampered, missing, truncated, oversized or unavailable authority fails closed',async t=>{
 const {input}=await fixture(t);
 for(const raw of [null,'','{}','not-json',' '.repeat(MAX_BYTES+1),'[]']){const i=copy(input);i.shop.authority=raw===null?null:{value:raw};blocked(i);}
 for(const change of [a=>a.schema=3,a=>a.store='production.myshopify.com',a=>a.config_sha256='a'.repeat(64),a=>a.grants=[],a=>a.grants[0].lines[0].unit_cents=0,a=>a.grants[0].lines[0].quantity=1.5]){const i=copy(input);replaceAuthority(i,change);blocked(i);}
 // An apparently valid browser payload cannot become the shop metafield.
 const i=copy(input);i.cart.authority=i.shop.authority;i.shop.authority=null;blocked(i);
});
test('V2 every queried immutable claim and current quantity is enforced; browser price is ignored',async t=>{
 const {input}=await fixture(t);
 for(const alias of Object.keys(ATTRIBUTES)){const i=copy(input);i.cart.lines[0][alias]={value:'forged'};blocked(i);}
 for(const quantity of [0,-1,1.5,5,10001]){const i=copy(input);i.cart.lines[0].quantity=quantity;blocked(i);}
 const i=copy(input);i.cart.lines[0]._custom_price_cents='1';assert.equal(price(i).operations[0].lineUpdate.price.adjustment.fixedPricePerUnit.amount,'1.20');
});
test('V2 replay to another cart, duplicate job/line, wrong product/variant, currency and selling plan reject',async t=>{
 const {input}=await fixture(t);
 for(const change of [i=>i.cart.binding.value='b'.repeat(64),i=>i.cart.lines.push(copy(i.cart.lines[0])),i=>i.cart.lines[0].merchandise.id='gid://shopify/ProductVariant/9',i=>i.cart.lines[0].merchandise.product.id='gid://shopify/Product/9',i=>i.cart.lines[0].cost.amountPerQuantity.currencyCode='AUD',i=>i.cart.lines[0].sellingPlanAllocation={sellingPlan:{id:'x'}}]){const i=copy(input);change(i);blocked(i);}
 const i=copy(input);replaceAuthority(i,a=>a.grants.push(copy(a.grants[0])));blocked(i);
});
test('V2 day expiry, future projection, revocation and config cutover reject old references',async t=>{
 const {input}=await fixture(t);
 for(const date of ['2026-10-20','2026-10-22',null]){const i=copy(input);i.shop.localTime.date=date;blocked(i);}
 const i=copy(input);i.shop.authority.value=revokeAuthority(i.shop.authority.value,{jobId:i.cart.lines[0].job.value});blocked(i);
 const j=copy(input);replaceAuthority(j,a=>{a.config_sha256='b'.repeat(64);a.config_version='f03-'+a.config_sha256.slice(0,24);});blocked(j);
});
test('V2 authenticated customer checks identity AND login; guest has no fabricated Function owner',async t=>{
 const s=await fixture(t,{customer:'gid://shopify/Customer/123'});assert.equal(inspectCart(s.input).valid,true);
 for(const buyer of [null,{isAuthenticated:false,customer:{id:'gid://shopify/Customer/123'}},{isAuthenticated:true,customer:{id:'gid://shopify/Customer/456'}}]){const i=copy(s.input);i.cart.buyerIdentity=buyer;blocked(i);}
 const guest=await fixture(t);guest.input.cart.buyerIdentity={isAuthenticated:true,customer:{id:'gid://shopify/Customer/123'}};blocked(guest.input);
});
test('V2 unique same-variant jobs work; changed subset requires new whole-cart authority',async t=>{
 const {input}=await fixture(t,{count:2});assert.equal(price(input).operations.length,2);assert.equal(lab(input).operations.length,2);assert.deepEqual(validate(input),{operations:[]});
 input.cart.lines.pop();blocked(input);
});
test('V2 missing pricing or missing/ambiguous deliverable mapping cannot pass validation',async t=>{
 const {input}=await fixture(t);
 for(const change of [i=>i.cart.lines[0].cost.subtotalAmount.amount='1.00',i=>i.cart.lines[0].cost.subtotalAmount.amount='NaN',i=>i.cart.deliverableLines=[],i=>i.cart.deliverableLines.push(copy(i.cart.deliverableLines[0]))]){const i=copy(input);change(i);assert.equal(validate(i).operations.length,1);}
});
test('V2 native Send Rolls/unrelated carts pass through even if authority is unavailable',async t=>{
 const {input}=await fixture(t);input.shop.authority=null;input.cart.lines=[{id:'other',quantity:1,merchandise:{id:'gid://shopify/ProductVariant/999',product:{id:'gid://shopify/Product/999'}}}];input.cart.deliverableLines=[];input.cart.deliveryGroups[0].cartLines=[{id:'other'}];
 for(const fn of [price,validate,lab,delivery])assert.deepEqual(fn(input),{operations:[]});
});
test('V2 projector reuses F05 signature/owner/assets and refuses stale catalog, wrong lab/cart/spec',async t=>{
 const s=await fixture(t);
 for(const change of [()=>s.cart.owner='foreign-owner',()=>s.cart.lines[0].reference.signature='0'.repeat(64),()=>s.cart.complete=false,()=>s.cart.lines[0].properties.Location='wrong',()=>s.cart.lines[0].variant_id='gid://shopify/ProductVariant/9',()=>s.catalog.version='old',()=>s.catalog.rows[0].per_file_cents=1]) {
  const cart=copy(s.cart),catalog=copy(s.catalog);change();await assert.rejects(s.projector.prepare({}));Object.assign(s.cart,cart);Object.assign(s.catalog,catalog);
 }
 s.store.recordUpload(s.cart.owner,{id:'asset-0001',state:'removed'});await assert.rejects(s.projector.prepare({}),/AUTHORITY_PENDING/);
});
test('V2 current-copy reauthorization replaces prior grant and invalidates old copies without mutating job',async t=>{
 const s=await fixture(t);s.context.field={value:s.prepared.value};s.cart.lines[0].quantity=5;
 const updated=await s.projector.prepare({copies:999});assert.equal(updated.authority.grants.length,1);assert.equal(updated.authority.grants[0].lines[0].quantity,5);assert.equal(updated.authority.grants[0].lines[0].unit_cents,120);
 s.input.shop.authority.value=updated.value;blocked(s.input);s.input.cart.lines[0].quantity=5;s.input.cart.lines[0].cost.subtotalAmount.amount='6.00';assert.deepEqual(validate(s.input),{operations:[]});
 assert.equal((await s.jobs.resolve(s.cart.owner,s.preparations[0].reference)).copies,4);
});
test('V2 bounded registry rejects overflow; unicode serializes without changing exact claims',async t=>{
 const s=await fixture(t);const a=copy(s.prepared.authority);a.grants[0].lines[0].claims.message='✓';const raw=serializeAuthority(a);assert.ok(raw.includes('\\u2713'));assert.equal(decodeAuthority(raw).grants[0].lines[0].claims.message,'✓');
 a.grants[0].lines[0].claims.message='x'.repeat(9001);assert.equal(decodeAuthority(serializeAuthority(a)),null);
 s.context.field={value:s.prepared.value};s.cart.id='gid://shopify/Cart/another';await assert.rejects(s.projector.prepare({}),/INVALID_AUTHORITY/); // same job cannot be reissued into another grant
});

async function adminFixture(t) {
 const s=await fixture(t);const catalogRaw=JSON.stringify(s.catalog);const priceVersion='price-'+createHash('sha256').update(catalogRaw).digest('hex');
 const a=copy(s.prepared.authority);a.price_version=priceVersion;
 const field={value:serializeAuthority(a),type:'json',compareDigest:'authority-digest',namespace:`app--${APP.split('/').pop()}--bfl-checkout`,key:'authority',definition:{ownerType:'SHOP',type:{name:'json'},access:{admin:'MERCHANT_READ',storefront:'NONE'}}};
 const data={shop:{id:'gid://shopify/Shop/123',myshopifyDomain:a.store,ianaTimezone:'America/New_York',authority:field},currentAppInstallation:{id:'gid://shopify/AppInstallation/123',app:{id:APP},active:{type:'json',value:JSON.stringify(s.release),compareDigest:'config-digest'},catalog:{type:'json',value:catalogRaw,compareDigest:'catalog-digest'},fence:{type:'single_line_text_field',value:'00000000-0000-0000-0000-000000000001',compareDigest:'fence-digest'}}};
 let writes=0,lastFields,reject=false,corrupt=false;
 const api=async(query,variables)=>{if(query.includes('mutation')){writes++;lastFields=variables.fields;if(reject)return {metafieldsSet:{userErrors:[{code:'STALE_OBJECT'}]}};data.shop.authority.value=corrupt?'{}':variables.fields[0].value;data.currentAppInstallation.fence.value=variables.fields.find(f=>f.key==='authority_fence').value;return {metafieldsSet:{userErrors:[]}};}return copy(data);};
 const admin=createAuthorityAdmin(api,{writesEnabled:true,lifecycle:s.store.lifecycle,now:()=>new Date('2026-10-21T12:00:00Z')});
 const context=await admin.read();const ticket=s.store.lifecycle.beginPreparation();s.store.lifecycle.stage(ticket,serializeAuthority(a));const prepared={context,ticket,value:serializeAuthority(a)};
 return {s,data,admin,api,prepared,get writes(){return writes;},get fields(){return lastFields;},set reject(v){reject=v;},set corrupt(v){corrupt=v;}};
}
test('V2 Admin adapter checks identity/access, defaults disabled, uses atomic source+authority CAS and readback',async t=>{
 const f=await adminFixture(t);await assert.rejects(createAuthorityAdmin(f.api).publish(f.prepared),/WRITES_DISABLED/);assert.equal(f.writes,0);
 assert.deepEqual(await f.admin.publish(f.prepared),{published:true,checkout_ready:false});assert.equal(f.writes,1);assert.equal(f.fields.length,4);assert.deepEqual(f.fields.map(v=>v.compareDigest),['authority-digest','config-digest','fence-digest','catalog-digest']);
 f.data.shop.authority.definition.access.storefront='PUBLIC_READ';await assert.rejects(f.admin.read(),/UNPROTECTED/);
 f.data.shop.myshopifyDomain='production.myshopify.com';await assert.rejects(f.admin.read(),/WRONG_TARGET/);
});
test('V2 stale writes, permission drift, write errors, readback changes and missing sources never acknowledge readiness',async t=>{
 for(const kind of ['stale','write-error','readback','catalog-missing','permissions']) {
  const f=await adminFixture(t);
  if(kind==='stale')f.data.currentAppInstallation.active.compareDigest='changed';
  if(kind==='write-error')f.reject=true;
  if(kind==='readback')f.corrupt=true;
  if(kind==='catalog-missing')f.data.currentAppInstallation.catalog=null;
  if(kind==='permissions')f.data.shop.authority.definition.access.admin='MERCHANT_READ_WRITE';
  await assert.rejects(f.admin.publish(f.prepared));
 }
});
test('V2 config/catalog cutover field clears grants in the same planned atomic write',async t=>{
 const f=await adminFixture(t);const c=f.prepared.context;const empty=serializeAuthority(emptyAuthority(c.release,c.catalog,c.shopDate));
 const field=authorityCutoverField(c,empty);assert.equal(field.compareDigest,'authority-digest');assert.deepEqual(JSON.parse(field.value).grants,[]);
 assert.throws(()=>authorityCutoverField(c,f.prepared.value));
});

test('V2 cart edits can bootstrap/recover; every checkout stage remains closed without authority',async t=>{
 const {input}=await fixture(t);input.shop.authority=null;
 input.buyerJourney.step='CART_INTERACTION';assert.deepEqual(validate(input),{operations:[]});assert.deepEqual(price(input),{operations:[]});
 for(const step of ['CHECKOUT_INTERACTION','CHECKOUT_COMPLETION',null,'unknown']){input.buyerJourney.step=step;assert.equal(validate(input).operations.length,1);}
});
test('V2 source unavailable and changed config cannot produce authority',async t=>{
 const {active}=await import('../../../fixtures/film-printing/f04/synthetic.mjs');
 const s=await fixture(t);s.context.release=active;await assert.rejects(s.projector.prepare({}),/VERSION_MISMATCH/);
 s.context.release=s.release;s.context.catalog=null;await assert.rejects(s.projector.prepare({}));
 const {createCheckoutProjector}=await import('../checkout/projector.mjs');
 const unavailable=createCheckoutProjector({jobs:s.jobs,resolveCart:async()=>s.cart,loadContext:async()=>{throw Error('offline');}});await assert.rejects(unavailable.prepare({}),/offline/);
});
test('V2 prior cart owner changes require explicit revoke; no inherited owner authorization',async t=>{
 const s=await fixture(t);const a=copy(s.prepared.authority);a.grants[0].owner='b'.repeat(64);s.context.field={value:serializeAuthority(a)};
 await assert.rejects(s.projector.prepare({}),/CART_OWNER_CHANGED/);
});
test('V2 aggregate price ceiling and duplicate jobs cannot be bypassed by splitting lines',async t=>{
 const s=await fixture(t,{count:2});const a=copy(s.prepared.authority);
 a.grants[0].lines.forEach(l=>{l.unit_cents=30000;l.quantity=4;});assert.equal(decodeAuthority(serializeAuthority(a)),null);
 const b=copy(s.prepared.authority);b.grants[0].lines[1].claims.job=b.grants[0].lines[0].claims.job;assert.equal(decodeAuthority(serializeAuthority(b)),null);
});

test('V2 oversized mixed carts are denied at checkout; unrelated carts remain logically untouched',async t=>{
 const {input}=await fixture(t);const ordinary={id:'other',quantity:1,merchandise:{id:'gid://shopify/ProductVariant/999',product:{id:'gid://shopify/Product/999'}}};
 for(let i=0;i<20;i++)input.cart.lines.push({...ordinary,id:`other-${i}`});
 assert.equal(inspectCart(input).valid,false);assert.deepEqual(price(input),{operations:[]});assert.equal(validate(input).operations.length,1);
 input.cart.lines.shift();assert.deepEqual(validate(input),{operations:[]});
});
