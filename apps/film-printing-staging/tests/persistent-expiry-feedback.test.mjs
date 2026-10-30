import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createFilmPrintingForm} from '../theme/film-printing-form.js';
import {mountCustomerCart} from '../theme/customer-form.js';
const policy='bfl-persistent-staging-client-v1';
const expiredMessage='These print selections have expired. Remove the expired print items from your bag, then refresh this page to start again.';
const legacyMessage='This test session has ended. Please ask for a new test session.';
const jobSource=readFileSync(new URL('../theme/film-printing-job.js',import.meta.url),'utf8');
const customerSource=readFileSync(new URL('../theme/customer-form.js',import.meta.url),'utf8');
const mountSource=customerSource.slice(customerSource.indexOf('export function mountCustomerForm('),customerSource.indexOf('// Other storefront pages')).replace('export function','function');
const {customerError}=globalThis.BFLPrintJob;
const protocol={mode:'prepared-unit-v3',prepare(){},addPrepared(){},cancelPreparation(){},change(){},resolveCartItem(){}};
function globals(t){
 const before={location:globalThis.location,document:globalThis.document,BFLPrintJob:globalThis.BFLPrintJob};
 t.after(()=>Object.assign(globalThis,before));
 globalThis.location={origin:'https://bellows-film-printing-staging.myshopify.com',hostname:'bellows-film-printing-staging.myshopify.com'};
 globalThis.document={querySelector:()=>null};
 vm.runInThisContext(jobSource);
}
test('only trusted persistent feedback offers expired-item removal; uncertain and read-retry advice wins',()=>{
 for(const code of ['RESOURCE_EXPIRED','PREPARED_EXPIRED','ENGINEERING_EXPIRED']){
  assert.equal(customerError(Error(code)),legacyMessage);
  assert.equal(customerError(Error(code),{persistent:false}),legacyMessage);
  assert.equal(customerError(Error(code),{persistent:policy}),legacyMessage);
  assert.equal(customerError(Error(code),{persistent:true}),expiredMessage);
  for(const flag of ['cartUncertain','refreshRequired','acceptedReadRetry']){
   const error=Object.assign(Error(code),{[flag]:true});
   assert.equal(customerError(error,{persistent:true}),customerError(error));
   assert.notEqual(customerError(error,{persistent:true}),expiredMessage);
  }
 }
});
test('the actual form mount carries its fixed persistent policy into customer feedback',t=>{
 globals(t);
 for(const persistent of [false,true]){
  const form=Object.assign(new EventTarget(),{dataset:{filmPrintingForm:''},querySelector:()=>null,querySelectorAll:()=>[]});
  createFilmPrintingForm(form,{sessionOptions:{preparedMode:true,...(persistent?{clientPolicy:policy}:{})},checkoutForSession:()=>protocol});
  const flow=globalThis.BFLPrintJob.forForm(form);
  assert.equal(flow.errorMessage(Error('RESOURCE_EXPIRED'),{persistent:!persistent}),persistent?expiredMessage:legacyMessage);
  assert.match(flow.errorMessage(Object.assign(Error('RESOURCE_EXPIRED'),{cartUncertain:true})),/contact us before trying again/);
 }
});
test('a persistent cart-only mount retains expiry custody and supplies removal advice without issuing',async t=>{
 globals(t);let requests=0;
 let saved=JSON.stringify({state:'accepted',token:'bflr1_'+'a'.repeat(43),expires:Date.now()-1,generation:1,prepared_generation:1,operation:null,client_policy:policy,cart_revision:0});
 const original=saved;
 const flow=mountCustomerCart({persistent:{policy,run:fn=>fn(),assertInitial(){}},sessionOptions:{clientPolicy:policy,reloadStorage:{getItem:()=>saved,setItem:(_k,v)=>{saved=v;}},fetchImpl:()=>{requests++;throw Error('unexpected request');}},checkoutForSession:()=>protocol});
 await assert.rejects(flow.ready,/RESOURCE_EXPIRED/);
 assert.equal(saved,original);assert.equal(requests,0);
 assert.equal(flow.errorMessage(Error('RESOURCE_EXPIRED'),{persistent:false}),expiredMessage);
 assert.match(flow.errorMessage(Object.assign(Error('RESOURCE_EXPIRED'),{cartUncertain:true})),/contact us before trying again/);
});
test('the form deadline wrapper preserves uncertainty and read-retry flags after expiry',async()=>{
 for(const flag of [null,'cartUncertain','refreshRequired','acceptedReadRetry']){
  let now=100000;const choose=new EventTarget(),input=new EventTarget(),errorNode={textContent:'',style:{}},error=Object.assign(Error('RESOURCE_EXPIRED'),flag?{[flag]:true}:{});
  const form=Object.assign(new EventTarget(),{dataset:{filmPrintingForm:''},append(){},querySelector:selector=>selector==='[data-uploadly-fallback-button]'?choose:null,querySelectorAll:()=>[errorNode]});
  const context=vm.createContext({form,Event,queueMicrotask,Date:class extends Date{static now(){return now;}},location:{hostname:'bellows-film-printing-staging.myshopify.com'},document:{createElement:()=>input},BFLPrintJob:{customerError},
   createFilmPrintingForm:()=>({issue:async()=>({client_policy:policy,expires_at:now+1000}),snapshot:()=>({})}),persistent:{policy,assertCurrent(){throw error;}},policy});
  const flow=vm.runInContext(mountSource+'mountCustomerForm(form,{persistent,preparedCart:true});',context);
  await flow.ready;now+=1000;choose.dispatchEvent(new Event('click'));
  assert.equal(errorNode.textContent,customerError(error,{persistent:true}));
 }
});
