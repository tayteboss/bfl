import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {mountCustomerCart} from '../theme/customer-form.js';
const jobSource=readFileSync(new URL('../theme/film-printing-job.js',import.meta.url),'utf8');
const cartSource=readFileSync(new URL('../../../assets/cart.js',import.meta.url),'utf8');
const method=cartSource.slice(cartSource.indexOf('  async changeOwnedCart('),cartSource.indexOf('  async refreshOwnedCart('));
const key='bfl:accepted-cart-session:v1';
function fixture(t,{state='accepted',expires=Date.now()+60000,record=true,operation=null}={}){
 const previous={location:globalThis.location,document:globalThis.document,BFLPrintJob:globalThis.BFLPrintJob};t.after(()=>Object.assign(globalThis,previous));
 globalThis.location={origin:'https://bellows-film-printing-staging.myshopify.com',hostname:'bellows-film-printing-staging.myshopify.com'};
 let saved=record?JSON.stringify({state,token:'bflr1_'+'a'.repeat(43),expires,generation:1,prepared_generation:2,operation}):null,requests=0,writes=0,renders=0,initializes=0,options,received;
 const storage={getItem:()=>saved,setItem:(_key,value)=>{saved=value;writes++;}};
 const item={properties:{_bfl_flow:'f05',_bfl_job:'existing-job'}};
 const items={getSectionsToRender:()=>[{section:'main-items'},{section:'main-footer'},{section:'cart-drawer'}],refreshOwnedCart:async()=>{renders++;}};
 globalThis.document={querySelector:()=>items};vm.runInThisContext(jobSource);
 const checkoutForSession=(session,o)=>{options=o;return {mode:'prepared-unit-v3',initialize:async input=>{initializes++;received=input;session.assertLive();session.checkpoint();return {cart:{items:[item]},render:{sections:{}}};},change:async input=>({accepted:true,input}),resolveCartItem:()=>item};};
 const mount=()=>mountCustomerCart({until:Date.now()+120000,sessionOptions:{reloadStorage:storage,fetchImpl:()=>{requests++;throw Error('no issuance or network fallback');}},checkoutForSession});
 return {mount,storage,get saved(){return saved;},get requests(){return requests;},get writes(){return writes;},get renders(){return renders;},get initializes(){return initializes;},get options(){return options;},get received(){return received;}};
}
test('cart-only page restores original accepted receipt and every mounted cart section without issuing or renewing',async t=>{
 const f=fixture(t),before=JSON.parse(f.saved),flow=f.mount();assert.equal(globalThis.BFLPrintJob.forCart(),flow);
 await flow.ready;assert.deepEqual(f.received,{resume:true,recovery:null});assert.equal(f.initializes,1);assert.equal(f.renders,1);assert.equal(f.requests,0);
 assert.deepEqual(f.options.sectionIds(),['main-items','main-footer','cart-drawer']);
 const after=JSON.parse(f.saved);for(const k of ['token','expires','generation','prepared_generation'])assert.equal(after[k],before[k]);
 assert.equal((await flow.changeCart({job:'existing-job',quantity:0})).accepted,true);
});
test('cart-only page leaves absent, closed, empty-form and unfinished-upload custody untouched',async t=>{
 for(const state of ['initialized','uploads','blocked',null]){
  const f=fixture(t,{state,record:state!==null}),before=f.saved;assert.equal(f.mount(),null);
  assert.equal(f.saved,before);assert.equal(f.writes,0);assert.equal(f.requests,0);assert.equal(f.initializes,0);
 }
});
test('expired accepted receipt rejects without a replacement credential or native initialization',async t=>{
 const f=fixture(t,{expires:Date.now()-1}),flow=f.mount();await assert.rejects(flow.ready,/RESOURCE_EXPIRED/);
 assert.equal(f.initializes,0);assert.equal(f.requests,0);assert.match(flow.errorMessage(Error('RESOURCE_EXPIRED')),/session has ended/);
});
test('pending existing operation follows authenticated recovery rather than another native write',async t=>{
 const f=fixture(t,{state:'pending'}),flow=f.mount();await flow.ready;
 assert.equal(f.received.resume,false);assert.equal(f.received.recovery.state,'pending');assert.equal(f.requests,0);
});
function control({flow,owned=true}={}){
 const errors={textContent:''},pending=[];let changed=0,rendered=0,legacy=0;
 const actual=flow&&{mode:'prepared-unit-v3',resolveCartItem:()=>({properties:{_bfl_flow:'f05',_bfl_job:'one'}}),changeCart:async()=>{changed++;return {accepted:true,cart:{items:[]},render:{}};},...flow};
 const context={window:{BFLPrintJob:{forForm:()=>undefined,forCart:()=>actual}},document:{querySelector:()=>null,getElementById:()=>errors},fetch:()=>{legacy++;throw Error('legacy mutation');}};
 const target=vm.runInNewContext('({'+method+'})',context);Object.assign(target,{querySelector:()=>owned?{}:null,closest:()=>({getAttribute:()=>null,classList:{contains:()=>false},setPending:(...args)=>pending.push(args)}),enableLoading(){},disableLoading(){},refreshOwnedCart:async()=>{rendered++;}});
 return {target,errors,pending,get changed(){return changed;},get rendered(){return rendered;},get legacy(){return legacy;}};
}
test('no-form signed cart edit waits for original-owner restoration, then removes exactly once',async()=>{
 let resolve;const ready=new Promise(r=>{resolve=r;}),f=control({flow:{ready}});const pending=f.target.changeOwnedCart({key:'one'},0);
 await Promise.resolve();assert.equal(f.changed,0);resolve();assert.equal(await pending,true);assert.equal(f.changed,1);assert.equal(f.rendered,1);assert.equal(f.legacy,0);
});
test('missing or expired adapter allows only ordinary zero-quantity removal',async()=>{
 const absent=control();assert.equal(await absent.target.changeOwnedCart({key:'one'},0),false);assert.equal(await absent.target.changeOwnedCart({key:'one'},2),true);assert.equal(absent.changed,0);assert.match(absent.errors.textContent,/test cart is not ready/);
 const failed=control({flow:{ready:Promise.reject(Error('RESOURCE_EXPIRED')),errorMessage:()=> 'This test session has ended.'}});
 assert.equal(await failed.target.changeOwnedCart({key:'one'},0),false);assert.equal(await failed.target.changeOwnedCart({key:'one'},2),true);assert.equal(failed.changed,0);assert.equal(failed.rendered,0);assert.match(failed.errors.textContent,/session has ended/);assert.equal(failed.pending.at(-1)[1].failed,false);
 assert.equal(absent.legacy+failed.legacy,0);
});
test('ordinary Send Rolls cart without a printing receipt retains its legacy dispatch',async()=>{
 const f=control({owned:false});assert.equal(await f.target.changeOwnedCart({key:'ordinary'},0),false);assert.equal(f.changed,0);assert.equal(f.errors.textContent,'');
});

