import {createResourceSession} from './resource-session.js';
import {createFilmPrintingForm,retainCartReadReceipt} from './film-printing-form.js';
import {createCustomerCheckout} from './customer-checkout.js';
import {createPreparedCheckout} from './prepared-checkout.js';
import {createOwnedWidget} from './owned-widget.js';

// Explicit finite acceptance mount for the existing no-app-block staging form.
// It preserves the supplied form and does not replace a mounted Uploadly widget.
export function mountCustomerForm(form,{until,sessionOptions,expectedCartHash,widget,publicKey,onOriginal,onCrop,observe,preparedCart=false,persistent,checkoutOptions}={}){
  const shared=persistent?.policy==='bfl-persistent-staging-client-v1';
  if(persistent&&(!shared||!preparedCart||until!==undefined||expectedCartHash!==undefined))throw Error('FORM_UNAVAILABLE');
  if(location.hostname!=='bellows-film-printing-staging.myshopify.com'||!shared&&(!Number.isSafeInteger(until)||Date.now()>=until)||
    form?.dataset.filmPrintingForm===undefined||form.querySelector('[data-uploadly-has-app-block="true"]'))throw Error('FORM_UNAVAILABLE');
  const choose=form.querySelector('[data-uploadly-fallback-button]');
  if(!choose)throw Error('FORM_UNAVAILABLE');
  let available=false,deadline=shared?null:until,initializationError=null,restoreSelectionFailure=()=>{};
  const expired=()=>deadline!==null&&Date.now()>=deadline;
  const admitted=result=>{if(shared){if(result?.client_policy!==persistent.policy||!Number.isSafeInteger(result.expires_at)||result.expires_at<=Date.now()||result.expires_at>Date.now()+86400000)throw Error('RESOURCE_SESSION_POLICY');deadline=result.expires_at;}available=true;syncChoose();return result;};
  const syncChoose=()=>{choose.disabled=!available||expired();};
  syncChoose();for(const name of ['change','input','bfl:uploads-changed'])form.addEventListener(name,()=>queueMicrotask(()=>{syncChoose();if(initializationError)setError(initializationError);else restoreSelectionFailure();}));
  const errorMessage=error=>globalThis.BFLPrintJob.customerError(expired()&&!error?.refreshRequired&&!error?.cartUncertain&&!error?.acceptedReadRetry?Error('RESOURCE_EXPIRED'):error,{persistent:shared});
  const setError=message=>{
    for(const node of form.querySelectorAll('[data-film-service-error],[data-film-service-error-bottom]')){
      node.textContent=message;node.style.display=message?'':'none';
    }
  };
  const clearError=message=>{for(const node of form.querySelectorAll('[data-film-service-error],[data-film-service-error-bottom]'))if(node.textContent===message){node.textContent='';node.style.display='none';}};
  const initializationFailed=error=>{initializationError=errorMessage(error);syncChoose();setError(initializationError);};
  const flow=createFilmPrintingForm(form,{sessionOptions:{reloadStorage:globalThis.sessionStorage,...sessionOptions,preparedMode:preparedCart},checkoutForSession:session=>(preparedCart?createPreparedCheckout:createCustomerCheckout)(session,{...checkoutOptions,expectedCartHash,observe,
    sectionIds:()=>preparedCart?['cart-drawer']:document.querySelector('cart-drawer-items').getSectionsToRender().map(s=>s.section).filter(Boolean)}),setError,observe,operation:shared?persistent.run:undefined});
  // Recalculate the existing summary now that the owned flow excludes hidden defaults.
  form.dispatchEvent(new Event('bfl:uploads-changed'));
  if(widget){
    const previews=document.createElement('div');previews.className='bfl-selected-previews';previews.hidden=true;
    choose.parentElement.after(previews);
    const previewNodes=new Map();let uploadFailureMessage=null,removalFailureMessage=null;
    restoreSelectionFailure=()=>{
      const retained=removalFailureMessage||uploadFailureMessage;if(!retained)return;
      const controller=globalThis.BFLPrintJob.forForm(form),message=controller.canRetry()?retained:controller.errorMessage();
      for(const node of form.querySelectorAll('[data-film-service-error],[data-film-service-error-bottom]'))if(!node.textContent||node.textContent===uploadFailureMessage||node.textContent===removalFailureMessage){node.textContent=message;node.style.display='';}
    };
    const uploader=createOwnedWidget(widget,shared?persistent.widgetFlow(flow):flow,{publicKey,onOriginal,onCrop,observe,onFailure:failed=>{
      if(failed){
        uploadFailureMessage=errorMessage(Error('UPLOAD_FAILED'));restoreSelectionFailure();
      }else if(uploadFailureMessage){
        // Explicit removal clears only this upload message, never a newer cart error.
        clearError(uploadFailureMessage);
        uploadFailureMessage=null;
      }
    },onRemovalFailure:failed=>{
      if(failed){removalFailureMessage='The image could not be removed. Please contact us.';restoreSelectionFailure();}
      else if(removalFailureMessage){clearError(removalFailureMessage);removalFailureMessage=null;restoreSelectionFailure();}
    },onSelections:rows=>{
      const keys=new Set(rows.map(row=>row.key));
      for(const [key,item] of previewNodes)if(!keys.has(key)){item.remove();previewNodes.delete(key);}
      for(const row of rows){
        if(previewNodes.has(row.key))continue;
        const item=document.createElement('div');item.className='bfl-selected-preview';
        const image=document.createElement('img');image.src=row.url;image.alt=row.name;image.loading='lazy';image.decoding='async';
        image.width=96;image.height=96;
        const remove=document.createElement('button');remove.type='button';remove.className='bfl-selected-preview-remove';
        remove.textContent='Remove';remove.setAttribute('aria-label',`Remove ${row.name}`);
        remove.addEventListener('click',async()=>{
          remove.disabled=true;
          try{await uploader.remove(row.key);restoreSelectionFailure();}
          catch{remove.disabled=false;restoreSelectionFailure();}
        });
        item.append(image,remove);previewNodes.set(row.key,item);previews.append(item);
      }
      previews.hidden=rows.length===0;
    }});
    form.addEventListener('bfl:job-reset',()=>uploader.dispose());
    const ready=flow.issue().then(async result=>{await uploader.restore(result.selections);if(result.cart)await document.querySelector('cart-drawer-items').refreshOwnedCart(result.cart,result.render);return admitted(result);});ready.catch(initializationFailed);
    choose.addEventListener('click',async event=>{
      event.preventDefault();event.stopImmediatePropagation();
      try{persistent?.assertCurrent();await ready;if(expired())throw Error('FORM_UNAVAILABLE');uploader.open();}
      catch(error){setError(errorMessage(error));}
    },true);
    return Object.freeze({ready,snapshot:flow.snapshot});
  }
  const input=document.createElement('input');input.type='file';input.accept='image/jpeg,image/png,image/tiff';input.multiple=true;input.hidden=true;
  // Keep it outside the vendor container so existing mount detection does not
  // mistake this native handoff for an initialized third-party widget.
  form.append(input);
  const ready=flow.issue().then(result=>{return admitted(result);});ready.catch(initializationFailed);
  choose.addEventListener('click',event=>{
    event.preventDefault();event.stopImmediatePropagation();
    try{persistent?.assertCurrent();}catch(error){setError(errorMessage(error));return;}
    if(expired()){setError(errorMessage(Error('RESOURCE_EXPIRED')));return;}
    input.click();
  },true);
  input.addEventListener('change',async()=>{
    try{persistent?.assertCurrent();await ready;if(expired())throw Error('FORM_UNAVAILABLE');
      const select=()=>flow.select(input.files);const rows=shared?await persistent.run(select):select();await Promise.all(rows.map(row=>row.completion));setError('');
    }catch(error){setError(errorMessage(error));}
  });
  return Object.freeze({ready,snapshot:flow.snapshot});
}

