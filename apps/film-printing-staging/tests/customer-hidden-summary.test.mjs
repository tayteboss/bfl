import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../../../assets/film-service.js',import.meta.url),'utf8');
const helper=source.slice(source.indexOf('  const isActivePrintOption ='),source.indexOf('  const getVisibleFieldsets ='));
const render=source.slice(source.indexOf('  const renderSummary = () => {'),source.indexOf('  // --- Total calc ---'));
const calculate=source.slice(source.indexOf('  function calculateTotal()'),source.indexOf('  // --- Conditions'));
const classes=()=>{const values=new Set();return {contains:k=>values.has(k),add:k=>values.add(k),remove:k=>values.delete(k)};};
function option(group,value,price,{service,visible=true,blockVisible=true,disabled=false,unavailable=false,name=group.toLowerCase()}={}){
 const label={visible:true,classList:classes(),querySelector:()=>null};if(unavailable)label.classList.add('is-unavailable');
 const block=service?{visible:blockVisible,dataset:{forService:service}}:null;
 const fs={visible,dataset:{group},getAttribute:()=>null};
 const radio={name,value,disabled,checked:true,dataset:{price},closest:selector=>selector==='label'?label:selector==='fieldset'?fs:selector==='.service-groups-wrapper'?block:null};
 fs.querySelector=selector=>selector.includes('input')?radio:null;fs.querySelectorAll=()=>[radio];return {radio,fs};
}
function summaryFixture({service=null,owned=true,rows=[]}={}){
 const output=[],top={},bottom={};const chosen=service?option('Service',service,0).radio:null;
 const form={querySelectorAll:selector=>selector.startsWith('fieldset')?rows.map(r=>r.fs):rows.map(r=>r.radio),querySelector:selector=>selector.includes('name="service"')?chosen:selector.includes('Turnaround')?rows.find(r=>r.radio.name==='properties[Turnaround]')?.radio:null};
 const context={form,printJobFlow:()=>owned?{}:null,isVisible:node=>node?.visible!==false,basePrice:0,total:0,syncCustomSizePrice(){},getQuantity:()=>1,getUploadedFilesCount:()=>1,usesPhysicalNegatives:()=>false,getSizeShippingHandle:()=>null,getCustomSizeValidation:()=>({active:false}),
  osList:{innerHTML:''},bottomOsList:{innerHTML:''},formatMoney:n=>n.toFixed(2),createRow:(list,label,value,price)=>output.push({list,label,value,price}),totalDisplay:top,bottomTotalDisplay:bottom,setErrorMessage(){},updateOrderSummaryVisibility(){}};
 vm.runInNewContext(helper+render+calculate+'calculateTotal();',context);return {output,top,bottom};
}
test('no selected service excludes stale default size even when its own label appears visible',()=>{
 const f=summaryFixture({rows:[option('Location','Orlando',0),option('Sizes','4×6',0.4,{service:'Photo Prints',blockVisible:false})]});
 assert.equal(f.top.textContent,'0.00');assert.equal(f.bottom.textContent,'0.00');
 assert.deepEqual(f.output.filter(r=>r.label!=='Total').map(r=>[r.label,r.value]),[['Location','Orlando'],['Location','Orlando']]);
});
test('only active visible service options appear in both summaries and turnaround totals',()=>{
 const f=summaryFixture({service:'Fine Arts',rows:[option('Sizes','4×6',0.4,{service:'Photo Prints'}),option('Sizes','16×20',25,{service:'Fine Arts'}),option('Paper','Fibre Paper',5,{service:'Fine Arts'}),option('Paper','Hidden paper',999,{service:'Fine Arts',visible:false}),option('Borders','Unavailable',99,{service:'Fine Arts',unavailable:true}),option('Scanning Options','Yes',20,{service:'Darkroom Prints'}),option('Delivery Options','Speedy (2-3 days)',0,{name:'properties[Turnaround]'})]});
 assert.equal(f.top.textContent,'45.00');assert.equal(f.bottom.textContent,'45.00');
 assert.deepEqual(f.output.filter(r=>r.label==='Sizes').map(r=>r.value),['16×20','16×20']);
 assert.deepEqual(f.output.filter(r=>r.label==='Paper').map(r=>r.value),['Fibre Paper','Fibre Paper']);
 assert.ok(!f.output.some(r=>['Borders','Scanning Options'].includes(r.label)));
});
test('hidden default summary behavior outside the owned printing flow stays unchanged',()=>{
 const f=summaryFixture({owned:false,rows:[option('Sizes','4×6',0.4,{service:'Photo Prints',blockVisible:false,visible:false})]});
 assert.equal(f.top.textContent,'0.40');assert.equal(f.output.filter(r=>r.label==='Sizes').length,2);
});
const conditions=source.slice(source.indexOf('  function applyConditions()'),source.indexOf('  // React to any radio change'));
const normalized=source.slice(source.indexOf('  const normKey ='),source.indexOf('  // --- Handle service change'));
test('unavailable printing services are natively disabled and changing location clears an invalid active block',()=>{
 for(const owned of [true,false]){
  const location=option('Location','Orlando',0,{name:'location'}).radio,photo=option('Service','Photo Prints',0,{name:'service'}).radio,dark=option('Service','Darkroom Prints',0,{name:'service'}).radio;dark.checked=false;
  dark.dataset.showIf=JSON.stringify({location:['Miami','Chicago','Atlanta']});const radios=[location,photo,dark];
  const blocks=['Photo Prints','Darkroom Prints'].map(forService=>({dataset:{forService},style:{display:'none'}}));
  const form={hasAttribute:()=>owned,querySelector:()=>radios.find(r=>r.name==='service'&&r.checked)??null,querySelectorAll:selector=>selector==='[data-show-if]'?[]:selector.includes(':checked')?radios.filter(r=>r.checked):radios};
  const context=vm.createContext({form,serviceBlocks:blocks,printJobFlow:()=>owned?{}:null,clearErrorsOnHidden(){},applyDefaultsInContainer(){},calculateTotal(){},console});
  vm.runInContext(normalized+conditions+'applyConditions();',context);
  assert.equal(dark.disabled,owned);assert.equal(photo.checked,true);assert.equal(photo.disabled,false);
  if(owned){assert.equal(blocks[0].style.display,'flex');assert.equal(blocks[1].style.display,'none');}
  location.value='Miami';vm.runInContext('applyConditions();',context);assert.equal(dark.disabled,false);
  photo.checked=false;dark.checked=true;location.value='Orlando';vm.runInContext('applyConditions();',context);
  assert.equal(dark.checked,false);assert.equal(dark.disabled,owned);if(owned)assert.ok(blocks.every(b=>b.style.display==='none'));
 }
});