test('expired saved dispatched mutation remains uncertain and cannot fall through to removal',async t=>{
 const f=fixture(t,{state:'pending',expires:Date.now()-1,operation:{kind:'add',operation_id:'already-dispatched',job:'one',quantity:1}}),flow=f.mount();
 await assert.rejects(flow.ready,error=>error.message==='RESOURCE_EXPIRED'&&error.cartUncertain===true);
 assert.equal(JSON.parse(f.saved).operation.kind,'add');
 vm.runInThisContext(jobSource);const retry=f.mount();await assert.rejects(retry.ready,error=>error.cartUncertain===true);
 assert.equal(JSON.parse(f.saved).operation.kind,'add');
 const cart=control({flow:retry});assert.equal(await cart.target.changeOwnedCart({key:'one'},0),true);assert.equal(cart.legacy,0);
 assert.match(cart.errors.textContent,/cart could not be confirmed/);
});
test('post-dispatch expiry and unknown write failures never become an ordinary removal',async()=>{
 for(const error of [Object.assign(Error('RESOURCE_EXPIRED'),{cartUncertain:true}),Error('unknown response')]){
  let owned=0;const f=control({flow:{ready:Promise.resolve(),changeCart:async()=>{owned++;throw error;}}});
  assert.equal(await f.target.changeOwnedCart({key:'one'},0),true);assert.equal(owned,1);assert.equal(f.legacy,0);assert.equal(f.pending.at(-1)[1].failed,true);
 }
});
function fullCartControls(mode){
 const definitions=new Map(),requests=[],errors={textContent:''};let owned=0,rendered=0,failed=false;
 const flow=mode==='absent'?undefined:{mode:'prepared-unit-v3',ready:mode==='uncertain'?Promise.resolve():Promise.reject(mode==='expired'?Error('RESOURCE_EXPIRED'):Object.assign(Error('RESOURCE_UNAVAILABLE'),{reason:'DIAGNOSTIC_CLOSED'})),resolveCartItem:()=>({properties:{_bfl_flow:'f05',_bfl_job:'one'}}),changeCart:async()=>{owned++;throw Object.assign(Error('RESOURCE_EXPIRED'),{cartUncertain:true});}};
 const drawer={getAttribute:()=>null,classList:{contains:()=>failed},setPending:(_pending,state={})=>{failed=!!state.failed;}};
 const context=vm.createContext({HTMLElement:class{},customElements:{define:(name,ctor)=>definitions.set(name,ctor),get:name=>definitions.get(name)},console,
  window:{location:{pathname:'/cart'},routes:{cart_url:'/cart',cart_change_url:'/cart/change.js'},BFLPrintJob:{forForm:()=>undefined,forCart:()=>flow}},
  document:{querySelector:()=>null,getElementById:()=>errors},routes:{cart_change_url:'/cart/change.js'},fetchConfig:()=>({method:'POST'}),publish(){},PUB_SUB_EVENTS:{cartUpdate:'cart'},
  fetch:async(url,options={})=>{requests.push({url,options});return {ok:true,json:async()=>options.method?{items:[],item_count:0,total_price:0}:{items:[{key:'signed-key',quantity:2,properties:{_bfl_flow:'f05',_bfl_job:'one'}}]}};}});
 vm.runInContext(cartSource,context);const target=Object.create(definitions.get('cart-items').prototype);
 Object.assign(target,{querySelector:()=>({}),closest:()=>drawer,getSectionsToRender:()=>[],enableLoading(){},disableLoading(){},refreshSections(){rendered++;}});
 return {target,requests,get owned(){return owned;},get rendered(){return rendered;}};
}
test('missing, expired and closed no-form adapters remove through one ordinary Shopify write',async()=>{
 for(const mode of ['absent','expired','closed']){
  const f=fullCartControls(mode);await f.target.removeByKey('signed-key');
  const writes=f.requests.filter(r=>r.options.method);assert.equal(writes.length,1,mode);assert.equal(writes[0].url,'/cart/change.js');
  assert.deepEqual(JSON.parse(writes[0].options.body),{id:'signed-key',quantity:0,sections:[],sections_url:'/cart'});
  assert.equal(f.owned,0);assert.equal(f.rendered,1);
 }
});
test('unknown owned removal is attempted once and never followed by ordinary fallback or a duplicate',async()=>{
 const f=fullCartControls('uncertain');await f.target.removeByKey('signed-key');await f.target.removeByKey('signed-key');
 assert.equal(f.owned,1);assert.equal(f.requests.length,0);assert.equal(f.rendered,0);
});

test('repeated expired cart restoration retains the exact finite receipt for safe removal',async t=>{
 const f=fixture(t,{expires:Date.now()-1}),saved=f.saved;
 for(let i=0;i<3;i++){vm.runInThisContext(jobSource);const flow=f.mount();await assert.rejects(flow.ready,error=>error.message==='RESOURCE_EXPIRED'&&error.acceptedCartReadOnly===true);assert.equal(f.saved,saved);const cart=control({flow});assert.equal(await cart.target.changeOwnedCart({key:'one'},0),false);}
 assert.equal(f.requests,0);assert.equal(f.initializes,0);
});
