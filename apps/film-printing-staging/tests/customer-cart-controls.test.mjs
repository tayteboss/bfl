import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../../../assets/cart.js',import.meta.url),'utf8');
function controls({owned,fail=false,current,fetchResponse}){
 const definitions=new Map(),requests=[],error={textContent:''},pageError={textContent:''};let refreshed=0,changed=0;
 const input=current??{items:[{key:'native-key',quantity:2,properties:owned?{_bfl_flow:'f05',_bfl_job:'owned-job'}:{_timestamp:'send-rolls'}}]};
 const context=vm.createContext({HTMLElement:class{},customElements:{define:(n,c)=>definitions.set(n,c),get:n=>definitions.get(n)},console,
  window:{location:{pathname:'/products/test'},routes:{cart_url:'/cart'},BFLPrintJob:{forForm:()=>({changeCart:async()=>{changed++;if(fail)throw Error('uncertain');return {accepted:true,cart:{items:[]}};}})}},
  document:{querySelector:()=>({}),getElementById:id=>id==='CartDrawer-CartErrors'?error:id==='cart-errors'?pageError:null},
  fetch:async(url,options={})=>{requests.push({url,options});return fetchResponse?fetchResponse(url,options):{ok:true,json:async()=>input,text:async()=>JSON.stringify(input)};},
  routes:{cart_change_url:'/cart/change.js'},fetchConfig:()=>({method:'POST'}),publish:()=>{},PUB_SUB_EVENTS:{cartUpdate:'cart'},
 });
 vm.runInContext(source,context);const prototype=definitions.get('cart-items').prototype;
 const target=Object.create(prototype);Object.assign(target,{enableLoading(){},disableLoading(){},getSectionsToRender:()=>[],refreshSections(){refreshed++;}});
 return {target,requests,error,pageError,get changed(){return changed;},get refreshed(){return refreshed;}};
}
test('owned cart failure never falls through to a legacy mutation or unverified render',async()=>{
 const f=controls({owned:true,fail:true});await f.target.updateQuantityByIndex('1',3,'updates[]','67852705202287');
 assert.equal(f.changed,1);assert.equal(f.requests.length,1);assert.equal(f.refreshed,0);assert.match(f.error.textContent,/cart could not be confirmed/);
});

test('legacy removal reports a rejected response without publishing a fake empty cart',async()=>{
 const f=controls({owned:false,fetchResponse:async(_url,options)=>({ok:!options.method,json:async()=>options.method?{errors:'invalid job'}:{items:[{key:'native-key',quantity:1}]}})});
 await f.target.removeByKey('native-key');assert.equal(f.refreshed,0);assert.match(f.error.textContent,/Unexpected error/);assert.equal(f.target.removing,false);assert.equal(f.pageError.textContent,f.error.textContent);
});

test('rapid legacy removal sends one mutation and never removes a different remaining item',async()=>{
 let release;const pending=new Promise(resolve=>{release=resolve;});
 const f=controls({owned:false,fetchResponse:async(_url,options)=>{
  if(!options.method)return {ok:true,json:async()=>({items:[{key:'native-key',quantity:1},{key:'other',quantity:2}]})};
  await pending;assert.deepEqual(JSON.parse(options.body).id,'native-key');return {ok:true,json:async()=>({items:[{key:'other',quantity:2}],item_count:2,total_price:80})};
 }});
 const a=f.target.removeByKey('native-key'),b=f.target.removeByKey('native-key');await new Promise(setImmediate);
 assert.equal(f.requests.filter(r=>r.options.method).length,1);release();await Promise.all([a,b]);assert.equal(f.refreshed,1);
});

test('full-cart empty rendering updates the shared badge and accessible count',()=>{
 const badge={textContent:'3'},attributes={};
 // Run the shared rendering method with no section replacements.
 const definitions=new Map(),context=vm.createContext({HTMLElement:class{},customElements:{define:(n,c)=>definitions.set(n,c),get:n=>definitions.get(n)},
  document:{querySelector:()=>null,getElementById:()=>({querySelector:()=>badge,setAttribute:(k,v)=>{attributes[k]=v;}})},console});
 vm.runInContext(source,context);const target=Object.create(definitions.get('cart-items').prototype);target.classList={toggle(){}};
 target.refreshSections({item_count:0},[]);assert.equal(badge.textContent,'0');assert.equal(attributes['aria-label'],'Shopping cart with 0 items');
});

