// Offline operator preparation only. Never imported by a browser or HTTP route.
// Input provenance is an operator custody record, not proof supplied by a customer.
import {createHash} from 'node:crypto';
import {canonical, freeze} from '../configuration/config.mjs';
import {normalizeSize, requireValue as need} from '../shipping/packing.mjs';
import {STORE} from '../configuration/schema.mjs';

export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const SEMANTICS = 'bfl-live-20261021-per-image-v1';
// A changed script/renderer requires an actual semantic review, never auto-learning
// prices from the browser. These are fresh read-only live-theme capture hashes.
const SCRIPT = '154bd0fd1087fc10e102f9f6366b3a27affecfe200765d35f5437d761ccc4f27';
const SECTION = '4b6d40fef89ce1dfee7109ed747bee3b8ccf4c02e81d8feb1e281bbf17c660cd';
export const TURNAROUNDS = Object.freeze({'Rush (1 Day)':2,'Speedy (2-3 days)':1.5,'Standard (4-5 days)':1});
export const LABS = Object.freeze(['Miami','Chicago','Orlando','Atlanta']);
const labels = sides => sides.map(([a,b])=>`${a}” × ${b}”`);
const photoSizes = labels([[3.5,5],[4,6],[5,7],[8,10],[8,12]]);
const artSizes = labels([[11,14],[16,20],[20,24],[20,30],[24,30],[30,40],[40,50],[44,60]]);
const papers = ['Matte','Luster','Glossy','Fibre Paper'];
const borders = ['Borderless (Edge-to-edge)','Borders (0.5” white)','Borders (1” white)'];
const shape = {
  'Photo Prints':{Sizes:photoSizes},
  'Fine Arts':{Sizes:[...artSizes,'Custom'],Paper:papers,Borders:borders},
  'Darkroom Prints':{Process:['Color','Black and White'],Sizes:labels([[8,10],[11,14],[12,16],[16,20]]),Paper:['RC Matte','RC Luster'],Borders:borders.slice(0,2),'Scanning Options':['Yes','No']},
};
const object = v => v !== null && typeof v==='object' && !Array.isArray(v);
const keys = (v,required,optional=[]) => {
  need(object(v) && required.every(k=>Object.hasOwn(v,k)) && Object.keys(v).every(k=>[...required,...optional].includes(k)), 'SOURCE_SCHEMA');
};
const equal = (a,b) => canonical(a)===canonical(b);
const text = v => typeof v==='string' && v.trim().length>0 && v.length<=5000;
const hash = v => typeof v==='string' && /^[a-f0-9]{64}$/.test(v);

// JSON.parse alone silently accepts duplicate keys. Scan the already syntax-checked
// JSON to reject those, including escaped-equivalent keys, before using any values.
export function parseStrictJson(raw) {
  need(typeof raw==='string' && Buffer.byteLength(raw)<=262144,'SOURCE_SIZE');
  let result; try {result=JSON.parse(raw);} catch {throw Error('SOURCE_JSON');}
  let i=0;
  const ws=()=>{while(/\s/.test(raw[i]??'') && i<raw.length)i++;};
  const string=()=>{const start=i++;while(i<raw.length){if(raw[i]==='\\'){i+=2;continue;}if(raw[i++]==='"')return JSON.parse(raw.slice(start,i));}throw Error('SOURCE_JSON');};
  function scan(depth=0) {
    need(depth<=32,'SOURCE_DEPTH');ws();
    if(raw[i]==='{') {
      i++;ws();const seen=new Set();
      if(raw[i]==='}') {i++;return;}
      while(true) {
        ws();const key=string();need(!seen.has(key) && !['__proto__','constructor','prototype'].includes(key),'DUPLICATE_OR_UNSAFE_KEY');seen.add(key);
        ws();i++;scan(depth+1);ws();if(raw[i++]==='}')return;
      }
    }
    if(raw[i]==='[') {
      i++;ws();if(raw[i]===']'){i++;return;}
      while(true){scan(depth+1);ws();if(raw[i++]===']')return;}
    }
    if(raw[i]==='"'){string();return;}
    while(i<raw.length && !/[\s,}\]]/.test(raw[i]))i++;
  }
  scan();return result;
}

