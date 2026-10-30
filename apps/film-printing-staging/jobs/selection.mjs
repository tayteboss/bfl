import {freeze,canonical,digest} from '../configuration/config.mjs';
import {normalizeSize,requireValue as need} from '../shipping/packing.mjs';
import {STORE} from '../configuration/schema.mjs';

export const CUSTOM_FORMULA_VERSION='bfl-custom-fibre-20261021-v1';
export const DARKROOM_BILLING_VERSION='bfl-darkroom-one-specification-per-copy-20261021-v1';
export const FULL_PRODUCT_VERSION='bfl-full-product-selection-v1';
export const LAB_VARIANT_VERSION='bfl-lab-variants-v1';
export const isLabVariantCatalog=catalog=>catalog?.product_semantics?.version===FULL_PRODUCT_VERSION&&catalog.product_semantics.variant_routing===LAB_VARIANT_VERSION;
export const isFullProductCatalog=catalog=>catalog?.product_semantics?.version===FULL_PRODUCT_VERSION;
export const TURNAROUND_FACTORS=Object.freeze({'Standard (4-5 days)':2,'Speedy (2-3 days)':3,'Rush (1 Day)':4});
const services=new Map([['photo','photo'],['photo printing','photo'],['photo prints','photo'],
  ['fine_art','fine_art'],['fine art printing','fine_art'],['fine arts','fine_art'],
  ['darkroom','darkroom'],['darkroom prints','darkroom']]);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const same=(a,b)=>canonical(a)===canonical(b);
const positive=(value,max)=>Number.isSafeInteger(value)&&value>0&&value<=max;
const exact=(value,keys)=>object(value)&&same(Object.keys(value).sort(),keys.slice().sort());
const formula=Object.freeze({version:CUSTOM_FORMULA_VERSION,base_mills:3000,area_mills:73,rounding:'source_js_math_round'});
const optionKeys={photo:['Turnaround'],fine_art:['Borders','Turnaround']};

function dimensions(value){
  need(exact(value,['width','height'])&&positive(value.width,44)&&positive(value.height,Number.MAX_SAFE_INTEGER),'INVALID_SIZE');
  return {width:value.width,height:value.height};
}
function customPrice(rule,custom,options){
  need(same(rule.formula,formula)&&rule.paper==='fibre-paper'&&rule.paper_input==='Fibre Paper','PRICE_UNAVAILABLE');
  need(Object.hasOwn(TURNAROUND_FACTORS,options.Turnaround),'UNSUPPORTED_OPTIONS');
  // Preserve the pinned source's Math.round expression, including binary-float
  // half-ties (13x500 is $477, not decimal half-up $478). Correcting that source
  // behavior separately must not silently change prices in the server alone.
  const area=BigInt(custom.width)*BigInt(custom.height);
  need(area<=BigInt(Number.MAX_SAFE_INTEGER),'PRICE_LIMIT');
  const dollars=Math.round(3+0.073*Number(area));
  need(Number.isSafeInteger(dollars)&&dollars>0,'PRICE_LIMIT');
  // Everything after the source's whole-dollar rounding uses integer cents.
  return BigInt(dollars)*100n*BigInt(TURNAROUND_FACTORS[options.Turnaround])/2n;
}

