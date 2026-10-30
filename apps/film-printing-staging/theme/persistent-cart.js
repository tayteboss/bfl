import {mountCustomerForm,mountCustomerCart} from './customer-form.js';
import {readNativeCart} from './native-cart-read.js';

export const PERSISTENT_CLIENT_POLICY='bfl-persistent-staging-client-v1';
const STORE='bellows-film-printing-staging.myshopify.com';
const target='15620086005871',variants=new Set(['67852705202287','68068335714415','68068358848623','68068358881391','68068358914159']);
const protectedLine=row=>String(row.product_id)===target||variants.has(String(row.variant_id))||Object.keys(row.properties??{}).some(key=>key.startsWith('_bfl_'));
const fail=code=>{throw Error(code);};
const parse=text=>{try{return JSON.parse(text);}catch{return null;}};
const pending=record=>record?.state==='pending';

// The native capability is used in memory only. Shared custody contains the
// original finite resource credential and never the native cart capability.
export async function createPersistentCartCoordinator({cartId,storage=globalThis.localStorage,locks=globalThis.navigator?.locks,
  events=globalThis,cryptoImpl=globalThis.crypto,onInvalidate=()=>{},onStale=()=>{}}={}){
  if(!/^gid:\/\/shopify\/Cart\/[A-Za-z0-9_-]+\?key=[A-Za-z0-9_-]+$/.test(cartId??'')||typeof locks?.request!=='function'||
    !storage||typeof events?.addEventListener!=='function')fail('PERSISTENT_CART_UNAVAILABLE');
  const hash=Array.from(new Uint8Array(await cryptoImpl.subtle.digest('SHA-256',new TextEncoder().encode(cartId))),b=>b.toString(16).padStart(2,'0')).join('');
  const key=`bfl:persistent-cart:v1:${hash}`,lockName=`bfl:persistent-cart:v1:${hash}`;
  let expected=storage.getItem(key),active=false,stale=false,disposed=false,announced=false;
  const lifetime=new AbortController(),queued=new Set(),localWaiters=new Set();
  const invalidate=()=>{if(!stale){stale=true;onInvalidate();}};
  const changed=()=>storage.getItem(key)!==expected;
  const staleError=()=>{
    invalidate();if(!announced){announced=true;onStale();}
    return Object.assign(Error('RESOURCE_SUPERSEDED'),{refreshRequired:true,cartUncertain:pending(parse(storage.getItem(key)))});
  };
  const guarded=Object.freeze({
    getItem(name){if(name!==key)fail('RESOURCE_TARGET');return storage.getItem(key);},
    setItem(name,value){
      if(name!==key||typeof value!=='string'||disposed)fail('PERSISTENT_OPERATION_REQUIRED');
      if(changed())throw staleError();
      if(value===expected)return; // Async upload continuations may repeat pending custody.
      if(!active)fail('PERSISTENT_OPERATION_REQUIRED');
      storage.setItem(key,value);expected=value;
    },
    removeItem(name){
      if(name!==key||disposed||!active||typeof storage.removeItem!=='function')fail('PERSISTENT_OPERATION_REQUIRED');
      if(changed())throw staleError();
      storage.removeItem(key);expected=null;
    },
  });
  // Only acquisition is bounded. Once entered, work retains the exclusive
  // lock until it settles, including any already-dispatched native mutation.
  const acquire=work=>{
    if(disposed)return Promise.reject(Error('PERSISTENT_CART_UNAVAILABLE'));
    const controller=new AbortController();queued.add(controller);
    const timer=setTimeout(()=>controller.abort(Error('PERSISTENT_CART_BUSY')),30000);
    const releaseWait=()=>{clearTimeout(timer);queued.delete(controller);};
    return Promise.resolve().then(()=>locks.request(lockName,{mode:'exclusive',signal:controller.signal},async()=>{
      releaseWait();if(disposed)fail('PERSISTENT_CART_UNAVAILABLE');return work();
    })).catch(error=>{throw controller.signal.aborted?controller.signal.reason:error;}).finally(releaseWait);
  };
  // Queue this page before acquiring the cross-tab lock. A second local upload
  // must not spend the acquisition timeout waiting for our own active transfer.
  let local=Promise.resolve();
  const run=work=>{
    if(disposed)return Promise.reject(Error('PERSISTENT_CART_UNAVAILABLE'));
    let rejectQueued;
    const waiting=new Promise((_,reject)=>{rejectQueued=reject;});
    localWaiters.add(rejectQueued);
    const result=local.then(()=>{
      localWaiters.delete(rejectQueued);
      return acquire(async()=>{
        if(stale||changed())throw staleError();
        active=true;try{return await work();}finally{active=false;}
      });
    });
    local=result.catch(()=>{});return Promise.race([result,waiting]);
  };
  const dispose=()=>{
    if(disposed)return;disposed=true;
    lifetime.abort(Error('PERSISTENT_CART_UNAVAILABLE'));
    for(const reject of localWaiters)reject(lifetime.signal.reason);
    localWaiters.clear();
    for(const controller of queued)controller.abort(Error('PERSISTENT_CART_UNAVAILABLE'));
    events.removeEventListener('storage',onStorage);events.removeEventListener('pagehide',dispose);
  };
  const onStorage=event=>{
    if(event.key!==key||event.storageArea&&event.storageArea!==storage)return;
    // restore() temporarily suspends custody while a read runs. Observe only
    // after its lock releases, so that internal checkpoint cannot cause loops.
    acquire(()=>{if(!disposed&&changed())invalidate();}).catch(()=>{});
  };
  events.addEventListener('storage',onStorage);events.addEventListener('pagehide',dispose);
  return Object.freeze({policy:PERSISTENT_CLIENT_POLICY,key,storage:guarded,run,signal:lifetime.signal,widgetFlow:flow=>coordinateWidgetFlow(flow,{run}),
    assertCurrent(){if(disposed)fail('PERSISTENT_CART_UNAVAILABLE');if(stale)throw staleError();},
    assertInitial(){
      const record=parse(guarded.getItem(key));
      if(record?.state==='blocked'&&Object.keys(record).length===1)return; // One bounded legacy initialization recovery.
      if(record&&record.client_policy!==PERSISTENT_CLIENT_POLICY)fail('RESOURCE_SESSION_POLICY');
      // Pending/null can only enter authenticated preparation diagnosis. Its
      // original credential is not permission to issue a replacement or Add.
      if(pending(record)&&record.operation?.kind==='replace_session')throw Object.assign(Error('RESOURCE_UNAVAILABLE'),{cartUncertain:true});
    },
    dispose,
  });
}