// Other storefront pages may edit an already accepted test cart. They never
// issue an owner or import files. Completed selection metadata stays in custody.
export function mountCustomerCart({until,sessionOptions,expectedCartHash,observe,checkoutForSession=createPreparedCheckout,checkoutOptions,persistent}={}){
  const shared=persistent?.policy==='bfl-persistent-staging-client-v1',operation=shared?persistent.run:work=>work();
  if(persistent&&(!shared||until!==undefined||expectedCartHash!==undefined))throw Error('FORM_UNAVAILABLE');
  if(location.hostname!=='bellows-film-printing-staging.myshopify.com'||!shared&&(!Number.isSafeInteger(until)||Date.now()>=until))throw Error('FORM_UNAVAILABLE');
  const reloadStorage=sessionOptions?.reloadStorage===undefined?globalThis.sessionStorage:sessionOptions.reloadStorage;
  const reloadKey=sessionOptions?.reloadKey??'bfl:accepted-cart-session:v1';
  const saved=reloadStorage?.getItem(reloadKey);
  if(saved==null)return null;
  let record;try{record=JSON.parse(saved);}catch{}
  if(!['accepted','prepared','pending'].includes(record?.state)&&!(record?.state==='uploads'&&record.selection?.version==='uncommitted-v1'))return null;
  const session=createResourceSession({...sessionOptions,reloadStorage,preparedMode:true,observe});
  const items=()=>document.querySelector('cart-items,cart-drawer-items');
  const checkout=checkoutForSession(session,{...checkoutOptions,expectedCartHash,observe,
    sectionIds:()=>items()?.getSectionsToRender().map(section=>section.section).filter(Boolean)??['cart-drawer']});
  let restoreCheckpoint;
  const ready=operation(()=>Promise.resolve().then(async()=>{
    if(shared)persistent.assertInitial();
    let resumed;try{resumed=session.restore();}finally{restoreCheckpoint=reloadStorage?.getItem(reloadKey);}
    if(!resumed||!['accepted','prepared','pending','uploads'].includes(resumed.state))throw Error('RESOURCE_UNAVAILABLE');
    const result=await checkout.initialize({resume:resumed.state==='accepted',...(resumed.state==='uploads'?{resumeUploads:true}:{}),...(resumed.selection?{selection:resumed.selection}:{}),
      recovery:['prepared','pending'].includes(resumed.state)?resumed:null});
    if(result.cart&&result.render)await items()?.refreshOwnedCart(result.cart,result.render);
    return result;
  }).catch(error=>{
    // Accepted restoration performs reads only. Its failure must not take over
    // separately rendered ordinary lines, including a successful server resume
    // whose ordinary items cannot be parsed as signed print jobs.
    const retained=retainCartReadReceipt(reloadStorage,reloadKey,saved,restoreCheckpoint,record,error);
    if(record?.state==='accepted'&&record.operation===null&&!error?.cartUncertain){
      if(retained)error.acceptedCartReadOnly=true;
      else if(reloadStorage?.getItem(reloadKey)!==restoreCheckpoint)error.cartUncertain=true;
    }
    // A saved dispatched operation remains uncertain even if its owner expires
    // before restoration. Do not turn that into permission for another write.
    if(record?.state==='pending'&&['add','change','remove','cancel_preparation'].includes(record.operation?.kind)){
      error.cartUncertain=true;
    }
    throw error;
  }));
  const protocol=shared?{...checkout,assertCurrent:persistent.assertCurrent,change:input=>operation(()=>checkout.change(input))}:checkout;
  const flow=globalThis.BFLPrintJob.mountCart({protocol,ready,persistent:shared});
  ready.catch(()=>{});return flow;
}
