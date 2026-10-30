import {readFileSync} from 'node:fs';
import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {STORE,APP,CLIENT} from '../configuration/schema.mjs';
import {SHOP,INSTALLATION,need,RuntimeError} from '../backend/config.mjs';
import {PRODUCT,VARIANT} from '../checkout/authority.js';
import {freeze} from '../configuration/config.mjs';
import {immutableSignature} from '../checkout/quantity-signature.js';
export const ORDER_QUERY=readFileSync(new URL('./order.graphql',import.meta.url),'utf8');
export const hash=value=>createHash('sha256').update(value).digest('hex');
const gid=(v,type)=>typeof v==='string'&&v.length<=200&&new RegExp(`^gid://shopify/${type}/[1-9]\\d*$`).test(v);
const integer=v=>Number.isSafeInteger(v)&&v>=0&&v<=10000;
const stamp=v=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT/.test(v)&&Number.isFinite(Date.parse(v));
const scopes=['read_orders','read_merchant_managed_fulfillment_orders','read_assigned_fulfillment_orders','read_third_party_fulfillment_orders'];
const connection=(c,max)=>{
  need(c?.pageInfo?.hasNextPage===false&&c.pageInfo.hasPreviousPage===false&&Array.isArray(c.nodes)&&c.nodes.length<=max,'ORDER_INCOMPLETE');
  need(new Set(c.nodes.map(x=>x?.id)).size===c.nodes.length,'ORDER_DUPLICATE_RESOURCE');return c.nodes;
};
// Headers are selectors/delivery hints, NOT HMAC-covered authorization. Only the
// signed order GID is used to re-read canonical state at the fixed staging API.
export function authenticateOrderSignal({rawBody,headers},secret) {
  need(Buffer.isBuffer(rawBody)&&rawBody.length>0&&rawBody.length<=262144,'ORDER_BODY_LIMIT');
  need(typeof secret==='string'&&secret.length>=32,'ORDER_SECRET_REQUIRED');
  need(headers&&typeof headers==='object'&&!Array.isArray(headers),'ORDER_HEADERS_INVALID');
  const h={};for(const [key,value] of Object.entries(headers)) {
    const k=key.toLowerCase();need(!Object.hasOwn(h,k)&&typeof value==='string'&&value.length<=2048,'ORDER_HEADERS_INVALID');h[k]=value;
  }
  need(h['x-shopify-topic']==='orders/create'&&h['x-shopify-shop-domain']===STORE&&h['x-shopify-api-version']==='2026-10','ORDER_SOURCE_REJECTED');
  need(/^application\/json(?:;|$)/i.test(h['content-type']??'')&&!h['content-encoding'],'ORDER_ENCODING_REJECTED');
  const sig=h['x-shopify-hmac-sha256'];need(typeof sig==='string'&&/^[A-Za-z0-9+/]{43}=$/.test(sig),'ORDER_SIGNATURE_INVALID');
  need(timingSafeEqual(createHmac('sha256',secret).update(rawBody).digest(),Buffer.from(sig,'base64')),'ORDER_SIGNATURE_INVALID');
  const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
  need(uuid(h['x-shopify-webhook-id'])&&uuid(h['x-shopify-event-id']),'ORDER_DELIVERY_INVALID');
  let body;try {body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(rawBody));}catch {throw new RuntimeError('ORDER_BODY_INVALID');}
  need(gid(body?.admin_graphql_api_id,'Order'),'ORDER_ID_INVALID');
  // Do not coerce a rounded JSON numeric resource ID or derive a GID from it.
  if(Object.hasOwn(body,'id'))need((typeof body.id==='string'&&/^[1-9]\d*$/.test(body.id)||Number.isSafeInteger(body.id)&&body.id>0)&&
    String(body.id)===body.admin_graphql_api_id.split('/').at(-1),'ORDER_ID_INVALID');
  return freeze({order_id:body.admin_graphql_api_id,delivery_hash:hash(h['x-shopify-webhook-id'].toLowerCase()),
    event_hash:hash(h['x-shopify-event-id'].toLowerCase()),body_hash:hash(rawBody)});
}

