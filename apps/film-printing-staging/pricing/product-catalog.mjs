// Operator-only extension of an already authenticated, reviewed fixed catalog.
// This does not establish lab routes, packing facts, merchant physical counts,
// shipping eligibility or production approval. Never accept it through HTTP.
import {canonical,freeze} from '../configuration/config.mjs';
import {normalizeSize,requireValue as need} from '../shipping/packing.mjs';
import {CUSTOM_FORMULA_VERSION,DARKROOM_BILLING_VERSION,FULL_PRODUCT_VERSION} from '../jobs/selection.mjs';
import {validateForm,perFileCents,cents,sha256,SEMANTICS} from './prepare.mjs';

export const NEGATIVE_DELIVERY=Object.freeze(['Already at Bellows','Drop Off','Mail In']);
const same=(a,b)=>canonical(a)===canonical(b);
const SCRIPT='154bd0fd1087fc10e102f9f6366b3a27affecfe200765d35f5437d761ccc4f27';
const SECTION='4b6d40fef89ce1dfee7109ed747bee3b8ccf4c02e81d8feb1e281bbf17c660cd';
const TURNAROUNDS=['Rush (1 Day)','Speedy (2-3 days)','Standard (4-5 days)'];

export function extendProductCatalog(catalog,formValue){
  const provenance=catalog?.provenance,capture=provenance?.capture;
  need(typeof formValue==='string'&&provenance?.semantics===SEMANTICS&&capture?.metafield?.sha256===sha256(formValue)&&
    capture?.theme?.script_sha256===SCRIPT&&capture.theme.section_sha256===SECTION,'SOURCE_REFRESH_CHANGED_OR_EXPIRED');
  need(Array.isArray(catalog.rows)&&catalog.rows.length>0&&!catalog.custom_rules&&!catalog.product_semantics,'PRICE_UNAVAILABLE');
  const form=validateForm(formValue),labs=new Map();
  for(const row of catalog.rows){
    need(['photo','fine_art'].includes(row.service)&&['Miami','Chicago','Orlando','Atlanta'].includes(row.lab_input)&&
      typeof row.lab==='string'&&typeof row.variant_id==='string'&&row.physical===true,'PRICE_UNAVAILABLE');
    const lab={lab:row.lab,lab_input:row.lab_input,variant_id:row.variant_id};
    need(!labs.has(row.lab_input)||same(labs.get(row.lab_input),lab),'PRICE_UNAVAILABLE');
    labs.set(row.lab_input,lab);
  }
  const rows=structuredClone(catalog.rows),custom_rules=[];
  const art=form['Fine Arts'],darkroom=form['Darkroom Prints'];
  const fibre=art.Paper.options.find(p=>p.label==='Fibre Paper');
  need(fibre&&!fibre.show_if&&fibre.price===0&&
    art.Paper.options.filter(p=>p!==fibre).every(p=>p.show_if?.sizes&&!p.show_if.sizes.includes('Custom')),'SOURCE_SCHEMA');
  // The Custom formula and Negatives labels are from the pinned section/script;
  // the form supplies applicable paper/border/turnaround-independent components.
  for(const lab of labs.values())for(const border of art.Borders.options)for(const Turnaround of TURNAROUNDS){
    need(border.price===0,'SOURCE_SCHEMA');
    custom_rules.push({enabled:true,physical:true,...lab,service:'fine_art',size_mode:'custom',paper:'fibre-paper',paper_input:'Fibre Paper',
      options:{Borders:border.label,Turnaround},formula:{version:CUSTOM_FORMULA_VERSION,base_mills:3000,area_mills:73,rounding:'source_js_math_round'}});
  }
  for(const lab of labs.values()){
    if(!darkroom.show_if.location.includes(lab.lab_input))continue;
    for(const size of darkroom.Sizes.options)for(const process of darkroom.Process.options)for(const paper of darkroom.Paper.options)
      for(const border of darkroom.Borders.options)for(const Turnaround of TURNAROUNDS)for(const Negatives of NEGATIVE_DELIVERY){
        const scanning=darkroom['Scanning Options'];
        const scans=scanning.show_if.sizes.includes(size.label)?scanning.options:[null];
        const sizePrice=size.price_overrides?.process?.[process.label]??size.price;
        for(const scan of scans){
          const options={Process:process.label,Borders:border.label,Turnaround,Negatives,...(scan?{'Scanning Options':scan.label}:{})};
          rows.push({enabled:true,physical:true,...lab,service:'darkroom',size:normalizeSize(size.label),
            paper:paper.label.toLowerCase().replaceAll(' ','-'),paper_input:paper.label,options,billing_basis:'specification',
            per_specification_cents:perFileCents([sizePrice,process.price,paper.price,border.price,scan?.price??0].map(cents),Turnaround)});
        }
      }
  }
  const next={...structuredClone(catalog),product_semantics:{version:FULL_PRODUCT_VERSION,custom_formula:CUSTOM_FORMULA_VERSION,darkroom_billing:DARKROOM_BILLING_VERSION},rows,custom_rules};
  delete next.version;
  const key=r=>canonical([r.service,r.size??r.size_mode,r.paper_input,r.lab_input,r.options]);
  need(new Set(rows.map(key)).size===rows.length&&new Set(custom_rules.map(key)).size===custom_rules.length,'DUPLICATE_CATALOG_ROW');
  rows.sort((a,b)=>key(a).localeCompare(key(b)));custom_rules.sort((a,b)=>key(a).localeCompare(key(b)));
  const value=canonical(next);
  return freeze({catalog:next,value,version:`price-${sha256(value)}`});
}
