import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createFilmPrintingForm} from '../theme/film-printing-form.js';
const cartSource=readFileSync(new URL('../../../assets/cart.js',import.meta.url),'utf8');
const KEY='bfl:accepted-cart-session:v1',TOKEN='bflr1_'+'a'.repeat(43);
function rig(t,{state='accepted',operation=null,expired=false,error=new TypeError('Failed to fetch'),wait,changeError,storageOverride,hook}={}){
 const previous=globalThis.location;globalThis.location={origin:'https://bellows-film-printing-staging.myshopify.com'};t.after(()=>{globalThis.location=previous;});
 const now=1000000,initial={state,token:TOKEN,expires:expired?now-1:now+60000,generation:1,prepared_generation:2,operation};let saved=JSON.stringify(initial),initializes=0,owned=0,resolved=0,renders=0,failed=false,busy=false;
 const storage=storageOverride??{getItem:()=>saved,setItem:(_key,value)=>{saved=value;}},requests=[],calls=[],pageError={textContent:''},drawerError={textContent:''};
 const form=Object.assign(new EventTarget(),{dataset:{filmPrintingForm:''},querySelector:()=>null,querySelectorAll:()=>[],bflSelectionComplete:()=>false});
 const owner=createFilmPrintingForm(form,{sessionOptions:{now:()=>now,reloadStorage:storage,preparedMode:true,fetchImpl:()=>assert.fail('no new owner/request')},checkoutForSession:session=>({
  mode:'prepared-unit-v3',prepare:async()=>assert.fail('no preparation'),cancelPreparation:async()=>assert.fail('no cancellation'),addPrepared:async()=>assert.fail('no Add'),
  async initialize(input){initializes++;calls.push(input);if(wait)await wait;session.assertLive();await hook?.(session);if(error)throw error;return {cart:{items:[]}};},
  resolveCartItem(){resolved++;return {properties:{_bfl_flow:'f05',_bfl_job:'existing-job'}};},
  async change(){owned++;if(changeError)throw changeError;return {accepted:true,cart:{items:[]},render:{}};},
 })});
 const initialization=owner.issue(),formFlow=globalThis.BFLPrintJob.forForm(form);initialization.catch(()=>{});
 const definitions=new Map(),row={dataset:{bflFlow:'f05'},querySelector:selector=>selector.startsWith('cart-remove-button')?{dataset:{key:'protected-key'}}:{dataset:{index:'1'}}};
 const drawer={getAttribute:()=>busy?'true':null,classList:{contains:()=>failed},setPending(value,detail={}){busy=value;failed=!!detail.failed;drawerError.textContent=failed?detail.message:'';}};
 const context=vm.createContext({HTMLElement:class{},customElements:{define:(name,type)=>definitions.set(name,type),get:name=>definitions.get(name)},console,
  window:{location:{pathname:'/products/f00-film-printing-test'},routes:{cart_url:'/cart',cart_change_url:'/cart/change.js'},BFLPrintJob:globalThis.BFLPrintJob},
  document:{querySelector:selector=>selector==='[data-film-printing-form]'?form:selector==='cart-drawer'?drawer:null,getElementById:id=>id==='cart-errors'?pageError:drawerError},
  routes:{cart_change_url:'/cart/change.js'},fetchConfig:()=>({method:'POST'}),publish(){},PUB_SUB_EVENTS:{cartUpdate:'cart'},
  fetch:async(url,options={})=>{requests.push({url,options});const result=options.method?{items:[]}:{items:[{key:'protected-key',properties:{_bfl_flow:'f05',_bfl_job:'existing-job'},quantity:2}]};return {ok:true,json:async()=>result};}});
 vm.runInContext(cartSource,context);const cart=Object.create(definitions.get('cart-items').prototype);
 Object.assign(cart,{querySelectorAll:()=>[row],querySelector:()=>({}),closest:()=>drawer,getSectionsToRender:()=>[],enableLoading(){},disableLoading(){},refreshSections(){renders++;},async refreshOwnedCart(){renders++;}});
 return {owner,formFlow,initialization,cart,requests,calls,initial,storage,get saved(){return JSON.parse(storage.getItem(KEY));},get initializes(){return initializes;},get owned(){return owned;},get resolved(){return resolved;},get renders(){return renders;},get failed(){return failed;}};
}
for(const [name,options] of [['transport',{}],['closed',{error:Object.assign(Error('RESOURCE_UNAVAILABLE'),{reason:'DIAGNOSTIC_CLOSED'})}],['expired',{expired:true}]])test(`actual product form ${name} accepted restoration permits exact native removal`,async t=>{
 const f=rig(t,options);assert.equal(typeof f.formFlow.ready.then,'function');await assert.rejects(f.initialization);await assert.rejects(f.formFlow.ready,error=>error.acceptedCartReadOnly===true&&!error.cartUncertain);
 const before=f.saved;await f.cart.removeByKey('protected-key');const writes=f.requests.filter(r=>r.options.method);assert.equal(writes.length,1);assert.equal(JSON.parse(writes[0].options.body).id,'protected-key');assert.equal(JSON.parse(writes[0].options.body).quantity,0);assert.equal(f.owned,0);assert.equal(f.resolved,0);assert.deepEqual(f.saved,before);assert.equal(f.renders,1);
});
test('product cart controls wait for the original in-flight initialization before changing a signed line',async t=>{
 let release;const wait=new Promise(resolve=>{release=resolve;}),f=rig(t,{wait,error:null});const change=f.cart.removeByKey('protected-key');await new Promise(setImmediate);assert.equal(f.owned,0);assert.equal(f.requests.length,0);release();await Promise.all([f.initialization,change]);assert.equal(f.initializes,1);assert.equal(f.owned,1);assert.equal(f.requests.length,0);assert.equal(f.renders,1);
});
for(const kind of ['add','change','remove','cancel_preparation'])for(const expired of [false,true])test(`product pending ${kind}${expired?' expired':''} never obtains native fallback`,async t=>{
 const f=rig(t,{state:'pending',operation:{kind,operation_id:'original',job:'existing-job',quantity:kind==='remove'?0:1},expired});await assert.rejects(f.initialization);
 await assert.rejects(f.formFlow.ready,error=>error.cartUncertain===true&&error.acceptedCartReadOnly!==true);await f.cart.removeByKey('protected-key');assert.equal(f.requests.length,0);assert.equal(f.owned,0);assert.equal(f.failed,true);
});
for(const [label,options] of [['prepared',{state:'prepared',operation:{kind:'prepared',operation_id:'original',job:'existing-job',generation:2}}],['accepted operation',{operation:{kind:'add',operation_id:'original',job:'existing-job',quantity:1}}],['uncertain accepted',{error:Object.assign(new TypeError('unknown'),{cartUncertain:true})}]])test(`${label} form restoration is not classified accepted read-only`,async t=>{
 const f=rig(t,options);await assert.rejects(f.initialization);await assert.rejects(f.formFlow.ready,error=>error.acceptedCartReadOnly!==true);await f.cart.removeByKey('protected-key');assert.equal(f.requests.length,0);assert.equal(f.owned,0);
});
test('a product-page owned dispatch failure never falls through to native removal',async t=>{
 const f=rig(t,{error:null,changeError:Object.assign(new TypeError('response lost'),{cartUncertain:true})});await f.initialization;await f.cart.removeByKey('protected-key');await f.cart.removeByKey('protected-key');assert.equal(f.owned,1);assert.equal(f.requests.length,0);assert.equal(f.failed,true);
});
test('cart readiness classification does not mutate the original caller error',async t=>{
 const original=new TypeError('original read failure'),f=rig(t,{error:original});await assert.rejects(f.initialization,error=>error===original);await assert.rejects(f.formFlow.ready,error=>error!==original&&error.acceptedCartReadOnly===true);assert.equal(original.acceptedCartReadOnly,undefined);assert.equal(original.cartUncertain,undefined);
});