// Widget factories are synchronous. Give each queued selection a local handle;
// keep intent allocation and its one transfer together under the operation lock.
// Preview fetching/decoding and readiness run after transfer completion.
export function coordinateWidgetFlow(flow,coordinator,{id=()=>crypto.randomUUID()}={}){
  const selections=new Map();
  const actual=async key=>selections.has(key)?(await selections.get(key).started).key:key;
  const selection=work=>{
    const key=id(),row={cancelled:false};selections.set(key,row);
    let started,rejected;
    row.started=new Promise((resolve,reject)=>{started=resolve;rejected=reject;});
    row.started.catch(()=>{});
    const completion=coordinator.run(async()=>{
      if(row.cancelled)fail('UPLOAD_CANCELLED');
      const value=work();started(value);return await value.completion;
    });
    completion.catch(rejected);
    return Object.freeze({key,completion});
  };
  return Object.freeze({...flow,
    select:files=>Array.from(files,file=>selection(()=>flow.select([file])[0])),
    selectSource:url=>selection(()=>flow.selectSource(url)),
    original:async key=>flow.original(await actual(key)),
    selectionReady:async key=>flow.selectionReady(await actual(key)),
    selectionFailed:async key=>flow.selectionFailed(await actual(key)),
    async remove(key){const row=selections.get(key);if(row)row.cancelled=true;let resolved;try{resolved=await actual(key);}catch(error){if(row?.cancelled&&error?.message==='UPLOAD_CANCELLED')return;throw error;}return flow.remove(resolved);},
    crop:async(key,value)=>flow.crop(await actual(key),value),
  });
}

