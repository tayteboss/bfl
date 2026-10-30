import {resolveSelection,isFullProductCatalog} from '../jobs/selection.mjs';
import {resolveRule} from '../configuration/config.mjs';
import {assertEngineeringConfig} from '../configuration/engineering.mjs';
import {need} from '../backend/config.mjs';
import {resolveEngineeringPackingJob} from '../shipping/full-product.mjs';

// Pricing/pickup eligibility does not supply missing parcel facts. Shipping is
// separately authorized by exact rules or the approved staging estimate policy
// within the private full-product scope; indivisible overweight prints stay pickup-only.
export function jobEligibility(release,catalog,job,{sourceScope}={}){
  const selected=resolveSelection(catalog,job,{completedFileCount:job.completed_asset_ids.length,canonicalInput:true});
  need(selected.variant_id===job.variant_id&&selected.unit_price_cents===job.unit_price_cents&&job.price_version===catalog.version,'PRICE_UNAVAILABLE');
  const full=isFullProductCatalog(catalog),lab=release.config.labs.find(l=>l.id===job.lab);
  need(lab?.enabled&&/^gid:\/\/shopify\/Location\/\d+$/.test(lab.location_id)&&
    (lab.origin_status==='verified'||release.config.engineering&&assertEngineeringConfig(sourceScope,release.config)),'LAB_UNAVAILABLE');
  let shipping=false;
  if(full&&sourceScope){
    try{resolveEngineeringPackingJob(release,job,{sourceScope});shipping=true;}
    catch(error){if(error.code!=='ENGINEERING_PRINT_TOO_HEAVY')throw error;}
  }else if(!full||job.service!=='darkroom'&&job.size_mode!=='custom'){
    resolveRule(release.config,{service:job.service,size_key:job.size,paper:job.paper,lab:job.lab},{sourceScope});
    shipping=true;
  }
  return {full,location_id:lab.location_id,shipping_eligible:shipping};
}

export function jobClaims(job,reference,{full=false}={}){
  return {flow:'f05',job:job.id,revision:job.revision,config:job.config_version,signature:reference.signature,
    service:job.service,size:job.size,paper:job.paper,lab:job.lab,message:job.message,
    borders:job.options.Borders??'',turnaround:job.options.Turnaround??'',files:String(job.completed_asset_ids.length),
    ...(full?{size_mode:job.size_mode,width:job.custom_dimensions?String(job.custom_dimensions.width):'',height:job.custom_dimensions?String(job.custom_dimensions.height):'',
      process:job.options.Process??'',scanning:job.options['Scanning Options']??'',negatives:job.options.Negatives??''}:{})};
}
