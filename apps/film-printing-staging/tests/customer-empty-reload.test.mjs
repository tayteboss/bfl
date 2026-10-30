import test from 'node:test';
import assert from 'node:assert/strict';
import {fullRig} from '../../../fixtures/film-printing/f06v3-candidate/full-rig.mjs';
import {createFilmPrintingForm} from '../theme/film-printing-form.js';
import {createPreparedCheckout} from '../theme/prepared-checkout.js';
import {mountCustomerForm} from '../theme/customer-form.js';

async function rig(t){
  const f=await fullRig(t),data=new Map();
  const saved={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)};
  class Form extends EventTarget{dataset={filmPrintingForm:''};querySelector(){return null;}querySelectorAll(){return [];}}
  let cartId=f.ids.A;
  const actions={getCart:async()=>({cart:{id:cartId,lines:[],totalQuantity:0,cost:{totalAmount:{amount:'0.00',currencyCode:'USD'}}}})};
  const fetchImpl=async path=>({ok:true,redirected:false,json:async()=>path==='/cart.js'?{currency:'USD',items:[],item_count:0,total_price:0}:{'cart-drawer':'<div>Empty</div>'}});
  const make=()=>createFilmPrintingForm(new Form(),{sessionOptions:{fetchImpl:f.browserFetch,now:()=>f.clock.time,reloadStorage:saved,preparedMode:true},
    checkoutForSession:session=>createPreparedCheckout(session,{actions,fetchImpl,now:()=>f.clock.time})});
  return Object.assign(f,{saved,make,changeCart(){cartId=f.ids.B;}});
}

test('reload before the first image authenticates the same empty cart without a pricing lease or reissuance',async t=>{
  const f=await rig(t);await f.make().issue();
  const before=f.rows(),counts={...f.runtime.status().counts};
  for(let i=0;i<2;i++){
    const restored=f.make(),result=await restored.issue();
    assert.deepEqual(result.selections,[]);assert.deepEqual(result.cart.items,[]);
    assert.equal(restored.snapshot().pending,0);
  }
  const after=f.rows();
  for(const key of ['resource_sessions','resource_admissions','checkout_owner_admissions','jobs','cart_prepared_jobs'])assert.deepEqual(after[key],before[key]);
  for(const key of ['issue','bind','install','publish','eligible'])assert.equal(f.runtime.status().counts[key],counts[key]);
  assert.equal(f.counts.uploads,0);
});

test('empty-form recovery rejects a different cart and never falls back to issuing another owner',async t=>{
  const f=await rig(t);await f.make().issue();f.changeCart();
  await assert.rejects(f.make().issue());await assert.rejects(f.make().issue());
  assert.equal(f.runtime.status().counts.issue,1);
});

test('empty-form recovery retains the original owner deadline',async t=>{
  const f=await rig(t);await f.make().issue();f.clock.time+=600001;
  await assert.rejects(f.make().issue());assert.equal(f.runtime.status().counts.issue,1);
});

test('first image after empty-form reload retains completed-selection recovery',async t=>{
  const f=await rig(t);await f.make().issue();
  const create=globalThis.BFLUploadLifecycle.create;globalThis.BFLUploadLifecycle.create=()=>create({now:()=>f.clock.time});
  t.after(()=>{globalThis.BFLUploadLifecycle.create=create;});
  const restored=f.make();await restored.issue();
  const file=f.inputFiles[0],selection=restored.select([new File([file.bytes],'fixture.png',{type:file.mime})])[0];
  await selection.completion;await restored.selectionReady(selection.key);
  assert.equal(JSON.parse(f.saved.getItem('bfl:accepted-cart-session:v1')).state,'uploads');
  const result=await f.make().issue();assert.equal(result.selections.length,1);
  assert.equal(f.counts.uploads,1);assert.equal(f.runtime.status().counts.issue,1);
});

test('Choose File stays disabled after initialization fails, including subsequent form changes',async t=>{
  const previous={location:globalThis.location,Shopify:globalThis.Shopify,document:globalThis.document};
  t.after(()=>Object.assign(globalThis,previous));
  globalThis.location={origin:'https://bellows-film-printing-staging.myshopify.com',hostname:'bellows-film-printing-staging.myshopify.com'};
  globalThis.Shopify={actions:{getCart:async()=>assert.fail('initialization failed before native read')}};
  globalThis.document={createElement:()=>Object.assign(new EventTarget(),{click(){}})};
  const choose=new EventTarget(),error={style:{}};
  const form=Object.assign(new EventTarget(),{dataset:{filmPrintingForm:''},append(){},querySelector:s=>s==='[data-uploadly-fallback-button]'?choose:null,
    querySelectorAll:s=>s.includes('data-film-service-error')?[error]:[]});
  const flow=mountCustomerForm(form,{until:Date.now()+60000,preparedCart:true,sessionOptions:{reloadStorage:null,fetchImpl:async()=>{throw Error('unavailable');}}});
  assert.equal(choose.disabled,true);await assert.rejects(flow.ready);
  choose.disabled=false;form.dispatchEvent(new Event('change'));await Promise.resolve();
  assert.equal(choose.disabled,true);assert.equal(error.textContent,'The selection could not be confirmed. Please contact us before trying again.');
});
