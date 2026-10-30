import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {resolveSelection} from '../jobs/selection.mjs';
import {extendProductCatalog} from '../pricing/product-catalog.mjs';

const root=new URL('../../../fixtures/film-printing/f05a/',import.meta.url);
const read=name=>readFileSync(new URL(name,root),'utf8');
const original=JSON.parse(read('proposed/price-catalog.proposed.json'));
const form=read('metafield-value.json'),script=read('source/film-service.js');
const labs=['Miami','Chicago','Orlando','Atlanta'];
// Synthetic label mapping for local price tests only: no location/origin,
// packing facts, live catalog publication or fulfillment approval is asserted.
const mapped={...original,rows:labs.flatMap(lab=>original.rows.map(row=>({...row,lab:lab.toLowerCase(),lab_input:lab})))};
const bundle=extendProductCatalog(mapped,form),catalog={...bundle.catalog,version:bundle.version};
const inputFor=row=>({service:row.service,size:row.size,paper:row.paper_input,lab:row.lab_input,options:{...row.options},copies:1,message:''});
const resolve=(input,files=1,c=catalog)=>resolveSelection(c,input,{completedFileCount:files});
const photo=catalog.rows.find(r=>r.service==='photo'&&r.size==='4x6'&&r.lab==='miami'&&r.options.Turnaround==='Standard (4-5 days)');
const dark=catalog.rows.find(r=>r.service==='darkroom'&&r.size==='8x10'&&r.lab==='miami'&&r.options.Process==='Black and White'&&r.options['Scanning Options']==='No'&&r.options.Turnaround==='Standard (4-5 days)');
const custom=(width=16,height=20,options={})=>({service:'Fine Arts',size:'Custom',size_mode:'custom',custom_dimensions:{width,height},paper:'Fibre Paper',lab:'Miami',
  options:{Borders:'Borderless (Edge-to-edge)',Turnaround:'Standard (4-5 days)',...options},copies:1,message:''});

test('source extension has every fixed/negative-delivery selection and preserves input catalog',()=>{
  assert.equal(original.rows.length,222);assert.equal(mapped.rows.length,888);
  assert.equal(catalog.rows.length,2184);assert.equal(catalog.rows.filter(r=>r.service==='darkroom').length,1296);
  assert.equal(catalog.custom_rules.length,36);
  assert.ok(catalog.rows.filter(r=>r.service==='darkroom').every(r=>r.lab!=='orlando'&&!Object.hasOwn(r,'per_file_cents')));
  assert.equal(mapped.custom_rules,undefined);assert.deepEqual(extendProductCatalog(mapped,form),bundle);
  assert.throws(()=>extendProductCatalog(mapped,form+' '),/SOURCE_REFRESH/);
  assert.throws(()=>extendProductCatalog({...mapped,provenance:{...mapped.provenance,semantics:'unknown'}},form),/SOURCE_REFRESH/);
});

test('all 888 fixed Photo/Fine Art rows retain captured golden prices for verified files and copies',()=>{
  let checked=0,ceilingRejected=0;
  for(const row of catalog.rows.filter(r=>r.service!=='darkroom'))for(const [files,copies] of [[1,1],[3,2]]){
    const golden=original.rows.find(r=>r.service===row.service&&r.size===row.size&&r.paper_input===row.paper_input&&JSON.stringify(r.options)===JSON.stringify(row.options));
    assert.ok(golden);const input={...inputFor(row),copies,price:1,file_count:999};
    if(golden.per_file_cents*files*copies>200000){assert.throws(()=>resolve(input,files),/PRICE_LIMIT/);ceilingRejected++;}
    else{
      const actual=resolve(input,files);assert.equal(actual.unit_price_cents,golden.per_file_cents*files);
      assert.equal(actual.total_price_cents,golden.per_file_cents*files*copies);
      assert.equal(actual.file_count,files);assert.equal(actual.billing_basis,'completed_files');checked++;
    }
  }
  assert.equal(checked+ceilingRejected,1776);assert.equal(ceilingRejected,12);
});

