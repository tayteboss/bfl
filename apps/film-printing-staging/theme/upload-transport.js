/* Uninstalled F05 preparation. No widget hooks, UI, session minting or cart writes.
 * A reviewed same-origin host/session and a supported raw File hook must precede
 * installation. Shopify app-proxy requests cannot be assumed to carry cookies. */
(function(root){
  const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  const fail=()=>new Error('Upload unavailable');
  function create({enabled=false,baseURL,origin=root.location?.origin,store,client,
    concurrency=1,observe=()=>{},fetchImpl=root.fetch?.bind(root),lifecycle=root.BFLUploadLifecycle?.create(),id=()=>crypto.randomUUID()}={}) {
    if(enabled!==true)throw fail();
    const base=client?null:new URL(baseURL);
    if(client?!['intent','bytes','status','remove'].every(name=>typeof client[name]==='function'):
      (store!=='bellows-film-printing-staging.myshopify.com'||base.origin!==origin||
      base.pathname!=='/'||base.search||base.hash||base.username||base.password||
      base.hostname==='bellowsfilmlab.com'||base.hostname.endsWith('.bellowsfilmlab.com')||base.hostname.endsWith('.myshopify.com')||
      !(base.protocol==='https:'||(base.protocol==='http:'&&base.hostname==='127.0.0.1'))||
      typeof fetchImpl!=='function'))throw fail();
    if(!lifecycle)throw fail();
    if(!Number.isInteger(concurrency)||concurrency<1||concurrency>4)throw fail();
    let active=0,closed=false;const queue=[];
    const rows=new Map(),controllers=new Set();
    const alive=()=>{if(closed)throw fail();};
    const pump=()=>{
      while(queue.length&&active<concurrency){
        if(queue[0].barrier&&active)return;
        const task=queue.shift(),slots=task.barrier?concurrency:1;active+=slots;
        Promise.resolve().then(()=>{alive();return task.work();}).then(task.resolve,task.reject).finally(()=>{active-=slots;pump();});
      }
    };
    const serial=(work,barrier=false,priority=false)=>new Promise((resolve,reject)=>{
      const rank=barrier?0:priority?1:2,task={work,barrier,rank,resolve,reject};
      const at=queue.findIndex(queued=>queued.rank>rank);
      if(at<0)queue.push(task);else queue.splice(at,0,task);pump();
    });
    async function post(path,body,type='application/json') {
      alive();
      if(client){
        let receipt;
        if(path==='/uploads/intents')receipt=await client.intent(body.request_key);
        else{
          const match=/^\/uploads\/([a-f0-9-]{36})\/(bytes|source|status|remove|original|preview|crop)$/.exec(path);
          if(!match)throw fail();
          receipt=await client[match[2]](match[1],match[2]==='source'?body.url:body);
        }
        alive();return receipt;
      }
      const controller=new AbortController();controllers.add(controller);
      const timeout=setTimeout(()=>controller.abort(),15000);
      try {
        const response=await fetchImpl(new URL(path,base).href,{method:'POST',credentials:'same-origin',
          redirect:'error',cache:'no-store',signal:controller.signal,headers:{'Content-Type':type},
          body:type==='application/json'?JSON.stringify(body):body});
        alive();if(!response.ok||response.redirected)throw fail();
        const receipt=await response.json();alive();return receipt;
      } finally {clearTimeout(timeout);controllers.delete(controller);}
    }
    function accept(row,receipt){
      if(!uuid.test(receipt?.intent_id)||(row.intent&&receipt.intent_id!==row.intent))throw fail();
      // Validate before storing the first intent. Only matching server receipts
      // feed the bridge; no UUID/verified/owner input is accepted by this API.
      try{lifecycle.apply(receipt,row.key);}catch(error){
        observe({stage:'upload-receipt',state:'rejected',code:({'Invalid upload receipt':'INVALID_RECEIPT','Conflicting upload receipt':'CONFLICTING_RECEIPT','Retired upload':'RETIRED_UPLOAD'})[error?.message]??'UNAVAILABLE'});throw error;
      }row.intent=receipt.intent_id;
      if(!row.receipt||receipt.version>=row.receipt.version)row.receipt=receipt;
      return receipt;
    }
    async function intent(row){
      if(!row.intent){row.intentStarted=true;accept(row,await post('/uploads/intents',{request_key:row.request}));}
    }
    const mark=row=>{alive();if(row.receipt?.state!=='removed')lifecycle.pending(row.key);};
    const find=key=>{alive();const row=rows.get(key);if(!row)throw fail();return row;};
    const refreshable=row=>!row.remove&&!row.cropPending&&!row.previewFailed&&row.receipt?.state==='complete';
    const stale=row=>!lifecycle.snapshot().completedAssetIds.includes(row.receipt.asset_id);
    const refreshComplete=(row,force=false)=>{
      if(row.statusFlight)return row.statusFlight;
      if(!refreshable(row)||!force&&!stale(row))return Promise.resolve();
      row.statusFlight=serial(async()=>{
        if(!refreshable(row)||!force&&!stale(row))return;
        mark(row);const receipt=await post(`/uploads/${row.intent}/status`,{});
        // Late status must not undo an explicit removal or preview failure.
        if(refreshable(row))accept(row,receipt);
      },false,true).finally(()=>{row.statusFlight=null;});
      return row.statusFlight;
    };
    return {
      restore(uploads){
        alive();if(rows.size||!Array.isArray(uploads)||!uploads.length||typeof client?.restore!=='function')throw fail();
        client.restore(uploads.map(value=>value.receipt));
        return uploads.map(value=>{
          const key=id(),row={key,intent:value.receipt.intent_id,remove:false};
          if(value.receipt.state!=='complete')throw fail();
          accept(row,value.receipt);rows.set(key,row);
          return Object.freeze({key,file:value.file,completion:Promise.resolve(value.receipt)});
        });
      },
      select(key,file){
        alive();if(typeof key!=='string'||!key)throw fail();
        if(rows.has(key))return rows.get(key).flight; // never repeat bytes after an uncertain response
        const row={key,request:id(),intent:null,remove:false};rows.set(key,row);mark(row);
        if(!(file instanceof Blob)||file.size<1||file.size>20*1024*1024||
          !['image/jpeg','image/png','image/tiff'].includes(file.type)){
          // A rejected new selection must also block previously completed files
          // until explicit removal; it must not silently disappear from state.
          row.flight=Promise.reject(fail());return row.flight;
        }
        row.flight=serial(async()=>{
          if(row.remove)return row.receipt;
          await intent(row);
          if(row.remove){mark(row);return;} // queued remove will retire the issued intent
          mark(row);
          try {return accept(row,await post(`/uploads/${row.intent}/bytes`,file,file.type));}
          finally {if(row.remove)mark(row);}
        });return row.flight;
      },
      selectSource(key,url){
        alive();if(typeof key!=='string'||!key)throw fail();
        if(rows.has(key))return rows.get(key).flight;
        const row={key,request:id(),intent:null,remove:false};rows.set(key,row);mark(row);
        if(typeof url!=='string'||url.length>768||!url.startsWith('https://')){row.flight=Promise.reject(fail());return row.flight;}
        row.flight=serial(async()=>{
          if(row.remove)return row.receipt;
          await intent(row);if(row.remove){mark(row);return;}
          mark(row);
          try{return accept(row,await post(`/uploads/${row.intent}/source`,{url}));}
          finally{if(row.remove)mark(row);}
        });return row.flight;
      },
      crop(key,coordinates){
        const row=find(key);if(row.remove||!row.intent||row.cropPending)throw fail();
        row.cropPending=true;mark(row);
        return serial(async()=>{
          const crop=await coordinates;if(row.remove)throw fail();
          const result=await post(`/uploads/${row.intent}/crop`,crop);
          if(row.remove)throw fail();
          accept(row,result.receipt);row.cropPending=false;return result;
        });
      },
      original(key){
        const row=find(key);if(row.remove||!row.intent)throw fail();
        return serial(()=>post(`/uploads/${row.intent}/original`,{}));
      },
      refresh(key){
        const row=find(key);mark(row);
        return serial(async()=>{await intent(row);mark(row);return accept(row,await post(`/uploads/${row.intent}/${row.remove?'remove':'status'}`,{}));});
      },
      remove(key){
        const row=find(key);row.remove=true;mark(row);
        if(!row.intent&&!row.intentStarted){lifecycle.discardUnstarted(row.key);row.receipt={state:'removed'};return Promise.resolve(row.receipt);}
        return serial(async()=>{await intent(row);mark(row);return accept(row,await post(`/uploads/${row.intent}/remove`,{}));},true);
      },
      failPreview(key){const row=find(key);if(row.remove)return;row.previewFailed=true;mark(row);},
      // Refresh only known completed uploads. Never replay bytes or turn an
      // uncertain/failed selection into an implicitly accepted one.
      refreshCompleted(){
        const invalid=[...rows.values()].filter(row=>((row.cropPending||row.previewFailed)&&!row.remove)||!['complete','removed'].includes(row.receipt?.state)||
          (row.remove&&row.receipt.state!=='removed'));
        if(invalid.length){observe({stage:'upload-refresh',state:'blocked',count:invalid.length,preview_failed:invalid.filter(row=>row.previewFailed&&!row.remove).length,removal_pending:invalid.filter(row=>row.remove&&row.receipt?.state!=='removed').length,nonterminal:invalid.filter(row=>!['complete','removed'].includes(row.receipt?.state)).length});return Promise.reject(fail());}
        return Promise.all([...rows.values()].filter(refreshable).map(row=>refreshComplete(row,true)));
      },
      // Partial batches refresh stale successes without accepting failed files.
      // Once the batch settles, read every complete proof: one that is fresh now
      // can expire while later reads finish. Flights still coalesce; no polling.
      refreshSuccessful({settled=false}={}){
        alive();const selected=[...rows.values()];
        const complete=settled&&selected.every(row=>row.receipt?.state==='removed'||refreshable(row));
        return Promise.allSettled(selected.filter(refreshable).map(row=>refreshComplete(row,complete)));
      },
      recoverySelection(){
        alive();const state=lifecycle.snapshot(),selected=[...rows.values()].filter(row=>!row.remove);
        if(state.pending||state.failed||!selected.length||selected.length>1000||selected.length!==state.completedAssetIds.length||
          selected.some(row=>!refreshable(row)||!uuid.test(row.intent)||!state.completedAssetIds.includes(row.receipt.asset_id)))throw fail();
        return {version:'uncommitted-v1',intent_ids:selected.map(row=>row.intent)};
      },
      snapshot(){alive();const state=lifecycle.snapshot();return {...state,pending:state.pending+[...rows.values()].filter(row=>row.cropPending&&!row.remove).length,failed:state.failed+[...rows.values()].filter(row=>row.previewFailed&&!row.remove).length};},
      // Preparation is diagnostic only. F06C must implement authenticated actual
      // cart publication/recalculation AFTER a separately permitted pending add.
      async prepare(selection){
        alive();const state=lifecycle.snapshot();
        if(state.pending||state.failed||!state.completedAssetIds.length)throw fail();
        const result=await post('/jobs',{...selection,asset_ids:[...state.completedAssetIds].sort(),request_key:id()});
        if(result.checkout_ready!==false)throw fail();return result;
      },
      dispose(){closed=true;for(const c of controllers)c.abort();lifecycle.reset();rows.clear();},
    };
  }
  root.BFLUploadTransport={create};
})(typeof window==='undefined'?globalThis:window);