for(const [label,options] of [['closed',{error:Object.assign(Error('RESOURCE_UNAVAILABLE'),{reason:'DIAGNOSTIC_CLOSED'})}],['expired',{expired:true}]])test(`three product reloads after ${label} retain exact original accepted custody and removal`,async t=>{
 let storage,original;for(let i=0;i<3;i++){const f=rig(t,{...options,storageOverride:storage});storage=f.storage;original??=storage.getItem(KEY);await assert.rejects(f.initialization);await assert.rejects(f.formFlow.ready,error=>error.acceptedCartReadOnly===true&&!error.cartUncertain);assert.equal(storage.getItem(KEY),original);await f.cart.removeByKey('protected-key');assert.equal(f.requests.filter(r=>r.options.method).length,1);assert.equal(f.owned,0);assert.equal(storage.getItem(KEY),original);}
});
for(const kind of ['add','change','remove','cancel_preparation'])for(const expired of [false,true])test(`repeated ${expired?'expired':'closed'} pending ${kind} product reload never discards or replays the operation`,async t=>{
 const operation=kind==='cancel_preparation'?{kind,operation_id:'original',job:'existing-job',generation:2}:{kind,operation_id:'original',job:'existing-job',quantity:kind==='remove'?0:1};
 let storage,original;for(let i=0;i<3;i++){const f=rig(t,{state:'pending',operation,expired,error:Object.assign(Error('RESOURCE_UNAVAILABLE'),{reason:'DIAGNOSTIC_CLOSED'}),storageOverride:storage});storage=f.storage;original??=storage.getItem(KEY);await assert.rejects(f.initialization);await assert.rejects(f.formFlow.ready,error=>error.cartUncertain===true&&error.acceptedCartReadOnly!==true);assert.equal(storage.getItem(KEY),original);await f.cart.removeByKey('protected-key');assert.equal(f.requests.length,0);assert.equal(f.owned,0);assert.equal(storage.getItem(KEY),original);}
});
for(const action of ['mutation','generation','revoke'])test(`intervening ${action} custody cannot be overwritten or obtain native removal provenance`,async t=>{
 const op={kind:'change',operation_id:'new-operation',job:'existing-job',quantity:3};
 const f=rig(t,{error:Object.assign(Error('RESOURCE_UNAVAILABLE'),{reason:'DIAGNOSTIC_CLOSED'}),hook:async session=>{if(action==='mutation')session.beginMutation(op);if(action==='generation')session.rememberPreparationGeneration(3);if(action==='revoke')await session.revoke().catch(()=>{});}});
 await assert.rejects(f.initialization);await assert.rejects(f.formFlow.ready,error=>error.cartUncertain===true&&error.acceptedCartReadOnly!==true);assert.equal(f.saved.state,'pending');if(action==='mutation')assert.deepEqual(f.saved.operation,op);if(action==='generation')assert.equal(f.saved.prepared_generation,3);
 const saved=f.storage.getItem(KEY);await f.cart.removeByKey('protected-key');assert.equal(f.requests.length,0);assert.equal(f.owned,0);assert.equal(f.storage.getItem(KEY),saved);
});
test('an intervening new pending operation supersedes the original pending receipt',async t=>{
 const old={kind:'add',operation_id:'old-add',job:'existing-job',quantity:1},newer={kind:'remove',operation_id:'new-remove',job:'existing-job',quantity:0};
 const f=rig(t,{state:'pending',operation:old,hook:session=>session.beginMutation(newer)});await assert.rejects(f.initialization);await assert.rejects(f.formFlow.ready,error=>error.cartUncertain===true);assert.deepEqual(f.saved.operation,newer);await f.cart.removeByKey('protected-key');assert.equal(f.requests.length,0);assert.deepEqual(f.saved.operation,newer);
});
