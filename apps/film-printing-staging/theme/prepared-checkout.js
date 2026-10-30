import {readNativeCart} from './native-cart-read.js';
// Explicit finite staging adapter. Native writes are never automatically replayed.
const STORE='bellows-film-printing-staging.myshopify.com';
// Conservative classification only; these are the exact staging target IDs
// from checkout/authority.js. Server observations still own every job/price.
const PRINT_PRODUCT='15620086005871';
const PRINT_VARIANTS=new Set(['67852705202287','68068335714415','68068358848623','68068358881391','68068358914159']);
const numericId=value=>String(value??'').split('/').at(-1);
const protectedLine=line=>numericId(line?.product_id)===PRINT_PRODUCT||PRINT_VARIANTS.has(numericId(line?.variant_id))||
  Object.keys(line?.properties??{}).some(key=>key.startsWith('_bfl_'));

const MUTATIONS={
  add:['cartLinesAdd','CartLineInput','lines:$lines'],
  change:['cartLinesUpdate','CartLineUpdateInput','lines:$lines'],
  remove:['cartLinesRemove','String','viewKeys:$lines'],
};
const mutationQuery=kind=>{const [name,type,args]=MUTATIONS[kind];return `mutation PreparedCart($i:ID!,$lines:[${type}!]!,$c:CountryCode!,$l:LanguageCode!) @inContext(country:$c,language:$l){${name}(cartId:$i,${args}){cart{id totalQuantity lines(first:20){nodes{id quantity} pageInfo{hasNextPage}}} userErrors{code field} warnings{code target}}}`;};
const KEYS=['_bfl_flow','_bfl_job','_bfl_revision','_bfl_config','_bfl_signature','Service','Sizes','Paper','Location','Message','Borders','Turnaround','Files Uploaded','_bfl_size_mode','Custom Width','Custom Height','Process','Scanning Options','Negatives'];
const need=value=>{if(!value)throw Error('CHECKOUT_UNAVAILABLE');};
const readFailure=error=>Object.assign(error instanceof Error?error:Error('CHECKOUT_UNAVAILABLE'),{readOnlyFailure:true});
const integer=v=>Number.isSafeInteger(v)&&v>0&&v<=10000;
const fileCountValid=(count,p)=>['darkroom','Darkroom Prints'].includes(p.Service)?count===0&&p._bfl_size_mode==='fixed':integer(count);
const equal=(a,b)=>a&&b&&Object.keys(a).length===Object.keys(b).length&&Object.entries(a).every(([k,v])=>b[k]===v);
export function signatureForQuantity(raw,quantity){need(/^[a-f0-9]{64}$/.test(raw)&&integer(quantity));return `v3:${raw}:${quantity}`;}
function cents(money){
  need(money?.currencyCode==='USD'&&typeof money.amount==='string'&&/^\d+(?:\.\d{1,2})?$/.test(money.amount));
  const [whole,fraction='']=money.amount.split('.'),value=Number(whole)*100+Number(fraction.padEnd(2,'0'));
  need(Number.isSafeInteger(value));return value;
}
function properties(value){
  need(value&&typeof value==='object'&&!Array.isArray(value));
  const result=Object.fromEntries(KEYS.filter(k=>Object.hasOwn(value,k)).map(k=>[k,value[k]]));
  need(Object.values(result).every(v=>typeof v==='string'));return result;
}
const sealed=items=>Object.freeze({items:Object.freeze(items.map(item=>Object.freeze({...item,properties:Object.freeze({...item.properties})})))});

