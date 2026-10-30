import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../../../assets/cart.js',import.meta.url),'utf8');
function fixture({drawerSurface=false,error=Object.assign(new TypeError('Failed to fetch'),{acceptedCartReadOnly:true}),rows=[{key:'print-one',flow:'f05'},{key:'print-two',flow:'f05'}],nativeRows=rows,change,ready,writeError,writeWait}={}){
 const definitions=new Map(),requests=[],drawerError={textContent:''},pageError={textContent:''},status={hidden:false},pending=[];
 let busy=false,failed=false,owned=0,resolved=0,renders=0,loading=true;
 const cards=rows.map((row,index)=>({dataset:row.flow===undefined?{}:{bflFlow:row.flow},querySelector:selector=>selector.startsWith('cart-remove-button')?{dataset:{key:row.key}}:{dataset:{index:String(index+1)}}}));
 const drawer={getAttribute:()=>busy?'true':null,classList:{contains:()=>failed},setPending(value,state={}){busy=value;failed=!!state.failed;drawerError.textContent=failed?state.message:'';pending.push({value,...state});}};
 const flow={mode:'prepared-unit-v3',ready:ready??Promise.reject(error),resolveCartItem(){resolved++;return {properties:{_bfl_flow:'f05',_bfl_job:'one'}};},async changeCart(input){owned++;return change?change(input):{accepted:true,cart:{items:[]},render:{}};}};
 const context=vm.createContext({HTMLElement:class{},customElements:{define:(name,type)=>definitions.set(name,type),get:name=>definitions.get(name)},console,
  window:{location:{pathname:'/cart'},routes:{cart_url:'/cart',cart_change_url:'/cart/change.js'},BFLPrintJob:{forForm:()=>null,forCart:()=>flow}},
  document:{querySelector:selector=>selector==='cart-drawer'?drawer:null,getElementById:id=>id==='CartDrawer-CartErrors'?drawerError:id==='cart-errors'?pageError:null},routes:{cart_change_url:'/cart/change.js'},fetchConfig:()=>({method:'POST'}),publish(){},PUB_SUB_EVENTS:{cartUpdate:'cart'},
  fetch:async(url,options={})=>{requests.push({url,options});if(options.method){if(writeWait)await writeWait;if(writeError)throw writeError;}const removed=options.method?JSON.parse(options.body).id:null;const cart={items:nativeRows.filter(row=>row.key!==removed).map(row=>({key:row.key,quantity:2,properties:row.flow==='f05'?{_bfl_flow:'f05',_bfl_job:row.key}:{}}))};return {ok:true,json:async()=>cart,text:async()=>JSON.stringify(cart)};}});
 vm.runInContext(source,context);const target=Object.create(definitions.get('cart-items').prototype);
 Object.assign(target,{querySelectorAll:()=>cards,querySelector:()=>({}),closest:()=>drawerSurface?drawer:null,getSectionsToRender:()=>[],enableLoading(){loading=true;status.hidden=false;},disableLoading(){loading=false;status.hidden=true;},refreshSections(){renders++;},async refreshOwnedCart(){renders++;}});
 return {target,requests,drawerError,pageError,pending,status,get owned(){return owned;},get resolved(){return resolved;},get renders(){return renders;},get loading(){return loading;}};
}
for(const drawerSurface of [false,true])test(`accepted proof transport failure permits one exact protected key removal on ${drawerSurface?'drawer':'main cart'}`,async()=>{
 const f=fixture({drawerSurface});await f.target.removeByKey('print-one');
 const writes=f.requests.filter(r=>r.options.method);assert.equal(writes.length,1);assert.equal(writes[0].url,'/cart/change.js');
 assert.deepEqual(JSON.parse(writes[0].options.body),{id:'print-one',quantity:0,sections:[],sections_url:'/cart'});
 assert.equal(f.requests.length,2);assert.equal(f.owned,0);assert.equal(f.resolved,0);assert.equal(f.renders,1);assert.equal(f.loading,false);assert.equal(f.status.hidden,true);assert.equal(f.pending.at(-1).failed,false);
});
test('accepted read fallback does not dispatch if the exact rendered key has already disappeared',async()=>{
 const f=fixture({nativeRows:[{key:'print-two',flow:'f05'}]});await f.target.removeByKey('print-one');
 assert.equal(f.requests.length,1);assert.equal(f.requests[0].options.method,undefined);assert.equal(f.owned,0);assert.equal(f.renders,1);assert.equal(f.loading,false);
});
test('accepted read failure keeps quantity increases blocked and still permits a later exact removal',async()=>{
 const f=fixture();await f.target.updateQuantityByIndex('1',3,'updates[]','print-variant');await new Promise(setImmediate);
 assert.equal(f.requests.length,0);assert.equal(f.owned,0);assert.match(f.pageError.textContent,/cart could not be confirmed/);assert.equal(f.pageError.textContent,f.drawerError.textContent);assert.equal(f.loading,false);
 await f.target.removeByKey('print-one');assert.equal(f.requests.filter(r=>r.options.method).length,1);assert.equal(f.owned,0);
});
test('accepted transport fallback rejects unknown, unmarked and index-only protected targets',async()=>{
 for(const [rows,selector] of [
  [[{key:'print-one',flow:'f05'}],{key:'missing'}],
  [[{key:'unmarked'}],{key:'unmarked'}],
  [[{key:'print-one',flow:'f05'}],{line:'1'}],
 ]){const f=fixture({rows});assert.equal(await f.target.changeOwnedCart(selector,0),true);assert.equal(f.requests.length,0);assert.equal(f.owned,0);assert.match(f.pageError.textContent,/cart could not be confirmed/);assert.equal(f.loading,false);}
});
test('pending, uncertain and unclassified restoration failures never use native protected removal',async()=>{
 for(const error of [Object.assign(new TypeError('Failed to fetch'),{cartUncertain:true,acceptedCartReadOnly:true}),new TypeError('Failed to fetch'),Object.assign(Error('RESOURCE_UNAVAILABLE'),{reason:'PREPARED_UNCERTAIN'})]){
  const f=fixture({error});await f.target.removeByKey('print-one');await f.target.removeByKey('print-one');
  assert.equal(f.requests.length,0);assert.equal(f.owned,0);assert.equal(f.pending.at(-1).failed,true);assert.match(f.pageError.textContent,/cart could not be confirmed/);assert.equal(f.loading,false);
 }
});
test('an owned dispatch can never acquire native fallback even with an erroneous read-only flag',async()=>{
 const f=fixture({ready:Promise.resolve(),change:async()=>{throw Object.assign(new TypeError('response lost'),{acceptedCartReadOnly:true});}});
 await f.target.removeByKey('print-one');await f.target.removeByKey('print-one');assert.equal(f.owned,1);assert.equal(f.requests.length,0);assert.equal(f.pending.at(-1).failed,true);assert.equal(f.loading,false);assert.match(f.pageError.textContent,/cart could not be confirmed/);
});

