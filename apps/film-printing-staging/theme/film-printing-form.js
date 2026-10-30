import {createResourceSession} from './resource-session.js';
import {createOwnedUploads} from './owned-uploads.js';
import './completed-uploads.js';
import './upload-transport.js';
import './native-files.js';
import './film-printing-job.js';

// Retain only original finite custody, never renewed authority. A newer local
// operation/checkpoint takes precedence over the failed restore's old record.
export function retainCartReadReceipt(storage,key,saved,checkpoint,record,error){
  const op=record?.operation,accepted=record?.state==='accepted'&&op===null&&!error?.cartUncertain;
  const pending=record?.state==='pending'&&op&&Object.keys(op).length===4&&
    typeof op.operation_id==='string'&&op.operation_id.length>0&&typeof op.job==='string'&&op.job.length>0&&
    (op.kind==='cancel_preparation'?Number.isSafeInteger(op.generation)&&op.generation>0:
      ['add','change','remove'].includes(op.kind)&&Number.isSafeInteger(op.quantity)&&
      (op.kind==='remove'?op.quantity===0:op.quantity>0&&op.quantity<=10000));
  if(!(accepted||pending)||!/^bflr1_[A-Za-z0-9_-]{43}$/.test(record?.token??'')||
    !Number.isSafeInteger(record.expires)||record.expires<=0||!Number.isSafeInteger(record.generation)||record.generation<1||
    !Number.isSafeInteger(record.prepared_generation??0)||(record.prepared_generation??0)<0||
    typeof saved!=='string'||typeof checkpoint!=='string')return false;
  const current=storage?.getItem(key);let existing;try{existing=JSON.parse(current);}catch{}
  const same=existing&&Object.keys(existing).length===Object.keys(record).length&&Object.keys(record).every(name=>JSON.stringify(existing[name])===JSON.stringify(record[name]));
  if(current!==checkpoint&&!(same&&(pending||error?.acceptedReadRetry===true||error?.uploadReadRetry===true)))return false;
  storage.setItem(key,saved);return true;
}