test('all 1296 Darkroom selections match captured size/process/scanning prices and bill copies without files',()=>{
  const prices={'8x10':[25,28],'11x14':[40,45],'12x16':[50,60],'16x20':[80,90]};
  const factors={'Standard (4-5 days)':1,'Speedy (2-3 days)':1.5,'Rush (1 Day)':2};
  for(const row of catalog.rows.filter(r=>r.service==='darkroom')){
    const base=prices[row.size][row.options.Process==='Color'?1:0];
    const expected=(base+(row.options['Scanning Options']==='Yes'?20:0))*factors[row.options.Turnaround]*100;
    const actual=resolve({...inputFor(row),copies:3},0);
    assert.equal(actual.per_unit_cents,expected);assert.equal(actual.unit_price_cents,expected);assert.equal(actual.total_price_cents,expected*3);
    assert.equal(actual.file_count,0);assert.equal(actual.billing_basis,'specification');assert.deepEqual(actual.spec.options,row.options);
    assert.equal(Object.hasOwn(actual.spec.options,'Scanning Options'),['8x10','11x14'].includes(row.size));
  }
});

test('Custom price matches actual captured function across widths, heights, turnaround and source options',()=>{
  const start=script.indexOf('  const getFineArtsCustomSizePrice ='),end=script.indexOf('  const syncCustomSizePrice =',start);
  assert.ok(start>0&&end>start);
  const originalPrice=vm.runInNewContext(script.slice(start,end)+'getFineArtsCustomSizePrice;');
  const factors={'Standard (4-5 days)':1,'Speedy (2-3 days)':1.5,'Rush (1 Day)':2};
  let checked=0;
  for(let width=1;width<=44;width++)for(const height of [1,7,11,20,44,60,500,1001])for(const rule of catalog.custom_rules){
    const input={...custom(width,height,rule.options),lab:rule.lab_input};
    const expected=originalPrice(width,height,'Fibre Paper')*factors[rule.options.Turnaround]*100;
    if(expected>200000)assert.throws(()=>resolve(input),/PRICE_LIMIT/);
    else {const actual=resolve(input);assert.equal(actual.unit_price_cents,expected);assert.deepEqual(actual.spec.custom_dimensions,{width,height});}
    checked++;
  }
  assert.equal(checked,12672);assert.equal(resolve(custom(1,1001)).unit_price_cents,7600);
  assert.equal(resolve(custom(1,500)).unit_price_cents,4000);
  assert.equal(resolve(custom(13,500)).unit_price_cents,47700); // source binary half-tie; decimal half-up would be $478
  const fixed=catalog.rows.find(r=>r.service==='fine_art'&&r.size==='16x20'&&r.paper==='fibre-paper'&&r.lab==='miami'&&r.options.Borders==='Borderless (Edge-to-edge)'&&r.options.Turnaround==='Standard (4-5 days)');
  assert.equal(resolve(custom()).unit_price_cents,2600);assert.equal(resolve(inputFor(fixed)).unit_price_cents,3000);
});

test('immutable canonical jobs re-resolve identically, including custom mode and preserved orientation',()=>{
  for(const [input,files] of [[inputFor(photo),2],[inputFor(dark),0],[{...custom(44,20),message:'Keep the subject centred.'},2]]){
    const first=resolve(input,files);
    const second=resolveSelection(catalog,first.spec,{completedFileCount:files,canonicalInput:true});
    assert.deepEqual(second,first);assert.ok(Object.isFrozen(first.spec.options));
  }
  const selected=resolve(custom(44,20));assert.equal(selected.spec.size,'20x44');
  assert.throws(()=>resolveSelection(catalog,{...selected.spec,size:'44x20'},{completedFileCount:1,canonicalInput:true}),/INVALID_SIZE/);
  assert.throws(()=>resolve({...custom(),size:'16x20'}),/INVALID_SIZE/);
  assert.throws(()=>resolve({...inputFor(photo),custom_dimensions:{width:4,height:6}}),/INVALID_SIZE/);
});

test('empty or claimed uploads cannot cross service boundaries and prices never come from browser fields',()=>{
  for(const count of [0,-1,0.5,NaN,1001])assert.throws(()=>resolve(inputFor(photo),count),/INVALID_COMPLETED_ASSETS/);
  for(const count of [1,2,-1])assert.throws(()=>resolve(inputFor(dark),count),/INVALID_COMPLETED_ASSETS/);
  const result=resolve({...inputFor(photo),price:0,per_file_cents:0,unit_price_cents:0,total:0,file_count:999},2);
  assert.equal(result.unit_price_cents,80);assert.equal(result.file_count,2);
  assert.throws(()=>resolve({...inputFor(dark),lab:'Orlando'},0),/PRICE_UNAVAILABLE/);
});