test('cart page and drawer edits request both mounted surfaces from one implementation',()=>{
 const definitions=new Map(),document={getElementById:id=>({'main-cart-items':{dataset:{id:'main-items'}},'main-cart-footer':{dataset:{id:'main-footer'}}}[id])};
 const context=vm.createContext({HTMLElement:class{},customElements:{define:(n,c)=>definitions.set(n,c),get:n=>definitions.get(n)},document,console});
 vm.runInContext(source,context);vm.runInContext(readFileSync(new URL('../../../assets/cart-drawer.js',import.meta.url),'utf8'),context);
 const page=Object.create(definitions.get('cart-items').prototype),drawer=Object.create(definitions.get('cart-drawer-items').prototype);
 assert.deepEqual(JSON.parse(JSON.stringify(page.getSectionsToRender())),[
  {id:'main-cart-items',section:'main-items',selector:'.js-contents'},
  {id:'main-cart-footer',section:'main-footer',selector:'.js-contents'},
  {id:'CartDrawer',section:'cart-drawer',selector:'#CartDrawer'},
 ]);assert.deepEqual(drawer.getSectionsToRender(),page.getSectionsToRender());
 const template=readFileSync(new URL('../../../sections/main-cart-items.liquid',import.meta.url),'utf8');
 assert.doesNotMatch(template,/<script[^>]*\b(?:bfl-performance-)?cart[^>]*>/);
});
test('existing Send Rolls quantity path remains a native legacy update',async()=>{
 const f=controls({owned:false});await f.target.updateQuantityByIndex('1',3,'updates[]','other');await new Promise(setImmediate);
 assert.equal(f.changed,0);const posts=f.requests.filter(r=>r.options.method==='POST');assert.equal(posts.length,1);
 assert.equal(posts[0].url,'/cart/change.js');assert.equal(JSON.parse(posts[0].options.body).quantity,3);assert.equal(f.refreshed,1);
});

test('resumed drawer refresh verifies current native rows and renders the complete drawer without mutations',async()=>{
 const current={items:[{quantity:2,final_line_price:80,properties:{_bfl_job:'owned-job'}}],item_count:2,total_price:80};
 const f=controls({owned:true,current});let rendered;
 f.target.getSectionsToRender=()=>[{id:'CartDrawer',section:'cart-drawer',selector:'.drawer__inner'}];
 f.target.refreshSections=(cart,sections)=>{rendered={cart,sections};};
 await f.target.refreshOwnedCart({items:[{quantity:2,subtotal_cents:80,properties:{_bfl_job:'owned-job'}}]});
 assert.equal(f.changed,0);assert.equal(f.requests.length,2);assert.ok(f.requests.every(r=>!r.options.method));
 assert.equal(rendered.sections[0].selector,'#CartDrawer');assert.equal(rendered.cart.total_price,80);
});
test('resumed drawer refuses stale membership or price before rendering',async()=>{
 const current={items:[{quantity:3,final_line_price:120,properties:{_bfl_job:'owned-job'}}],item_count:3,total_price:120};
 const f=controls({owned:true,current});await assert.rejects(f.target.refreshOwnedCart({items:[{quantity:2,subtotal_cents:80,properties:{_bfl_job:'owned-job'}}]}));
 assert.equal(f.refreshed,0);assert.equal(f.requests.length,2);assert.equal(f.changed,0);
});

test('prepared quantities dispatch immediately while ordinary carts keep the input debounce',()=>{
 const definitions=new Map(),listeners=new Map(),delayed=[];let mode='prepared-unit-v3',calls=0;
 const context=vm.createContext({HTMLElement:class{addEventListener(name,callback){listeners.set(name,callback);}},
  customElements:{define:(name,type)=>definitions.set(name,type),get:name=>definitions.get(name)},document:{getElementById:()=>null,querySelector:()=>({})},
  window:{BFLPrintJob:{forForm:()=>({mode})}},ON_CHANGE_DEBOUNCE_TIMER:300,
  debounce:(callback,delay)=>{assert.equal(delay,300);return event=>delayed.push(()=>callback(event));},console});
 vm.runInContext(source,context);const target=new (definitions.get('cart-items'))();target.onChange=()=>calls++;
 listeners.get('change')({});assert.equal(calls,1);assert.equal(delayed.length,0);
 mode=undefined;listeners.get('change')({});assert.equal(calls,1);assert.equal(delayed.length,1);
 delayed[0]();assert.equal(calls,2);
});