export async function readUnprotectedNativeCart({actions,fetchImpl,cartId,signal}){
    const before=await readNativeCart(actions,{signal});if(before?.cart?.id!==cartId)fail('RESOURCE_SUPERSEDED');
    const response=await fetchImpl(`${globalThis.routes?.cart_url??'/cart'}.js`,{credentials:'same-origin',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(10000)});
    if(!response.ok||response.redirected)fail('CHECKOUT_UNAVAILABLE');const ajax=await response.json();
    if(!Array.isArray(ajax?.items)||ajax.items.some(protectedLine))fail('RESOURCE_EXPIRED');
    const after=await readNativeCart(actions,{signal});if(after?.cart?.id!==cartId||JSON.stringify(after.cart)!==JSON.stringify(before.cart))fail('RESOURCE_SUPERSEDED');
    return cartId;
}

// getCart is read-only and explicitly returns null for a new browser. The only
// initialization mutation is an empty note, sent once under a browser-wide lock.
// A lost response never causes a replay; an existing empty cart can be reconciled
// by two stable native reads after Shopify's default handler reloads the page.
export async function readPersistentNativeCart({actions,createIfMissing=false,storage=globalThis.localStorage,
  locks=globalThis.navigator?.locks,cryptoImpl=globalThis.crypto}={}){
  const valid=cart=>typeof cart?.id==='string'&&cart.id.length<=4096&&/^gid:\/\/shopify\/Cart\/[A-Za-z0-9_-]+\?key=[A-Za-z0-9_-]+$/.test(cart.id);
  const read=async()=>{
    const result=await readNativeCart(actions);
    if(result?.cart!==null&&!valid(result?.cart))fail('PERSISTENT_CART_UNAVAILABLE');
    return result.cart;
  };
  if(typeof actions?.getCart!=='function')fail('PERSISTENT_CART_UNAVAILABLE');
  if(!createIfMissing)return read(); // Ordinary empty cart pages stay ordinary.
  if(typeof locks?.request!=='function'||typeof storage?.getItem!=='function'||typeof storage?.setItem!=='function'||
    typeof storage?.removeItem!=='function')fail('PERSISTENT_CART_UNAVAILABLE');
  const key='bfl:persistent-native-init:v1';let reserved=false;
  const uncertain=()=>{throw Object.assign(Error('PERSISTENT_CART_UNCONFIRMED'),{cartUncertain:true});};
  const digest=async id=>Array.from(new Uint8Array(await cryptoImpl.subtle.digest('SHA-256',new TextEncoder().encode(id))),b=>b.toString(16).padStart(2,'0')).join('');
  const empty=cart=>{
    const lines=Array.isArray(cart?.lines)?cart.lines:cart?.lines?.nodes;
    return valid(cart)&&cart.totalQuantity===0&&Array.isArray(lines)&&lines.length===0;
  };
  const wait=new AbortController(),waitTimer=setTimeout(()=>wait.abort(Error('PERSISTENT_CART_BUSY')),30000);
  return Promise.resolve().then(()=>locks.request(key,{mode:'exclusive',signal:wait.signal},async()=>{
    // Do not release or race an already dispatched updateCart. Only another
    // document's queued acquisition times out; the pending journal stays exact.
    clearTimeout(waitTimer);
    let saved=storage.getItem(key),record=saved===null?null:parse(saved);
    if(saved!==null&&(record?.version!==1||record.state!=='pending'||!(record.cart_hash===null||/^[a-f0-9]{64}$/.test(record.cart_hash))))uncertain();
    reserved=record!==null;
    let cart=await read();
    if(cart!==null&&record===null)return cart; // Never touch an existing note/cart.
    if(cart===null){
      if(record)uncertain();
      if(typeof actions.updateCart!=='function'||typeof cryptoImpl?.subtle?.digest!=='function')fail('PERSISTENT_CART_UNAVAILABLE');
      record={version:1,state:'pending',cart_hash:null};
      saved=JSON.stringify(record);storage.setItem(key,saved);reserved=true;
      let result;try{result=await actions.updateCart({note:''},{signal:AbortSignal.timeout(10000)});}catch{uncertain();}
      if(!empty(result?.cart)||['userErrors','warnings'].some(name=>result[name]!==undefined&&(!Array.isArray(result[name])||result[name].length)))uncertain();
      record.cart_hash=await digest(result.cart.id);
      if(storage.getItem(key)!==saved)uncertain();
      saved=JSON.stringify(record);storage.setItem(key,saved);
      cart=await read();
    }
    if(!empty(cart)||record.cart_hash!==null&&await digest(cart.id)!==record.cart_hash)uncertain();
    const after=await read();
    if(!empty(after)||JSON.stringify(after)!==JSON.stringify(cart)||storage.getItem(key)!==saved)uncertain();
    storage.removeItem(key);reserved=false;
    return after;
  })).catch(error=>{if(reserved&&!error?.cartUncertain)uncertain();throw wait.signal.aborted?wait.signal.reason:error;}).finally(()=>clearTimeout(waitTimer));
}