test('strict options reject unavailable papers/scanning, omitted negatives, unknown choices and ambiguous catalogs',()=>{
  assert.throws(()=>resolve({...custom(),paper:'Matte'}),/PRICE_UNAVAILABLE/);
  for(const width of [0,-1,1.1,45,Infinity,'16'])assert.throws(()=>resolve(custom(width,20)),/INVALID_SIZE/);
  for(const height of [0,-1,1.1,Infinity,'20',Number.MAX_SAFE_INTEGER+1])assert.throws(()=>resolve(custom(16,height)),/INVALID_SIZE/);
  assert.throws(()=>resolve(custom(44,Number.MAX_SAFE_INTEGER)),/PRICE_LIMIT/);
  for(const options of [{},{...photo.options,Process:'Color'},{Turnaround:'Rush'}])assert.throws(()=>resolve({...inputFor(photo),options}),/UNSUPPORTED_OPTIONS/);
  const noNegatives={...dark.options};delete noNegatives.Negatives;
  assert.throws(()=>resolve({...inputFor(dark),options:noNegatives},0),/UNSUPPORTED_OPTIONS/);
  assert.throws(()=>resolve({...inputFor(dark),options:{...dark.options,Negatives:'Courier'}},0),/PRICE_UNAVAILABLE/);
  const large=catalog.rows.find(r=>r.service==='darkroom'&&r.size==='12x16');
  assert.throws(()=>resolve({...inputFor(large),options:{...large.options,'Scanning Options':'Yes'}},0),/UNSUPPORTED_OPTIONS/);
  assert.throws(()=>resolve(inputFor(photo),1,{...catalog,rows:[...catalog.rows,photo]}),/PRICE_UNAVAILABLE/);
  assert.throws(()=>resolve(custom(),1,{...catalog,custom_rules:catalog.custom_rules.map(r=>({...r,formula:{...r.formula,area_mills:1}}))}),/PRICE_UNAVAILABLE/);
  assert.throws(()=>resolve(inputFor(dark),0,{...catalog,product_semantics:{}}),/PRICE_UNAVAILABLE/);
});

test('copies, complete-job ceiling and note bounds remain finite',()=>{
  assert.equal(resolve({...inputFor(photo),copies:5000}).total_price_cents,200000);
  assert.throws(()=>resolve({...inputFor(photo),copies:5001}),/PRICE_LIMIT/);
  assert.equal(resolve({...inputFor(dark),copies:80},0).total_price_cents,200000);
  assert.throws(()=>resolve({...inputFor(dark),copies:81},0),/PRICE_LIMIT/);
  for(const copies of [0,-1,1.5,'1',10001,Infinity])assert.throws(()=>resolve({...inputFor(photo),copies}),/INVALID_COPIES/);
  assert.equal(resolve({...inputFor(photo),message:'x'.repeat(2000)}).spec.message.length,2000);
  for(const message of ['x'.repeat(2001),{},1])assert.throws(()=>resolve({...inputFor(photo),message}),/INVALID_MESSAGE/);
});

test('legacy private catalog and job shape remain readable without full-product authority',()=>{
  const legacy=JSON.parse(readFileSync(new URL('../../../fixtures/film-printing/f06p-integration/engineering-catalog-proposal.json',import.meta.url),'utf8'));
  const input={service:'photo',size:'4x6',paper:'engineering-f06p-paper',lab:'miami',options:{},message:'',copies:4};
  const actual=resolveSelection(legacy,input,{completedFileCount:3,canonicalInput:true});
  assert.deepEqual(actual.spec,input);assert.equal(actual.unit_price_cents,120);assert.equal(actual.total_price_cents,480);
  assert.match(actual.price_version,/^price-[a-f0-9]{64}$/);
  assert.deepEqual(resolveSelection(legacy,input,{completedFileCount:3}).spec,input);
});
