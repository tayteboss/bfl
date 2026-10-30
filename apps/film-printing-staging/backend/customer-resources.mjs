import {createHash} from 'node:crypto';
import {preparedPolicy} from '../checkout/prepared-limits.mjs';
import {createPublicSource} from '../uploads/public-source.mjs';
import {need} from './config.mjs';
import {createResourceScope} from './resource-session.mjs';
import {createUploadIngress} from '../uploads/http.mjs';
import {createUploadcareAdapter,uploadReceipt} from '../uploads/uploadcare.mjs';
import {createJobService} from '../jobs/service.mjs';
import {createJobHandler} from '../jobs/http.mjs';
import {ShippingError} from '../shipping/packing.mjs';
import {createConfigLoader} from '../configuration/shopify.mjs';
import {createPriceCatalogLoader} from '../jobs/catalog.mjs';
import {engineeringFiles,bindEngineeringAssets,bindEngineeringCustomerJob} from '../configuration/engineering.mjs';

// Finite isolated-staging customer acceptance. Actual browser bytes traverse the
// normal owned relay. Image bytes and public sources are independently verified.
// The private engineering scope still bounds admission and pricing.
export function createCustomerResources({store,api,config,uploadConfig,files,custody,customerJobs=1,eligibility=false,enabled=false,permit=()=>false,fetchImpl=fetch,importSource=createPublicSource(),now=Date.now,sourceScope,persistent=null}){
  const limits=preparedPolicy(sourceScope);
  need([1,2].includes(customerJobs),'CUSTOMER_JOB_LIMIT');
  engineeringFiles(sourceScope,files);
  need(!persistent||eligibility&&customerJobs===2&&limits.clientPolicy==='bfl-persistent-staging-client-v1'&&typeof persistent.owner==='string'&&typeof persistent.state?.load==='function'&&typeof persistent.state?.save==='function'&&typeof persistent.ticketForOwner==='function','STAGING_RESOURCE_SCOPE');
  const intents=new Map(),tickets=new WeakMap();
  const scope=createResourceScope(store,store.resourceSessions);
  const uploader=createUploadcareAdapter({store:scope.store,config:uploadConfig,enabled,fetchImpl,now,custody,concurrency:4});
  const cleaner=createUploadcareAdapter({store,config:uploadConfig,enabled,fetchImpl,now,custody,concurrency:4});
  const loader=createConfigLoader(api,{ttlMs:0,sourceScope}),catalog=createPriceCatalogLoader(api,{sourceScope});
  const jobs=createJobService({store:scope.store,loader,loadCatalog:()=>catalog(),secret:config.jobSecret,beforeSave:eligibility?admitPrepared:undefined,validateUploads:(owner,ids)=>uploader.validate(owner,ids,{fresh:false}),resolveFiles:(_owner,assets)=>assets.map(asset=>{const row=[...intents.values()].find(r=>r.asset===asset.id);need(!row?.cropPending,'UPLOAD_CROP_PENDING');need(!row?.sourcePending&&!row?.verifying,'SOURCE_UNVERIFIED');const local=row&&!row.source&&!row.cropped?scope.store.uploadLedger.owned(_owner,row.id,uploader.binding):null;return {...(row?.cropped??asset),...(local?{sha256:local.digest,bytes:local.size,mime:local.mime}:{}),...(row?.source?{source:row.source}:{})};}),sourceScope});
  let owner=null,job=null,jobKey=null,authenticateCurrent=null,original=null,refreshAt=Infinity,refreshing=null;
  const jobKeys=new Map(),jobIds=new Set();
  let stateRevision=0;
  const persist=()=>{if(persistent&&owner)stateRevision=persistent.state.save(owner,{version:1,revision:stateRevision,owner,principal:{owner:original.owner,verifier:original.verifier,generation:original.generation},intents:[...intents.values()],job,jobKey,jobKeys:[...jobKeys],jobIds:[...jobIds]});};
  const trustedTicket=()=>{const ticket=persistent.ticketForOwner(persistent.owner);store.resourceSessions.assert(ticket);store.checkoutOwner.bound(ticket);need(ticket.owner===persistent.owner&&(!original||['owner','verifier','generation'].every(key=>ticket[key]===original[key])),'RESOURCE_FENCED');return ticket;};
  if(persistent){
    const restored=persistent.state.load(persistent.owner);
    if(restored){
      owner=restored.owner;original=restored.principal;stateRevision=restored.revision;
      // A process can stop during a read-only status refresh after completion.
      // Release only that transient read flag when the immutable original asset
      // and digest are already committed; unknown sends/imports remain blocked.
      let recoveredRead=false;
      for(const row of restored.intents){
        const committed=row.verifying&&row.asset&&row.digest&&!row.removed&&!row.sourcePending&&!row.cropPending?store.uploadLedger.read(row.id):null;
        if(committed?.state==='complete'&&committed.asset===row.asset&&committed.digest===row.digest){row.verifying=false;recoveredRead=true;}
        intents.set(row.id,row);
      }
      for(const [key,value] of restored.jobKeys)jobKeys.set(key,value);
      for(const id of restored.jobIds)jobIds.add(id);
      job=restored.job;jobKey=restored.jobKey;authenticateCurrent=trustedTicket;refreshAt=now();
      if(recoveredRead)persist();
    }
  }
  const gate=()=>need(enabled===true&&permit(),'CUSTOMER_RESOURCES_CLOSED');
  const assets=()=>[...intents.values()].filter(r=>r.asset).map(r=>r.asset);
  const authenticate=(request,sessions)=>{
    gate();const ticket=sessions.authenticate(request);sessions.assert(ticket);store.checkoutOwner.bound(ticket);
    need((!persistent||ticket.owner===persistent.owner)&&(owner===null||owner===ticket.owner),'CUSTOMER_OWNER_CHANGED');
    tickets.set(request,ticket);return ticket;
  };
  const retainOwner=(request,ticket)=>{
    if(owner!==null){need(owner===ticket.owner,'CUSTOMER_OWNER_CHANGED');return;}
    custody.admitOwner(ticket);owner=ticket.owner;original=ticket;
    if(persistent){authenticateCurrent=trustedTicket;persist();return;}
    const held={headers:{origin:request.headers.origin,authorization:request.headers.authorization}};
    authenticateCurrent=()=>store.resourceSessions.authenticate(held);
  };
  const work=(request,fn)=>scope.run(tickets.get(request),async()=>{gate();const value=await fn();gate();return value;});
  const rejectUnsent=(request,id)=>{
    const ticket=tickets.get(request),row=intents.get(id),current=store.uploadLedger.read(id);
    if(ticket&&row?.owner===ticket.owner&&current?.owner===ticket.owner&&current.state==='issued'){
      custody.failed(id);row.removed=true;persist();
    }
  };
  const ingress=createUploadIngress({config,enabled,concurrency:4,bodyTimeoutMs:30000,rejectUpload:rejectUnsent,privatePreview:true,privateOriginal:true,privateSource:true,privateCrop:true,authenticate:request=>{
    need(tickets.has(request),'OWNER_REJECTED');return tickets.get(request).owner;
  },receiveUploadDeletion:()=>{throw Error('WEBHOOK_NOT_MOUNTED');},upload:async(action,request,input)=>{
    const ticket=tickets.get(request);
    if(action==='remove')return scope.remove(ticket,()=>{
      const result=uploader.remove(ticket.owner,input.intent_id),row=intents.get(input.intent_id);
      if(row&&result.state==='removed'){row.removed=true;delete row.asset;persist();}
      return result;
    });
    return work(request,async()=>{
      if(action==='intent'){
        retainOwner(request,ticket);
        const result=store.lifecycle.transaction(()=>{
          store.resourceSessions.admit(ticket,'uploads',input.request_key);
          const result=uploader.intent(owner,input.request_key,{sourceScope});
          if(!intents.has(result.intent_id))intents.set(result.intent_id,{owner,id:result.intent_id});
          persist();return result;
        });
        // The durable session admission above bounds uploads before allocation.
        // Fixture count is not a cumulative customer upload allowance.
        return result;
      }
      const row=intents.get(input.intent_id);need(row&&row.owner===ticket.owner,'UPLOAD_INTENT_UNAVAILABLE');
      if(action==='crop'){
        need(!persistent,'UPLOAD_CROP_UNAVAILABLE');
        need(row.asset&&!row.removed&&!row.cropPending,'UPLOAD_CROP_UNAVAILABLE');row.cropPending=true;persist();
        // A failed or uncertain edit stays blocked; only explicit removal clears it.
        const result=await uploader.crop(owner,row.id,input.crop);gate();
        need(!row.removed,'UPLOAD_CROP_UNAVAILABLE');row.cropped=result.file;row.cropPending=false;persist();
        return result;
      }
      if(action==='preview'||action==='original')return uploader.delivery(owner,row.id,action);
      let verifying=false;
      try {
      if(['bytes','source'].includes(action)&&!row.asset){need(!row.verifying,'UPLOAD_PENDING');row.verifying=true;verifying=true;}
      if(action==='source'){
        need(!row.sourceStarted&&!row.digest&&!row.removed,'CUSTOMER_SOURCE_SPENT');
        row.sourceStarted=true;row.sourcePending=true;persist();
        const source=await importSource(input.url);gate();
        // Source validation is independent of fixture admission/pricing. The
        // current authenticated staging scope still limits owner/files/jobs.
        input={...input,bytes:source.bytes,mime:source.mime};row.source=source.source;persist();
      }
      if(action==='bytes'||action==='source'){
        const prefix=input.bytes.subarray(0,12);
        need(input.mime==='image/png'?prefix.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):
          input.mime==='image/jpeg'?prefix.subarray(0,3).equals(Buffer.from([255,216,255])):
          input.mime==='image/tiff'&&['49492a00','4d4d002a'].includes(prefix.subarray(0,4).toString('hex')),'UPLOAD_IMAGE_INVALID');
        const digest=createHash('sha256').update(input.bytes).digest('hex');
        persist();
        let result=await uploader.upload(owner,row.id,input);row.digest=digest;
        if(result.state==='complete'){
          try{result=await uploader.verifyOriginal(owner,row.id);gate();need(!row.removed,'SOURCE_UNVERIFIED');}
          catch(error){custody.failed(row.id);throw error;}
          row.sourcePending=false;
          result={...result,file:{sha256:digest,bytes:input.bytes.length,mime:input.mime}};
        }else need(action!=='source','SOURCE_UNVERIFIED');
        if(result.state==='complete'){row.asset=result.asset_id;refreshAt=Math.min(refreshAt,now()+20000);}
        return result;
      }
      } catch(error) {
        // Reject an unsent selection immediately. Never invalidate a completed
        // asset on a conflicting replay or retry an uncertain provider write.
        rejectUnsent(request,row.id);
        throw error;
      }finally{if(verifying){row.verifying=false;persist();}}
      need(action==='status','UPLOAD_ACTION_INVALID');need(!row.sourcePending&&!row.verifying,'SOURCE_UNVERIFIED');
      row.verifying=true;persist();
      try{
        let result=await uploader.status(owner,row.id);
        if(result.state==='complete'){
          if(!row.asset)try{result=await uploader.verifyOriginal(owner,row.id);}catch(error){custody.failed(row.id);throw error;}
          row.asset=result.asset_id;refreshAt=Math.min(refreshAt,now()+20000);
          const file=scope.store.uploadLedger.owned(owner,row.id,uploader.binding);
          result={...result,file:{sha256:file.digest,bytes:file.size,mime:file.mime}};
        }
        return result;
      }finally{row.verifying=false;persist();}
    });
  }});
  function admitPrepared(current,input,body){
    gate();const ticket=authenticateCurrent();need(current===owner&&ticket.owner===owner&&customerJobs===2,'CUSTOMER_OWNER_CHANGED');
    need(Array.isArray(input.asset_ids)&&(body.service==='darkroom'?input.asset_ids.length===0:input.asset_ids.length>0)&&input.asset_ids.every(id=>assets().includes(id)),'CUSTOMER_FILES_INCOMPLETE');
    const selection=JSON.stringify([input.asset_ids.slice().sort(),input.copies]);
    if(jobKeys.has(input.request_key))need(jobKeys.get(input.request_key)===selection,'CUSTOMER_JOB_SPENT');
    else {
      need(jobKeys.size<limits.preparations,'PREPARATION_LIMIT');
      store.preparedCart.assertCapacity(owner,{sourceScope});
      // This runs synchronously inside the job-save transaction, after all
      // catalog, message and file validation. A rejected selection admits no job.
      store.resourceSessions.admit(ticket,'jobs',input.request_key,{sourceScope});
      bindEngineeringCustomerJob(sourceScope,owner,input.asset_ids,input.copies,body,limits.preparations);
      jobKeys.set(input.request_key,selection);
    }
  }
  const jobHttp=createJobHandler({authenticate:async request=>tickets.get(request)?.owner,
    service:{prepare:async(current,input)=>{
      const ticket=authenticateCurrent?.();need(ticket&&current===owner,'CUSTOMER_OWNER_CHANGED');
      return scope.run(ticket,async()=>{
        gate();
        if(!eligibility){
        if(customerJobs===2){
          need(Array.isArray(input.asset_ids)&&input.asset_ids.length>0&&input.asset_ids.every(id=>assets().includes(id)),'CUSTOMER_FILES_INCOMPLETE');
          const selection=JSON.stringify([input.asset_ids.slice().sort(),input.copies]);
          if(jobKeys.has(input.request_key))need(jobKeys.get(input.request_key)===selection,'CUSTOMER_JOB_SPENT');
          else{
            need(jobKeys.size<customerJobs,'CUSTOMER_JOB_SPENT');
            bindEngineeringCustomerJob(sourceScope,owner,input.asset_ids,input.copies);jobKeys.set(input.request_key,selection);
          }
        }else{
          need(assets().length===files.length&&new Set(assets()).size===files.length,'CUSTOMER_FILES_INCOMPLETE');
          need(jobKey===null||jobKey===input.request_key,'CUSTOMER_JOB_SPENT');
          if(jobKey===null){bindEngineeringAssets(sourceScope,owner,assets());jobKey=input.request_key;}
        }
        store.resourceSessions.admit(ticket,'jobs',input.request_key,{sourceScope});
        }
        let result;
        try{result=await jobs.prepare(owner,input);}catch(error){
          if(eligibility&&!jobKeys.has(input.request_key)&&['INVALID_JOB','INVALID_SIZE','UNSUPPORTED_SIZE','UNSUPPORTED_SERVICE','INVALID_COPIES','INVALID_COMPLETED_ASSETS','UNSUPPORTED_OPTIONS','PRICE_UNAVAILABLE','PRICE_LIMIT','INVALID_MESSAGE','ENGINEERING_ASSETS','ENGINEERING_JOB','CUSTOMER_FILES_INCOMPLETE'].includes(error.code))throw new ShippingError('CUSTOMER_SELECTION_REJECTED');
          throw error;
        }
        gate();job=result.reference.id;jobIds.add(job);persist();refreshAt=Math.min(refreshAt,now()+20000);return result;
      });
    }}});
  return Object.freeze({jobs,
    async resumeUploads({ticket,guard,selection,excludedAssetIds}){
      gate();guard();
      const check=()=>{
        gate();guard();const current=authenticateCurrent?.();
        need(current&&original&&['owner','verifier','generation'].every(k=>current[k]===original[k]&&ticket[k]===original[k]),'RESOURCE_FENCED');
        const exact=selection!==undefined;
        if(exact)need(eligibility&&limits.clientPolicy&&selection&&typeof selection==='object'&&!Array.isArray(selection)&&Object.keys(selection).sort().join(',')==='intent_ids,version'&&selection.version==='uncommitted-v1'&&Array.isArray(selection.intent_ids)&&selection.intent_ids.length>0&&selection.intent_ids.length<=1000&&new Set(selection.intent_ids).size===selection.intent_ids.length&&selection.intent_ids.every(id=>typeof id==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id))&&Array.isArray(excludedAssetIds),'UPLOAD_RECOVERY_UNAVAILABLE');
        else need(jobKey===null&&jobKeys.size===0&&jobIds.size===0,'CUSTOMER_JOB_SPENT');
        const selected=exact?selection.intent_ids.map(id=>intents.get(id)):[...intents.values()].filter(row=>!row.removed);
        need(selected.length>0&&selected.every(row=>row&&row.owner===ticket.owner&&!row.removed&&row.asset&&row.digest&&!row.verifying&&!row.sourcePending&&!row.cropPending&&!row.cropped&&
          (exact?!excludedAssetIds.includes(row.asset)&&(!row.sourceStarted||!!row.source):!row.sourceStarted)),'UPLOAD_RECOVERY_UNAVAILABLE');
        return selected;
      };
      const selected=check();
      return scope.run(ticket,async()=>{
        await uploader.validate(ticket.owner,selected.map(row=>row.asset),{fresh:false});check();
        const uploads=[];
        for(const row of selected){
          const receipt=uploadReceipt(scope.store.uploadLedger.owned(ticket.owner,row.id,uploader.binding));
          need(receipt.state==='complete'&&receipt.asset_id===row.asset,'UPLOAD_RECOVERY_UNAVAILABLE');
          scope.store.uploads(ticket.owner,[row.asset]);
          const asset=scope.store.uploadLedger.owned(ticket.owner,row.id,uploader.binding);
          need(asset.digest===row.digest,'UPLOAD_RECOVERY_UNAVAILABLE');
          uploads.push({receipt,file:{sha256:asset.digest,bytes:asset.size,mime:asset.mime}});
        }
        check();return uploads;
      });
    },
    callbackOwner(id){gate();if(persistent)trustedTicket();need(jobIds.has(id)&&owner,'CALLBACK_JOB_UNAVAILABLE');return owner;},
    async handle(request,response,sessions){
      if(request.url!=='/jobs'&&!request.url?.startsWith('/uploads/'))return false;
      const ticket=authenticate(request,sessions);
      if(request.url==='/jobs'){
        need(!request.headers['content-encoding']&&request.headers['content-type']==='application/json','RESOURCE_BODY');
        // An authenticated physical-negative order has no upload intent. Its
        // complete catalog selection is still validated before any job admission.
        if(eligibility)retainOwner(request,ticket);
        await jobHttp(request,response);return true;
      }
      return ingress(request,response);
    },
    async maintain(){
      if(refreshing)return refreshing;
      const refreshAssets=persistent?[...intents.values()].filter(row=>{
        const current=row.asset&&!row.removed?store.uploadLedger.read(row.id):null;
        return current&&current.owner===owner&&current.asset===row.asset&&['pending','complete'].includes(current.state)&&current.expires>now();
      }).map(row=>row.asset):assets();
      if(!authenticateCurrent||!refreshAssets.length||!permit()||now()<refreshAt)return;
      refreshAt=Infinity;
      refreshing=(async()=>{
        const ticket=authenticateCurrent();need(['owner','verifier','generation'].every(k=>ticket[k]===original[k]),'RESOURCE_FENCED');
        await scope.run(ticket,()=>uploader.refresh(owner,refreshAssets));gate();refreshAt=Math.min(refreshAt,now()+20000);
      })();
      try{await refreshing;}finally{refreshing=null;}
    },
    async cleanup(){
      authenticateCurrent=null;refreshAt=Infinity;if(refreshing)await refreshing.catch(()=>{});
      for(const row of intents.values()){
        if(!store.lifecycle.retired('owner',row.owner)){cleaner.remove(row.owner,row.id);continue;}
        // The owner is already durably retired, so ordinary owned removal is
        // closed. Retire only this runtime's exact intent; keep its deadline and
        // provider custody intact for the cleanup below, including late sends.
        const current=store.uploadLedger.read(row.id);
        need(current&&current.owner===row.owner&&current.binding===cleaner.binding,'UPLOAD_INTENT_UNAVAILABLE');
        store.uploadLedger.invalidate(current,'failed');
      }
      return cleaner.cleanup();
    },
  });
}