export function parseOrderResponse(result,id) {
  need(result&&typeof result==='object'&&!Array.isArray(result)&&
    (!Object.hasOwn(result,'errors')||Array.isArray(result.errors)&&result.errors.length===0)&&
    result.data&&typeof result.data==='object'&&!Array.isArray(result.data),'ORDER_QUERY_REJECTED');const d=result.data,o=d.order;
  need(d.shop?.id===SHOP&&d.shop.myshopifyDomain===STORE&&d.currentAppInstallation?.id===INSTALLATION&&
    d.currentAppInstallation.app?.id===APP&&d.currentAppInstallation.app?.apiKey===CLIENT,'ORDER_WRONG_TARGET');
  need(Array.isArray(d.currentAppInstallation.accessScopes)&&scopes.every(s=>d.currentAppInstallation.accessScopes.some(x=>x.handle===s)),'ORDER_SCOPE_REQUIRED');
  need(o?.id===id&&gid(o.id,'Order')&&typeof o.legacyResourceId==='string'&&o.legacyResourceId===id.split('/').at(-1),'ORDER_NOT_FOUND');
  need(stamp(o.createdAt)&&stamp(o.updatedAt)&&Date.parse(o.updatedAt)>=Date.parse(o.createdAt)&&typeof o.edited==='boolean'&&
    (o.cancelledAt===null||stamp(o.cancelledAt))&&o.currencyCode==='USD','ORDER_INCOMPLETE');
  need(o.cartToken===null||typeof o.cartToken==='string'&&o.cartToken.length>0&&o.cartToken.length<=2048,'ORDER_INCOMPLETE');
  need(o.customer===null||gid(o.customer?.id,'Customer'),'ORDER_INCOMPLETE');
  const lines=connection(o.lineItems,20).map(l=>{
    need(gid(l.id,'LineItem')&&integer(l.quantity)&&l.quantity>0&&integer(l.currentQuantity)&&l.currentQuantity<=l.quantity&&typeof l.requiresShipping==='boolean','ORDER_INCOMPLETE');
    need(l.product===null||gid(l.product?.id,'Product'),'ORDER_INCOMPLETE');
    need(l.variant===null||gid(l.variant?.id,'ProductVariant'),'ORDER_INCOMPLETE');
    need(Object.hasOwn(l,'sellingPlan')&&Object.hasOwn(l,'lineItemGroup'),'ORDER_INCOMPLETE');
    need(Array.isArray(l.customAttributes)&&l.customAttributes.length<=1100,'ORDER_ATTRIBUTES_INVALID');
    const a=Object.create(null);for(const {key,value} of l.customAttributes){
      need(typeof key==='string'&&key.length>0&&key.length<=100&&typeof value==='string'&&value.length<=2048&&!Object.hasOwn(a,key),'ORDER_ATTRIBUTES_INVALID');a[key]=value;
    }
    const m=l.originalUnitPriceSet?.shopMoney;
    need(m?.currencyCode==='USD'&&typeof m.amount==='string'&&/^\d{1,8}(?:\.\d{1,2})?$/.test(m.amount),'ORDER_PRICE_INVALID');
    const cents=Math.round(Number(m.amount)*100);need(Number.isSafeInteger(cents),'ORDER_PRICE_INVALID');
    const print=l.product?.id===PRODUCT||l.variant?.id===VARIANT||Object.keys(a).some(k=>k.startsWith('_bfl_'));
    if(print)need(l.product?.id===PRODUCT&&l.variant?.id===VARIANT&&l.requiresShipping===true&&l.sellingPlan===null&&l.lineItemGroup===null,'ORDER_PRINT_VARIANT_INVALID');
    return {id:l.id,quantity:l.quantity,current_quantity:l.currentQuantity,unit_cents:cents,print,variant_id:l.variant?.id??null,
      reference:print?{id:a._bfl_job,revision:a._bfl_revision,config_version:a._bfl_config,signature:immutableSignature(a._bfl_signature,l.quantity)}:null};
  });
  need(lines.filter(l=>l.print).length<=8,'ORDER_JOB_LIMIT');
  const known=new Set(lines.map(l=>l.id));
  const groups=connection(o.fulfillmentOrders,20).map(g=>{
    need(gid(g.id,'FulfillmentOrder')&&typeof g.status==='string'&&g.status.length<=40,'ORDER_INCOMPLETE');
    need(g.assignedLocation&&Object.hasOwn(g.assignedLocation,'location')&&(g.assignedLocation.location===null||gid(g.assignedLocation.location?.id,'Location')),'ORDER_INCOMPLETE');
    need(g.deliveryMethod===null||typeof g.deliveryMethod?.methodType==='string','ORDER_INCOMPLETE');
    const items=connection(g.lineItems,20).map(l=>{
      need(gid(l.id,'FulfillmentOrderLineItem')&&known.has(l.lineItem?.id)&&integer(l.totalQuantity)&&integer(l.remainingQuantity)&&l.remainingQuantity<=l.totalQuantity,'ORDER_GROUP_INVALID');
      return {id:l.id,line_id:l.lineItem.id,total:l.totalQuantity,remaining:l.remainingQuantity};
    });
    need(new Set(items.map(l=>l.line_id)).size===items.length,'ORDER_GROUP_INVALID');
    return {id:g.id,status:g.status,location_id:g.assignedLocation.location?.id??null,method:g.deliveryMethod?.methodType??null,lines:items};
  });
  return freeze({id:o.id,created_at:o.createdAt,updated_at:o.updatedAt,edited:o.edited,cancelled:o.cancelledAt!==null,
    cart_token_hash:o.cartToken===null?null:hash(o.cartToken),customer_hash:o.customer===null?null:hash(o.customer.id),lines,groups});
}

