import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {isIP} from 'node:net';
import {STORE, PRODUCT, VARIANT} from './authority.js';
import {SHOP, RuntimeError, need} from '../backend/config.mjs';
import {freeze} from '../configuration/config.mjs';
import {immutableSignature} from './quantity-signature.js';

export const CART_QUERY=readFileSync(new URL('./current-cart.graphql',import.meta.url),'utf8');
export const cartHash=id=>createHash('sha256').update(id).digest('hex');
const gid=(v,type)=>typeof v==='string'&&new RegExp(`^gid://shopify/${type}/[1-9]\\d*$`).test(v);
const opaque=(v,type)=>typeof v==='string'&&v.length<=4096&&v.startsWith(`gid://shopify/${type}/`)&&
  v.slice(`gid://shopify/${type}/`.length).split('?')[0].length>0&&!/[#\s\x00-\x1f\x7f]/.test(v);
// Syntax only. Never remove/replace a key or convert an Ajax identifier.
export function requireCartLocator(id) {
  need(opaque(id,'Cart'),'CART_LOCATOR_INVALID');
  let u;try {u=new URL(id);}catch {throw new RuntimeError('CART_LOCATOR_INVALID');}
  need(u.host==='shopify'&&!u.username&&!u.password&&!u.hash&&u.pathname.length>6&&
    u.searchParams.getAll('key').length===1&&u.searchParams.get('key'),'CART_LOCATOR_INVALID');
  return id;
}
export const printLine=line=>line.product_id===PRODUCT||line.variant_id===VARIANT||
  Object.keys(line.properties).some(k=>k.startsWith('_bfl_'));

// Complete structural read only. Null customer explicitly remains ambiguous.
export function parseCurrentCart(result,id) {
  requireCartLocator(id);
  need(result&&(!Object.hasOwn(result,'errors')||Array.isArray(result.errors)&&result.errors.length===0)&&result.data,'CART_QUERY_REJECTED');
  const {shop,cart}=result.data;
  need(shop?.id===SHOP,'CART_WRONG_SHOP');
  need(cart?.id===id&&typeof cart.updatedAt==='string'&&Number.isFinite(Date.parse(cart.updatedAt)),'CART_IDENTITY_UNCERTAIN');
  need(cart.buyerIdentity&&Object.hasOwn(cart.buyerIdentity,'customer')&&cart.buyerIdentity.purchasingCompany===null,'CART_BUYER_UNCERTAIN');
  const customer=cart.buyerIdentity.customer;
  need(customer===null||gid(customer?.id,'Customer'),'CART_BUYER_UNCERTAIN');
  need(cart.lines?.pageInfo?.hasNextPage===false&&cart.lines.pageInfo.hasPreviousPage===false&&
    Array.isArray(cart.lines.nodes)&&cart.lines.nodes.length<=20,'CART_INCOMPLETE');
  const ids=new Set();
  const lines=cart.lines.nodes.map(l=>{
    need(l?.__typename==='CartLine'&&l.parentRelationship===null&&opaque(l.id,'CartLine')&&!ids.has(l.id),'CART_LINE_UNSUPPORTED');ids.add(l.id);
    const m=l.merchandise;
    need(m?.__typename==='ProductVariant'&&gid(m.id,'ProductVariant')&&gid(m.product?.id,'Product')&&m.requiresComponents===false,'CART_LINE_UNSUPPORTED');
    need(l.sellingPlanAllocation===null,'CART_LINE_UNSUPPORTED');
    need(Number.isSafeInteger(l.quantity)&&l.quantity>0&&l.quantity<=10000,'CART_QUANTITY_INVALID');
    need(Array.isArray(l.attributes)&&l.attributes.length<=1100,'CART_ATTRIBUTES_INVALID');
    const properties=Object.create(null);
    for(const a of l.attributes) {
      need(typeof a?.key==='string'&&a.key.length>0&&a.key.length<=256&&typeof a.value==='string'&&
        a.value.length<=8192&&!Object.hasOwn(properties,a.key),'CART_ATTRIBUTES_INVALID');
      properties[a.key]=a.value;
    }
    const money=l.cost?.subtotalAmount;
    need(money?.currencyCode==='USD'&&typeof money.amount==='string'&&/^\d{1,10}(?:\.\d{1,2})?$/.test(money.amount),'CART_COST_INVALID');
    const [whole,fraction='']=money.amount.split('.'),subtotal=Number(whole)*100+Number(fraction.padEnd(2,'0'));
    need(Number.isSafeInteger(subtotal),'CART_COST_INVALID');
    const line={id:l.id,quantity:l.quantity,variant_id:m.id,product_id:m.product.id,properties,selling_plan:false,subtotal_cents:subtotal};
    if(printLine(line))line.reference={id:properties._bfl_job,revision:properties._bfl_revision,
      config_version:properties._bfl_config,signature:immutableSignature(properties._bfl_signature,l.quantity)};
    return line;
  });
  need(Number.isSafeInteger(cart.totalQuantity)&&cart.totalQuantity===lines.reduce((n,l)=>n+l.quantity,0),'CART_INCOMPLETE');
  return freeze({store:STORE,id,updated_at:cart.updatedAt,customer_id:customer?.id??null,lines,
    complete:true,customer_context:'unproven',checkout_ready:false});
}

// No arbitrary query, endpoint, mutation, tokenless fallback, redirect or retry.
// Private token custody/entitlement and actual locked-channel access remain gates.
export function createStorefrontReader({store,shopId,privateToken=null,enabled=false},
  {fetchImpl=fetch,timeoutMs=5000,maxBytes=1048576,credentialProvider=null}={}) {
  need(store===STORE&&shopId===SHOP,'CART_WRONG_SHOP');
  need(credentialProvider===null||typeof credentialProvider.read==='function','STOREFRONT_CREDENTIAL_REQUIRED');
  return async({cart_id,buyerIp}={})=>{
    need(enabled===true,'STOREFRONT_DISABLED');
    requireCartLocator(cart_id);
    need(typeof buyerIp==='string'&&isIP(buyerIp),'BUYER_IP_REQUIRED');
    const token=credentialProvider?await credentialProvider.read():privateToken;
    need(typeof token==='string'&&/^[\x21-\x7e]{32,2048}$/.test(token),'STOREFRONT_CREDENTIAL_REQUIRED');
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
    try {
      const response=await fetchImpl(`https://${STORE}/api/2026-07/graphql.json`,{method:'POST',redirect:'error',signal:controller.signal,
        headers:{'Content-Type':'application/json','Accept':'application/json','Accept-Encoding':'identity',
          'Shopify-Storefront-Private-Token':token,'Shopify-Storefront-Buyer-IP':buyerIp},
        body:JSON.stringify({query:CART_QUERY,variables:{id:cart_id}})});
      need(response.status===200&&!response.redirected,'STOREFRONT_UNAVAILABLE');
      need(response.headers.get('x-shopify-api-version')==='2026-07','STOREFRONT_VERSION_MISMATCH');
      need(/^application\/json(?:;|$)/i.test(response.headers.get('content-type')??'')&&
        [null,'identity'].includes(response.headers.get('content-encoding')),'STOREFRONT_INVALID_RESPONSE');
      const chunks=[];let bytes=0;
      for await(const chunk of response.body){bytes+=chunk.length;need(bytes<=maxBytes,'STOREFRONT_RESPONSE_TOO_LARGE');chunks.push(chunk);}
      return parseCurrentCart(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))),cart_id);
    } catch(error){throw error instanceof RuntimeError?error:new RuntimeError('STOREFRONT_UNAVAILABLE');}
    finally {clearTimeout(timer);controller.abort();}
  };
}