test('lost native removal response locks subsequent attempts instead of replaying a write',async()=>{
 const f=fixture({writeError:new TypeError('Response lost')});await f.target.removeByKey('print-one');await f.target.removeByKey('print-one');await f.target.removeByKey('print-two');
 assert.equal(f.requests.filter(r=>r.options.method).length,1);assert.equal(f.owned,0);assert.equal(f.renders,0);assert.equal(f.pending.at(-1).failed,true);assert.equal(f.pageError.textContent,'Response lost');assert.equal(f.loading,false);
});
test('rapid accepted-read removals share the existing native in-flight guard',async()=>{
 let release;const writeWait=new Promise(resolve=>{release=resolve;}),f=fixture({writeWait});
 const first=f.target.removeByKey('print-one');await new Promise(setImmediate);const second=f.target.removeByKey('print-one');const other=f.target.removeByKey('print-two');
 await new Promise(setImmediate);assert.equal(f.requests.filter(r=>r.options.method).length,1);release();await Promise.all([first,second,other]);assert.equal(f.renders,1);assert.equal(f.owned,0);
});
test('accepted-read removal never deletes legacy shipping lines beside the exact protected key',async()=>{
 const f=fixture();f.target._isFilmPrintItem=()=>true;f.target._isSizeShippingItem=()=>true;
 await f.target.removeByKey('print-one');const writes=f.requests.filter(r=>r.options.method);assert.equal(writes.length,1);assert.equal(writes[0].url,'/cart/change.js');assert.equal(JSON.parse(writes[0].options.body).id,'print-one');
});

test('a later explicit removal after reload re-reads the key and never writes for an absent line',async()=>{
 const lost=fixture({writeError:new TypeError('Response lost')});await lost.target.removeByKey('print-one');assert.equal(lost.requests.filter(r=>r.options.method).length,1);
 for(const present of [false,true]){
  const reload=fixture({nativeRows:present?[{key:'print-one',flow:'f05'},{key:'print-two',flow:'f05'}]:[{key:'print-two',flow:'f05'}]});
  await reload.target.removeByKey('print-one');const writes=reload.requests.filter(r=>r.options.method);assert.equal(writes.length,present?1:0);assert.equal(reload.requests[0].options.method,undefined);
  if(present)assert.deepEqual(JSON.parse(writes[0].options.body),{id:'print-one',quantity:0,sections:[],sections_url:'/cart'});
 }
});
