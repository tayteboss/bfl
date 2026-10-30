import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../../../assets/cart.js',import.meta.url),'utf8');
function fixture({drawerSurface=false,empty=false,sectionsOk=true,missingHtml=false}={}){
  const section=drawerSurface?'cart-drawer':'main-cart-items',id=drawerSurface?'CartDrawer':'main-cart-items';
  const selector=drawerSurface?'#CartDrawer':'.js-contents',requests=[],published=[],definitions=new Map();
  const content={innerHTML:'stale-row + surviving-row'},error={textContent:''},badge={textContent:''};
  const html=empty?'<div>Cart empty</div>':'<div>Surviving row</div>';
  const container={querySelector:()=>content};let failed=false,busy=false;
  const drawer={classList:{toggle(){},contains:()=>failed},getAttribute:()=>busy?'true':null,setPending(value,status={}){busy=value;failed=!!status.failed;}};
  const flow={mode:'prepared-unit-v3',ready:Promise.reject(Object.assign(new TypeError('closed accepted read'),{acceptedCartReadOnly:true})),changeCart:()=>assert.fail('no owned write')};
  const cart={item_count:empty?0:1,total_price:empty?0:250,items:empty?[]:[{key:'surviving-key',quantity:1,properties:{},final_line_price:250}]};
  const context=vm.createContext({HTMLElement:class{},customElements:{define:(name,type)=>definitions.set(name,type),get:name=>definitions.get(name)},console,
    window:{location:{pathname:drawerSurface?'/products/f00-film-printing-test':'/cart'},routes:{cart_url:'/cart',cart_change_url:'/cart/change.js'},BFLPrintJob:{forForm:()=>null,forCart:()=>flow}},
    document:{querySelector:s=>s==='cart-drawer'?drawer:null,getElementById:name=>name===id?container:name==='cart-icon-bubble'?{querySelector:()=>badge,setAttribute(){}}:name==='CartDrawer-CartErrors'||name==='cart-errors'?error:null},
    DOMParser:class{parseFromString(value){return {querySelector:s=>s===selector?{innerHTML:value}:null};}},
    routes:{cart_change_url:'/cart/change.js'},fetchConfig:()=>({method:'POST'}),PUB_SUB_EVENTS:{cartUpdate:'cart'},publish:(_type,value)=>published.push(value),
    fetch:async(url,options={})=>{requests.push({url,options});assert.equal(options.method,undefined,'stale removal must never POST');
      if(url.includes('?sections='))return {ok:sectionsOk,json:async()=>missingHtml?{}:{[section]:html}};
      return {ok:true,json:async()=>structuredClone(cart)};},
  });
  vm.runInContext(source,context);const target=Object.create(definitions.get('cart-items').prototype);
  const row={dataset:{bflFlow:'f05'},querySelector:()=>({dataset:{key:'stale-key'}})};
  Object.assign(target,{classList:{toggle(){}},querySelectorAll:()=>[row],querySelector:()=>({}),closest:()=>drawerSurface?drawer:null,
    getSectionsToRender:()=>[{id,section,selector}],enableLoading(){},disableLoading(){}});
  return {target,requests,published,content,error,badge,html,section,get failed(){return failed;}};
}
for(const drawerSurface of [false,true])test(`absent protected key refreshes surviving ${drawerSurface?'drawer':'cart page'} rows using GET only`,async()=>{
  const f=fixture({drawerSurface});await f.target.removeByKey('stale-key');
  assert.equal(f.requests.length,2);assert.equal(f.requests[1].url,`/cart?sections=${f.section}`);assert.equal(f.requests[1].options.cache,'no-store');
  assert.equal(f.content.innerHTML,f.html);assert.equal(f.badge.textContent,'1');assert.equal(f.published.length,1);assert.equal(f.published[0].cartData.items[0].key,'surviving-key');assert.equal(f.failed,false);
});
test('absent last key refreshes the empty state and publishes zero items without a write',async()=>{
  const f=fixture({drawerSurface:true,empty:true});await f.target.removeByKey('stale-key');assert.equal(f.content.innerHTML,f.html);assert.equal(f.badge.textContent,'0');assert.equal(f.published[0].cartData.items.length,0);assert.equal(f.requests.length,2);
});
for(const options of [{sectionsOk:false},{missingHtml:true}])test(`failed sections read leaves stale-key removal retryable without publishing incomplete HTML (${JSON.stringify(options)})`,async()=>{
  const f=fixture(options);await f.target.removeByKey('stale-key');assert.equal(f.requests.length,2);assert.equal(f.published.length,0);assert.equal(f.content.innerHTML,'stale-row + surviving-row');assert.equal(f.error.textContent,'Cart sections unavailable');assert.equal(f.failed,false);
});
