/* F05 staging integration. Upload DOM links are candidates only; the server owns completion and prices. */
(function (root) {
  const unavailable = (code='SELECTION_UNAVAILABLE') => new Error(code);
  // Only fixed, locally classified reasons reach existing customer error slots.
  // A possibly dispatched cart write always takes priority over retry advice.
  function customerError(error,{uploadState,blocked=false,cart=false,persistent=false}={}) {
    if(error?.refreshRequired)return 'Your cart changed in another tab. Refreshing this page…';
    if(error?.cartUncertain)return 'The cart could not be confirmed. Please contact us before trying again.';
    if(error?.acceptedReadRetry)return 'The cart could not be confirmed. Reload this page to try again.';
    const code=error?.reason??error?.message;
    if(['RESOURCE_EXPIRED','PREPARED_EXPIRED','ENGINEERING_EXPIRED'].includes(code))return persistent===true?'These print selections have expired. Remove the expired print items from your bag, then refresh this page to start again.':'This test session has ended. Please ask for a new test session.';
    if(['RESOURCE_REJECTED','DIAGNOSTIC_CLOSED','CUSTOMER_RESOURCES_CLOSED'].includes(code))return 'This test session is no longer available. Please ask for a new test session.';
    if(['PREPARATION_LIMIT','RESOURCE_ADMISSION_LIMIT','DIAGNOSTIC_LIMIT','CUSTOMER_JOB_SPENT'].includes(code))return 'This test session has reached its limit. Please ask for a new test session.';
    if(code==='PERSISTENT_CART_BUSY')return 'The print service is still finishing another action. Refresh this page to check your cart.';
    if(code==='NATIVE_CART_TIMEOUT')return 'Your cart took too long to respond. Refresh this page to check your cart.';
    if(cart)return 'The cart could not be confirmed. Please contact us before trying again.';
    if(code==='CUSTOM_SIZE_INVALID')return 'Enter a whole-number width from 1 to 44 inches and a whole-number height of at least 1 inch.';
    if(['CUSTOMER_SELECTION_REJECTED','PRICE_UNAVAILABLE','PRICE_LIMIT'].includes(code))return 'The price could not be confirmed for these options. Review the size, paper, copies and location before adding to bag.';
    if(blocked)return 'This selection could not be confirmed. Please contact us before trying again.';
    if(['UPLOAD_IMAGE_INVALID','UPLOAD_BODY_LIMIT','TOO_LARGE','CONTENT_TYPE_UNSUPPORTED'].includes(code))return 'Choose a JPG, PNG or TIFF image no larger than 20 MB.';
    if(code==='UPLOAD_FAILED'||uploadState?.failed)return 'An image could not be uploaded. Remove the failed image and choose it again.';
    if(['UPLOAD_INCOMPLETE','CUSTOMER_FILES_INCOMPLETE'].includes(code)||uploadState?.pending)return 'An image is still uploading or could not be confirmed. Wait for it to finish, or remove it and choose it again.';
    if(code==='UPLOAD_REQUIRED')return 'Choose at least one image before adding to bag.';
    if(code==='SELECTION_CHANGED')return 'Your options changed while the order was being prepared. Review them and add to bag again.';
    if(code==='SELECTION_INCOMPLETE')return 'Complete the highlighted options before adding to bag.';
    return 'The selection could not be confirmed. Please contact us before trying again.';
  }
  function readSelection(form, uploadAdapter) {
    const active = el => el && !el.disabled && el.closest?.('.service-groups-wrapper')?.style?.display !== 'none' && el.closest?.('fieldset')?.style?.display !== 'none' && !el.closest?.('label')?.classList?.contains('is-unavailable');
    const checked = selector => {const el=form.querySelector(selector);return active(el)?el.value:null;};
    const service=checked('[name="service"]:checked');
    const darkroom=service==='Darkroom Prints';
    if (!uploadAdapter || typeof uploadAdapter.snapshot !== 'function') throw unavailable();
    const snapshot = uploadAdapter.snapshot();
    // Adapter lifecycle must report pending/failure/removal. Never infer success from thumbnails/URLs.
    // Darkroom uses physical negatives; a previous digital selection is not part of that job.
    if (!snapshot || !Array.isArray(snapshot.completedAssetIds)) throw unavailable();
    if(!darkroom){if(snapshot.failed)throw unavailable('UPLOAD_FAILED');if(snapshot.pending)throw unavailable('UPLOAD_INCOMPLETE');if(!snapshot.completedAssetIds.length)throw unavailable('UPLOAD_REQUIRED');}
    const assets = darkroom?[]:snapshot.completedAssetIds;
    if (new Set(assets).size !== assets.length) throw unavailable();
    const groups = name => Array.from(form.querySelectorAll(`fieldset[data-group="${name}"] input:checked`)).find(active)?.value ?? null;
    const size=groups('Sizes');
    const options = {};
    for (const name of ['Borders']) { const value=groups(name); if(value)options[name]=value; }
    const turnaround=checked('[name="properties[Turnaround]"]:checked');
    if(turnaround)options.Turnaround=turnaround;
    const copies=Number(form.querySelector('[name="quantity"]')?.value);
    if(!Number.isSafeInteger(copies)||copies<1||copies>10000)throw unavailable('SELECTION_INCOMPLETE');
    if(darkroom){
      const process=groups('Process'),negatives=checked('[name="delivery"]:checked');
      if(!process||!negatives)throw unavailable('SELECTION_INCOMPLETE');
      options.Process=process;options.Negatives=negatives;
      const dimensions=String(size).replace(/[\s”"″]/g,'').replace('×','x');
      if(['8x10','11x14'].includes(dimensions)){
        const scanning=groups('Scanning Options');if(!scanning)throw unavailable('SELECTION_INCOMPLETE');options['Scanning Options']=scanning;
      }
    }
    const custom=size==='Custom';
    const rawWidth=custom?checked('[data-custom-size-input="width"]'):null,rawHeight=custom?checked('[data-custom-size-input="height"]'):null;
    const custom_dimensions=custom?{width:Number(rawWidth),height:Number(rawHeight)}:null;
    if(custom&&(!/^\d+$/.test(String(rawWidth).trim())||!/^\d+$/.test(String(rawHeight).trim())||service!=='Fine Arts'||!Number.isSafeInteger(custom_dimensions.width)||custom_dimensions.width<1||custom_dimensions.width>44||!Number.isSafeInteger(custom_dimensions.height)||custom_dimensions.height<1))throw unavailable('CUSTOM_SIZE_INVALID');
    const paper=groups('Paper');
    if(!service||!size||!checked('[name="location"]:checked')||custom&&paper!=='Fibre Paper')throw unavailable('SELECTION_INCOMPLETE');
    return {service,size,paper,lab:checked('[name="location"]:checked'),
      copies,asset_ids:[...assets].sort(),options,message:form.querySelector('[name="properties[Message]"]')?.value ?? '',
      ...(custom?{size_mode:'custom',custom_dimensions}:{})};
  }
  // The caller supplies authenticated publication and native cart adapters. The
  // cart adapter must independently read signed line properties/variant identity;
  // Shopify.actions.getCart alone returns only IDs, quantities and costs.
  // Never manufacture a verified item by attaching submitted properties to it.
  // A job remains pending until AFTER its physical line has been added.
  function createController({read,prepare,cart,add,publish,publicationStatus,recalculate,observe=()=>{},id=()=>crypto.randomUUID()}) {
    let flight=null,attempt=null;
    let stage='selection';
    const step=name=>{stage=name;observe({stage,state:'started'});};
    const requireValue=value=>{if(!value)throw unavailable();};
    const itemProperties=['_bfl_flow','_bfl_job','_bfl_revision','_bfl_config','_bfl_signature',
      'Service','Sizes','Paper','Location','Message','Borders','Turnaround','Files Uploaded',
      '_bfl_size_mode','Custom Width','Custom Height','Process','Scanning Options','Negatives'];
    async function work() {
      requireValue([prepare,cart,add,publish,recalculate].every(fn=>typeof fn==='function'));
      step('selection');const selection=read(),fingerprint=JSON.stringify(selection);
      observe({stage:'selection',state:'read',files:selection.asset_ids.length,copies:selection.copies});
      if(attempt?.addStarted && attempt.fingerprint!==fingerprint)throw unavailable();
      if(!attempt || attempt.fingerprint!==fingerprint)attempt={fingerprint,key:id()};
      if(attempt.result)return attempt.result;
      if(!attempt.prepared){
        step('prepare');const job=await prepare({...selection,request_key:attempt.key});
        requireValue(job?.checkout_ready===false && typeof job.reference?.id==='string' &&
          /^\d+$/.test(job.item?.id) && job.item.quantity===selection.copies &&
          job.file_count===selection.asset_ids.length && Number.isSafeInteger(job.unit_price_cents) && job.unit_price_cents>0 &&
          job.item.properties?._bfl_job===job.reference.id);
        // Legacy job responses may contain public provider URLs. They must never
        // reach the cart; file access belongs to authenticated private delivery.
        const properties=Object.fromEntries(itemProperties.filter(key=>Object.hasOwn(job.item.properties,key))
          .map(key=>[key,job.item.properties[key]]));
        attempt.prepared={reference:job.reference,item:{id:job.item.id,quantity:job.item.quantity,properties},
          unit_price_cents:job.unit_price_cents,file_count:job.file_count};
      }
      const prepared=attempt.prepared;
      step('selection');requireValue(JSON.stringify(read())===fingerprint);
      const find=current=>{
        requireValue(Array.isArray(current?.items));
        const matches=current.items.filter(line=>line.properties?._bfl_job===prepared.reference.id);
        requireValue(matches.length<=1);
        if(!matches.length)return null;
        const line=matches[0];
        requireValue(typeof line.id==='string' && line.id && String(line.variant_id)===prepared.item.id &&
          line.quantity===prepared.item.quantity && Object.entries(prepared.item.properties).every(([key,value])=>line.properties[key]===value));
        return line;
      };
      step('cart');let current=await cart(),line=find(current);
      step('selection');requireValue(JSON.stringify(read())===fingerprint);
      if(!line){
        requireValue(!attempt.addStarted);
        // Retain the request identity before sending. A lost add is reconciled
        // from a fresh native read and is never automatically sent again.
        attempt.addStarted=true;
        step('add');await add(prepared.item,{cart:current});
        step('cart');current=await cart();line=find(current);requireValue(line);
      }else requireValue(attempt.addStarted); // no adoption of an unrelated line
      requireValue(!attempt.lineId || attempt.lineId===line.id);
      attempt.lineId=line.id;
      step('selection');requireValue(JSON.stringify(read())===fingerprint);
      const input={reference:prepared.reference,lineId:line.id,cart:current};
      if(!attempt.published){
        step('publish');let receipt;
        if(attempt.publishStarted){
          requireValue(typeof publicationStatus==='function');
          receipt=await publicationStatus(input);
        }else{
          attempt.publishStarted=true;receipt=await publish(input);
        }
        requireValue(receipt?.published===true);attempt.published=true;
      }
      step('selection');requireValue(JSON.stringify(read())===fingerprint);
      // The adapter must perform the supported unchanged-quantity native update
      // and readback, validating its actual price against the prepared job.
      // An uncertain update is retained; this controller does not replay it.
      requireValue(!attempt.recalculateStarted);attempt.recalculateStarted=true;
      step('recalculate');const result=await recalculate({...input,quantity:prepared.item.quantity,
        unit_price_cents:prepared.unit_price_cents,file_count:prepared.file_count});
      requireValue(result?.recalculated===true && JSON.stringify(read())===fingerprint);
      attempt.result={accepted:true,cart:result.cart};return attempt.result;
    }
    return {submit(){if(!flight)flight=work().catch(error=>{observe({stage,state:'failed'});throw error;}).finally(()=>{flight=null;});return flight;},
      canRetry(){return !flight&&!attempt?.addStarted&&!attempt?.publishStarted&&!attempt?.recalculateStarted;},
      reset(){if(flight || !attempt?.result)return false;attempt=null;return true;}};
  }
  function createPreparedController({read,prepare,cancelPreparation,addPrepared,generationFloor=()=>0,observe=()=>{},id=()=>crypto.randomUUID()}) {
    let generation=0,content=null,desired=null,selectionError=null,failure=null,preparing=null,prepared=null,preparationFlight=null,submission=null,used=false,uncertain=false,result=null,suspended=false,resourceQueue=Promise.resolve(),resourceChanges=0;
    const advanceGeneration=()=>{
      const floor=generationFloor();
      if(!Number.isSafeInteger(floor)||floor<0||Math.max(generation,floor)>=Number.MAX_SAFE_INTEGER)throw unavailable();
      generation=Math.max(generation,floor)+1;
    };
    const fingerprint=selection=>JSON.stringify({...selection,copies:undefined});
    const selectionChanged=()=>{
      if(suspended)return null;
      let selection;try{selection=read();selectionError=null;}catch(error){selection=null;selectionError=error;}
      const next=selection?fingerprint(selection):null;
      if(next!==content){advanceGeneration();content=next;}
      desired=selection;return selection;
    };
    async function settle(){
      if(uncertain||used||suspended)throw failure??unavailable();
      selectionChanged();
      if(preparing){await preparing;selectionChanged();}
      if(prepared&&prepared.generation!==generation){
        const stale=prepared;prepared=null;
        try{await cancelPreparation(stale.receipt);}catch(error){uncertain=true;throw error;}
      }
      if(!desired)throw selectionError??unavailable('SELECTION_INCOMPLETE');
      if(prepared)return prepared;
      const selected=desired,version=generation,key=id();
      const attempt={generation:version,key,selection:selected};
      preparing=(async()=>{
        try{
          const receipt=await prepare({...selected,generation:version,request_key:key});
          if(receipt?.prepared!==true||receipt.generation!==version||receipt.checkout_ready!==false||
            !receipt.reservation?.operation_id||!Number.isSafeInteger(receipt.expires_at))throw unavailable();
          if(receipt.expires_at<=Date.now())throw unavailable('PREPARED_EXPIRED');
          prepared={...attempt,receipt};
        }catch(error){failure=error;if(error?.definitive!==true)uncertain=true;throw error;}
      })();
      try{await preparing;}finally{preparing=null;}
      if(suspended)return prepared;
      selectionChanged();
      if(prepared.generation!==generation)return settle();
      return prepared;
    }
    const ensure=()=>{if(!preparationFlight)preparationFlight=settle().finally(()=>{preparationFlight=null;});return preparationFlight;};
    return {
      selectionChanged,
      prepare:ensure,
      beforeResourceChange(work){
        if(typeof work!=='function'||used||uncertain)return Promise.reject(unavailable());
        suspended=true;resourceChanges++;advanceGeneration();content=null;desired=null;
        const change=resourceQueue.then(async()=>{
          try{
            if(preparationFlight)await preparationFlight;
            if(submission)await submission.catch(()=>{});
            if(used||uncertain)throw unavailable();
            if(prepared){const stale=prepared;prepared=null;try{await cancelPreparation(stale.receipt);}catch(error){uncertain=true;throw error;}}
            return await work();
          }finally{resourceChanges--;suspended=resourceChanges>0;}
        });
        resourceQueue=change.catch(()=>{});return change;
      },
      submit(){
        if(!submission)submission=(async()=>{
          if(result)return result;
          const clicked=selectionChanged(),version=generation;
          if(uncertain)throw failure??unavailable();
          if(!clicked)throw selectionError??unavailable('SELECTION_INCOMPLETE');
          const ready=await ensure();
          const assertSelection=()=>{
            const current=selectionChanged();
            if(ready.receipt.expires_at<=Date.now())throw unavailable('PREPARED_EXPIRED');
            if(!current||version!==generation||JSON.stringify(current)!==JSON.stringify(clicked))throw unavailable('SELECTION_CHANGED');
          };
          assertSelection();
          try{
            result=await addPrepared({prepared:ready.receipt,quantity:clicked.copies,assertSelection,onWriteStarted(){used=true;}});
            if(result?.accepted!==true)throw unavailable();
            used=true;return result;
          }catch(error){failure=error;if(used){uncertain=true;error.cartUncertain=true;}throw error;}
        })().finally(()=>{submission=null;});
        return submission;
      },
      canRetry:()=>!submission&&!used&&!uncertain,
      reset(){if(submission||!result)return false;prepared=null;used=false;result=null;content=null;desired=null;selectionError=null;failure=null;advanceGeneration();return true;},
      invalidate(){advanceGeneration();content=null;desired=null;},
    };
  }
  let cartFlow=null;
  function mountCart({protocol,ready,persistent=false}) {
    if(cartFlow||protocol?.mode!=='prepared-unit-v3'||!['change','resolveCartItem'].every(name=>typeof protocol[name]==='function')||typeof ready?.then!=='function')throw unavailable();
    cartFlow=Object.freeze({mode:protocol.mode,ready,assertCurrent:protocol.assertCurrent,changeCart:protocol.change,resolveCartItem:protocol.resolveCartItem,
      errorMessage:(error,context={})=>customerError(error,{cart:true,...context,persistent})});
    return cartFlow;
  }
  const mounted=new WeakMap();
  function mount(form,{uploadAdapter,protocol,success,setError,resetSelection,persistent=false}={}) {
    // Explicit code registration only: DOM flags and endpoints cannot activate
    // the flow. The supplied adapters must use the same private resource session.
    const preparedMode=protocol?.mode==='prepared-unit-v3';
    const available=form.dataset.filmPrintingForm!==undefined && protocol &&
      (preparedMode?['prepare','cancelPreparation','addPrepared']:['prepare','cart','add','publish','recalculate']).every(name=>typeof protocol[name]==='function');
    const read=()=>{const selection=readSelection(form,uploadAdapter);if(preparedMode&&form.bflSelectionComplete?.()!==true)throw unavailable('SELECTION_INCOMPLETE');return selection;};
    const controller=(preparedMode?createPreparedController:createController)({...(available?protocol:{}),read});
    let submission=null,refreshed=null,refreshedAt=0,lastError=null;
    let enabled=false,timer,sharedStale=false;
    const changed=()=>{if(!preparedMode||!enabled||sharedStale)return;controller.selectionChanged();clearTimeout(timer);timer=setTimeout(()=>{controller.prepare().then(()=>{lastError=null;},error=>{lastError=error;});},250);};
    if(preparedMode)for(const name of ['bfl:uploads-changed','change','input'])form.addEventListener(name,()=>{controller.selectionChanged();queueMicrotask(changed);});
    const refresh=async()=>{
      const state=uploadAdapter.snapshot();
      const hasSelection=state.pending||state.failed||state.displayCompletedCount||state.completedAssetIds.length;
      // Empty Add is form validation, not recoverable work. Keep the original
      // empty/accepted checkpoint so a later reload does not attempt a lease resume.
      const darkroom=form.querySelector('[name="service"]:checked')?.value==='Darkroom Prints';
      if(!darkroom&&(!preparedMode||hasSelection&&(state.pending||state.failed||!state.completedAssetIds.length)))await uploadAdapter?.refresh?.();
      refreshed=JSON.stringify(uploadAdapter.snapshot());refreshedAt=Date.now();
    };
    const flow={assertCurrent:protocol?.assertCurrent,invalidateSharedCart(){sharedStale=true;enabled=false;clearTimeout(timer);},errorMessage:(error=lastError,context={})=>customerError(error,{uploadState:uploadAdapter.snapshot(),blocked:!controller.canRetry(),...context,persistent}),mode:protocol?.mode,changeCart:preparedMode&&protocol?.change?input=>controller.beforeResourceChange(()=>protocol.change(input)):protocol?.change,resolveCartItem:protocol?.resolveCartItem,beforeResourceChange:controller.beforeResourceChange,enablePreparation(){enabled=true;changed();},canRetry:()=>!submission&&controller.canRetry(),snapshot:()=>uploadAdapter.snapshot(),refresh,reset(){
      if(!controller.reset())return false;resetSelection?.();return true;
    },submit(){
      if(!submission)submission=submit().finally(()=>{submission=null;});return submission;
    }};
    async function submit(){
      const buttons=Array.from(form.querySelectorAll('button[type="submit"]'));
      const disabled=buttons.map(button=>button.disabled);
      buttons.forEach(b=>{b.disabled=true;b.classList.add('is-loading');});
      try {protocol?.assertCurrent?.();if(sharedStale)throw unavailable('RESOURCE_SUPERSEDED');if(Date.now()-refreshedAt>1000||refreshed!==JSON.stringify(uploadAdapter.snapshot()))await refresh();refreshed=null;const result=await controller.submit();await success?.(result);return result;}
      catch(error){lastError=error;setError?.(flow.errorMessage(error));return null;}
      finally{refreshed=null;buttons.forEach((b,i)=>{b.disabled=disabled[i];b.classList.remove('is-loading');});}
    }
    if(available){if(mounted.has(form))throw unavailable();mounted.set(form,flow);}
    return flow;
  }
  root.BFLPrintJob={customerError,readSelection,createController,createPreparedController,mount,mountCart,forCart:()=>cartFlow,forForm:form=>mounted.get(form)};
})(typeof window==='undefined'?globalThis:window);
