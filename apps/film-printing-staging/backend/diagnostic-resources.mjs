import {engineeringFiles,bindEngineeringAssets} from '../configuration/engineering.mjs';
import {createHash} from 'node:crypto';
import {need} from './config.mjs';
import {createResourceScope} from './resource-session.mjs';
import {createUploadcareAdapter} from '../uploads/uploadcare.mjs';
import {createJobService} from '../jobs/service.mjs';
import {createConfigLoader} from '../configuration/shopify.mjs';
import {createPriceCatalogLoader} from '../jobs/catalog.mjs';

// Generated nonpersonal files are still uploaded/completed through the normal
// provider protocol. No supplied completion flag or synthetic Shop grant.
export function createDiagnosticResources({store,api,config,uploadConfig,files,selection,custody,enabled=false,permit=()=>false,fetchImpl=fetch,now=Date.now,sourceScope}){
 let spent=false,quoteOwner=null,quoteJob=null,quoteTicket=null,quoteAssets=null,quoteAuthenticate=null,refreshAt=Infinity,refreshing=null;const intents=[];
 const ordinary=createUploadcareAdapter({store,config:uploadConfig,enabled,fetchImpl,now,custody});
 const refreshScope=createResourceScope(store,store.resourceSessions);
 const maintainer=createUploadcareAdapter({store:refreshScope.store,config:uploadConfig,enabled,fetchImpl,now,custody});
 const loader=createConfigLoader(api,{ttlMs:0,sourceScope}),catalog=createPriceCatalogLoader(api,{sourceScope});
 const jobs=createJobService({store,loader,loadCatalog:()=>catalog(),secret:config.jobSecret,validateUploads:ordinary.validate,sourceScope});
 return Object.freeze({jobs,
  callbackOwner(id){need(permit()&&quoteOwner&&id===quoteJob,'CALLBACK_JOB_UNAVAILABLE');return quoteOwner;},
  async maintain(){
   if(refreshing)return refreshing;
   if(!quoteTicket||!permit()||now()<refreshAt)return;
   // A completed upload's 60-second proof must stay fresh while the bounded
   // owner reaches checkout. Recheck the provider; never extend a stale proof,
   // retired owner, or terminal upload through a local timestamp change.
   const original=quoteTicket,assets=quoteAssets;refreshAt=Infinity;
   refreshing=(async()=>{
    // Publication advances the request epoch. Authenticate the same original
    // credential again; never rebase an old ticket or renew its lifetime.
    const ticket=quoteAuthenticate();
    need(['owner','verifier','generation'].every(key=>ticket[key]===original[key]),'RESOURCE_FENCED');
    store.resourceSessions.assert(ticket);
    await refreshScope.run(ticket,()=>maintainer.validate(ticket.owner,assets));
    store.resourceSessions.assert(ticket);need(permit(),'DIAGNOSTIC_CLOSED');
    refreshAt=now()+20000;
   })();
   try{await refreshing;}catch(error){quoteTicket=null;throw error;}finally{refreshing=null;}
  },
  async prepare({owner,ticket,guard,authenticate=()=>ticket}){
   need(enabled===true&&permit()&&!spent,'DIAGNOSTIC_RESOURCES_CLOSED');spent=true;
   need(files?.length===3&&selection?.copies===4,'DIAGNOSTIC_FIXTURE_REQUIRED');
   if(sourceScope)engineeringFiles(sourceScope,files);
   need(custody,'DIAGNOSTIC_CUSTODY_REQUIRED');custody.admitOwner(ticket);
   const scope=createResourceScope(store,{assert:()=>{guard();need(permit(),'DIAGNOSTIC_CLOSED');}});
   const uploader=createUploadcareAdapter({store:scope.store,config:uploadConfig,enabled:true,fetchImpl,now,custody,beforeSend:guard});
   const scopedJobs=createJobService({store:scope.store,loader,loadCatalog:()=>catalog(),secret:config.jobSecret,validateUploads:uploader.validate,sourceScope});
   return scope.run(ticket,async()=>{
    // Eligibility is verified before any provider send. Engineering requires
    // the exact private scope; ordinary merchant validation still rejects it.
    await loader.load({fresh:true});guard();await catalog();guard();
    const assets=[];
    for(let i=0;i<files.length;i++){
     const file=files[i];need(Buffer.isBuffer(file.bytes)&&file.mime==='image/png'&&createHash('sha256').update(file.bytes).digest('hex')===file.sha256,'DIAGNOSTIC_FILE_CHANGED');
     store.resourceSessions.admit(ticket,'uploads',`f06p-generated-file-${i+1}`);
     const intent=uploader.intent(owner,`f06p-generated-file-${i+1}`);intents.push({owner,id:intent.intent_id});
     const completed=await uploader.upload(owner,intent.intent_id,{bytes:file.bytes,mime:file.mime});guard();
     need(completed.state==='complete'&&typeof completed.asset_id==='string','DIAGNOSTIC_UPLOAD_INCOMPLETE');assets.push(completed.asset_id);
    }
    if(sourceScope)bindEngineeringAssets(sourceScope,owner,assets);
    store.resourceSessions.admit(ticket,'jobs','f06p-generated-job-v1');
    const job=await scopedJobs.prepare(owner,{...selection,request_key:'f06p-generated-job-v1',asset_ids:assets});guard();
    quoteOwner=owner;quoteJob=job.reference.id;quoteTicket=ticket;quoteAssets=assets;quoteAuthenticate=authenticate;refreshAt=now()+20000;
    return {item:job.item,cart_verified:false,checkout_ready:false};
   });
  },
  async cleanup(){
   quoteTicket=null;quoteAuthenticate=null;refreshAt=Infinity;if(refreshing)await refreshing.catch(()=>{});
   for(const {owner,id} of intents)if(!store.lifecycle.retired('owner',owner))ordinary.remove(owner,id);
   // Custody owns exact returned provider IDs, including uncertain sends.
   return ordinary.cleanup();
  },
 });
}
