// Page-owned, explicit-call test actions. Only native getCart/updateCart; never
// converts an Ajax locator, creates a cart, exports capabilities or retries.
export function createNativeCases({client,role,fetchImpl=fetch,until,cleanupUntil=until,now=Date.now,controlContractSha256,signal}){
 if(!['A','B'].includes(role))throw Error('DIAGNOSTIC_ROLE');
 const actions=globalThis.Shopify?.actions,spent=new Set(),knownLines=new Set();let item=null,control=null,duplicate=null,cartId=null,nativeCalls=0,initialMarker,checkpoint=false;
 // Fixed preflight evidence only. Never retain a thrown value or rebind actions.
 const methods=read=>{try{const value=read();return Object.freeze({observed:true,get_cart:typeof value?.getCart==='function',update_cart:typeof value?.updateCart==='function'});}catch{return Object.freeze({observed:false,get_cart:false,update_cart:false});}};
 const constructionMethods=methods(()=>actions);let preflightFailure=null;
 const requireValue=ok=>{if(signal?.aborted||!ok)throw Error('DIAGNOSTIC_NATIVE_UNAVAILABLE');};
 const digest=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');
 const summary=result=>{
  const c=result?.cart,lines=Array.isArray(c?.lines)?c.lines:c?.lines?.nodes;
  requireValue(c&&Array.isArray(lines)&&Number.isSafeInteger(c.totalQuantity)&&c.totalQuantity>=0&&
   lines.every(l=>typeof l.id==='string'&&l.id&&Number.isSafeInteger(l.quantity)&&l.quantity>0)&&
   new Set(lines.map(l=>l.id)).size===lines.length&&lines.reduce((n,l)=>n+l.quantity,0)===c.totalQuantity);
  return {...c,lines};
 };
 const current=async(mark)=>{
  mark?.('native_guard');
  requireValue(now()<cleanupUntil&&typeof actions?.getCart==='function');
  mark?.('native_read');const result=await actions.getCart();
  mark?.('native_summary');const c=summary(result);
  mark?.('locator');const id=(await globalThis.BFLPrintCartLocator.locate()).cart_id;
  mark?.('continuity');
  requireValue(c.id===id);if(cartId)requireValue(cartId===id);else cartId=id;return c;
 };
 const spend=key=>{requireValue(!spent.has(key));spent.add(key);};
 const mutate=async(key,lines)=>{
  spend(key);requireValue(now()<(key==='cleanup'?cleanupUntil:until)&&++nativeCalls<=(role==='A'?10:4)&&typeof actions.updateCart==='function');
  const r=await actions.updateCart({cartId,lines},{signal:AbortSignal.timeout(10000)});
  requireValue(!r.userErrors?.length&&!r.warnings?.length&&r.cart?.id===cartId);return summary(r);
 };
 const add=extra=>({merchandiseId:'gid://shopify/ProductVariant/'+item.id,quantity:item.quantity,attributes:Object.entries({...item.properties,...extra}).map(([key,value])=>({key,value}))});
 const inspect=async()=>{
  const result=await client.act('inspect');
  if(initialMarker===undefined){requireValue(role==='A'?typeof result.binding_value==='string':result.binding_value===null);initialMarker=result.binding_value;}
  return {...result,matches_initial:result.binding_value===initialMarker};
 };
 return Object.freeze({
  preflightFailure:()=>preflightFailure,
  async preflight(phase){
   let stage='entry',capturedMethods,currentMethods;
   const mark=value=>{stage=value;if(value==='locator'){stage='locator_availability';try{stage=typeof globalThis.BFLPrintCartLocator?.locate==='function'?'locator_read':'locator_unavailable';}catch{}}};
   try{
    capturedMethods=methods(()=>actions);currentMethods=methods(()=>globalThis.Shopify?.actions);
    stage='native_methods';
    requireValue(now()<until&&['initial','recheck'].includes(phase)&&typeof actions?.getCart==='function'&&typeof actions?.updateCart==='function');
    stage='phase';
    requireValue(phase==='initial'?!checkpoint:checkpoint);spend('preflight_'+phase);
    const c=await current(mark);
    // Comparison only, not ownership. Accept one unambiguous native shape; no
    // decoding/normalization or access-key hashing. A/B share the exact domain/run.
    stage='capability';
    const identity=/^gid:\/\/shopify\/Cart\/([A-Za-z0-9_-]+)\?key=[A-Za-z0-9_-]+$/.exec(cartId);
    requireValue(identity&&identity[0]===cartId&&cartId.length<=4096);
    stage='comparison_hash';
    const cart_comparison_sha256=await digest(JSON.stringify(['bfl:native-cart-comparison:v1','bellows-film-printing-staging.myshopify.com','f06p-integrated-v1','gid://shopify/Cart/'+identity[1]]));
    stage='final_guard';
    requireValue(now()<until);checkpoint=true;
    return {phase,cart_comparison_sha256,native_actions_present:true,exact_capability_retained:true,controller_memory_retained:phase==='recheck',empty:c.totalQuantity===0&&c.lines.length===0,line_count:c.lines.length,cart_verified:false,checkout_ready:false};
   }catch{
    preflightFailure=Object.freeze({stage,reason:signal?.aborted?'cancelled':now()>=until?'expired':'unavailable',construction_methods:constructionMethods,...(capturedMethods?{captured_methods:capturedMethods}:{}),...(currentMethods?{current_methods:currentMethods}:{})});
    throw Error('DIAGNOSTIC_NATIVE_UNAVAILABLE');
   }
  },
  async inspect(){const result=await inspect();return {observed:true,marker_present:typeof result.binding_value==='string',matches_initial:result.matches_initial,checkout_ready:false};},
  async resources(){spend('resources');requireValue(role==='A');const r=await client.act('resources');requireValue(r.item?.id==='67852705202287'&&r.item.quantity===4);item=r.item;return {prepared:true};},
  async native(action){
   requireValue(action==='cleanup'||now()<until);
   const c=await current();let r;
   if(action==='control_add'){
    requireValue(c.lines.length===0&&/^[a-f0-9]{64}$/.test(controlContractSha256));
    const value=(await client.act('control')).control;
    requireValue(value&&value.run_id==='f06p-integrated-v1'&&value.title==='F06P engineering control — f06p-integrated-v1'&&value.currency==='USD'&&value.price==='1.00'&&value.quantity===1&&value.requires_shipping===false&&value.tracked===false);
    // The authenticated backend already checked its exact product/variant/
    // publication/full hash pin. This public contract exists before those IDs.
    const {product_id,variant_id,...contract}=value;
    const hash=await digest(JSON.stringify(Object.fromEntries(Object.entries(contract).sort(([a],[b])=>a.localeCompare(b)))));
    requireValue(hash===controlContractSha256&&/^gid:\/\/shopify\/Product\/\d+$/.test(product_id)&&/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(variant_id));
    r=await mutate(action,[{merchandiseId:value.variant_id,quantity:1}]);
    requireValue(r.lines.length===1&&r.lines[0].quantity===1);control=r.lines[0].id;knownLines.add(control);
   }else if(action==='control_remove'){
    requireValue(control&&c.lines.length===1&&c.lines[0].id===control);r=await mutate(action,[{id:control,quantity:0}]);requireValue(r.lines.length===0);
   }else if(action==='add_job'){
    requireValue(c.lines.length===0);
    if(role==='B'){spend('copy_item');const result=await client.act('copy_item');item=result.item;}
    requireValue(item?.id==='67852705202287'&&item.quantity===4);r=await mutate(action,[add({})]);
    requireValue(r.lines.length===1&&r.lines[0].quantity===4);knownLines.add(r.lines[0].id);
   }else if(['quantity_changed','quantity_restored','remove_job'].includes(action)){
    requireValue(role==='A'&&item&&c.lines.length===1&&knownLines.has(c.lines[0].id));
    const quantity=action==='quantity_changed'?5:action==='quantity_restored'?4:0;
    r=await mutate(action,[{id:c.lines[0].id,quantity}]);requireValue(quantity===0?r.lines.length===0:r.lines.length===1&&r.lines[0].quantity===quantity);
    for(const line of r.lines)knownLines.add(line.id);
   }else if(action==='readd_job'){
    requireValue(role==='A'&&spent.has('remove_job')&&c.lines.length===0);r=await mutate(action,[add({})]);requireValue(r.lines.length===1&&r.lines[0].quantity===4);knownLines.add(r.lines[0].id);
   }else if(action==='duplicate_add'){
    requireValue(role==='A'&&item&&c.lines.length===1);r=await mutate(action,[add({_f06p_duplicate:'engineering-negative'})]);
    requireValue(r.lines.length===2);const created=r.lines.filter(l=>!c.lines.some(old=>old.id===l.id));requireValue(created.length===1);duplicate=created[0].id;knownLines.add(duplicate);
   }else if(action==='duplicate_remove'){
    requireValue(role==='A'&&duplicate&&c.lines.some(l=>l.id===duplicate));r=await mutate(action,[{id:duplicate,quantity:0}]);requireValue(r.lines.length===1);
   }else if(action==='cleanup'){
    const lines=c.lines.filter(l=>knownLines.has(l.id));requireValue(lines.length===c.lines.length);r=await mutate(action,lines.map(l=>({id:l.id,quantity:0})));requireValue(r.lines.length===0);
   }else throw Error('DIAGNOSTIC_NATIVE_ACTION');
   return {complete:true,line_count:r.lines.length,total_quantity:r.totalQuantity,native_calls:nativeCalls};
  },
  async hostile(action){
   requireValue(role==='A'?['overwrite','delete'].includes(action):action==='copy');spend('hostile_'+action);
   await current();const before=await inspect();const marker=before.test_marker;
   requireValue(now()<until&&typeof marker==='string'&&/^[a-f0-9]{64}$/.test(marker));
   const key='app--436988772353--bfl-checkout.binding_v2';
   const query=action==='delete'?'mutation($input:CartMetafieldDeleteInput!){cartMetafieldDelete(input:$input){deletedId userErrors{code field}}}':'mutation($fields:[CartMetafieldsSetInput!]!){cartMetafieldsSet(metafields:$fields){userErrors{code field}}}';
   const variables=action==='delete'?{input:{ownerId:cartId,key}}:{fields:[{ownerId:cartId,key,type:'single_line_text_field',value:action==='overwrite'?(marker==='b'.repeat(64)?'c':'b').repeat(64):marker}]};
   const response=await fetchImpl('/api/2026-07/graphql.json',{method:'POST',credentials:'same-origin',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(5000),headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify({query,variables})});
   let body;try{const text=await response.text();requireValue(text.length<=16384);body=JSON.parse(text);}catch{throw Error('DIAGNOSTIC_HOSTILE_UNKNOWN');}
   const payload=body.data?.[action==='delete'?'cartMetafieldDelete':'cartMetafieldsSet'];
   const codes=[...(body.errors??[]).map(e=>e.extensions?.code),...(payload?.userErrors??[]).map(e=>e.code)].filter(c=>['ACCESS_DENIED','FORBIDDEN','BAD_REQUEST','INVALID'].includes(c));
   const after=await inspect();const unchanged=after.binding_value===before.binding_value&&after.matches_initial;
   // A BAD_REQUEST/channel-lock result is not a permission pass. Both carts'
   // independent persisted readbacks and native positives remain required.
   return {attempted:true,status:response.status,codes,persisted_unchanged:unchanged,permission_candidate:unchanged&&codes.some(c=>['ACCESS_DENIED','FORBIDDEN'].includes(c)),checkout_ready:false};
  },
 });
}
