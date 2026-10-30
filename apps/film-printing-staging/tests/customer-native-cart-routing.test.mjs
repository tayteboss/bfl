import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../../../assets/cart.js',import.meta.url),'utf8');
function fixture({rows=[{key:'ordinary',flow:''}],ready=Promise.resolve(),resolve=()=>null,change,drawerSurface=false}={}){
 const definitions=new Map(),requests=[],errors={textContent:''},pending=[];
 let owned=0,resolved=0,rendered=0,busy=false,failed=false;
 const cards=rows.map((row,index)=>({dataset:row.flow===undefined?{}:{bflFlow:row.flow},querySelector:selector=>
  selector.startsWith('cart-remove-button')?{dataset:{key:row.key}}:{dataset:{index:String(index+1)}}}));
 const drawer={getAttribute:()=>busy?'true':null,classList:{contains:()=>failed},setPending:(value,state={})=>{
  busy=value;if(!value)failed=!!state.failed;pending.push({value,...state});
 }};
 const flow={mode:'prepared-unit-v3',ready,resolveCartItem:selector=>{resolved++;return resolve(selector);},changeCart:async input=>{
  owned++;return change?change(input):{accepted:true,cart:{items:[]},render:{}};
 }};
 const context=vm.createContext({HTMLElement:class{},customElements:{define:(name,value)=>definitions.set(name,value),get:name=>definitions.get(name)},console,
  window:{location:{pathname:'/cart'},routes:{cart_url:'/cart',cart_change_url:'/cart/change.js'},BFLPrintJob:{forForm:()=>undefined,forCart:()=>flow}},
  document:{querySelector:selector=>selector==='cart-drawer'?drawer:null,getElementById:()=>errors},routes:{cart_change_url:'/cart/change.js'},
  fetchConfig:()=>({method:'POST'}),publish(){},PUB_SUB_EVENTS:{cartUpdate:'cart'},
  fetch:async(url,options={})=>{requests.push({url,options});const cart=options.method?{items:[],item_count:0,total_price:0}:{items:rows.map(row=>({key:row.key,quantity:1,properties:row.flow==='f05'?{_bfl_flow:'f05',_bfl_job:'one'}:{_timestamp:'send-rolls'}}))};
   return {ok:true,json:async()=>cart,text:async()=>JSON.stringify(cart)};},
 });
 vm.runInContext(source,context);const target=Object.create(definitions.get('cart-items').prototype);
 Object.assign(target,{querySelectorAll:()=>cards,querySelector:()=>rows.some(row=>row.flow==='f05')?{}:null,
  closest:()=>drawerSurface?drawer:null,getSectionsToRender:()=>[],enableLoading(){},disableLoading(){},refreshSections(){rendered++;},refreshOwnedCart:async()=>{rendered++;}});
 return {target,requests,pending,errors,drawer,get owned(){return owned;},get resolved(){return resolved;},get rendered(){return rendered;}};
}
test('ordinary Send Rolls line added after an empty accepted print cart removes through one native write',async()=>{
 for(const drawerSurface of [false,true]){
  const f=fixture({drawerSurface});await f.target.removeByKey('ordinary');
  const writes=f.requests.filter(r=>r.options.method);assert.equal(writes.length,1);assert.equal(writes[0].url,'/cart/change.js');
  assert.equal(JSON.parse(writes[0].options.body).id,'ordinary');assert.equal(f.owned,0);assert.equal(f.resolved,0);assert.equal(f.rendered,1);assert.equal(f.errors.textContent,'');
 }
});
test('ordinary quantity routes by its exact rendered index even with another F05 card',async()=>{
 const f=fixture({rows:[{key:'owned',flow:'f05'},{key:'ordinary',flow:''}]});
 await f.target.updateQuantityByIndex('2',3,'updates[]','native-variant');await new Promise(setImmediate);
 const writes=f.requests.filter(r=>r.options.method);assert.equal(writes.length,1);assert.deepEqual(JSON.parse(writes[0].options.body),{line:'2',quantity:3,sections:[],sections_url:'/cart'});
 assert.equal(f.owned,0);assert.equal(f.resolved,0);assert.equal(f.rendered,1);
});
test('a key for an unknown target or a marked F05 target never uses ordinary dispatch',async()=>{
 for(const {rows,key} of [
  {rows:[{key:'ordinary',flow:''}],key:'unknown'},
  {rows:[{key:'signed',flow:'f05'}],key:'signed'},
  {rows:[{key:'unmarked'}],key:'unmarked'},
 ]){
  const f=fixture({rows});await f.target.removeByKey(key);assert.equal(f.requests.length,0);assert.equal(f.owned,0);assert.equal(f.resolved,1);assert.match(f.errors.textContent,/cart could not be confirmed/);
 }
});
test('ordinary dispatch waits for original restoration and cannot bypass a pending uncertain result',async()=>{
 let release;const ready=new Promise(resolve=>{release=resolve;});const f=fixture({ready});const removal=f.target.removeByKey('ordinary');
 await Promise.resolve();assert.equal(f.requests.length,0);release();await removal;assert.equal(f.requests.filter(r=>r.options.method).length,1);
 const blocked=fixture({ready:Promise.reject(Object.assign(Error('RESOURCE_EXPIRED'),{cartUncertain:true}))});
 await blocked.target.removeByKey('ordinary');assert.equal(blocked.requests.length,0);assert.equal(blocked.owned,0);assert.equal(blocked.pending.at(-1).failed,true);
});
test('main cart uncertain owned write locks both surfaces before ordinary fallback or duplicate work',async()=>{
 const f=fixture({rows:[{key:'signed',flow:'f05'},{key:'ordinary',flow:''}],resolve:()=>({properties:{_bfl_flow:'f05',_bfl_job:'one'}}),
  change:async()=>{throw Object.assign(Error('unknown response'),{cartUncertain:true});}});
 await f.target.removeByKey('signed');await f.target.removeByKey('ordinary');await f.target.removeByKey('signed');
 assert.equal(f.owned,1);assert.equal(f.requests.length,0);assert.equal(f.drawer.classList.contains('update-failed'),true);assert.equal(f.rendered,0);
});
test('ordinary controls survive a known rejected print-session resume after reload',async()=>{
 for(const drawerSurface of [false,true])for(const kind of ['remove','quantity']){
  const ready=Promise.reject(Object.assign(Error('RESOURCE_UNAVAILABLE'),{reason:'CHECKOUT_RESUME_REJECTED'}));
  const f=fixture({ready,drawerSurface});
  if(kind==='remove')await f.target.removeByKey('ordinary');
  else {await f.target.updateQuantityByIndex('1',2,'updates[]','ordinary-variant');await new Promise(setImmediate);}
  assert.equal(f.requests.filter(r=>r.options.method).length,1);assert.equal(f.owned,0);assert.equal(f.resolved,0);
  assert.equal(f.rendered,1);assert.equal(f.errors.textContent,'');assert.equal(f.pending.at(-1).failed,false);
 }
});
test('failed resume never sends an ordinary write for unknown, print, or uncertain targets',async()=>{
 for(const [rows,key,uncertain,reason] of [
  [[{key:'ordinary',flow:''}],'missing',false,'CHECKOUT_RESUME_REJECTED'],
  [[{key:'print',flow:'f05'}],'print',false,'CHECKOUT_RESUME_REJECTED'],
  [[{key:'ordinary',flow:''}],'ordinary',true,'CHECKOUT_RESUME_REJECTED'],
  [[{key:'ordinary',flow:''}],'ordinary',false,'PREPARED_UNCERTAIN'],
 ]){
  const ready=Promise.reject(Object.assign(Error('RESOURCE_UNAVAILABLE'),{reason,...(uncertain?{cartUncertain:true}:{})}));
  const f=fixture({rows,ready});await f.target.removeByKey(key);
  assert.equal(f.requests.length,0);assert.equal(f.owned,0);assert.equal(f.pending.at(-1).failed,true);
 }
});