// Explicit integration, not automatically installed. checkoutForSession
// must provide authenticated publication plus native cart/readback operations.
// The bounded staging customer adapter uses /checkout; never substitute fixture actions.
// The UI supplies actual Files from a supported input/drop/crop/cloud handoff;
// this module does not intercept proprietary widget internals or add controls.
export function createFilmPrintingForm(form,{checkoutForSession,sessionOptions,success,setError,observe,operation=work=>work()}={}){
  if(form.dataset.filmPrintingForm===undefined || typeof checkoutForSession!=='function')throw Error('FORM_UNAVAILABLE');
  const session=createResourceSession({...sessionOptions,observe}),uploads=createOwnedUploads(undefined,session);
  const checkout=checkoutForSession(session);
  const preparedMode=checkout?.mode==='prepared-unit-v3';
  if(!(preparedMode?['prepare','addPrepared','cancelPreparation']:['cart','add','publish','recalculate']).every(name=>typeof checkout?.[name]==='function'))throw Error('FORM_UNAVAILABLE');
  let transport,files,ready=false,recoverable=true,selectionRecovery=false;
  const localKeys=new Set(),finished=new Set();
  const suspend=()=>session.suspend();
  const checkpoint=()=>{
    const state=transport.snapshot();
    const count=localKeys.size+(selectionRecovery?remoteKeys.size:0);
    if(count&&finished.size===count&&!state.pending&&!state.failed&&state.completedAssetIds.length===count){
      const selection=selectionRecovery?transport.recoverySelection():undefined;
      const unprepared=selection?session.rememberUploadSelection(selection):true;
      if(recoverable&&unprepared)session.checkpoint('uploads',null,selection);
    }
  };
  const remoteKeys=new Set();
  const changed=()=>form.dispatchEvent(new Event('bfl:uploads-changed'));
  const settleSuccessful=async(current=transport)=>{
    const settled=[...localKeys,...remoteKeys].every(key=>finished.has(key));
    await current.refreshSuccessful({settled});
    if(current===transport){checkpoint();changed();}
  };
  const refreshSuccessful=()=>{
    const current=transport;
    return Promise.resolve(operation(()=>settleSuccessful(current))).catch(()=>{});
  };
  const fresh=()=>{
    transport=globalThis.BFLUploadTransport.create({enabled:true,client:uploads,concurrency:4,observe});
    files=globalThis.BFLNativeFiles.create({transport});
  };
  fresh();
  const flow=globalThis.BFLPrintJob.mount(form,{persistent:sessionOptions?.clientPolicy==='bfl-persistent-staging-client-v1',uploadAdapter:{snapshot:()=>transport.snapshot(),refresh:()=>operation(async()=>{recoverable=false;suspend();try{await transport.refreshCompleted();}finally{changed();}})},
    protocol:{...checkout,observe,assertCurrent:sessionOptions?.assertCurrent,...(preparedMode?{cancelPreparation:input=>operation(()=>checkout.cancelPreparation(input)),addPrepared:input=>operation(()=>checkout.addPrepared(input)),change:input=>operation(()=>checkout.change(input))}:{}),prepare:input=>operation(()=>{recoverable=false;suspend();return preparedMode?checkout.prepare(input):session.request('/jobs',input);})},setError,
    resetSelection(){
      // Submitted originals belong to their immutable job; discard only the
      // next form's local selection and previews, never provider resources.
      files.dispose();remoteKeys.clear();localKeys.clear();finished.clear();recoverable=selectionRecovery;fresh();changed();form.dispatchEvent(new Event('bfl:job-reset'));
    },
    async success(result){await success?.(result);}});
  return Object.freeze({
    issue(){
      const storage=sessionOptions?.reloadStorage,key=sessionOptions?.reloadKey??'bfl:accepted-cart-session:v1';
      let record,saved,restoreCheckpoint,cartFailure;
      const initialization=operation(()=>Promise.resolve().then(async()=>{
      sessionOptions?.assertInitial?.();
      saved=storage?.getItem(key);
      try{record=JSON.parse(saved);}catch{}
      let resumed,receipt;
      if(sessionOptions?.clientPolicy==='bfl-persistent-staging-client-v1'&&record?.state==='blocked'){
        await sessionOptions.verifyNewCart();receipt=await session.recoverUnbound();
      }else if(sessionOptions?.clientPolicy==='bfl-persistent-staging-client-v1'&&record?.expires<=(sessionOptions.now?.()??Date.now())&&['accepted','initialized','uploads','initializing'].includes(record.state)&&record.operation===null){
        if(typeof sessionOptions.replaceCart!=='function')throw Error('RESOURCE_SESSION_POLICY');
        receipt=await session.replaceSession(await sessionOptions.replaceCart());
      }else {try{resumed=session.restore();}finally{restoreCheckpoint=storage?.getItem(key);}if(!resumed&&sessionOptions?.clientPolicy)await sessionOptions.verifyNewCart();receipt=resumed?{resumed:true}:await session.issue();}
      const uploadResume=resumed==='uploads'||resumed?.state==='uploads';
      const initialized=await checkout.initialize?.({resume:resumed===true||resumed?.state==='accepted',resumeUploads:uploadResume,resumeEmpty:resumed?.state==='initialized',resumeInitialization:resumed?.state==='initializing',selection:resumed?.selection,
        recovery:preparedMode&&resumed&&['prepared','pending'].includes(resumed.state)?resumed:null});
      selectionRecovery=preparedMode&&initialized?.upload_recovery==='uncommitted-v1';
      let selections=[];
      if(uploadResume||selectionRecovery&&Array.isArray(initialized?.uploads)){
        selections=transport.restore(initialized.uploads);files.restore(selections);
        for(const row of selections)localKeys.add(row.key);
        changed();
      }else if(resumed&&resumed.state!=='initialized')recoverable=selectionRecovery&&resumed.state==='accepted';
      ready=true;flow.enablePreparation?.();return {...receipt,...session.receipt(),selections,cart:initialized?.cart,render:initialized?.render};
      }).catch(error=>{
        const failure=Object.assign(Error(error?.message??'RESOURCE_UNAVAILABLE'),error);
        const retained=preparedMode&&retainCartReadReceipt(storage,key,saved,restoreCheckpoint,record,error);
        if(preparedMode&&record?.state==='accepted'&&record.operation===null&&!failure.cartUncertain){
          if(retained)failure.acceptedCartReadOnly=true;
          else if(storage?.getItem(key)!==restoreCheckpoint)failure.cartUncertain=true;
        }
        if(preparedMode&&record?.state==='pending'&&['add','change','remove','cancel_preparation'].includes(record.operation?.kind))failure.cartUncertain=true;
        cartFailure=failure;throw error;
      }));
      // Cart controls share initialization; only their error carries read provenance.
      flow.ready=initialization.catch(error=>{throw cartFailure??error;});
      flow.ready.catch(()=>{});return initialization;
    },
    selectionReady:key=>operation(()=>{
      if(finished.has(key)||!localKeys.has(key)&&!remoteKeys.has(key))return;
      finished.add(key);checkpoint();return settleSuccessful();
    }),
    selectionFailed:key=>operation(()=>{transport.failPreview(key);changed();return settleSuccessful();}),
    renew:()=>operation(()=>session.renew()),
    select(list){
      if(!ready)throw Error('FORM_UNAVAILABLE');
      if(selectionRecovery)recoverable=true;session.clearUploadSelection?.();suspend();const selected=files.select(list);for(const row of selected)localKeys.add(row.key);changed();
      for(const row of selected)row.completion.then(changed,changed);
      return selected;
    },
    selectSource(url){
      if(!ready)throw Error('FORM_UNAVAILABLE');
      recoverable=selectionRecovery;session.clearUploadSelection?.();suspend();const key=crypto.randomUUID();remoteKeys.add(key);
      const completion=transport.selectSource(key,url);changed();completion.then(changed,changed);
      return Object.freeze({key,completion});
    },
    crop:(key,coordinates)=>operation(async()=>{recoverable=false;suspend();try{const result=transport.crop(key,coordinates);changed();return await result;}finally{changed();}}),
    original:key=>operation(()=>transport.original(key)),
    async remove(key){
      const remove=()=>operation(async()=>{if(selectionRecovery)recoverable=true;session.clearUploadSelection?.();suspend();try{
        const result=remoteKeys.has(key)?transport.remove(key):files.remove(key);changed();const receipt=await result;
        localKeys.delete(key);remoteKeys.delete(key);finished.delete(key);
        const state=transport.snapshot();
        if(sessionOptions?.clientPolicy==='bfl-persistent-staging-client-v1'&&selectionRecovery&&!localKeys.size&&!remoteKeys.size&&!state.pending&&!state.failed&&!state.completedAssetIds.length){
          if(typeof checkout.completeUploadRemoval!=='function')throw Error('FORM_UNAVAILABLE');
          await checkout.completeUploadRemoval();
        }else checkpoint();
        refreshSuccessful();return receipt;
      }finally{changed();}});
      return preparedMode?await flow.beforeResourceChange(remove):await remove();
    },
    refresh:key=>operation(async()=>{try{const result=transport.refresh(key);changed();return await result;}finally{changed();}}),
    snapshot:()=>transport.snapshot(),submit:flow.submit,
    reset:flow.reset,
    revoke:()=>operation(async()=>{ready=false;files.dispose();return session.revoke();}),
  });
}
