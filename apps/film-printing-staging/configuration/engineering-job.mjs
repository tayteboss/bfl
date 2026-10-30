// Pure job check; this cannot construct or admit an engineering scope. The
// caller must supply the catalog held by the private, exact-source scope.
import {resolveSelection} from '../jobs/selection.mjs';
import {canonical,digest} from './config.mjs';
import {need} from '../backend/config.mjs';
import {isCompactProductCatalog,expandFullProductCatalog} from '../pricing/compact-catalog.mjs';

export function engineeringJobSpecification(catalog,job,fileCount,{requireBillingBasis=false}={}) {
 if(isCompactProductCatalog(catalog))catalog=expandFullProductCatalog(catalog);
 let selection;
 try{selection=resolveSelection(catalog,job,{completedFileCount:fileCount,canonicalInput:true});}
 catch{need(false,'ENGINEERING_JOB');}
 const spec={service:job.service,size:job.size,...(Object.hasOwn(selection.spec,'size_mode')?{size_mode:job.size_mode??'fixed',custom_dimensions:job.custom_dimensions??null}:{}),
   paper:job.paper,lab:job.lab,options:job.options,message:job.message,copies:job.copies};
 need(canonical(selection.spec)===canonical(spec)&&selection.variant_id===job.variant_id&&
   selection.file_count===fileCount&&selection.unit_price_cents===job.unit_price_cents&&
   ((!requireBillingBasis&&job.billing_basis===undefined)||job.billing_basis===selection.billing_basis),'ENGINEERING_JOB');
 return digest({spec,variant_id:selection.variant_id,billing_basis:selection.billing_basis,unit_price_cents:selection.unit_price_cents,file_count:fileCount});
}
