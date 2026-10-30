// Privately source-pinned staging packing. Existing fixed observations are exact;
// only missing weights and package sharing use Tayte's 30Oct estimate approval.
import {canonical,freeze,resolveRule,verifyRelease} from '../configuration/config.mjs';
import {assertEngineeringScope,assertEngineeringConfig} from '../configuration/engineering.mjs';
import {engineeringJobSpecification} from '../configuration/engineering-job.mjs';
import {isFullProductCatalog} from '../jobs/selection.mjs';
import {normalizeJob,requireValue as need} from './packing.mjs';

export const ESTIMATED_PACKING_POLICY='bfl-staging-estimated-packing-20261030-v1';
const darkroomSelectors=Object.freeze({
  '8x10':{service:'photo',paper:'photo-premium-luster'},
  '11x14':{service:'fine_art',paper:'fibre-paper'},
  '16x20':{service:'fine_art',paper:'fibre-paper'},
});
const tenths=value=>{
  const result=Math.round(value*10);
  need(Number.isSafeInteger(result)&&result>0&&result/10===value,'ENGINEERING_PACKING_WEIGHT');
  return result;
};
function packagePolicy(config,pkg){
  const rules=config.rules.filter(rule=>rule.package_id===pkg.id&&rule.enabled);
  need(pkg.enabled&&rules.length>0&&rules.every(rule=>rule.capacity===rules[0].capacity),'ENGINEERING_PACKING_PACKAGE');
  const tare=tenths(pkg.empty_weight_oz),capacity=rules[0].capacity;
  // Packaging!H/I/J: infer the gross ceiling from the heaviest existing full
  // package of this exact kind. No observed row, weight or capacity is changed.
  const gross=Math.max(...rules.map(rule=>tare+rule.capacity*tenths(rule.print_weight_oz)));
  return {tare,capacity,gross};
}
function estimatedRule(config,job){
  const custom=job.size_mode==='custom',width=custom?job.custom_dimensions.width:12,height=custom?job.custom_dimensions.height:16;
  // Conservative density: 0.01oz/in² exceeds every observed Fine Art row.
  // BigInt preserves upward 0.1oz rounding at exact integer-area boundaries.
  const weight=(BigInt(width)*BigInt(height)+9n)/10n;
  const candidates=(width<=24?['pkg-4','pkg-5','pkg-6']:width<=36?['pkg-5','pkg-6']:['pkg-6'])
    .map(id=>config.packages.find(pkg=>pkg.id===id));
  for(const pkg of candidates){
    need(pkg,'ENGINEERING_PACKING_PACKAGE');const policy=packagePolicy(config,pkg);
    if(weight>BigInt(policy.gross-policy.tare))continue;
    return {pkg,rule:{id:ESTIMATED_PACKING_POLICY+':'+(custom?'custom':'darkroom-12x16'),package_id:pkg.id,
      capacity:policy.capacity,print_weight_oz:Number(weight)/10,weight_status:'estimated',estimate_policy:ESTIMATED_PACKING_POLICY}};
  }
  // A print is indivisible. Pricing/pickup remain valid when no existing tube
  // can hold even one estimated print within its inferred gross ceiling.
  need(false,'ENGINEERING_PRINT_TOO_HEAVY');
}
export function resolveEngineeringPackingJob(release,job,{sourceScope}={}){
  const {catalog}=assertEngineeringScope(sourceScope);
  need(isFullProductCatalog(catalog),'ENGINEERING_SHIPPING_UNAVAILABLE');
  assertEngineeringConfig(sourceScope,release.config);
  engineeringJobSpecification(catalog,job,job.completed_asset_ids.length,{requireBillingBasis:true});
  need(job.config_version===release.version,'ENGINEERING_SHIPPING_UNAVAILABLE');
  const custom=job.size_mode==='custom';
  need(custom?job.service==='fine_art'&&Number.isSafeInteger(job.custom_dimensions?.width)&&job.custom_dimensions.width>=1&&job.custom_dimensions.width<=44&&
    Number.isSafeInteger(job.custom_dimensions.height)&&job.custom_dimensions.height>=1:job.size_mode==='fixed'&&job.custom_dimensions===null,'ENGINEERING_SHIPPING_UNAVAILABLE');
  let normalized,selector;
  if(job.service==='darkroom'||custom){
    const fileCount=job.completed_asset_ids.length;
    need(job.service==='darkroom'?fileCount===0&&job.billing_basis==='specification':fileCount>0&&job.billing_basis==='completed_files','ENGINEERING_SHIPPING_UNAVAILABLE');
    normalized={id:job.id,revision:job.revision,config_version:job.config_version,lab:job.lab,paper:job.paper,
      service:job.service,size_key:job.size,copies:job.copies,file_count:fileCount,physical_count:job.copies*(custom?fileCount:1)};
    need(Number.isSafeInteger(normalized.physical_count)&&normalized.physical_count>0,'INVALID_PRINT_COUNT');
    if(custom||job.size==='12x16')return {job:normalized,...estimatedRule(release.config,job)};
    selector=darkroomSelectors[job.size];need(selector,'ENGINEERING_SHIPPING_UNAVAILABLE');
  }else{
    normalized=normalizeJob(job);selector=normalized;
  }
  const rule=resolveRule(release.config,{...selector,size_key:job.size,lab:job.lab},{sourceScope});
  const pkg=release.config.packages.find(p=>p.id===rule.package_id);
  return {job:normalized,rule,pkg};
}