export function cents(value) {
  need(typeof value==='number' && Number.isFinite(value) && value>=0 && !Object.is(value,-0),'UNSAFE_MONEY');
  const match=/^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  need(match,'UNSAFE_MONEY');
  const n=BigInt(match[1])*100n+BigInt((match[2]??'').padEnd(2,'0'));
  need(n<=200000n,'UNSAFE_MONEY');return Number(n);
}

function condition(value, choices) {
  need(object(value) && Object.keys(value).length===1,'SOURCE_CONDITION');
  const [key,values]=Object.entries(value)[0];
  need(choices[key] && Array.isArray(values) && values.length>0 && new Set(values).size===values.length && values.every(v=>choices[key].includes(v)),'SOURCE_CONDITION');
}
const matches = (condition, selected) => !condition || Object.entries(condition).every(([k,vs])=>vs.includes(selected[k]));
export function availableOptions(group, selected) {
  const active=group.options.filter(o=>o.default_if && matches(o.default_if,selected));
  need(active.length<=1,'CONFLICTING_DEFAULTS');
  need(!active.length || matches(active[0].show_if,selected),'HIDDEN_DEFAULT');
  return group.options.filter(o=>matches(o.show_if,selected) && (!active.length || o===active[0]));
}

export function validateForm(raw) {
  const form=parseStrictJson(raw);keys(form,Object.keys(shape));
  for(const [service,groups] of Object.entries(shape)) {
    const s=form[service];keys(s,['description',...Object.keys(groups)],service==='Darkroom Prints'?['show_if']:[]);
    need(text(s.description),'SOURCE_TEXT');
    if(s.show_if)condition(s.show_if,{location:LABS});
    for(const [name,expected] of Object.entries(groups)) {
      const group=s[name];keys(group,['options'],['description','sub_title','accordion_title','accordion_sub_title','feature_image','show_if']);
      for(const [k,v] of Object.entries(group))if(!['options','show_if'].includes(k))need(text(v),'SOURCE_TEXT');
      const choices=service==='Darkroom Prints'?{sizes:groups.Sizes,process:groups.Process}:{sizes:groups.Sizes};
      if(group.show_if) {
        need(service==='Darkroom Prints' && name==='Scanning Options','UNREVIEWED_GROUP_CONDITION');condition(group.show_if,choices);
      }
      need(Array.isArray(group.options) && equal(group.options.map(o=>o?.label),expected),'UNKNOWN_MISSING_OR_DUPLICATE_OPTION');
      let defaults=0;
      for(const option of group.options) {
        keys(option,['label','price'],['default','show_if','default_if','price_overrides','description','description_image']);
        cents(option.price);
        for(const k of ['description','description_image'])if(Object.hasOwn(option,k))need(text(option[k]),'SOURCE_TEXT');
        if(Object.hasOwn(option,'default')){need(typeof option.default==='boolean','SOURCE_DEFAULT');if(option.default)defaults++;}
        for(const k of ['show_if','default_if'])if(Object.hasOwn(option,k)) {
          // Only reviewed source dependency direction: Paper <- Sizes. This avoids
          // cyclic, stale-selected-map or cross-service renderer interpretation.
          need(name==='Paper' && service==='Fine Arts','UNREVIEWED_OPTION_CONDITION');condition(option[k],{sizes:groups.Sizes});
        }
        if(Object.hasOwn(option,'price_overrides')) {
          const dependency=service==='Fine Arts' && name==='Paper'?'sizes':service==='Darkroom Prints' && name==='Sizes'?'process':null;
          need(dependency,'UNREVIEWED_PRICE_OVERRIDE');keys(option.price_overrides,[dependency]);
          const overrides=option.price_overrides[dependency];need(object(overrides) && Object.keys(overrides).length>0,'SOURCE_OVERRIDE');
          for(const [key,price] of Object.entries(overrides)){need(choices[dependency].includes(key),'SOURCE_OVERRIDE');cents(price);}
        }
      }
      need(defaults<=1,'CONFLICTING_DEFAULTS');
      for(const size of groups.Sizes) {
        const selected={sizes:size};const available=availableOptions(group,selected);
        need(available.length>0,'ABSENT_OPTIONS');
        const conditional=group.options.filter(o=>o.default_if && matches(o.default_if,selected));
        need(!conditional.length || !group.options.some(o=>o!==conditional[0] && o.default),'CONFLICTING_DEFAULTS');
      }
    }
  }
  return form;
}