// Separate read-only transport: no generic query entry point, mutation, token
// discovery, pagination fallback or retry. All connection bounds are strict.
export function createOrderReader({store,app,clientId,installation,adminToken=null,enabled=false},
  {fetchImpl=fetch,timeoutMs=5000,maxBytes=1048576}={}) {
  need(store===STORE&&app===APP&&clientId===CLIENT&&installation===INSTALLATION,'ORDER_WRONG_TARGET');
  need(timeoutMs>0&&timeoutMs<=5000&&maxBytes>0&&maxBytes<=1048576,'ORDER_LIMIT_INVALID');
  return async(id,{signal}={})=>{
    need(!signal?.aborted,'ORDER_PROCESS_ABORTED');
    need(enabled===true,'ORDER_TRANSPORT_DISABLED');need(gid(id,'Order'),'ORDER_ID_INVALID');
    need(typeof adminToken==='string'&&/^[\x21-\x7e]{16,2048}$/.test(adminToken),'ORDER_CREDENTIAL_REQUIRED');
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
    const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
    try {
      const response=await fetchImpl(`https://${STORE}/admin/api/2026-10/graphql.json`,{method:'POST',redirect:'error',signal:controller.signal,
        headers:{'Content-Type':'application/json','Accept':'application/json','Accept-Encoding':'identity','X-Shopify-Access-Token':adminToken},
        body:JSON.stringify({query:ORDER_QUERY,variables:{id}})});
      need(response.status===200&&!response.redirected,[401,403].includes(response.status)?'ORDER_ACCESS_DENIED':'ORDER_READ_UNAVAILABLE');
      need(response.headers.get('x-shopify-api-version')==='2026-10','ORDER_VERSION_MISMATCH');
      need(/^application\/json(?:;|$)/i.test(response.headers.get('content-type')??'')&&[null,'identity'].includes(response.headers.get('content-encoding')),'ORDER_RESPONSE_INVALID');
      const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;need(size<=maxBytes,'ORDER_RESPONSE_LIMIT');chunks.push(chunk);}
      need(!controller.signal.aborted,'ORDER_READ_UNAVAILABLE');
      return parseOrderResponse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))),id);
    }catch(error){throw error instanceof RuntimeError?error:new RuntimeError('ORDER_READ_UNAVAILABLE');}
    finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.abort();}
  };
}