// Pure pricing/selection validation, not authentication or fulfillment approval.
// completedFileCount must come from the caller's owner-verified completed assets.
// canonicalInput is an internal mode for immutable stored jobs, never body input.
export function resolveSelection(catalog,input,{completedFileCount,canonicalInput=false}={}){
  need(catalog?.store===STORE&&catalog.currency==='USD'&&Array.isArray(catalog.rows)&&
    (catalog.version===undefined||typeof catalog.version==='string'&&catalog.version.length>0),'PRICE_UNAVAILABLE');
  const fullProduct=isFullProductCatalog(catalog);
  need(catalog.product_semantics===undefined||fullProduct,'PRICE_UNAVAILABLE');
  need(object(input),'INVALID_JOB');
  const service=services.get(typeof input.service==='string'?input.service.trim().toLowerCase():'');
  need(service,'UNSUPPORTED_SERVICE');
  need(service!=='darkroom'||fullProduct,'UNSUPPORTED_SERVICE');
  need(positive(input.copies,10000),'INVALID_COPIES');
  need(Number.isSafeInteger(completedFileCount)&&completedFileCount>=0&&completedFileCount<=1000&&
    (service==='darkroom'?completedFileCount===0:completedFileCount>0),'INVALID_COMPLETED_ASSETS');
  need(input.message==null||typeof input.message==='string'&&input.message.length<=2000,'INVALID_MESSAGE');
  const customRequested=typeof input.size==='string'&&input.size.trim().toLowerCase()==='custom';
  const mode=input.size_mode??(customRequested?'custom':'fixed');
  need(['fixed','custom'].includes(mode)&&(!customRequested||mode==='custom'),'INVALID_SIZE');
  need(mode!=='custom'||service==='fine_art'&&fullProduct,'UNSUPPORTED_SIZE');
  let custom=null,size;
  if(mode==='custom'){
    need(canonicalInput||customRequested,'INVALID_SIZE');
    custom=dimensions(input.custom_dimensions);
    size=[custom.width,custom.height].sort((a,b)=>a-b).join('x');
    if(canonicalInput)need(input.size===size,'INVALID_SIZE');
  }else{
    need(input.custom_dimensions==null,'INVALID_SIZE');
    size=normalizeSize(input.size);
    if(canonicalInput)need(input.size===size,'INVALID_SIZE');
  }
  const options=input.options??{};
  const keys=!fullProduct?Object.keys(options):service==='darkroom'?['Process','Borders','Turnaround','Negatives',...(['8x10','11x14'].includes(size)?['Scanning Options']:[])]:optionKeys[service];
  need(fullProduct||keys.every(k=>['Borders','Turnaround'].includes(k)),'UNSUPPORTED_OPTIONS');
  need(exact(options,keys)&&Object.values(options).every(v=>typeof v==='string'&&v.length>0&&v.length<=200),'UNSUPPORTED_OPTIONS');
  need(!fullProduct||Object.hasOwn(TURNAROUND_FACTORS,options.Turnaround),'UNSUPPORTED_OPTIONS');
  const candidates=mode==='custom'?catalog.custom_rules:catalog.rows;
  need(Array.isArray(candidates),'PRICE_UNAVAILABLE');
  const rows=candidates.filter(row=>row&&row.enabled===true&&row.physical===true&&row.service===service&&
    (mode==='custom'?row.size_mode==='custom':(row.size_mode??'fixed')==='fixed'&&row.size===size)&&
    (canonicalInput?row.paper:(Object.hasOwn(row,'paper_input')?row.paper_input:row.paper))===input.paper&&
    (canonicalInput?row.lab:(row.lab_input??row.lab))===input.lab&&same(row.options??{},options));
  need(rows.length===1,'PRICE_UNAVAILABLE');
  const row=rows[0];
  need(typeof row.variant_id==='string'&&/^\d+$/.test(row.variant_id)&&typeof row.paper==='string'&&row.paper.length>0&&
    row.paper.length<=200&&typeof row.lab==='string'&&row.lab.length>0&&row.lab.length<=200,'PRICE_UNAVAILABLE');
  let perUnit;
  const billingBasis=service==='darkroom'?'specification':'completed_files';
  if(service==='darkroom'){
    need(catalog.product_semantics?.darkroom_billing===DARKROOM_BILLING_VERSION&&row.billing_basis==='specification'&&
      !Object.hasOwn(row,'per_file_cents')&&positive(row.per_specification_cents,200000),'PRICE_UNAVAILABLE');
    perUnit=BigInt(row.per_specification_cents);
  }else if(mode==='custom'){
    need(catalog.product_semantics?.custom_formula===CUSTOM_FORMULA_VERSION,'PRICE_UNAVAILABLE');
    perUnit=customPrice(row,custom,options);
  }else{
    need((row.billing_basis??'completed_files')==='completed_files'&&!Object.hasOwn(row,'per_specification_cents')&&positive(row.per_file_cents,200000),'PRICE_UNAVAILABLE');
    perUnit=BigInt(row.per_file_cents);
  }
  const units=service==='darkroom'?1:completedFileCount,unit=perUnit*BigInt(units),total=unit*BigInt(input.copies);
  need(perUnit>0n&&perUnit<=200000n&&unit<=200000n&&total<=200000n,'PRICE_LIMIT');
  return freeze({spec:{service,size,...(fullProduct?{size_mode:mode,custom_dimensions:custom}:{}),paper:row.paper,lab:row.lab,
      options:{...options},message:input.message??'',copies:input.copies},
    variant_id:row.variant_id,file_count:completedFileCount,billing_basis:billingBasis,per_unit_cents:Number(perUnit),
    unit_price_cents:Number(unit),total_price_cents:Number(total),price_version:catalog.version??`price-${digest(catalog)}`});
}
