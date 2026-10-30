import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../../../assets/cart.js',import.meta.url),'utf8');
const acceptedError=()=>Object.assign(new TypeError('Failed to fetch'),{acceptedCartReadOnly:true});
function fixture({surface='drawer',error=acceptedError(),ready,change}={}){
 const definitions=new Map(),requests=[],errors={drawer:{textContent:''},page:{textContent:''}};
 let busy=false,failed=false,owned=0,loading=false,rendered=0;
 const input={value:'2',confirmed:'1',dataset:{index:'1'},getAttribute(name){return name==='value'?this.confirmed:null;}};
 const other={value:'4',confirmed:'4',dataset:{index:'2'},getAttribute(name){return name==='value'?this.confirmed:null;}};
 const rows=[input,other].map((field,index)=>({dataset:{bflFlow:'f05'},querySelector:selector=>selector.startsWith('cart-remove-button')?{dataset:{key:`print-${index+1}`}}:field}));
 const drawer={getAttribute:()=>busy?'true':null,classList:{contains:()=>failed},setPending(value,state={}){busy=value;failed=!!state.failed;}};
 const flow={mode:'prepared-unit-v3',ready:ready??Promise.reject(error),resolveCartItem:()=>({properties:{_bfl_flow:'f05',_bfl_job:'job-one'}}),async changeCart(value){owned++;return change?change(value):{accepted:true,cart:{items:[]},render:{}};}};
 const context=vm.createContext({HTMLElement:class{},customElements:{define:(name,type)=>definitions.set(name,type),get:name=>definitions.get(name)},console,
  window:{location:{pathname:surface==='drawer'?'/products/test':'/cart'},routes:{cart_url:'/cart'},BFLPrintJob:{forForm:()=>surface==='drawer'?flow:null,forCart:()=>flow}},
  document:{querySelector:selector=>selector==='cart-drawer'?drawer:null,getElementById:id=>id==='CartDrawer-CartErrors'?errors.drawer:id==='cart-errors'?errors.page:null},
  routes:{cart_change_url:'/cart/change.js'},fetchConfig:()=>({method:'POST'}),fetch:async(...args)=>{requests.push(args);throw Error('unexpected native request');},publish(){},PUB_SUB_EVENTS:{cartUpdate:'cart'}});
 vm.runInContext(source,context);const target=Object.create(definitions.get('cart-items').prototype);
 Object.assign(target,{querySelectorAll:()=>rows,closest:()=>surface==='drawer'?drawer:null,enableLoading(){loading=true;},disableLoading(){loading=false;},async refreshOwnedCart(){rendered++;},getSectionsToRender:()=>[]});
 return {target,input,other,requests,errors,get owned(){return owned;},get failed(){return failed;},get loading(){return loading;},get rendered(){return rendered;}};
}
for(const surface of ['drawer','page'])test(`${surface}: accepted read rejection restores confirmed quantity without any cart request`,async()=>{
 const f=fixture({surface});await f.target.updateQuantityByIndex('1',2,'updates[]','variant');
 assert.equal(f.input.value,'1');assert.equal(f.input.confirmed,'1');assert.equal(f.other.value,'4');assert.equal(f.owned,0);assert.equal(f.requests.length,0);
 assert.equal(f.loading,false);assert.equal(f.failed,false);assert.match(f.errors.page.textContent,/cart could not be confirmed/);assert.equal(f.errors.drawer.textContent,f.errors.page.textContent);
});
test('definite closed restoration restores a typed increase from the confirmed render',async()=>{
 const f=fixture({error:Object.assign(Error('DIAGNOSTIC_CLOSED'),{reason:'DIAGNOSTIC_CLOSED'})});f.input.value='13';
 await f.target.updateQuantityByIndex('1',13,'updates[]','variant');assert.equal(f.input.value,'1');assert.equal(f.owned,0);assert.equal(f.requests.length,0);assert.equal(f.failed,false);
});
test('accepted read rejection restores a decrease to the confirmed render',async()=>{
 const f=fixture();f.input.confirmed='3';f.input.value='2';await f.target.updateQuantityByIndex('1',2,'updates[]','variant');
 assert.equal(f.input.value,'3');assert.equal(f.owned,0);assert.equal(f.requests.length,0);
});
for(const error of [Object.assign(acceptedError(),{cartUncertain:true}),new TypeError('Unclassified restore failure')])test(`unproven restoration never claims a quantity rollback: ${error.message}`,async()=>{
 const f=fixture({error});await f.target.updateQuantityByIndex('1',2,'updates[]','variant');assert.equal(f.input.value,'2');assert.equal(f.owned,0);assert.equal(f.requests.length,0);assert.equal(f.failed,true);
});
test('a lost owned response retains uncertainty without rollback or a second dispatch',async()=>{
 const f=fixture({ready:Promise.resolve(),change:async()=>{throw acceptedError();}});
 await f.target.updateQuantityByIndex('1',2,'updates[]','variant');await f.target.updateQuantityByIndex('1',2,'updates[]','variant');
 assert.equal(f.input.value,'2');assert.equal(f.owned,1);assert.equal(f.requests.length,0);assert.equal(f.failed,true);assert.equal(f.rendered,0);
});
for(const changed of ['input','render'])test(`a newer ${changed} during restoration is not overwritten by the earlier rejected change`,async()=>{
 let reject;const ready=new Promise((_resolve,no)=>{reject=no;}),f=fixture({ready});const pending=f.target.updateQuantityByIndex('1',2,'updates[]','variant');
 if(changed==='input')f.input.value='3';else f.input.confirmed='2';reject(acceptedError());await pending;
 assert.equal(f.input.value,changed==='input'?'3':'2');assert.equal(f.input.confirmed,changed==='input'?'1':'2');assert.equal(f.owned,0);assert.equal(f.requests.length,0);
});
test('successful owned mutation still renders the accepted result without local rollback',async()=>{
 const f=fixture({ready:Promise.resolve()});await f.target.updateQuantityByIndex('1',2,'updates[]','variant');
 assert.equal(f.input.value,'2');assert.equal(f.owned,1);assert.equal(f.requests.length,0);assert.equal(f.rendered,1);assert.equal(f.failed,false);
});
