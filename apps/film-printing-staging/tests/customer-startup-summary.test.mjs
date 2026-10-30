import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const service=readFileSync(new URL('../../../assets/film-service.js',import.meta.url),'utf8');
const customer=readFileSync(new URL('../theme/customer-form.js',import.meta.url),'utf8');
const helper=service.slice(service.indexOf('  const isActivePrintOption ='),service.indexOf('  const getVisibleFieldsets ='));
const render=service.slice(service.indexOf('  const renderSummary = () => {'),service.indexOf('  // --- Total calc ---'));
const calculate=service.slice(service.indexOf('  function calculateTotal()'),service.indexOf('  // --- Conditions'));
const mount=customer.slice(customer.indexOf('export function mountCustomerForm('),customer.indexOf('// Other storefront pages')).replace('export function','function');

test('first owned form mount recalculates the stale hidden 40-cent default before session initialization settles',()=>{
 let owned=false,issues=0;const output=[],top={},bottom={},choose=new EventTarget(),input=new EventTarget();
 const block={visible:false,dataset:{forService:'Photo Prints'}},label={visible:true,classList:{contains:()=>false},querySelector:()=>null};
 const fieldset={visible:true,dataset:{group:'Sizes'},getAttribute:()=>null};
 const radio={name:'sizes',value:'4×6',checked:true,disabled:false,dataset:{price:0.4},closest:s=>s==='label'?label:s==='fieldset'?fieldset:s==='.service-groups-wrapper'?block:null};
 fieldset.querySelector=selector=>selector.includes('input')?radio:null;fieldset.querySelectorAll=()=>[radio];
 const form=Object.assign(new EventTarget(),{dataset:{filmPrintingForm:''},append(){},querySelectorAll:selector=>selector.startsWith('fieldset')?[fieldset]:selector.startsWith('input')?[radio]:[],querySelector:selector=>selector==='[data-uploadly-fallback-button]'?choose:null});
 const context=vm.createContext({form,printJobFlow:()=>owned?{}:null,isVisible:node=>node?.visible!==false,basePrice:0,total:0,syncCustomSizePrice(){},getQuantity:()=>1,getUploadedFilesCount:()=>owned?0:1,usesPhysicalNegatives:()=>false,getSizeShippingHandle:()=>null,getCustomSizeValidation:()=>({active:false}),
   osList:{innerHTML:''},bottomOsList:{innerHTML:''},formatMoney:n=>n.toFixed(2),createRow:(list,label,value,price)=>output.push({label,value,price}),totalDisplay:top,bottomTotalDisplay:bottom,setErrorMessage(){},updateOrderSummaryVisibility(){},
   location:{hostname:'bellows-film-printing-staging.myshopify.com'},document:{createElement:()=>input},Event,queueMicrotask,BFLPrintJob:{customerError:()=> 'error'},
   createFilmPrintingForm(){owned=true;return {issue(){issues++;return new Promise(()=>{});},snapshot:()=>({pending:0,failed:0,displayCompletedCount:0,completedAssetIds:[]})};}});
 vm.runInContext(helper+render+calculate+'calculateTotal();',context);assert.equal(top.textContent,'0.40');assert.ok(output.some(row=>row.label==='Sizes'));
 form.addEventListener('bfl:uploads-changed',()=>{output.length=0;vm.runInContext('calculateTotal();',context);});
 vm.runInContext(mount+'mountCustomerForm(form,{until:Date.now()+60000});',context);
 assert.equal(top.textContent,'0.00');assert.equal(bottom.textContent,'0.00');assert.ok(!output.some(row=>row.label==='Sizes'));
 assert.equal(choose.disabled,true);assert.equal(issues,1);
});
