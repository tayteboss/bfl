// Generated offline inputs only. Never publish these authorities or leases.
import assert from 'node:assert/strict';
import {scenario} from '../f06p-candidate/synthetic.mjs';
import {ATTRIBUTES,MAX_BYTES,PRODUCT,VARIANT,inspectCart} from '../../../apps/film-printing-staging/checkout/authority.js';
const ascii=v=>JSON.stringify(v).replace(/[\u007f-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
const service='BFL_SHIPPO_c355361391ae286b9b8d2d4bf6057208a9161b0a5865ac1956d083a9eb46a9c4';
const envelope=i=>JSON.parse(i.leaseOwner.lease.value);
const editEnvelope=(i,change)=>{const e=envelope(i);change(e);i.leaseOwner.lease.value=ascii(e);};
const editAuthority=(i,change)=>editEnvelope(i,e=>change(e.authority));
function upgrade(source){
 const i=structuredClone(source),a=JSON.parse(i.shop.authority.value);
 a.schema=3;a.lease={token:'e'.repeat(64),deadline:'2026-10-21T12:04:00',expires_at:1792598640000};
 a.grants.forEach(g=>g.lines.forEach(l=>delete l.quantity));
 i.leaseOwner={lease:{value:ascii({deadline:a.lease.deadline,authority:a})}};i.shop={localTime:{beforeDeadline:true}};
 i.cart.lines.forEach(l=>l.signature.value='v3:'+l.signature.value+':'+l.quantity);return i;
}
const ordinary=n=>({id:'gid://shopify/CartLine/ordinary-'+n,quantity:1,merchandise:{id:'gid://shopify/ProductVariant/999',product:{id:'gid://shopify/Product/999'}},sellingPlanAllocation:null,cost:{amountPerQuantity:{currencyCode:'USD'},subtotalAmount:{amount:'1.00'}}});
const target=l=>l.merchandise?.id===VARIANT||l.merchandise?.product?.id===PRODUCT||Boolean(l.flow?.value);
function quantity(i,n){const l=i.cart.lines[0],a=envelope(i).authority,g=a.grants.find(g=>g.binding===i.cart.binding.value),v=g.lines.find(v=>v.claims.job===l.job.value);l.quantity=n;l.signature.value='v3:'+v.claims.signature+':'+n;l.cost.subtotalAmount.amount=(v.unit_cents*n/100).toFixed(2);}
export async function buildCases(){
 const sources=[];
 try{
  for(const options of [{},{count:8},{customer:'gid://shopify/Customer/123'}])sources.push(await scenario(options));
  const [single,multiple,customer]=sources.map(s=>upgrade(s.input)),cases=[],modes=new Map();
  function add(name,source=single,change=()=>{},mode='allow'){
   assert.ok(!modes.has(name));const i=structuredClone(source);change(i);cases.push([name,i]);modes.set(name,mode);assert.equal(inspectCart(i).valid,mode!=='deny',name+' source eligibility');
  }
  add('valid');add('eight-jobs',multiple);add('customer',customer);
  add('v3-subset',multiple,i=>{i.cart.lines=i.cart.lines.slice(0,1);i.cart.deliverableLines=i.cart.deliverableLines.slice(0,1);i.cart.deliveryGroups[0].cartLines=i.cart.deliveryGroups[0].cartLines.slice(0,1);});
  add('v3-remove-all',multiple,i=>{i.cart.lines=[];i.cart.deliverableLines=[];i.cart.deliveryGroups=[];});add('v3-reordered',multiple,i=>i.cart.lines.reverse());
  add('v3-replacement-id',single,i=>{i.cart.lines[0].id='gid://shopify/CartLine/new';i.cart.deliveryGroups[0].cartLines[0].id=i.cart.lines[0].id;});
  add('v3-target-local-deliverable',single,i=>i.cart.deliverableLines[0].id='gid://shopify/DeliverableCartLine/new');
  for(const n of [1,5,1666])add('v3-quantity-'+n,single,i=>quantity(i,n));
  for(const n of [0,-1,1667,10001])add('v3-quantity-denied-'+n,single,i=>quantity(i,n),'deny');
  add('v3-quantity-10000',single,i=>{editAuthority(i,a=>a.grants[0].lines[0].unit_cents=1);quantity(i,10000);});
  add('v3-quantity-roundtrip',single,i=>{quantity(i,9);quantity(i,4);});add('v3-quantity-stale-wrapper',single,i=>i.cart.lines[0].quantity=5,'deny');
  for(const suffix of ['04','+4','4.0','4e0',' 4','4 ','5','0','-4','10001'])add('v3-wrapper-'+JSON.stringify(suffix),single,i=>{i.cart.lines[0].signature.value='v3:'+envelope(i).authority.grants[0].lines[0].claims.signature+':'+suffix;},'deny');
  add('v3-wrapper-raw',single,i=>i.cart.lines[0].signature.value=envelope(i).authority.grants[0].lines[0].claims.signature,'deny');
  for(const name of ['v3-deadline-equality','v3-deadline-past'])add(name,single,i=>i.shop.localTime.beforeDeadline=false,'deny');
  add('v3-deadline-mismatch',single,i=>editEnvelope(i,e=>e.deadline='2026-10-21T12:05:00'),'deny');
  add('v3-deadline-missing',single,i=>editEnvelope(i,e=>delete e.deadline),'deny');add('v3-deadline-null',single,i=>editEnvelope(i,e=>e.deadline=null),'deny');
  add('v3-envelope-extra',single,i=>editEnvelope(i,e=>e.extra=true),'deny');add('v3-owner-field-absent',single,i=>i.leaseOwner.lease=null,'deny');
  add('v3-empty-grants',single,i=>editAuthority(i,a=>a.grants=[]),'deny');
  add('v3-expired-sentinel',single,i=>{const a=JSON.parse(sources[0].input.shop.authority.value);a.grants=[];i.leaseOwner.lease.value=ascii({deadline:'1970-01-01T00:00:00',authority:a});i.shop.localTime.beforeDeadline=false;},'deny');
  add('v3-legacy-authority',single,i=>i.leaseOwner.lease.value=ascii({deadline:'2026-10-21T12:04:00',authority:JSON.parse(sources[0].input.shop.authority.value)}),'deny');
  for(const [name,raw] of Object.entries({malformed:'not-json',truncated:'{"deadline":',array:'[]',number:'42',empty:'',oversize:' '.repeat(MAX_BYTES+129),deep:'['.repeat(200)+'0'+']'.repeat(200),unicode:'{"deadline":"é"}'}))add('v3-envelope-'+name,single,i=>i.leaseOwner.lease.value=raw,'deny');
  for(const alias of Object.keys(ATTRIBUTES))for(const missing of [false,true])add('v3-claim-'+alias+(missing?'-missing':'-changed'),single,i=>i.cart.lines[0][alias]=missing?null:{value:'forged'},missing&&!single.cart.lines[0][alias]?.value?'allow':'deny');
  for(const [name,change] of Object.entries({binding:i=>i.cart.binding={value:'f'.repeat(64)},'binding-missing':i=>i.cart.binding=null,'binding-format':i=>i.cart.binding={value:'bad'},'duplicate-id':i=>i.cart.lines.push(structuredClone(i.cart.lines[0])),
   'duplicate-job':i=>{const l=structuredClone(i.cart.lines[0]);l.id='gid://shopify/CartLine/duplicate';i.cart.lines.push(l);},'unknown-job':i=>i.cart.lines[0].job.value='unknown',
   'wrong-variant':i=>i.cart.lines[0].merchandise.id='gid://shopify/ProductVariant/9','wrong-product':i=>i.cart.lines[0].merchandise.product.id='gid://shopify/Product/9',currency:i=>i.cart.lines[0].cost.amountPerQuantity.currencyCode='AUD',
   'selling-plan':i=>i.cart.lines[0].sellingPlanAllocation={__typename:'SellingPlanAllocation'},'line-id':i=>i.cart.lines[0].id='bad','guest-now-customer':i=>i.cart.buyerIdentity={isAuthenticated:true,customer:{id:'gid://shopify/Customer/123'}}}))add('v3-'+name,single,change,'deny');
  for(const [name,buyer] of Object.entries({wrong:{isAuthenticated:true,customer:{id:'gid://shopify/Customer/456'}},logout:{isAuthenticated:false,customer:null},absent:null}))add('v3-customer-'+name,customer,i=>i.cart.buyerIdentity=buyer,'deny');
  const changes={schema:a=>a.schema=4,store:a=>a.store='wrong.myshopify.com',hash:a=>a.config_sha256='f'.repeat(64),'root-extra':a=>a.extra=true,'grant-extra':a=>a.grants[0].extra=true,'line-extra':a=>a.grants[0].lines[0].extra=true,'claims-extra':a=>a.grants[0].lines[0].claims.extra='x',
   owner:a=>a.grants[0].owner='bad',cart:a=>a.grants[0].cart='bad',customer:a=>a.grants[0].customer_id='bad',binding:a=>a.grants[0].binding='bad',generation:a=>a.grants[0].generation=0,epoch:a=>a.grants[0].epoch=-1,'duplicate-grant':a=>a.grants.push(structuredClone(a.grants[0])),
   'price-zero':a=>a.grants[0].lines[0].unit_cents=0,'price-fractional':a=>a.grants[0].lines[0].unit_cents=1.5,'price-overflow':a=>a.grants[0].lines[0].unit_cents=200001,'files-zero':a=>a.grants[0].lines[0].file_count=0,'files-mismatch':a=>a.grants[0].lines[0].claims.files='2',
   location:a=>a.grants[0].lines[0].location_id='bad',revision:a=>a.grants[0].lines[0].claims.revision='bad',signature:a=>a.grants[0].lines[0].claims.signature='bad','config-cutover':a=>{a.config_sha256='b'.repeat(64);a.config_version='f03-'+a.config_sha256.slice(0,24);},
   date:a=>a.valid_on='bad',service:a=>a.grants[0].lines[0].claims.service='darkroom',size:a=>a.grants[0].lines[0].claims.size='1.x2','message-length':a=>a.grants[0].lines[0].claims.message='x'.repeat(2001),'message-type':a=>a.grants[0].lines[0].claims.message=23,
   'null-grant':a=>a.grants=[null],'null-line':a=>a.grants[0].lines=[null],'null-claims':a=>a.grants[0].lines[0].claims=null,'lease-token':a=>a.lease.token='bad','lease-deadline':a=>a.lease.deadline='bad','lease-expiry':a=>a.lease.expires_at=0,'lease-extra':a=>a.lease.extra=true};
  for(const [name,change] of Object.entries(changes))add('v3-authority-'+name,single,i=>editAuthority(i,change),'deny');
  const a=envelope(single).authority;
  for(const [part,keys] of [['root',Object.keys(a)],['grant',Object.keys(a.grants[0])],['line',Object.keys(a.grants[0].lines[0])],['lease',Object.keys(a.lease)],['claims',Object.keys(ATTRIBUTES)]])for(const key of keys)add('v3-missing-'+part+'-'+key,single,i=>editAuthority(i,a=>{const obj={root:a,grant:a.grants[0],line:a.grants[0].lines[0],lease:a.lease,claims:a.grants[0].lines[0].claims}[part];delete obj[key];}),'deny');
  add('v3-aggregate-ceiling',multiple,i=>editAuthority(i,a=>a.grants[0].lines.forEach(l=>l.unit_cents=30000)),'deny');
  add('v3-unicode-exact',single,i=>{i.cart.lines[0].message.value='Print ✓ café 📷';editAuthority(i,a=>a.grants[0].lines[0].claims.message=i.cart.lines[0].message.value);});
  add('v3-price-stale',single,i=>i.cart.lines[0].cost.subtotalAmount.amount='1.00','price');
  for(const value of ['-4.80','4.8e0','4.800','999999999999999999999'])add('v3-subtotal-'+value,single,i=>i.cart.lines[0].cost.subtotalAmount.amount=value,'price');
  add('v3-lab-map-absent',single,i=>i.cart.deliverableLines=[],'mapping');add('v3-lab-map-duplicate',single,i=>i.cart.deliverableLines.push(structuredClone(i.cart.deliverableLines[0])),'mapping');
  add('v3-cart-removal-allowed',single,i=>{i.leaseOwner.lease=null;i.buyerJourney.step='CART_INTERACTION';},'deny');
  add('v3-checkout-interaction-denied',single,i=>{i.leaseOwner.lease=null;i.buyerJourney.step='CHECKOUT_INTERACTION';},'deny');
  const boundary=structuredClone(multiple);for(let n=0;n<12;n++)boundary.cart.lines.push(ordinary(n));add('20-line-boundary',boundary);
  add('6000-byte-20-line-boundary',boundary,i=>{const e=envelope(i),pad='x'.repeat(MAX_BYTES-ascii(e.authority).length);e.authority.grants[0].lines[0].claims.message+=pad;i.cart.lines[0].message.value+=pad;i.leaseOwner.lease.value=ascii(e);assert.equal(ascii(e.authority).length,MAX_BYTES);});
  add('v3-authority-6001-bytes',boundary,i=>{const e=envelope(i),pad='x'.repeat(MAX_BYTES+1-ascii(e.authority).length);e.authority.grants[0].lines[0].claims.message+=pad;i.cart.lines[0].message.value+=pad;i.leaseOwner.lease.value=ascii(e);},'deny');
  add('21-line-denied',boundary,i=>i.cart.lines.push(ordinary(12)),'deny');
  const large=structuredClone(multiple);for(let n=0;n<192;n++)large.cart.lines.push(ordinary(n));add('200-line-cart-denied',large,()=>{},'deny');add('200-target-last',large,i=>i.cart.lines.reverse(),'deny');
  const unrelated=structuredClone(single);unrelated.cart.lines=Array.from({length:200},(_,n)=>ordinary(n));unrelated.cart.deliverableLines=[];unrelated.cart.deliveryGroups=[];
  add('200-unrelated-200-groups',unrelated,i=>{i.leaseOwner.lease=null;i.cart.deliveryGroups=i.cart.lines.map(l=>({cartLines:[{id:l.id,merchandise:l.merchandise}],deliveryOptions:[{handle:'s',deliveryMethodType:'SHIPPING'}]}));});
  add('near-128k-valid-mixed',boundary);add('near-128k-unrelated',unrelated);add('near-128k-denied-target-last',large,i=>i.cart.lines.reverse(),'deny');
  add('v3-test-service-valid',single,i=>i.cart.deliveryGroups[0].deliveryOptions=[{handle:'test',deliveryMethodType:'SHIPPING',code:service}]);
  add('v3-test-service-expired',single,i=>{i.shop.localTime.beforeDeadline=false;i.cart.deliveryGroups[0].deliveryOptions=[{handle:'test',deliveryMethodType:'SHIPPING',code:service}];},'deny');
  add('v3-send-rolls-only',unrelated,i=>{i.cart.lines=i.cart.lines.slice(0,2);i.cart.lines[0]._return_shipping_required={value:'true'};i.cart.lines[1]._role={value:'return_shipping'};i.leaseOwner.lease=null;});
  return {cases,close(){sources.forEach(s=>s.store.close());},assertOutput(caseName,name,input,output){
   if(caseName==='historical-f06a-golden')return;
   const mode=modes.get(caseName);assert.ok(mode,caseName);const selected=input.cart.lines.filter(target),deliveryCustomer=name==='delivery'&&input.cart.buyerIdentity?.customer!=null,allowed=mode!=='deny'&&!deliveryCustomer;
   const count=selected.length,expected=name==='pricing'?(allowed?count:0):name==='lab'?(allowed&&mode!=='mapping'?count:0):name==='validation'?(input.buyerJourney?.step==='CART_INTERACTION'||allowed&&!['price','mapping'].includes(mode)?0:count?1:0):null;
   if(expected!==null)assert.equal(output.operations.length,expected,caseName+'/'+name+' contract');
   else{const ids=new Set(selected.map(l=>l.id)),hide=[];for(const g of input.cart.deliveryGroups)if(g.cartLines.some(l=>ids.has(l.id)))for(const o of g.deliveryOptions)if(!(allowed&&(o.deliveryMethodType==='PICK_UP'||o.deliveryMethodType==='SHIPPING'&&o.code===service)))hide.push({deliveryOptionHide:{deliveryOptionHandle:o.handle}});assert.deepEqual(output.operations,hide,caseName+'/delivery contract');}
  }};
 }catch(error){sources.forEach(s=>s.store.close());throw error;}
}