export function createPreparedCheckout(session,{actions=globalThis.Shopify?.actions,fetchImpl=globalThis.fetch?.bind(globalThis),expectedCartHash,
  signal,cartUrl=globalThis.routes?.cart_url??`${globalThis.Shopify?.routes?.root??'/'}cart`,sectionIds=()=>['cart-drawer'],now=Date.now,observe=()=>{}}={}){
  need(['checkout','request','assertLive','beginMutation','preparationGeneration','rememberPreparationGeneration'].every(k=>typeof session?.[k]==='function')&&typeof actions?.getCart==='function'&&typeof fetchImpl==='function');
  const url=new URL(cartUrl,globalThis.location.origin);need(url.origin===globalThis.location.origin&&url.hostname===STORE&&!url.search&&!url.hash);
  const base=url.pathname;
  const country=globalThis.Shopify?.country??'US',locale=(globalThis.Shopify?.locale??'EN').trim().replace(/-/g,'_').toUpperCase();
  const language=['PT_BR','PT_PT','ZH_CN','ZH_TW'].includes(locale)?locale:locale.split('_')[0]||'EN';
  need(/^[A-Z]{2}$/.test(country)&&/^[A-Z]{2}(?:_[A-Z]{2})?$/.test(language));
  let cartId=null,initialized=null,preparing=false,mutating=false,blocked=false,acceptedNative=null,acceptedAjax=null,accepted=sealed([]),lastOperation=null,uploadRecovery=false;
  const trusted=new Map(),issued=new WeakSet(),spentAdds=new Set(),readbackNative=new WeakMap();
  const live=expiry=>{session.assertLive();if(expiry!==undefined){need(Number.isSafeInteger(expiry));if(now()>=expiry)throw Error('PREPARED_EXPIRED');}};
  function parseNative(cart,{identityOnly=false}={}){
    const lines=Array.isArray(cart?.lines)?cart.lines:cart?.lines?.nodes;
    need(cart&&typeof cart.id==='string'&&/^gid:\/\/shopify\/Cart\/[A-Za-z0-9_-]+\?key=[A-Za-z0-9_-]+$/.test(cart.id)&&Array.isArray(lines)&&lines.length<=20);
    need(cartId===null||cart.id===cartId);
    need(lines.every(l=>typeof l.id==='string'&&l.id&&integer(l.quantity))&&new Set(lines.map(l=>l.id)).size===lines.length);
    need(cart.totalQuantity===lines.reduce((s,l)=>s+l.quantity,0));
    if(identityOnly)need(cart.lines?.pageInfo?.hasNextPage===false);
    else{for(const line of lines)cents(line.cost?.totalAmount);cents(cart.cost?.totalAmount);}
    cartId=cart.id;return {...cart,lines};
  }
  async function native(){const start=performance.now();try{let result;try{result=await readNativeCart(actions,{signal});}catch(error){throw readFailure(error);}return parseNative(result?.cart);}finally{observe({stage:'timing',operation:'native-read',ms:Math.round(performance.now()-start)});}}
  const locate=async()=>(await native()).id;
  const sameNativeLines=(a,b)=>a.id===b.id&&a.totalQuantity===b.totalQuantity&&a.lines.length===b.lines.length&&a.lines.every(l=>b.lines.some(r=>r.id===l.id&&r.quantity===l.quantity));
  const sameNative=(a,b)=>sameNativeLines(a,b)&&a.lines.every(l=>b.lines.some(r=>r.id===l.id&&cents(r.cost.totalAmount)===cents(l.cost.totalAmount)));
  function verifyNative(cart,expected){
    const actual=cart.lines.map(l=>`${l.quantity}:${cents(l.cost.totalAmount)}`).sort(),wanted=expected.map(l=>`${l.quantity}:${l.subtotal_cents}`).sort();
    need(JSON.stringify(actual)===JSON.stringify(wanted));
    for(const item of expected)if(item.native_id)need(cart.lines.some(line=>line.id===item.native_id&&line.quantity===item.quantity&&cents(line.cost.totalAmount)===item.subtotal_cents));
    const subtotal=expected.reduce((s,l)=>s+l.subtotal_cents,0),total=cents(cart.cost.totalAmount);need(expected.length?total>=subtotal:total===0);
  }
  function expectedLine(record,quantity){
    live(record.expires_at);need(integer(quantity));const subtotal=record.unit_price_cents*quantity;
    need(Number.isSafeInteger(subtotal)&&subtotal>0&&subtotal<=200000);
    return {variant_id:record.item.id,quantity,properties:{...record.item.properties,_bfl_signature:signatureForQuantity(record.reference.signature,quantity)},subtotal_cents:subtotal};
  }
  function ordinaryLine(line){
    need(!protectedLine(line)&&/^\d+$/.test(String(line.variant_id))&&integer(line.quantity)&&Number.isSafeInteger(line.subtotal_cents)&&line.subtotal_cents>=0);
    const p=line.properties;need(p&&typeof p==='object'&&!Array.isArray(p)&&Object.values(p).every(value=>typeof value==='string'));
    return {variant_id:String(line.variant_id),quantity:line.quantity,properties:{...p},subtotal_cents:line.subtotal_cents,
      ...(line.native_id?{native_id:line.native_id}:{}),...(line.key?{key:line.key}:{}),
      ...(line.product_id?{product_id:String(line.product_id)}:{}),...(line.final_price!==undefined?{final_price:line.final_price}:{})};
  }
  function verifyAjax(cart,expected){
    need(cart?.currency==='USD'&&Array.isArray(cart.items)&&cart.items.length===expected.length&&cart.items.length<=20);
    need(cart.items.every(row=>typeof row.key==='string'&&row.key)&&new Set(cart.items.map(r=>r.key)).size===cart.items.length);
    const signed=cart.items.filter(protectedLine);need(new Set(signed.map(r=>r.properties?._bfl_job)).size===signed.length);
    const used=new Set(),actual=expected.map(wanted=>{
      const owned=protectedLine(wanted);
      const matches=cart.items.filter(row=>!used.has(row.key)&&(owned?row.properties?._bfl_job===wanted.properties._bfl_job:
        !protectedLine(row)&&(!wanted.key||row.key===wanted.key)&&String(row.variant_id)===wanted.variant_id&&row.quantity===wanted.quantity&&row.final_line_price===wanted.subtotal_cents&&equal(row.properties??{},wanted.properties)));
      need(matches.length>0&&(owned?matches.length===1:true));const row=matches[0];used.add(row.key);
      need(String(row.variant_id)===wanted.variant_id&&row.quantity===wanted.quantity&&row.final_line_price===wanted.subtotal_cents&&!row.selling_plan_allocation&&equal(row.properties??{},wanted.properties));
      if(owned)need(row.final_price*row.quantity===wanted.subtotal_cents);
      else need(/^\d+$/.test(String(row.product_id))&&String(row.product_id)!==PRINT_PRODUCT&&Number.isSafeInteger(row.final_price)&&row.final_price>=0&&
        (wanted.product_id===undefined||String(row.product_id)===wanted.product_id)&&(wanted.final_price===undefined||row.final_price===wanted.final_price));
      return {id:row.key,key:row.key,variant_id:String(row.variant_id),quantity:row.quantity,properties:{...(row.properties??{})},subtotal_cents:row.final_line_price,
        ...(!owned?{product_id:String(row.product_id),final_price:row.final_price,...(wanted.native_id?{native_id:wanted.native_id}:{})}:{})};
    });
    const total=expected.reduce((s,l)=>s+l.subtotal_cents,0);need(Number.isSafeInteger(total)&&total<=200000&&cart.item_count===expected.reduce((s,l)=>s+l.quantity,0)&&cart.total_price===total);return sealed(actual);
  }
  function ordinaryAjax(cart){
    need(Array.isArray(cart?.items));
    return verifyAjax(cart,cart.items.map(row=>ordinaryLine({...row,variant_id:String(row.variant_id),properties:row.properties??{},subtotal_cents:row.final_line_price})));
  }
  async function getJSON(path){let response;try{response=await fetchImpl(path,{credentials:'same-origin',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(10000)});}catch(error){throw readFailure(error);}need(response.ok&&!response.redirected);try{return await response.json();}catch(error){if(['TypeError','AbortError','TimeoutError'].includes(error?.name))throw readFailure(error);throw error;}}
  async function mutate(kind,lines){
    // Tokenless Storefront Cart writes support an explicit full cart capability.
    // Prices are read independently after this one mutation; no fallback/retry.
    const start=performance.now();
    const response=await fetchImpl('/api/2026-07/graphql.json',{method:'POST',credentials:'same-origin',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:mutationQuery(kind),variables:{i:cartId,lines:kind==='remove'?lines.map(line=>line.viewKey):lines,c:country,l:language}}),signal:AbortSignal.timeout(10000)});
    const headersAt=performance.now();
    need(response.ok&&!response.redirected);const result=await response.json();
    observe({stage:'timing',operation:'mutation-response',kind,status:response.status??null,headers_ms:Math.round(headersAt-start),json_ms:Math.round(performance.now()-headersAt)});
    need(result&&(!Object.hasOwn(result,'errors')||(Array.isArray(result.errors)&&result.errors.length===0)));
    const payload=result.data?.[MUTATIONS[kind][0]];
    need(payload&&Array.isArray(payload.userErrors)&&payload.userErrors.length===0&&Array.isArray(payload.warnings)&&payload.warnings.length===0);
    return payload;
  }
  async function readResult(expected,nativeCart,{freshNative=false}={}){
    const ids=[...new Set(sectionIds())];need(ids.length>0&&ids.length<=5&&ids.every(id=>typeof id==='string'&&id));
    const [ajax,sections,currentNative]=await Promise.all([getJSON(`${base}.js`),getJSON(`${base}?sections=${encodeURIComponent(ids.join(','))}`),freshNative?native():nativeCart]);
    // A successful mutation response can contain the previous calculation.
    // Independently read the current prices in the same parallel readback wave;
    // require exact line continuity and never repeat the mutation.
    need(sameNativeLines(nativeCart,currentNative));
    need(sections&&ids.every(id=>typeof sections[id]==='string'&&sections[id].length>0));
    const cart=verifyAjax(ajax,expected);verifyNative(currentNative,cart.items);
    if(freshNative&&nativeCart.cost&&!sameNative(nativeCart,currentNative))observe({stage:'readback',state:'mutation-price-refreshed'});
    const result={cart,render:{ajax,sections}};readbackNative.set(result,currentNative);return result;
  }
  const accept=(result,nativeCart)=>{accepted=result.cart;acceptedNative=readbackNative.get(result)??nativeCart;acceptedAjax=structuredClone(result.render.ajax);return result;};
  async function verifyHash(cart){
    if(expectedCartHash===undefined)return;need(/^[a-f0-9]{64}$/.test(expectedCartHash));
    const input=JSON.stringify(['bfl:native-cart-comparison:v1',STORE,'f06p-integrated-v1',cart.id.split('?')[0]]);
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(input))),b=>b.toString(16).padStart(2,'0')).join('');need(hash===expectedCartHash);
  }
  function recoveredRecords(selected){
    need(Array.isArray(selected?.items)&&Number.isSafeInteger(selected.expires_at));live(selected.expires_at);
    return selected.items.filter(protectedLine).map(line=>{
      const p=properties(line.properties),match=/^v3:([a-f0-9]{64}):([1-9]\d*)$/.exec(p._bfl_signature);
      need(match&&Number(match[2])===line.quantity&&integer(line.quantity)&&/^\d+$/.test(String(line.variant_id))&&Number.isSafeInteger(line.subtotal_cents)&&line.subtotal_cents>0&&line.subtotal_cents%line.quantity===0);
      const fileCount=Number(p['Files Uploaded']);need(fileCountValid(fileCount,p)&&p['Files Uploaded']===String(fileCount));
      return Object.freeze({reference:Object.freeze({id:p._bfl_job,revision:p._bfl_revision,config_version:p._bfl_config,signature:match[1]}),item:Object.freeze({id:String(line.variant_id),properties:Object.freeze({...p,_bfl_signature:match[1]})}),unit_price_cents:line.subtotal_cents/line.quantity,file_count:fileCount,expires_at:selected.expires_at});
    });
  }
  function preparedRecovery(selected,operation){
    const recovered=selected?.prepared_recovery,ticket=recovered?.reservation;
    need(['issued','cancelled'].includes(recovered?.state)&&ticket&&Object.keys(ticket).length===6&&
      ticket.operation_id===operation.operation_id&&ticket.job_id===operation.job&&ticket.generation===operation.generation&&
      ticket.expires_at===selected.expires_at&&/^[a-f0-9]{64}$/.test(ticket.owner_hash)&&/^[a-f0-9]{64}$/.test(ticket.cart_hash));
    return recovered;
  }
  function agreeSelected(selected,...carts){
    need(Array.isArray(selected?.items)&&selected.items.length<=20&&new Set(selected.items.map(line=>line.id)).size===selected.items.length);
    for(const cart of carts)need(cart.lines.length===selected.items.length&&selected.items.every(item=>typeof item.id==='string'&&cart.lines.some(line=>line.id===item.id&&line.quantity===item.quantity&&cents(line.cost.totalAmount)===item.subtotal_cents)));
  }
  async function adoptOrdinary(selected,before){
    live();const expected=selected.items.map(line=>ordinaryLine({...line,native_id:line.id}));
    const after=await native();agreeSelected(selected,before,after);
    const result=await readResult(expected,after);live();return accept(result,after);
  }
  async function adoptAuthenticated(selected,before){
    const records=recoveredRecords(selected);need(new Set(records.map(r=>r.reference.id)).size===records.length);
    const after=await native();agreeSelected(selected,before,after);
    const expected=selected.items.map(line=>protectedLine(line)?expectedLine(records.find(record=>record.reference.id===line.properties._bfl_job),line.quantity):ordinaryLine({...line,native_id:line.id}));
    const result=await readResult(expected,after);live(selected.expires_at);
    trusted.clear();for(const record of records){trusted.set(record.reference.id,record);spentAdds.add(record.reference.id);}return accept(result,after);
  }
  async function acceptKnownCurrent(selected,before){
    need(selected?.resumed===true&&selected.recovery==='known-current-v1'&&selected.reservation===undefined&&
      Number.isSafeInteger(selected.expires_at)&&selected.expires_at<=session.receipt?.().expires_at);
    const result=await adoptAuthenticated(selected,before);
    session.checkpoint(result.cart.items.some(protectedLine)?'accepted':'initialized');blocked=false;return result;
  }
  async function refreshOrdinary(before){
    // Ordinary Shopify edits may happen between print edits. Authenticate the
    // changed native snapshot, retaining every protected job exactly as accepted.
    // This is read-only reconciliation, never a mutation retry or new owner.
    const ordinaryIds=new Set(accepted.items.filter(line=>!protectedLine(line)).map(line=>line.native_id));
    for(const line of acceptedNative.lines.filter(line=>!ordinaryIds.has(line.id)))need(before.lines.some(current=>current.id===line.id&&current.quantity===line.quantity&&cents(current.cost.totalAmount)===cents(line.cost.totalAmount)));
    const selected=await session.checkout('current',async()=>before.id),after=await native();
    agreeSelected(selected,before,after);need(sameNative(before,after));
    const previous=accepted.items.filter(protectedLine),current=selected.items.filter(protectedLine);
    need(previous.length===current.length&&current.every(line=>previous.some(prior=>prior.properties._bfl_job===line.properties._bfl_job&&prior.variant_id===String(line.variant_id)&&prior.quantity===line.quantity&&prior.subtotal_cents===line.subtotal_cents&&equal(prior.properties,line.properties))));
    const expected=selected.items.map(line=>protectedLine(line)?previous.find(prior=>prior.properties._bfl_job===line.properties._bfl_job):ordinaryLine({...line,native_id:line.id}));
    const result=await readResult(expected,after);live();return accept(result,after);
  }
  async function write({kind,job,quantity,operationId,lines,expected,assertSelection,onWriteStarted}){
    need(!blocked&&!mutating&&!preparing&&acceptedNative);mutating=true;let dispatched=false,phase='current-cart';
    const check=()=>{live();const total=expected.reduce((sum,line)=>sum+line.subtotal_cents,0);need(Number.isSafeInteger(total)&&total>=0&&total<=200000);const changed=trusted.get(job);need(changed);live(changed.expires_at);for(const line of expected.filter(protectedLine)){const record=trusted.get(line.properties._bfl_job);need(record);live(record.expires_at);}};
    try{
      let [before,actualAjax]=await Promise.all([native(),getJSON(`${base}.js`)]);
      let unchanged=false;
      if(sameNative(before,acceptedNative)){try{const actual=verifyAjax(actualAjax,accepted.items);verifyNative(before,actual.items);unchanged=true;}catch{}}
      if(!unchanged){
        await refreshOrdinary(before);before=acceptedNative;actualAjax=acceptedAjax;
        // Rebuild only the ordinary portion of this proposed print operation.
        expected=[...expected.filter(protectedLine),...accepted.items.filter(line=>!protectedLine(line))];
      }
      if(kind!=='add'){
        const target=actualAjax.items.find(row=>row.properties._bfl_job===job);need(target&&lines.length===1);
        const replacement=expected.find(row=>row.properties._bfl_job===job);
        lines=[{viewKey:target.key,quantity,...(replacement?{attributes:Object.entries({...target.properties,_bfl_signature:replacement.properties._bfl_signature}).map(([key,value])=>({key,value}))}:{})}];
      }
      phase='selection';check();assertSelection?.();
      const operation={operation_id:operationId,kind,job,quantity};need(typeof operationId==='string'&&operationId);
      session.beginMutation(operation);lastOperation=operation;onWriteStarted?.();dispatched=true;if(kind==='add')spentAdds.add(job);
      phase='native-write';const start=performance.now();let response;
      try{response=await mutate(kind,lines);}finally{observe({stage:'timing',operation:'native-write',ms:Math.round(performance.now()-start)});}
      need(!response?.userErrors?.length&&!response?.warnings?.length&&response?.cart?.id===cartId);
      const returned=parseNative(response.cart,{identityOnly:true});phase='readback';check();const result=await readResult(expected,returned,{freshNative:true});check();
      if((kind==='add'||kind==='remove')&&session.receipt?.().client_policy==='bfl-persistent-staging-client-v1'){
        // Confirm Add before removal can orphan its issued reservation; confirm
        // removal before reporting success so the server releases unused grant
        // capacity. A lost acknowledgement stays pending; never replay.
        phase='confirmation';const selected=await session.checkout('resume',locate,{operation});
        need(selected?.resumed===true&&selected.expires_at===trusted.get(job).expires_at);
        live(selected.expires_at);agreeSelected(selected,readbackNative.get(result));check();
      }
      accept(result,returned);session.checkpoint();lastOperation=null;
      observe({stage:'cart-edit',state:'verified',lines:result.cart.items.length,total:result.cart.items.reduce((s,l)=>s+l.subtotal_cents,0)});return {accepted:true,...result};
    }catch(error){if(dispatched){blocked=true;error.cartUncertain=true;}observe({stage:'cart-edit',state:'rejected',kind,phase,dispatched});throw error;}finally{mutating=false;}
  }
  return Object.freeze({
    mode:'prepared-unit-v3',
    generationFloor:()=>session.preparationGeneration(),
    initialize({resume=false,resumeUploads=false,resumeEmpty=false,resumeInitialization=false,recovery=null,selection}={}){
      if(!initialized)initialized=(async()=>{
        const first=await native();await verifyHash(first);
        const capability=selected=>{uploadRecovery=selected?.upload_recovery==='uncommitted-v1';return uploadRecovery?{upload_recovery:'uncommitted-v1'}:{};};
        const restoreUploads=async before=>{
          const selected=await session.checkout('resume_uploads',locate,selection?{selection}:{});
          need(selected?.resumed_uploads===true&&Array.isArray(selected.uploads)&&Array.isArray(selected.items));
          if(selection)need(selected.upload_recovery==='uncommitted-v1');
          const result=await (selected.items.some(protectedLine)?adoptAuthenticated:adoptOrdinary)(selected,before);
          if(selection)session.checkpoint('uploads',null,selection);
          blocked=false;return {initialized:true,resumed:true,uploads:selected.uploads,...capability(selected),...result};
        };
        const finishCancellation=async(ticket,operation)=>{
          const before=await native(),current=await session.checkout('resume',locate,{operation});
          need(current?.resumed===true&&current.prepared_recovery?.state==='cancelled'&&equal(current.prepared_recovery.reservation,ticket)&&current.expires_at===ticket.expires_at);
          const result=await adoptAuthenticated(current,before);
          session.checkpoint(result.cart.items.some(protectedLine)?'accepted':'initialized');blocked=false;
          return {initialized:true,resumed:true,...capability(current),...result};
        };
        if(recovery?.state==='pending'&&recovery.operation===null&&session.receipt?.().client_policy==='bfl-persistent-staging-client-v1'){
          blocked=true;
          // A local pending/null receipt proves no outcome. Only the server's
          // fresh, read-only diagnosis can identify one absent issued ticket.
          const selected=await session.checkout('resume',locate,{operation:{kind:'recover_preparation'}}),ticket=selected?.reservation;
          if(selected?.recovery==='known-current-v1')return {initialized:true,resumed:true,...capability(selected),...await acceptKnownCurrent(selected,first)};
          need(selected?.resumed===true&&selected.recovery==='cancel-issued-absent-v1'&&ticket&&Object.keys(ticket).length===6&&
            typeof ticket.operation_id==='string'&&ticket.operation_id&&typeof ticket.job_id==='string'&&ticket.job_id&&
            Number.isSafeInteger(ticket.generation)&&ticket.generation>0&&ticket.generation<=session.preparationGeneration()&&
            ticket.expires_at===selected.expires_at&&/^[a-f0-9]{64}$/.test(ticket.owner_hash)&&/^[a-f0-9]{64}$/.test(ticket.cart_hash));
          live(ticket.expires_at);await adoptAuthenticated(selected,first);
          need(!selected.items.some(line=>line.properties?._bfl_job===ticket.job_id));
          const operation={kind:'cancel_preparation',operation_id:ticket.operation_id,job:ticket.job_id,generation:ticket.generation};
          session.beginMutation(operation);
          try{
            const cancelled=await session.checkout('cancel_preparation',locate,{reservation:ticket});
            need(cancelled.cancelled===true&&cancelled.revoked===true&&cancelled.expires_at===ticket.expires_at);live(ticket.expires_at);
            return await finishCancellation(ticket,operation);
          }catch(error){error.cartUncertain=true;throw error;}
        }
        if(recovery||resume){
          blocked=true;const selected=await session.checkout('resume',locate,recovery?{operation:recovery.operation??null}:{});
          need(selected?.resumed===true);
          if(recovery?.operation?.kind==='cancel_preparation')need(preparedRecovery(selected,recovery.operation).state==='cancelled');
          const unselectedPreparation=!selection&&['prepared','cancel_preparation'].includes(recovery?.operation?.kind)&&session.receipt?.().client_policy==='bfl-persistent-staging-client-v1';
          if(selection||unselectedPreparation){
            need(selected.upload_recovery==='uncommitted-v1');
            const operation=recovery?.operation;
            if(recovery){
              need(['prepared','cancel_preparation'].includes(operation?.kind));
              const recovered=preparedRecovery(selected,operation),ticket=recovered.reservation;
              live(selected.expires_at);const result=await adoptAuthenticated(selected,first);
              if(recovered.state==='issued'){
                need(recovery.state==='prepared'&&operation.kind==='prepared');
                // Persist the exact pending cancellation BEFORE its only send.
                // Reload may observe cancellation; it must never send it again.
                const cancellation={...operation,kind:'cancel_preparation'};session.beginMutation(cancellation);
                let cancelled;
                try{cancelled=await session.checkout('cancel_preparation',locate,{reservation:ticket});
                  need(cancelled.cancelled===true&&cancelled.revoked===true&&cancelled.expires_at===ticket.expires_at);live(ticket.expires_at);
                  if(!selection)return await finishCancellation(ticket,cancellation);
                }catch(error){error.cartUncertain=true;throw error;}
              }
              if(!selection){session.checkpoint(result.cart.items.some(protectedLine)?'accepted':'initialized');blocked=false;return {initialized:true,resumed:true,...capability(selected),...result};}
              session.checkpoint('uploads',null,selection);
            }else await adoptAuthenticated(selected,first);
            return restoreUploads(await native());
          }
          const result=await adoptAuthenticated(selected,first);blocked=false;session.checkpoint();return {initialized:true,resumed:true,...capability(selected),...result};
        }
        // Exact completed-selection recovery may contain previously accepted
        // print jobs. The server authenticates both those grants and the files.
        if(resumeUploads&&selection){blocked=true;return restoreUploads(first);}
        const initialAjax=ordinaryAjax(await getJSON(`${base}.js`));verifyNative(first,initialAjax.items);
        if(resumeEmpty){
          const selected=await session.checkout('current',locate);need(Array.isArray(selected?.items));
          const result=await adoptOrdinary(selected,first);
          session.checkpoint('initialized');return {initialized:true,resumed:true,...capability(selected),...result};
        }
        if(resumeUploads)return restoreUploads(first);
        if(resumeInitialization){
          // A confirmed initialization needs reads only. Otherwise the existing
          // server journals permit only an absent bind/marker attempt to send;
          // unknown/rejected attempts cannot replay. This never sends cart lines.
          let selected;
          try{selected=await session.checkout('current',locate);}catch{
            try{await session.checkout('bind',locate);}catch{}
            try{await session.checkout('install',locate);}catch{}
            selected=await session.checkout('current',locate);
          }
          need(Array.isArray(selected?.items));const result=await adoptOrdinary(selected,first);
          session.checkpoint('initialized');return {initialized:true,resumed:true,...capability(selected),...result};
        }
        await session.checkout('bind',locate);await session.checkout('install',locate);
        const selected=await session.checkout('current',locate);need(Array.isArray(selected?.items));
        const result=await adoptOrdinary(selected,first);session.checkpoint('initialized');return {initialized:true,...capability(selected),...result};
      })().catch(error=>{
        if(selection)session.preserveUploadRead?.(error);
        if(resume&&!recovery)session.preserveAcceptedRead?.(error);
        else if(recovery?.state==='pending'&&recovery.operation?.kind==='add')session.preservePendingRead?.(error);
        throw error;
      });return initialized;
    },
    async completeUploadRemoval(){
      need(initialized);await initialized;
      need(!blocked&&!preparing&&!mutating&&uploadRecovery&&session.receipt?.().client_policy==='bfl-persistent-staging-client-v1'&&session.completedSelection?.()===null);
      const before=await native(),selected=await session.checkout('resume',locate,{operation:{kind:'recover_preparation'}});
      return acceptKnownCurrent(selected,before);
    },
    async prepare(input){
      need(initialized);await initialized;
      if(!blocked&&(preparing||mutating)){const error=Error('CHECKOUT_BUSY');error.definitive=true;throw error;}
      need(!blocked);preparing=true;
      try{
        const {generation,...jobInput}=input;need(Number.isSafeInteger(generation)&&generation>0);
        session.rememberPreparationGeneration(generation);
        const job=await session.request('/jobs',jobInput);need(job?.checkout_ready===false&&/^[a-f0-9]{64}$/.test(job.reference?.signature));
        const receipt=await session.checkout('eligible',locate,{reference:job.reference,generation});
        need(receipt?.prepared===true&&receipt.cart_verified===false&&receipt.checkout_ready===false&&receipt.generation===generation&&['id','revision','config_version','signature'].every(k=>receipt.reference?.[k]===job.reference[k])&&receipt.item?.id===job.item?.id&&receipt.unit_price_cents===job.unit_price_cents&&receipt.file_count===job.file_count&&typeof receipt.reservation?.operation_id==='string'&&receipt.reservation.operation_id&&Number.isSafeInteger(receipt.expires_at));live(receipt.expires_at);
        need(receipt.reservation.job_id===receipt.reference.id&&receipt.reservation.generation===generation&&receipt.reservation.expires_at===receipt.expires_at&&/^[a-f0-9]{64}$/.test(receipt.reservation.owner_hash)&&/^[a-f0-9]{64}$/.test(receipt.reservation.cart_hash));
        const p=properties(receipt.item.properties);need(/^\d+$/.test(receipt.item.id)&&p._bfl_job===receipt.reference.id&&p._bfl_signature===receipt.reference.signature&&p['Files Uploaded']===String(receipt.file_count)&&fileCountValid(receipt.file_count,p)&&Number.isSafeInteger(receipt.unit_price_cents)&&receipt.unit_price_cents>0);
        const prepared=Object.freeze({...receipt,reference:Object.freeze({...receipt.reference}),reservation:Object.freeze({...receipt.reservation}),item:Object.freeze({id:receipt.item.id,quantity:receipt.item.quantity,properties:Object.freeze(p)})});
        trusted.set(prepared.reference.id,prepared);issued.add(prepared);session.checkpoint('prepared',{operation_id:prepared.reservation.operation_id,generation,kind:'prepared',job:prepared.reference.id});return prepared;
      }finally{preparing=false;}
    },
    async cancelPreparation(prepared){
      need(!mutating&&!preparing&&!spentAdds.has(prepared.reference.id));issued.delete(prepared);
      const selection=uploadRecovery?session.completedSelection?.():null;
      if(uploadRecovery)session.beginMutation({kind:'cancel_preparation',operation_id:prepared.reservation.operation_id,job:prepared.reference.id,generation:prepared.reservation.generation});
      let result;
      try{result=await session.checkout('cancel_preparation',locate,{reservation:prepared.reservation});need(result.cancelled===true&&result.revoked===true);}
      catch(error){if(uploadRecovery)error.cartUncertain=true;throw error;}
      trusted.delete(prepared.reference.id);
      if(uploadRecovery)session.checkpoint(selection?'uploads':accepted.items.some(protectedLine)?'accepted':'initialized',null,selection??undefined);
      return result;
    },
    async addPrepared({prepared,quantity,assertSelection,onWriteStarted}){
      need(initialized);await initialized;need(issued.has(prepared)&&trusted.get(prepared.reference.id)===prepared&&!spentAdds.has(prepared.reference.id));live(prepared.expires_at);
      const line=expectedLine(prepared,quantity);need(!accepted.items.some(l=>l.properties._bfl_job===prepared.reference.id));
      return write({kind:'add',job:prepared.reference.id,quantity,operationId:prepared.reservation.operation_id,expected:[...accepted.items,line],assertSelection,onWriteStarted,
        lines:[{merchandiseId:`gid://shopify/ProductVariant/${prepared.item.id}`,quantity,attributes:Object.entries(line.properties).map(([key,value])=>({key,value}))}]});
    },
    async change({job,quantity}){
      need(initialized);await initialized;need(Number.isSafeInteger(quantity)&&quantity>=0&&quantity<=10000);
      const record=trusted.get(job),target=acceptedAjax?.items.find(r=>r.properties?._bfl_job===job);need(record&&target);live(record.expires_at);
      const replacement=quantity?expectedLine(record,quantity):null,expected=accepted.items.flatMap(l=>l.properties._bfl_job===job?(replacement?[replacement]:[]):[l]);
      return write({kind:quantity?'change':'remove',job,quantity,operationId:crypto.randomUUID(),expected,lines:[{id:target.key,quantity,...(replacement?{attributes:Object.entries({...target.properties,_bfl_signature:replacement.properties._bfl_signature}).map(([key,value])=>({key,value}))}:{})}]});
    },
    resolveCartItem(selector){const row=selector.key?acceptedAjax?.items.find(r=>r.key===selector.key):acceptedAjax?.items[Number(selector.line)-1];return row?structuredClone(row):null;},
    async recover(operation=lastOperation){
      need(!mutating&&!preparing&&operation);blocked=true;const before=await native(),selected=await session.checkout('resume',locate,{operation});need(selected?.resumed===true);
      const result=await adoptAuthenticated(selected,before);session.checkpoint();lastOperation=null;blocked=false;return {accepted:true,...result};
    },
    canRetry:()=>!blocked&&!mutating,
  });
}
