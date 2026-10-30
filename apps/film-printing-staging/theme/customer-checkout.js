// Explicit staging form adapter. No startup request, DOM hook or global secret.
// Uses the actual native cart plus authenticated server-selected line fields.
export function createCustomerCheckout(session,{actions=globalThis.Shopify?.actions,expectedCartHash,observe=()=>{}}={}){
  const need=value=>{if(!value)throw Error('CHECKOUT_UNAVAILABLE');};
  need(typeof session?.checkout==='function'&&typeof actions?.getCart==='function'&&typeof actions?.updateCart==='function');
  const cents=money=>{
    need(money?.currencyCode==='USD'&&typeof money.amount==='string'&&/^\d+(?:\.\d{1,2})?$/.test(money.amount));
    const [whole,fraction='']=money.amount.split('.');
    const value=Number(whole)*100+Number(fraction.padEnd(2,'0'));need(Number.isSafeInteger(value));return value;
  };
  const pricesMatch=(cart,items)=>{
    // Native cart totals include checkout shipping/tax. Verify each print line
    // against its authenticated price instead of comparing unlike totals.
    const linesMatch=cart.lines.length===items.length&&items.every(item=>cart.lines.some(line=>
      line.id===item.id&&line.quantity===item.quantity&&cents(line.cost?.totalAmount)===item.subtotal_cents));
    const subtotal=items.reduce((sum,line)=>sum+line.subtotal_cents,0),total=cents(cart.cost?.totalAmount);
    return linesMatch&&(items.length?total>=subtotal:total===0);
  };
  const verifyPrices=(cart,items)=>need(pricesMatch(cart,items));
  let cartId=null,ready=null,editing=false;
  const added=new Set(),recalculated=new Set(),accepted=new Map(),published=new Map(),snapshots=new WeakMap(),nativeSnapshots=new WeakMap();
  let revision=0;
  const seal=value=>Object.freeze({...value,items:Object.freeze(value.items.map(line=>Object.freeze({...line,properties:Object.freeze({...line.properties})})))});
  const agreement=(cart,items)=>need(Array.isArray(items)&&cart.lines.length===items.length&&items.every(item=>cart.lines.some(l=>l.id===item.id&&l.quantity===item.quantity)));
  const useSnapshot=async value=>{
    if(!value||snapshots.get(value)!==revision)return read();
    const version=revision;agreement(await native(),value.items);need(version===revision);return value;
  };
  const sameLine=(a,b)=>a.id===b.id&&a.variant_id===b.variant_id&&a.quantity===b.quantity&&
    Object.keys(a.properties).length===Object.keys(b.properties).length&&Object.entries(a.properties).every(([k,v])=>b.properties[k]===v);
  const priorLines=(cart,newLineId)=>{
    const others=cart.items.filter(l=>l.id!==newLineId);
    const sameIds=others.every(l=>accepted.has(l.id));
    const matched=others.length===accepted.size&&sameIds&&others.every(l=>sameLine(l,accepted.get(l.id)));
    if(!matched)observe({stage:'prior-lines',state:'rejected',sameCount:others.length===accepted.size,sameIds});
    need(matched);
  };
  const parseNative=cart=>{
    const lines=Array.isArray(cart?.lines)?cart.lines:cart?.lines?.nodes;
    need(cart&&typeof cart.id==='string'&&/^gid:\/\/shopify\/Cart\/[A-Za-z0-9_-]+\?key=[A-Za-z0-9_-]+$/.test(cart.id)&&Array.isArray(lines));
    need(!cartId||cartId===cart.id);cartId=cart.id;
    need(lines.every(l=>typeof l.id==='string'&&Number.isSafeInteger(l.quantity)&&l.quantity>0)&&
      new Set(lines.map(l=>l.id)).size===lines.length&&cart.totalQuantity===lines.reduce((n,l)=>n+l.quantity,0));
    return {...cart,lines};
  };
  const native=async()=>{const started=performance.now();try{return parseNative((await actions.getCart())?.cart);}finally{observe({stage:'timing',operation:'native-read',ms:Math.round(performance.now()-started)});}};
  const locate=async()=>{await native();return cartId;};
  const read=async(action='current')=>{
    const version=revision;let phase='native-before';
    try{
    const before=await native();phase='authenticated-read';
    // This exact native read already established current-cart continuity.
    // Reuse it for this request's locator, retaining the independent after-read
    // and fresh native reads for any subsequent continuation callback.
    let located=false;
    const selected=await session.checkout(action,async()=>{if(located)return locate();located=true;return before.id;});phase='native-after';
    const after=await native();phase='line-agreement';
    need(Array.isArray(selected.items)&&selected.items.length===before.lines.length&&selected.items.length===after.lines.length);
    for(const item of selected.items){
      need(before.lines.some(l=>l.id===item.id&&l.quantity===item.quantity)&&after.lines.some(l=>l.id===item.id&&l.quantity===item.quantity));
    }
    need(version===revision);const verified=seal(selected);snapshots.set(verified,revision);nativeSnapshots.set(verified,after);return verified;
    }catch(error){observe({stage:phase,state:'rejected'});throw error;}
  };
  const update=async lines=>{
    session.assertLive?.();let result;revision++;const started=performance.now();
    try{result=await actions.updateCart({cartId,lines},{signal:AbortSignal.timeout(10000)});}
    catch{observe({stage:'native-update',state:'rejected'});throw Error('CHECKOUT_UNAVAILABLE');}
    observe({stage:'timing',operation:'native-write',ms:Math.round(performance.now()-started)});
    observe({stage:'native-update',state:'returned',errors:result.userErrors?.length??0,codes:(result.userErrors??[]).map(e=>typeof e.code==='string'&&/^[A-Z][A-Z_]{0,63}$/.test(e.code)?e.code:'UNSPECIFIED'),warnings:result.warnings?.length??0,sameCart:result.cart?.id===cartId});
    need(!result.userErrors?.length&&!result.warnings?.length&&result.cart?.id===cartId);
    // Shopify returns the resulting native cart. Validate it directly; never
    // replace missing or malformed response fields with assumed success.
    return parseNative(result.cart);
  };
  const verifyRecalculation=async expected=>{
    const check=cart=>need(cart.items.length===expected.length&&expected.every(l=>cart.items.some(v=>sameLine(l,v))));
    const matches=cart=>cart.items.every(l=>l.subtotal_cents===expected.find(v=>v.id===l.id).subtotal_cents)&&pricesMatch(nativeSnapshots.get(cart),expected);
    let cart=await read();check(cart);
    if(!matches(cart)){
      // The preceding mutation returned definitively and this independent
      // authenticated read confirms every line/claim/quantity. Shopify can
      // still return the pre-publication price. Recalculate the unchanged cart
      // once, never retry an unknown mutation, add, publication, or expiry.
      observe({stage:'recalculate',state:'confirmed-stale-price'});
      await update(expected.map(l=>({id:l.id,quantity:l.quantity})));
      cart=await read();check(cart);
    }
    need(matches(cart));return cart;
  };
  return Object.freeze({
    initialize({resume=false,resumeUploads=false}={}){
      if(!ready)ready=(async()=>{
        const cart=await native();need(resume?cart.lines.length>0:cart.lines.length===0);
        if(expectedCartHash!==undefined){
          need(/^[a-f0-9]{64}$/.test(expectedCartHash));
          const value=JSON.stringify(['bfl:native-cart-comparison:v1','bellows-film-printing-staging.myshopify.com','f06p-integrated-v1',cart.id.split('?')[0]]);
          const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');
          need(hash===expectedCartHash);
        }
        if(resumeUploads){
          const selected=await read('resume_uploads');
          need(selected.resumed_uploads===true&&Array.isArray(selected.uploads)&&selected.uploads.length>0);
          observe({stage:'resume-uploads',state:'verified',files:selected.uploads.length});
          return {initialized:true,uploads:selected.uploads};
        }
        if(resume){
          const selected=await read('resume'),current=await native();
          need(selected.resumed===true&&selected.items.length>0);
          verifyPrices(current,selected.items);
          for(const line of selected.items){accepted.set(line.id,structuredClone(line));added.add(line.properties._bfl_job);recalculated.add(line.properties._bfl_job);}
          session.checkpoint?.();observe({stage:'resume',state:'verified',lines:selected.items.length,total:selected.items.reduce((n,l)=>n+l.subtotal_cents,0)});
          return {initialized:true,resumed:true,cart:selected};
        }
        await session.checkout('bind',locate);await session.checkout('install',locate);
        return {initialized:true};
      })();
      return ready;
    },
    async cart(){need(ready);await ready;return read();},
    async add(item,{cart:prior}={}){
      need(ready);await ready;const job=item?.properties?._bfl_job;
      need(typeof job==='string'&&!added.has(job)&&/^\d+$/.test(item?.id)&&Number.isSafeInteger(item.quantity)&&item.quantity>0);
      priorLines(await useSnapshot(prior));session.suspend?.();added.add(job);
      return update([{merchandiseId:'gid://shopify/ProductVariant/'+item.id,quantity:item.quantity,
        attributes:Object.entries(item.properties).map(([key,value])=>({key,value}))}]);
    },
    async publish({reference,lineId,cart:prior}){
      const cart=await useSnapshot(prior),line=cart.items.find(l=>l.id===lineId);
      need(line?.properties?._bfl_job===reference.id);priorLines(cart,lineId);
      const result=await session.checkout('publish',locate);
      need(result.state==='published_unverified');
      const selected=Array.isArray(result.items)?result:cart;
      need(selected.items.length===cart.items.length&&cart.items.every(l=>selected.items.some(v=>sameLine(l,v))));
      published.set(reference.id,{cart:seal(selected),revision});return {published:true};
    },
    async change({job,quantity}){
      need(ready&&!editing&&typeof job==='string'&&Number.isSafeInteger(quantity)&&quantity>=0&&quantity<=10000);
      session.suspend?.();editing=true; // Remains spent after any uncertain native/publication outcome.
      observe({stage:'cart-edit',state:'started'});
      let phase='cart-edit-read-before';
      try{
      const before=await read();priorLines(before);
      const target=before.items.find(l=>l.properties._bfl_job===job);
      need(target&&accepted.has(target.id));
      const expected=before.items.filter(l=>l.id!==target.id||quantity>0).map(l=>({...l,quantity:l.id===target.id?quantity:l.quantity,
        subtotal_cents:l.id===target.id?accepted.get(l.id).subtotal_cents/accepted.get(l.id).quantity*quantity:l.subtotal_cents}));
      need(expected.every(l=>Number.isSafeInteger(l.subtotal_cents)&&l.subtotal_cents>0)&&expected.reduce((n,l)=>n+l.subtotal_cents,0)<=200000);
      phase='cart-edit-native-update';
      if(target.quantity!==quantity)await update([{id:target.id,quantity}]);
      const check=cart=>need(cart.items.length===expected.length&&expected.every(l=>cart.items.some(v=>sameLine(l,v))));
      phase='cart-edit-read-after';
      phase='cart-edit-publication';
      const publication=await session.checkout('publish',locate);
      need(publication.state===(expected.length?'published_unverified':'revoked'));
      const afterMutation=Array.isArray(publication.items)?publication:await read();check(afterMutation);
      observe({stage:phase,state:'verified',empty:expected.length===0});
      phase='cart-edit-price-verification';
      const nativeCart=expected.length?await update(expected.map(l=>({id:l.id,quantity:l.quantity}))):await native();
      // Empty publication retires the owner. Verify the native empty cart
      // without making another request with the now-retired credential.
      const cart=expected.length?await verifyRecalculation(expected):afterMutation;check(cart);
      if(!expected.length)need(nativeCart.lines.length===0&&nativeCart.totalQuantity===0);
      need(expected.every(l=>cart.items.find(v=>v.id===l.id).subtotal_cents===l.subtotal_cents));
      verifyPrices(expected.length?nativeSnapshots.get(cart):nativeCart,expected);
      accepted.clear();for(const line of cart.items)accepted.set(line.id,structuredClone(line));
      if(cart.items.length)session.checkpoint?.();
      editing=false;observe({stage:'cart-edit',state:'verified',lines:cart.items.length,total:expected.reduce((n,l)=>n+l.subtotal_cents,0)});
      return {accepted:true,cart};
      }catch(error){observe({stage:phase,state:'rejected'});throw error;}
    },
    async recalculate({reference,lineId,quantity,unit_price_cents}){
      need(!recalculated.has(reference.id)&&Number.isSafeInteger(unit_price_cents)&&unit_price_cents>0);
      const publication=published.get(reference.id);need(!publication||publication.revision===revision);
      const before=publication?.cart??await read(),selected=before.items.find(l=>l.id===lineId);
      const version=revision;agreement(await native(),before.items);need(version===revision);
      need(selected?.quantity===quantity&&selected.properties?._bfl_job===reference.id);priorLines(before,lineId);
      recalculated.add(reference.id);published.delete(reference.id);
      await update(before.items.map(l=>({id:l.id,quantity:l.quantity})));
      const expected=before.items.map(l=>({...l,subtotal_cents:l.id===lineId?unit_price_cents*quantity:accepted.get(l.id).subtotal_cents}));
      const cart=await verifyRecalculation(expected),line=cart.items.find(l=>l.id===lineId);
      priorLines(cart,lineId);
      need(line?.quantity===quantity&&line.properties?._bfl_job===reference.id&&
        line.subtotal_cents===unit_price_cents*quantity);
      for(const previous of accepted.values())need(cart.items.find(l=>l.id===previous.id)?.subtotal_cents===previous.subtotal_cents);
      verifyPrices(nativeSnapshots.get(cart),cart.items);
      accepted.set(lineId,structuredClone(line));session.checkpoint?.();
      return {recalculated:true,cart};
    },
  });
}