// Combine only this authenticated callback's one lab and an exact physical
// package signature. First-fit descending uses arithmetic counts, never a huge
// per-print expansion; every parcel retains its constituent immutable job IDs.
export function packEngineeringCallback(release,{jobs,group},{sourceScope}={}){
  verifyRelease(release,{sourceScope});
  need(Array.isArray(jobs)&&jobs.length>0&&jobs.length<=20&&new Set(jobs.map(j=>j.id)).size===jobs.length,'INVALID_JOBS');
  need(group&&typeof group.id==='string'&&group.id.length>0&&group.id.length<=180&&
    Array.isArray(group.job_ids)&&group.job_ids.length===jobs.length&&group.job_ids.every((id,i)=>id===jobs[i].id),'INVALID_GROUP');
  const lab=release.config.labs.find(l=>l.id===group.lab);
  need(lab?.enabled&&lab.location_id===group.location_id&&jobs.every(j=>j.lab===lab.id),'CROSS_LAB_GROUP');
  const selected=jobs.map(job=>resolveEngineeringPackingJob(release,job,{sourceScope}));
  const packages=new Map();
  for(const row of selected){
    const {pkg}=row,policy=packagePolicy(release.config,pkg);
    const key=canonical({kind:pkg.kind,length:pkg.length_in,width:pkg.width_in,height:pkg.height_in,...policy});
    if(!packages.has(key))packages.set(key,{pkg,policy,rows:[]});
    packages.get(key).rows.push(row);
  }
  const parcels=[];
  for(const {pkg,policy,rows} of [...packages.values()].sort((a,b)=>a.pkg.id.localeCompare(b.pkg.id))){
    const shared=[];
    rows.sort((a,b)=>b.rule.print_weight_oz-a.rule.print_weight_oz||a.job.id.localeCompare(b.job.id));
    for(const {job,rule} of rows){
      const unit=tenths(rule.print_weight_oz);let remaining=job.physical_count;
      const add=(parcel,count)=>{
        parcel.print_count+=count;parcel.weight+=unit*count;remaining-=count;
        parcel.contents.push({job_id:job.id,revision:job.revision,rule_id:rule.id,print_count:count,print_weight_oz:rule.print_weight_oz});
      };
      for(const parcel of shared){
        const count=Math.min(remaining,policy.capacity-parcel.print_count,Math.floor((policy.gross-parcel.weight)/unit));
        if(count>0)add(parcel,count);if(!remaining)break;
      }
      while(remaining){
        need(parcels.length<200,'PARCEL_LIMIT');
        const count=Math.min(remaining,policy.capacity,Math.floor((policy.gross-policy.tare)/unit));
        need(count>0,'ENGINEERING_PRINT_TOO_HEAVY');
        const parcel={sequence:parcels.length+1,package_id:pkg.id,print_count:0,weight:policy.tare,
          tare_weight_oz:pkg.empty_weight_oz,max_packed_weight_oz:policy.gross/10,contents:[],
          dimensions_in:{length:pkg.length_in,width:pkg.width_in,height:pkg.height_in}};
        add(parcel,count);shared.push(parcel);parcels.push(parcel);
      }
    }
  }
  const packed=parcels.map(({weight,...parcel})=>({...parcel,weight_oz:weight/10,
    ...(parcel.contents.length===1?{job_id:parcel.contents[0].job_id,rule_id:parcel.contents[0].rule_id,print_weight_oz:parcel.contents[0].print_weight_oz}:{})}));
  const parcelGroups=selected.map(({job},i)=>({id:jobs.length===1?group.id:group.id+'-job-'+(i+1),lab:lab.id,location_id:lab.location_id,origin:lab.origin,
    job,parcel_sequences:packed.filter(p=>p.contents.some(c=>c.job_id===job.id)).map(p=>p.sequence)}));
  const shipment={id:group.id,lab:lab.id,location_id:lab.location_id,origin:lab.origin,
    ...(jobs.length===1?{job:parcelGroups[0].job}:{jobs:parcelGroups.map(g=>g.job)}),parcels:packed,total_weight_oz:parcels.reduce((sum,p)=>sum+p.weight,0)/10};
  return freeze({config_version:release.version,config_sha256:release.sha256,estimate_policy:ESTIMATED_PACKING_POLICY,groups:[shipment],parcel_groups:parcelGroups});
}
