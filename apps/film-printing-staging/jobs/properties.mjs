import {displayClaims,variantForLab} from '../checkout/authority.js';
// One projection of immutable specifications for job receipts and native Adds.
export function jobProperties(job,reference,{includeUploads=false,canonical=false}={}){
  const labels=!canonical&&variantForLab(job.lab)===`gid://shopify/ProductVariant/${job.variant_id}`?displayClaims({service:job.service,size:job.size,paper:job.paper,lab:job.lab,size_mode:job.size_mode,width:String(job.custom_dimensions?.width??''),height:String(job.custom_dimensions?.height??'')}):null;
  return {_bfl_flow:'f05',_bfl_job:job.id,_bfl_revision:job.revision,_bfl_config:job.config_version,_bfl_signature:reference.signature,
    Service:labels?.service??job.service,Sizes:labels?.size??job.size,Paper:labels?.paper??job.paper,Location:labels?.lab??job.lab,Message:job.message,...job.options,
    ...(job.size_mode?{_bfl_size_mode:job.size_mode,'Custom Width':job.custom_dimensions?String(job.custom_dimensions.width):'',
      'Custom Height':job.custom_dimensions?String(job.custom_dimensions.height):'',Process:job.options.Process??'',
      'Scanning Options':job.options['Scanning Options']??'',Negatives:job.options.Negatives??''}:{}),
    'Files Uploaded':String(job.completed_asset_ids.length),
    ...(includeUploads?Object.fromEntries(job.files.map((a,i)=>[`Uploaded File ${i+1}`,a.url])):{})};
}