// verifyOwnership is a trusted, independently authenticated host implementation,
// never browser input. The bounded owned-cart composition supplies concrete
// application-owner/capability evidence; general refresh remains unconfigured.
export async function bindCurrentCart({read,verifyOwnership,request,owner,cart_id,now=Date.now}) {
  need(typeof verifyOwnership==='function','CART_OWNER_PROOF_UNAVAILABLE');
  need(typeof owner==='string'&&owner.length>0&&owner.length<=200,'CART_OWNER_REJECTED');
  const cart=await read({cart_id,request});
  const evidence=await verifyOwnership({request,owner,cart});
  const time=now();
  need(evidence?.store===STORE&&evidence.owner===owner&&evidence.cart_hash===cartHash(cart_id)&&
    evidence.customer_id===cart.customer_id&&
    (evidence.customer_context==='unredacted'||evidence.kind==='application_owner'&&cart.customer_id===null&&evidence.customer_context==='no_customer_account'&&evidence.ownership_basis==='new_application_owner_and_verified_capability')&&evidence.capability==='verified'&&
    typeof evidence.binding_id==='string'&&/^[a-zA-Z0-9_-]{8,128}$/.test(evidence.binding_id)&&
    Number.isSafeInteger(evidence.verified_at)&&Number.isSafeInteger(evidence.expires_at)&&
    evidence.verified_at<=time&&time<evidence.expires_at&&evidence.expires_at-evidence.verified_at<=60000&&
    (evidence.kind===(cart.customer_id===null?'guest':'customer')||cart.customer_id===null&&evidence.kind==='application_owner'),'CART_OWNER_REJECTED');
  return freeze({...cart,owner,binding_id:evidence.binding_id,customer_context:evidence.customer_context});
}
