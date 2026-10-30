// BFL's version-pinned widget fork supplies this transport seam. It is not an
// Uploadly hook and does not modify a vendor object's prototypes at runtime.
export function createOwnedWidget(widget,flow,{publicKey,onOriginal=()=>{},onCrop=()=>{},onSelections=()=>{},onFailure=()=>{},onRemovalFailure=()=>{},observe=()=>{},fetchImpl=fetch,urls=URL}={}){
  if(!['select','selectSource','original','remove','crop'].every(name=>typeof flow?.[name]==='function'))throw Error('WIDGET_FLOW_UNAVAILABLE');
  if(widget?.version!=='3.25.3'||typeof widget.openDialog!=='function'||typeof widget.plugin!=='function'||!/^\w{20}$/.test(publicKey??''))throw Error('WIDGET_UNAVAILABLE');
  const fixedPipe=widget.plugin(namespace=>namespace.utils.fixedPipe);
  if(typeof fixedPipe!=='function')throw Error('WIDGET_UNAVAILABLE');
  const $=widget.jQuery,promises=new WeakMap(),selected=new Set(),previews=new Set(),failed=new Set(),failedRemovals=new Set();
  const reportFailure=api=>{failed.add(api);onFailure(true);};
  const clearFailure=api=>{if(failed.delete(api)&&!failed.size)onFailure(false);};
  const clearRemovalFailure=api=>{if(failedRemovals.delete(api)&&!failedRemovals.size)onRemovalFailure(false);};
  let decoding=0;const decodeQueue=[];
  const decode=work=>new Promise((resolve,reject)=>{
    decodeQueue.push({work,resolve,reject});pump();
  });
  const pump=()=>{while(decoding<2&&decodeQueue.length){const task=decodeQueue.shift();decoding++;
    Promise.resolve().then(task.work).then(task.resolve,task.reject).finally(()=>{decoding--;pump();});
  }};
  const changed=()=>onSelections([...selected].map(api=>promises.get(api)).filter(row=>row?.preview&&!row.removed)
    .map(row=>({key:row.selection.key,url:row.preview,name:row.name})));
  // Match BaseFile.__extendApi in the exact pinned fork: collection setup
  // consumes remembered progress synchronously when reopening completed files.
  const extend=api=>{api.pipe=api.then=(...args)=>extend(fixedPipe(api,...args));return api;};
  const remove=async row=>{if(row.removed)return;if(row.removing)return row.removing;
    row.removing=(async()=>{
      await flow.remove(row.selection.key);row.removed=true;selected.delete(row.api);
      if(row.preview){urls.revokeObjectURL(row.preview);previews.delete(row.preview);}clearFailure(row.api);clearRemovalFailure(row.api);changed();
    })();
    try{return await row.removing;}catch(error){failedRemovals.add(row.api);onRemovalFailure(true);throw error;}finally{row.removing=null;}
  };
  // The pinned FileGroup summarizes rejected files too. Supply display metadata
  // as BaseFile does; missing info throws when a later good file resolves.
  const failedInfo=({name='Image',source='file',localFile}={})=>({
    uuid:null,name,size:localFile?.size??0,isImage:false,isStored:false,
    mimeType:localFile?.type??null,originalUrl:null,cdnUrl:null,cdnUrlModifiers:null,
    originalImageInfo:null,sourceInfo:{source},
  });
  const owned=(selection,{name='Image',source='file',expected,localFile}={})=>{
    const df=$.Deferred(),api=extend(df.promise());
    const rejected=failedInfo({name,source,localFile});
    let row,stage='selection';
    api.cancel=()=>{if(row)remove(row).catch(()=>{});df.reject('user',rejected);};
    // Reject copied UUIDs, existing provider groups and transformed ready-file
    // claims. These are not selections and cannot establish owned provenance.
    try{
      if(!selection)throw Error('WIDGET_SOURCE_UNAVAILABLE');
      row={api,selection,name,removed:false,preview:null};promises.set(api,row);selected.add(api);
      df.notify({state:'uploading',progress:0,uploadProgress:0,incompleteFileInfo:{name,size:0}});
      (async()=>{
        const receipt=await selection.completion;stage='preview';
        if(row.removed||receipt?.state!=='complete')throw Error('UPLOAD_UNAVAILABLE');
        await decode(async()=>{
        const active=()=>{if(row.removed||row.removing)throw Error('UPLOAD_CANCELLED');};active();
        let blob=localFile;
        if(!blob){
          const delivery=await flow.original(selection.key);
          const response=await fetchImpl(delivery.url,{credentials:'omit',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(15000)});
          if(!response.ok||response.redirected)throw Error('UPLOAD_UNAVAILABLE');
          blob=await response.blob();
        }
        const expectedFile=localFile?receipt.file:expected;
        if(row.removed||!['image/png','image/jpeg','image/tiff'].includes(blob.type)||blob.size<1||blob.size>20*1024*1024)throw Error('UPLOAD_UNAVAILABLE');
        const sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer())),b=>b.toString(16).padStart(2,'0')).join('');
        if(row.removed)throw Error('UPLOAD_UNAVAILABLE');
        if(localFile&&!expectedFile||expectedFile&&(blob.size!==expectedFile.bytes||blob.type!==expectedFile.mime||sha256!==expectedFile.sha256))throw Error('UPLOAD_UNAVAILABLE');
        onOriginal({bytes:blob.size,sha256});
        const bitmap=await createImageBitmap(blob);let previewBlob=blob;
        try{
          active();row.dimensions={width:bitmap.width,height:bitmap.height};
          if(typeof OffscreenCanvas==='function'){
            const scale=Math.min(1,256/Math.max(bitmap.width,bitmap.height));
            const canvas=new OffscreenCanvas(Math.max(1,Math.round(bitmap.width*scale)),Math.max(1,Math.round(bitmap.height*scale)));
            canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);
            previewBlob=await canvas.convertToBlob({type:'image/jpeg',quality:0.8});
          }
        }finally{bitmap.close();}
        active();row.preview=urls.createObjectURL(previewBlob);previews.add(row.preview);
        changed();
        const info={uuid:receipt.asset_id,name,size:blob.size,
          isImage:true,isStored:true,mimeType:blob.type,originalUrl:row.preview,cdnUrl:row.preview,
          cdnUrlModifiers:null,originalImageInfo:row.dimensions,sourceInfo:{source}};
        stage='selection-ready';await flow.selectionReady?.(selection.key);stage='widget-ready';df.notify({state:'ready',progress:1,uploadProgress:1,incompleteFileInfo:info});stage='widget-resolve';df.resolve(info);
        });
      })().catch(()=>{observe({stage:'upload-preview',state:'failed',phase:stage});if(!row.removed&&!row.removing){reportFailure(api);try{Promise.resolve(flow.selectionFailed?.(selection.key)).catch(()=>{});}catch{}}if(df.state()==='pending')df.reject('upload',rejected);});
    }catch{reportFailure(api);df.reject('upload',rejected);}
    return api;
  };
  const factory=(type,data,settings,sourceInfo)=>{
    try{
      const selection=type==='object'&&data instanceof File?flow.select([data])[0]:
        type==='url'&&typeof data==='string'?flow.selectSource(data):null;
      return owned(selection,{name:type==='object'?data.name:'Image',source:sourceInfo?.source||type,localFile:type==='object'?data:undefined});
    }catch{const api=$.Deferred().reject('upload',failedInfo({name:type==='object'?data?.name:'Image',source:sourceInfo?.source||type,localFile:type==='object'?data:undefined})).promise();reportFailure(api);return api;}
  };
  return Object.freeze({
    async remove(key){
      const row=[...selected].map(api=>promises.get(api)).find(row=>row.selection.key===key);
      if(!row)throw Error('UPLOAD_UNAVAILABLE');
      await remove(row);
    },
    async restore(selections){
      if(selected.size)throw Error('WIDGET_UNAVAILABLE');
      await Promise.all(selections.map((row,index)=>Promise.resolve(owned(row,{name:`Image ${index+1}`,expected:row.file}))));
    },
    open(){
      const dialog=widget.openDialog([...selected],{
        publicKey,multiple:true,tabs:'file url gdrive dropbox',
        imagesOnly:true,previewStep:true,crop:false,imageShrink:false,clearable:true,
        previewUrlCallback:(url,info)=>url.startsWith(info.originalUrl+'-/preview/1162x693/')?info.originalUrl:(info.bflPreview||info.originalUrl),
        bflOwnedFileFactory:factory,
        bflOwnedCrop(oldFile,newFile){
          const row=promises.get(oldFile),df=$.Deferred(),api=extend(df.promise());
          if(!row||row.removed){df.reject('upload');return api;}
          promises.set(api,row);selected.delete(row.api);row.api=api;selected.add(api);
          api.cancel=()=>remove(row).catch(()=>{});
          const edited=Promise.resolve(newFile);
          // Block Add to Bag synchronously, before the editor closes.
          const work=flow.crop(row.selection.key,edited.then(info=>info.crop));
          (async()=>{
            const result=await work,info=await edited;
            const response=await fetchImpl(result.url,{credentials:'omit',redirect:'error',cache:'no-store'});
            if(!response.ok||response.redirected)throw Error('UPLOAD_CROP_UNAVAILABLE');
            const blob=await response.blob();
            const sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer())),b=>b.toString(16).padStart(2,'0')).join('');
            if(row.removed||blob.type!=='image/png'||blob.size!==result.file.bytes||sha256!==result.file.sha256)throw Error('UPLOAD_CROP_UNAVAILABLE');
            const preview=urls.createObjectURL(blob);previews.add(preview);
            onCrop({crop:result.file.crop,bytes:blob.size,sha256,original:result.file.original});
            df.resolve({...info,bflPreview:preview});
          })().catch(()=>{df.reject('upload');});
          return api;
        },
      });
      dialog.fileColl.onRemove.add(file=>{const row=promises.get(file);if(row)remove(row).catch(()=>{});else clearFailure(file);});
      return dialog;
    },
    dispose(){for(const api of selected){const row=promises.get(api);if(row)row.removed=true;}for(const preview of previews)urls.revokeObjectURL(preview);previews.clear();selected.clear();if(failed.size){failed.clear();onFailure(false);}if(failedRemovals.size){failedRemovals.clear();onRemovalFailure(false);}changed();},
  });
}
