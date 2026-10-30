import {createHash} from 'node:crypto';
import {assertEngineeringScope} from '../configuration/engineering.mjs';
import {isFullProductCatalog} from '../jobs/selection.mjs';

// Historical owners and ordinary composition retain these exact defaults.
export const PREPARED_LIMITS=Object.freeze({jobs:2,preparations:8,publications:16,cancellations:8,resumes:16});
const legacy=Object.freeze({...PREPARED_LIMITS,cartLines:2,current:48,ownerMs:600000,leaseMs:240000,windowMs:1200000,resourceJobs:16,clientPolicy:null});
export const FULL_PRODUCT_CLIENT_POLICY=Object.freeze({jobs:64,preparations:64,publications:128,cancellations:64,resumes:128,
 cartLines:8,current:512,ownerMs:3600000,leaseMs:3600000,windowMs:3600000,resourceJobs:64,clientPolicy:'bfl-full-product-client-v1'});
export const PERSISTENT_STAGING_CLIENT_POLICY=Object.freeze({...FULL_PRODUCT_CLIENT_POLICY,
 jobs:1024,preparations:4096,publications:8192,cancellations:4096,resumes:8192,current:16384,resourceJobs:4096,
 ownerMs:86400000,leaseMs:86400000,windowMs:null,clientPolicy:'bfl-persistent-staging-client-v1'});
export const CLIENT_POLICY_ADMISSION='prepared-client-policy';
// Constants alone never grant the policy. Only an admitted exact-pinned source
// scope can select it; no HTTP body or plan flag can construct that scope.
export function preparedPolicy(sourceScope){
 if(!sourceScope)return legacy;
 const scope=assertEngineeringScope(sourceScope);
 if(scope.contract.kind==='persistent_staging')return PERSISTENT_STAGING_CLIENT_POLICY;
 return isFullProductCatalog(scope.catalog)?FULL_PRODUCT_CLIENT_POLICY:legacy;
}
export function preparedPolicyReceipt(sourceScope){
 if(!preparedPolicy(sourceScope).clientPolicy)return null;
 return createHash('sha256').update(JSON.stringify(assertEngineeringScope(sourceScope).contract)).digest('hex');
}
export function preparedOwnerPolicy(db,owner,sourceScope){
 const requested=preparedPolicy(sourceScope),receipt=preparedPolicyReceipt(sourceScope);
 if(receipt&&db.prepare('SELECT 1 FROM resource_admissions WHERE owner=? AND kind=? AND request_hash=?').get(owner,CLIENT_POLICY_ADMISSION,receipt))return requested;
 return legacy;
}
