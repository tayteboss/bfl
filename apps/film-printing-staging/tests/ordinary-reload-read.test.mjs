import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {mountCustomerCart} from '../theme/customer-form.js';
const jobSource=readFileSync(new URL('../theme/film-printing-job.js',import.meta.url),'utf8');
const cartSource=readFileSync(new URL('../../../assets/cart.js',import.meta.url),'utf8');
const ORIGIN='https://bellows-film-printing-staging.myshopify.com';
const CART='gid://shopify/Cart/ordinary-reload-test?key=private-test';
const KEY='bfl:accepted-cart-session:v1',TOKEN='bflr1_'+'a'.repeat(43),OPAQUE='b'.repeat(43);
const money=amount=>({amount,currencyCode:'USD'});
function rig(t,{state='accepted',operation=null,marked='',nativeFlow='',error=null}={}){
 const old={location:globalThis.location,document:globalThis.document,BFLPrintJob:globalThis.BFLPrintJob};
 t.after(()=>Object.assign(globalThis,old));
 globalThis.location={origin:ORIGIN,hostname:new URL(ORIGIN).hostname};
 let saved=JSON.stringify({state,operation,token:TOKEN,expires:Date.now()+60000,generation:1,prepared_generation:2});
 const storage={getItem:()=>saved,setItem:(_key,value)=>{saved=value;}};
 const reads=[],writes=[],pending=[],errors={textContent:''};let rendered=0,failed=false;
 const native={id:CART,lines:[{id:'ordinary-native-line',quantity:2,cost:{totalAmount:money('5.00')}}],totalQuantity:2,cost:{totalAmount:money('5.00')}};
 const response=value=>({ok:true,redirected:false,json:async()=>structuredClone(value)});
 const fetchImpl=async(url,options={})=>{
  const path=new URL(url,ORIGIN).pathname;reads.push(path);
  if(path==='/resource-proof/challenge'){
   assert.equal(options.headers.Authorization,`Bearer ${TOKEN}`);
   return response({challenge:OPAQUE,verifier:OPAQUE,purpose:'bfl:resource-fresh-proof:v1',audience:ORIGIN+'/bfl-application-resources',action:'cart-capability',expires_in:30});
  }
  if(path==='/apps/bfl-staging/resource-proof')return response({ticket:OPAQUE});
  if(path==='/checkout/resume'){
   assert.equal(JSON.parse(options.body).cart_id,CART);
   if(error)throw error;
   return response({resumed:true,expires_at:Date.now()+30000,cart_verified:false,checkout_ready:false,
    items:[{id:'ordinary-native-line',variant_id:'ordinary-variant',quantity:2,properties:{},subtotal_cents:500}]});
  }
  assert.fail(`unexpected print request ${path}`);
 };
 globalThis.document={querySelector:()=>({getSectionsToRender:()=>[{section:'cart-drawer'}],refreshOwnedCart:async()=>assert.fail('ordinary item must not become a signed print job')})};
 vm.runInThisContext(jobSource);
 const flow=mountCustomerCart({until:Date.now()+120000,sessionOptions:{reloadStorage:storage,fetchImpl},checkoutOptions:{fetchImpl,actions:{getCart:async()=>({cart:structuredClone(native)})}}});
 const definitions=new Map(),drawer={getAttribute:()=>null,classList:{contains:()=>failed},setPending:(value,detail={})=>{if(!value)failed=!!detail.failed;pending.push({value,...detail});}};
 const context=vm.createContext({HTMLElement:class{},customElements:{define:(name,value)=>definitions.set(name,value),get:name=>definitions.get(name)},console,
  window:{location:{pathname:'/products/ordinary-test'},routes:{cart_url:'/cart',cart_change_url:'/cart/change.js'},BFLPrintJob:{forForm:()=>undefined,forCart:()=>flow}},
  document:{querySelector:selector=>selector==='cart-drawer'?drawer:null,getElementById:()=>errors},routes:{cart_change_url:'/cart/change.js'},
  fetchConfig:()=>({method:'POST'}),publish(){},PUB_SUB_EVENTS:{cartUpdate:'cart'},
  fetch:async(url,options={})=>{if(options.method)writes.push({url,body:JSON.parse(options.body)});const cart=options.method?{items:[],item_count:0,total_price:0}:{items:[{key:'ordinary-key',quantity:2,properties:nativeFlow?{_bfl_flow:nativeFlow,_bfl_job:'original-print-job'}:{}}]};return {ok:true,json:async()=>cart,text:async()=>JSON.stringify(cart)};},
 });
 vm.runInContext(cartSource,context);const target=Object.create(definitions.get('cart-items').prototype);
 const row={dataset:marked===undefined?{}:{bflFlow:marked},querySelector:selector=>selector.startsWith('cart-remove-button')?{dataset:{key:'ordinary-key'}}:{dataset:{index:'1'}}};
 Object.assign(target,{querySelectorAll:()=>[row],querySelector:()=>marked==='f05'?{}:null,closest:()=>drawer,getSectionsToRender:()=>[],enableLoading(){},disableLoading(){},refreshSections(){rendered++;}});
 return {flow,target,reads,writes,errors,pending,get rendered(){return rendered;},get saved(){return JSON.parse(saved);}};
}
for(const action of ['remove','quantity'])test(`ordinary-only successful server resume permits one native ${action} after local signed-record rejection`,async t=>{
 const f=rig(t);let error;await assert.rejects(f.flow.ready,value=>(error=value,true));
 assert.equal(error.message,'CHECKOUT_UNAVAILABLE');assert.equal(error.acceptedCartReadOnly,true);assert.notEqual(error.cartUncertain,true);
 assert.equal(f.reads.filter(path=>path==='/checkout/resume').length,1);
 if(action==='remove')await f.target.removeByKey('ordinary-key');
 else {await f.target.updateQuantityByIndex('1',3,'updates[]','ordinary-variant');await new Promise(setImmediate);}
 assert.equal(f.writes.length,1);assert.equal(f.writes[0].url,'/cart/change.js');assert.equal(f.writes[0].body.quantity,action==='remove'?0:3);
 assert.equal(f.rendered,1);assert.equal(f.errors.textContent,'');assert.equal(f.pending.at(-1).failed,false);
 assert.ok(!f.reads.some(path=>/\/(issue|renew|bind|install|publish|jobs|eligible)$/.test(path)));
});
for(const kind of ['add','change','remove'])test(`saved pending ${kind} never receives accepted-read provenance or ordinary fallback`,async t=>{
 const f=rig(t,{state:'pending',operation:{operation_id:'dispatched',kind,job:'print-job',quantity:kind==='remove'?0:1}});
 await assert.rejects(f.flow.ready,error=>error.cartUncertain===true&&error.acceptedCartReadOnly!==true);
 await f.target.removeByKey('ordinary-key');assert.equal(f.writes.length,0);assert.equal(f.saved.operation.kind,kind);assert.equal(f.pending.at(-1).failed,true);
});
for(const [label,options] of [
 ['prepared',{state:'prepared',operation:{operation_id:'held',kind:'prepared',job:'print-job',generation:2}}],
 ['accepted with an operation',{operation:{operation_id:'dispatched',kind:'add',job:'print-job',quantity:1}}],
 ['already uncertain',{error:Object.assign(Error('unknown write'),{cartUncertain:true})}],
])test(`${label} does not receive the accepted-read label`,async t=>{
 const f=rig(t,options);await assert.rejects(f.flow.ready,error=>error.acceptedCartReadOnly!==true);
 await f.target.removeByKey('ordinary-key');assert.equal(f.writes.length,0);
});
for(const marked of ['f05','unknown'])test(`accepted-read provenance cannot remove a ${marked} target that differs from the native cart`,async t=>{
 const f=rig(t,{marked});await assert.rejects(f.flow.ready,error=>error.acceptedCartReadOnly===true);
 await f.target.removeByKey('ordinary-key');assert.equal(f.writes.length,0);assert.equal(f.pending.at(-1).failed,marked==='unknown');
});

test('accepted transport failure allows exact native protected removal without issuing or mutating owner custody',async t=>{
 const f=rig(t,{marked:'f05',nativeFlow:'f05',error:new TypeError('Failed to fetch')});
 await assert.rejects(f.flow.ready,error=>error.acceptedCartReadOnly===true&&!error.cartUncertain);const before=f.saved;
 await f.target.removeByKey('ordinary-key');assert.equal(f.writes.length,1);assert.equal(f.writes[0].body.id,'ordinary-key');assert.equal(f.writes[0].body.quantity,0);assert.deepEqual(f.saved,before);
 assert.ok(!f.reads.some(path=>/\/(issue|renew|bind|install|publish|jobs|eligible)$/.test(path)));assert.equal(f.pending.at(-1).failed,false);
});