function validateCapture(capture,raw,script,section) {
  keys(capture,['schema','capture_method','captured_at','store','product','metafield','theme']);
  need(capture.schema===1 && capture.capture_method==='authenticated_shopify_admin_iab_and_cli_read_only' && capture.store==='1jukgy-dc.myshopify.com','SOURCE_IDENTITY');
  need(typeof capture.captured_at==='string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(capture.captured_at) && Number.isFinite(Date.parse(capture.captured_at)),'SOURCE_TIME');
  keys(capture.product,['id','handle']);need(capture.product.id==='9425818484991' && capture.product.handle==='film-printing','SOURCE_IDENTITY');
  keys(capture.metafield,['namespace','key','type','sha256']);
  need(capture.metafield.namespace==='custom' && capture.metafield.key==='film_services_json' && capture.metafield.type==='json' && hash(capture.metafield.sha256) && sha256(raw)===capture.metafield.sha256,'SOURCE_HASH_OR_METAFIELD');
  keys(capture.theme,['id','role','script_sha256','section_sha256']);
  need(/^\d+$/.test(capture.theme.id) && capture.theme.role==='live' && capture.theme.script_sha256===sha256(script) && capture.theme.section_sha256===sha256(section),'SOURCE_THEME');
  need(sha256(script)===SCRIPT && sha256(section)===SECTION,'SEMANTICS_REVIEW_REQUIRED');
}

// Offline operator custody, never browser-supplied location/price authority.
export function validateStagingLabReadback(mapping) {
  const receipt=mapping.location_readback;
  keys(receipt,['schema','capture_method','captured_at','store','product_id','variant_id','locations']);
  need(receipt.schema===1 && receipt.capture_method==='authenticated_shopify_admin_read_only' && receipt.store===STORE &&
    receipt.product_id===mapping.product_id && receipt.variant_id===mapping.variant_id &&
    typeof receipt.captured_at==='string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(receipt.captured_at) && Number.isFinite(Date.parse(receipt.captured_at)), 'UNPROVEN_LAB_MAPPING');
  need(Array.isArray(mapping.labs) && equal(mapping.labs.map(l=>l.input),LABS) && Array.isArray(receipt.locations) && receipt.locations.length===LABS.length,'UNPROVEN_LAB_MAPPING');
  const ids=new Set();
  for(const lab of mapping.labs) {
    keys(lab,['input','lab','location_id','evidence']);
    need(lab.lab===lab.input.toLowerCase() && /^[1-9]\d{0,19}$/.test(lab.location_id) && text(lab.evidence) &&
      lab.location_id!=='92446294127' && !ids.has(lab.location_id) && (lab.input!=='Miami'||lab.location_id==='92443803759'),'UNPROVEN_LAB_MAPPING');
    ids.add(lab.location_id);
    const matches=receipt.locations.filter(row=>row.lab===lab.lab && row.location_id===lab.location_id);
    need(matches.length===1,'UNPROVEN_LAB_MAPPING');
    const row=matches[0];keys(row,['lab','location_id','active','fulfills_online_orders','variant_available','origin','evidence']);
    need(row.active===true && row.fulfills_online_orders===true && row.variant_available===true && text(row.evidence),'UNPROVEN_LAB_MAPPING');
    keys(row.origin,['address1','address2','city','province_code','country_code','postal_code']);
    need(['address1','city','province_code','postal_code'].every(k=>text(row.origin[k])) && typeof row.origin.address2==='string' && row.origin.country_code==='US','UNPROVEN_LAB_MAPPING');
  }
  return receipt;
}

function validateMapping(m,source,form) {
  const full=m?.status==='reviewed_staging_test_lab_mapping';
  keys(m,['schema','status','source_sha256','store','product_id','variant_id','physical','evidence','labs','photo_paper','fine_art_papers',...(full?['location_readback']:[])]);
  need(m.schema===1 && (full||m.status==='reviewed_staging_identity_mapping_only') && m.source_sha256===source.metafield.sha256 && text(m.evidence),'MAPPING_REVIEW_REQUIRED');
  need(m.store===STORE && m.product_id==='15620086005871' && m.variant_id==='67852705202287' && m.physical===true,'MAPPING_TARGET');
  if(full)validateStagingLabReadback(m);
  else {
    need(Array.isArray(m.labs) && m.labs.length<=1,'UNPROVEN_LAB_MAPPING');
    for(const lab of m.labs) {
      keys(lab,['input','lab','location_id','evidence']);
      need(lab.input==='Miami' && lab.lab==='miami' && lab.location_id==='92443803759' && text(lab.evidence),'UNPROVEN_LAB_MAPPING');
    }
  }
  keys(m.photo_paper,['input','paper','evidence']);
  need(m.photo_paper.input===null && m.photo_paper.paper==='photo-premium-luster' && text(m.photo_paper.evidence) && form['Photo Prints'].description.includes('premium luster paper') && !form['Photo Prints'].Paper,'UNPROVEN_NULL_PAPER');
  need(Array.isArray(m.fine_art_papers) && equal(m.fine_art_papers.map(p=>p.input),papers),'UNPROVEN_PAPER_MAPPING');
  for(const p of m.fine_art_papers){keys(p,['input','paper','evidence']);need(p.paper===p.input.toLowerCase().replaceAll(' ','-') && text(p.evidence),'UNPROVEN_PAPER_MAPPING');}
}

function optionPrice(option,selected) {
  let price=option.price;
  for(const [key,values] of Object.entries(option.price_overrides??{}))if(Object.hasOwn(values,selected[key]))price=values[selected[key]];
  return cents(price);
}

// Integer rational multiplication. Rounding a half-cent per file would disagree
// with the old renderer's round-after-files behavior, so that path is rejected.
export function perFileCents(componentCents,turnaround) {
  need(Array.isArray(componentCents) && componentCents.every(n=>Number.isSafeInteger(n) && n>=0 && n<=200000),'UNSAFE_MONEY');
  need(Object.hasOwn(TURNAROUNDS,turnaround),'UNKNOWN_TURNAROUND');
  const numerator=turnaround==='Rush (1 Day)'?4n:turnaround==='Speedy (2-3 days)'?3n:2n;
  const product=componentCents.reduce((s,n)=>s+BigInt(n),0n)*numerator;
  need(product%2n===0n,'FRACTIONAL_PER_FILE_CENT');
  const result=product/2n;need(result>0n && result<=200000n,'PRICE_LIMIT');return Number(result);
}

// Pure derivation shared by operator preparation and compact, authenticated catalog loading.
export function buildFixedCatalogRows(form,mapping) {
  const rows=[],selections=[];
  for(const [label,service] of [['Photo Prints','photo'],['Fine Arts','fine_art']]) {
    const s=form[label];
    for(const size of s.Sizes.options.filter(o=>o.label!=='Custom')) {
      const selected={sizes:size.label};
      const allowedPapers=s.Paper?availableOptions(s.Paper,selected):[null];
      const allowedBorders=s.Borders?s.Borders.options:[null];
      for(const paper of allowedPapers)for(const border of allowedBorders)for(const turnaround of Object.keys(TURNAROUNDS)) {
        const options={...(border?{Borders:border.label}:{}),Turnaround:turnaround};
        const price=perFileCents([optionPrice(size,selected),paper?optionPrice(paper,selected):0,border?optionPrice(border,selected):0],turnaround);
        for(const lab of mapping.labs) {
          const row={enabled:true,physical:true,variant_id:mapping.variant_id,service,size:normalizeSize(size.label),paper:paper?mapping.fine_art_papers.find(p=>p.input===paper.label).paper:mapping.photo_paper.paper,paper_input:paper?.label??null,lab:lab.lab,lab_input:lab.input,options,per_file_cents:price};
          rows.push(row);selections.push({service:label,size:size.label,paper:row.paper_input,lab:lab.input,options,per_file_cents:price});
        }
      }
    }
  }
  const rowKey=r=>canonical([r.service,r.size,r.paper_input,r.lab_input,r.options]);
  need(new Set(rows.map(rowKey)).size===rows.length,'DUPLICATE_CATALOG_ROW');
  rows.sort((a,b)=>rowKey(a)<rowKey(b)?-1:rowKey(a)>rowKey(b)?1:0);
  return {rows,selections};
}

export function prepareCatalog({capture,metafieldValue,script,section,mapping},previous=null) {
  validateCapture(capture,metafieldValue,script,section);
  const form=validateForm(metafieldValue);validateMapping(mapping,capture,form);
  const {rows,selections}=buildFixedCatalogRows(form,mapping);
  const sourceVersion=sha256(canonical({metafield:capture.metafield,theme:capture.theme,semantics:SEMANTICS}));
  const mappingHash=sha256(canonical(mapping));
  const catalog={store:STORE,currency:'USD',provenance:{semantics:SEMANTICS,source_version:sourceVersion,capture,mapping_sha256:mappingHash},rows};
  const value=canonical(catalog),version='price-'+sha256(value);
  const diagnostics={schema:1,status:'proposed_not_published',checkout_ready:false,shipping_enabled:false,source_version:sourceVersion,price_version:version,mapping_sha256:mappingHash,rows:rows.length,
    unsupported:['Fine Arts / Custom','Darkroom Prints',...LABS.filter(l=>!mapping.labs.some(m=>m.input===l)).map(l=>`Unmapped lab / ${l}`)],
    form:{sha256:sha256(metafieldValue),preserves_source_bytes:true,service_default:null,photo_size_default:form['Photo Prints'].Sizes.options.find(o=>o.default)?.label??null,fine_art_size_default:form['Fine Arts'].Sizes.options.find(o=>o.default)?.label??null,turnaround_default:'Standard (4-5 days)',photo_paper_control:false,photo_borders_control:false},
    ceiling_cents:200000,ceiling_scope:'complete_job_files_times_current_copies',
    limits:['Price evidence does not confirm packing paper, physical weights or real carrier origin.','Form retains unsupported controls; existing unavailable gate stays in place.','No fixed job fee is present in the reviewed source. New fee semantics require review.'],
    change:previous?{source_changed:previous.provenance?.source_version!==sourceVersion,mapping_changed:previous.provenance?.mapping_sha256!==mappingHash,catalog_changed:canonical(previous)!==value}:null};
  return freeze({catalog,value,version,formValue:metafieldValue,diagnostics,selections});
}

// Last local review before a separately authorized F06D operator cutover. Rebuild
// from the authenticated export, never accept edited/partial rows as an import.
// This returns bytes only; the existing fenced publisher remains the sole writer.
export function verifyPreparedCatalog(input,{catalogValue,formValue,expectedVersion}) {
  parseStrictJson(catalogValue);
  const result=prepareCatalog(input);
  need(result.version===expectedVersion && result.value===catalogValue && result.formValue===formValue,'PREPARED_BUNDLE_CHANGED');
  return result;
}