export async function mountPersistentCustomer({form=document.querySelector('[data-film-printing-form]'),actions=globalThis.Shopify?.actions,
  storage=globalThis.localStorage,locks=globalThis.navigator?.locks,events=globalThis,fetchImpl=globalThis.fetch?.bind(globalThis),
  reload=()=>location.reload(),widget=globalThis.BFLOwnedWidget,publicKey,observe=()=>{},...options}={}){
  if(location.hostname!==STORE||typeof actions?.getCart!=='function'||typeof fetchImpl!=='function')fail('PERSISTENT_CART_UNAVAILABLE');
  const native=await readPersistentNativeCart({actions,createIfMissing:!!form,storage,locks});
  if(native===null)return Object.freeze({ready:Promise.resolve(null),dispose:()=>{}});
  const cartId=native.id;
  let mounted;
  const coordinator=await createPersistentCartCoordinator({cartId,storage,locks,events,
    onInvalidate:()=>globalThis.BFLPrintJob?.forForm(form)?.invalidateSharedCart?.(),
    onStale:()=>{
      const message='Your cart changed in another tab. Refreshing this page…';
      for(const node of document.querySelectorAll('[data-film-service-error],[data-film-service-error-bottom],#cart-errors,#CartDrawer-CartErrors')){node.textContent=message;node.style.display='';}
      setTimeout(reload,0);
    }});
  // A back/forward cached document must reacquire authenticated custody through
  // a normal load, never reuse the controller disposed by pagehide.
  const onPageShow=event=>{if(event.persisted&&coordinator.signal.aborted)reload();};
  events.addEventListener('pageshow',onPageShow);
  const dispose=()=>{events.removeEventListener('pageshow',onPageShow);coordinator.dispose();};
  const replacementCart=()=>readUnprotectedNativeCart({actions,fetchImpl,cartId,signal:coordinator.signal});
  const sessionOptions={...options.sessionOptions,reloadStorage:coordinator.storage,reloadKey:coordinator.key,clientPolicy:PERSISTENT_CLIENT_POLICY,replaceCart:replacementCart,verifyNewCart:replacementCart,assertInitial:coordinator.assertInitial,assertCurrent:coordinator.assertCurrent};
  try{
    const common={...options,persistent:coordinator,sessionOptions,observe,checkoutOptions:{...options.checkoutOptions,actions,fetchImpl,signal:coordinator.signal}};
    mounted=form?mountCustomerForm(form,{...common,preparedCart:true,widget,publicKey}):mountCustomerCart(common);
    return Object.freeze({ready:mounted?.ready??Promise.resolve(null),dispose,snapshot:mounted?.snapshot});
  }catch(error){dispose();throw error;}
}
