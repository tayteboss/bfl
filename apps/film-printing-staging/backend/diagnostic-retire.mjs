// One stopped-writer recovery, never an HTTP route or a publication path.
import {lstatSync,readFileSync,openSync,writeSync,fsyncSync,closeSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {readConfig,need,safeCode} from './config.mjs';
import {openDatabase} from './storage.mjs';
import {createAdminTransport} from './admin.mjs';
import {createAuthorityAdmin} from '../checkout/shopify.mjs';
import {createEngineeringScope} from '../configuration/engineering.mjs';
import {createEngineeringSourceOperator} from '../configuration/engineering-operator.mjs';
import {leaseOwners} from '../checkout/lease.mjs';
import {isFullProductCatalog} from '../jobs/selection.mjs';
import {INVENTORY_QUERY} from './diagnostic-operator.mjs';

export async function retireDiagnostic({store,admin,history,planHash,enabled=false,record=()=>{}}){
 need(enabled===true&&history?.[0]?.event==='reserved'&&history[0].run_id==='f06p-integrated-v1'&&history[0].plan_sha256===planHash,'DIAGNOSTIC_RECOVERY_REVIEW');
 const owners=[...new Set(history.filter(e=>e.event==='issued_owner').map(e=>e.owner))];
 need(owners.length<=2&&owners.every(x=>typeof x==='string'&&x.length<=128),'DIAGNOSTIC_RECOVERY_HISTORY');
 for(const owner of owners)store.revoke({id:`diagnostic-recovery:${owner}`,kind:'owner',owner});
 const markers=[...new Set(history.filter(e=>e.event==='installed_marker').map(e=>e.marker))];
 need(markers.length<=1&&markers.every(x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x)),'DIAGNOSTIC_RECOVERY_HISTORY');
 for(const marker of markers)store.cartBinding.retire(marker);
 store.resourceSessions.retireExpiredCartOwners();
 // Normal EMPTY-only CAS/fence/readback also repairs an uncertain publication.
 await admin.reconcile();
 const s=store.lifecycle.state();need(s.pending===0&&!s.operation,'DIAGNOSTIC_RECOVERY_UNCONFIRMED');
 record({event:'recovery_authority_cleared',owners:owners.length,checkout_ready:false});
 return {authority_cleared:true,provider_cleanup_confirmed:false,cart_cleanup_confirmed:false,checkout_ready:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 process.umask(0o077);let storage,fd;
 try{
  const [directory,planPath,planHash,...extra]=process.argv.slice(2);
  need(process.env.BFL_F06P_RECOVERY==='stopped-writer'&&process.env.BFL_ALL_WRITERS_STOPPED==='yes'&&!extra.length&&/^[a-f0-9]{64}$/.test(planHash),'OPERATOR_DISABLED');
  const dir=lstatSync(directory);need(dir.isDirectory()&&!dir.isSymbolicLink()&&(dir.mode&0o077)===0,'PRIVATE_DIAGNOSTIC_DIRECTORY');
  const planStat=lstatSync(planPath);need(planStat.isFile()&&!planStat.isSymbolicLink()&&planStat.nlink===1&&(planStat.mode&0o077)===0&&planStat.size<=262144,'PRIVATE_REVIEW_REQUIRED');
  const planRaw=readFileSync(planPath);need(createHash('sha256').update(planRaw).digest('hex')===planHash,'DIAGNOSTIC_RECOVERY_REVIEW');
  const plan=JSON.parse(planRaw);need(plan.phase==='reviewed-integrated'&&plan.source_eligibility==='staging_engineering','DIAGNOSTIC_RECOVERY_REVIEW');
  need(plan.customer_eligibility===undefined||typeof plan.customer_eligibility==='boolean','CUSTOMER_ELIGIBILITY_MODE');
  const eligibility=plan.customer_eligibility===true;
  const specificationOwner=plan.specification_owner??null,fullProduct=isFullProductCatalog(JSON.parse(plan.engineering?.catalogValue??'null'));
  need(fullProduct?eligibility&&specificationOwner!==null:specificationOwner===null,'SPECIFICATION_OWNER_REQUIRED');
  leaseOwners(specificationOwner);
  const path=join(directory,'f06p-integrated-v1.spent.jsonl'),stat=lstatSync(path);
  need(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&(stat.mode&0o077)===0&&stat.size<=1048576,'DIAGNOSTIC_RECOVERY_HISTORY');
  const raw=readFileSync(path,'utf8');need(raw.endsWith('\n'),'DIAGNOSTIC_RECOVERY_HISTORY');
  const history=raw.trim().split('\n').map(s=>JSON.parse(s));
  need(history[0]?.plan_sha256===planHash,'DIAGNOSTIC_RECOVERY_REVIEW');
  fd=openSync(join(directory,'f06p-integrated-v1.recovery.spent.jsonl'),'wx',0o600);
  const record=e=>{writeSync(fd,JSON.stringify(e)+'\n');fsyncSync(fd);};
  record({event:'recovery_reserved',plan_sha256:planHash,history_sha256:createHash('sha256').update(raw).digest('hex')});
  const d=openSync(directory,'r');try{fsyncSync(d);}finally{closeSync(d);}
  const config=readConfig();need(config.mode==='reconcile-only'&&config.resourceSessions==='disabled'&&config.storefrontSessions==='disabled','OPERATOR_DISABLED');
  // Existing crash lock must be released separately after exact container/PID
  // stop evidence. This executable cannot take over or guess a lock token.
  storage=openDatabase(config,{resourceSessions:true,checkoutOwner:true});let requests=0;
  const api=createAdminTransport(config,{eligibility,specificationOwner,fetchImpl:async(...args)=>{need(++requests<=12,'DIAGNOSTIC_RECOVERY_LIMIT');record({event:'admin_attempt',count:requests});return fetch(...args);}});
  const identity=await api(INVENTORY_QUERY);
  const sourceScope=createEngineeringScope({...plan.engineering,identity,mode:'recovery'});
  const sources=createEngineeringSourceOperator({config,storage,sourceScope,append:record,history,eligibility,specificationOwner});
  const admin=createAuthorityAdmin(api,{writesEnabled:true,lifecycle:storage.store.lifecycle,sourceScope,eligibility,specificationOwner});
  const result=await retireDiagnostic({store:storage.store,admin,history,planHash,enabled:true,record});
  let restored=false;
  if(history.some(e=>e.event==='source_restored')){
   const current=await sources.admin.read({allowMissingCatalog:true}),prior=history.find(e=>e.event==='source_preimage');
   restored=!!prior&&current.active.value===prior.active.value&&current.catalogField===null;
  }else try{restored=(await sources.restore()).restored;}catch(error){record({event:'recovery_source_unconfirmed',code:safeCode(error)});}
  record({event:'recovery_finished',sources_restored:restored,provider_cleanup_confirmed:false,cart_cleanup_confirmed:false,checkout_ready:false});
  console.log(JSON.stringify({...result,sources_restored:restored}));
 }catch(error){console.error(JSON.stringify({code:safeCode(error),checkout_ready:false}));process.exitCode=1;}
 finally{storage?.close();if(fd!==undefined)closeSync(fd);}
}
