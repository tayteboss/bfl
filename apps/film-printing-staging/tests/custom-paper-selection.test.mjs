import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import '../theme/film-printing-job.js';
import {expandFullProductCatalog} from '../pricing/compact-catalog.mjs';
import {resolveSelection} from '../jobs/selection.mjs';
const source=readFileSync(new URL('../../../assets/film-service.js',import.meta.url),'utf8');
const conditions=source.slice(source.indexOf('  function applyConditions()'),source.indexOf('  // React to any radio change'));
const normalized=source.slice(source.indexOf('  const normKey ='),source.indexOf('  // --- Handle service change'));
const classes=()=>{const values=new Set();return {contains:k=>values.has(k),add:k=>values.add(k),remove:k=>values.delete(k)};};
function radio(name,value,{showIf,defaultIf,checked=false}={}){
 const label={classList:classes(),querySelector:()=>null};
 return {name,value,checked,disabled:false,dataset:{...(showIf?{showIf:JSON.stringify(showIf)}:{}),...(defaultIf?{defaultIf:JSON.stringify(defaultIf)}:{})},closest:()=>label};
}
function conditionsFixture(owned=true){
 const size=radio('sizes','11” × 14”',{checked:true}),matte=radio('paper','Matte',{checked:true,showIf:{sizes:['11” × 14”','16” × 20”','20” × 24”','20” × 30”','24” × 30”']}}),
  fibre=radio('paper','Fibre Paper',{defaultIf:{sizes:['30” × 40”','40” × 50”','44” × 60”']}}),radios=[size,matte,fibre];
 const form={hasAttribute:()=>owned,querySelector:()=>null,querySelectorAll:selector=>selector==='[data-show-if]'?[]:selector.includes(':checked')?radios.filter(r=>r.checked):radios};
 const context=vm.createContext({form,serviceBlocks:[],printJobFlow:()=>owned?{}:null,clearErrorsOnHidden(){},applyDefaultsInContainer(){},calculateTotal(){},console});
 vm.runInContext(normalized+conditions,context);
 return {size,matte,fibre,apply:()=>vm.runInContext('applyConditions();',context)};
}
test('Custom clears an unavailable fixed paper, keeps it natively inert, and does not invent a Fibre default',()=>{
 const f=conditionsFixture();f.apply();assert.equal(f.matte.checked,true);assert.equal(f.matte.disabled,false);
 f.size.value='Custom';f.apply();assert.equal(f.matte.checked,false);assert.equal(f.matte.disabled,true);assert.equal(f.matte.closest().classList.contains('is-unavailable'),true);assert.equal(f.fibre.checked,false);assert.equal(f.fibre.disabled,false);
 // Native clicks/keyboard cannot check the disabled input or displace Fibre.
 f.fibre.checked=true;if(!f.matte.disabled){f.fibre.checked=false;f.matte.checked=true;}f.apply();assert.equal(f.fibre.checked,true);assert.equal(f.matte.checked,false);
 f.size.value='11” × 14”';f.apply();assert.equal(f.matte.disabled,false);assert.equal(f.matte.closest().classList.contains('is-unavailable'),false);
});
test('leaving a conditional Fibre default does not re-enable a Custom-ineligible paper',()=>{
 const f=conditionsFixture();f.size.value='30” × 40”';f.apply();assert.equal(f.fibre.checked,true);assert.equal(f.matte.disabled,true);
 f.size.value='Custom';f.apply();assert.equal(f.matte.dataset.lockedByDefaultIf,undefined);assert.equal(f.matte.disabled,true);assert.equal(f.fibre.checked,true);
 f.size.value='11” × 14”';f.apply();assert.equal(f.matte.disabled,false);
});
test('non-owned shared form availability remains unchanged',()=>{
 const f=conditionsFixture(false);f.size.value='Custom';f.apply();assert.equal(f.matte.disabled,false);assert.equal(f.matte.checked,false);assert.equal(f.matte.closest().classList.contains('is-unavailable'),true);
});
const pricing=source.slice(source.indexOf('  const getFineArtsCustomSizePrice ='),source.indexOf('  const osWrapper ='));
const calculate=source.slice(source.indexOf('  function calculateTotal()'),source.indexOf('  // --- Conditions'));
function preview({paper=null,owned=true}={}){
 const custom={dataset:{price:0},closest:()=>({querySelector:()=>null})},turnaround={value:'Speedy (2-3 days)',dataset:{price:0}},top={},bottom={};
 const form={querySelector:selector=>selector.includes('[value="Custom"]')?custom:selector.includes('name="paper"')?paper:selector.includes('Turnaround')?turnaround:null,querySelectorAll:()=>[custom,turnaround]};
 const context={form,printJobFlow:()=>owned?{}:null,isActivePrintOption:r=>!r.disabled&&!r.unavailable,getCustomSizeValidation:()=>({active:true,valid:true,width:37,height:20}),basePrice:0,total:0,
  getQuantity:()=>2,getUploadedFilesCount:()=>1,usesPhysicalNegatives:()=>false,totalDisplay:top,bottomTotalDisplay:bottom,formatMoney:v=>v.toFixed(2),setErrorMessage(){},renderSummary(){},updateOrderSummaryVisibility(){}};
 vm.runInNewContext(pricing+calculate+'calculateTotal();',context);return {price:custom.dataset.price,total:top.textContent,bottom:bottom.textContent};
}
test('owned Custom never displays the legacy non-Fibre price for missing or unavailable paper',()=>{
 for(const paper of [null,{value:'Matte'},{value:'Fibre Paper',disabled:true},{value:'Fibre Paper',unavailable:true}])assert.deepEqual(preview({paper}),{price:0,total:'0.00',bottom:'0.00'});
 assert.deepEqual(preview({paper:{value:'Fibre Paper'}}),{price:57,total:'171.00',bottom:'171.00'});
 assert.deepEqual(preview({owned:false}),{price:42,total:'126.00',bottom:'126.00'});
});
function selectionFixture(paper){
 const values={'[name="service"]:checked':{value:'Fine Arts'},'[name="location"]:checked':{value:'Atlanta'},'[name="quantity"]':{value:'2'},'[name="properties[Turnaround]"]:checked':{value:'Speedy (2-3 days)'},'[data-custom-size-input="width"]':{value:'37'},'[data-custom-size-input="height"]':{value:'20'}};
 const groups={Sizes:[{value:'Custom'}],Paper:paper?[paper]:[],Borders:[{value:'Borderless (Edge-to-edge)'}]};
 return {querySelector:s=>values[s]??null,querySelectorAll:s=>groups[/data-group="([^"]+)"/.exec(s)?.[1]]??[]};
}
const uploads={snapshot:()=>({completedAssetIds:['asset-one'],pending:0,failed:0})};
test('missing, wrong or unavailable Custom paper cannot prepare or add an immutable job',async()=>{
 for(const paper of [null,{value:'Matte'},{value:'Fibre Paper',disabled:true},{value:'Fibre Paper',closest:s=>s==='label'?{classList:{contains:()=>true}}:null}]){
  let preparations=0,adds=0;
  const controller=globalThis.BFLPrintJob.createPreparedController({read:()=>globalThis.BFLPrintJob.readSelection(selectionFixture(paper),uploads),prepare:async()=>{preparations++;},cancelPreparation(){},addPrepared:async()=>{adds++;}});
  await assert.rejects(controller.prepare(),/SELECTION_INCOMPLETE/);await assert.rejects(controller.submit(),/SELECTION_INCOMPLETE/);assert.equal(preparations,0);assert.equal(adds,0);
 }
});
test('explicit Fibre Custom preview agrees with the exact pinned catalog, and Matte has no Custom price row',()=>{
 const wire=JSON.parse(readFileSync(new URL('../../../fixtures/film-printing/full-product-lab-routing-20261030/engineering-catalog-proposal.json',import.meta.url),'utf8'));
 const catalog=expandFullProductCatalog(wire);
 const selection=globalThis.BFLPrintJob.readSelection(selectionFixture({value:'Fibre Paper'}),uploads),priced=resolveSelection(catalog,selection,{completedFileCount:1});
 assert.equal(priced.per_unit_cents,8550);assert.equal(priced.total_price_cents,17100);assert.equal(preview({paper:{value:'Fibre Paper'}}).total,(priced.total_price_cents/100).toFixed(2));
 assert.throws(()=>resolveSelection(catalog,{...selection,paper:'Matte'},{completedFileCount:1}),/PRICE_UNAVAILABLE/);
});
