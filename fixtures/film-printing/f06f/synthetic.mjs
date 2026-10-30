// SYNTHETIC ONLY. No network, real ownership, cartToken correspondence or order.
import {createHmac,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {fixture as cartFixture,id,owner,customer} from '../f06c-continuation/synthetic.mjs';
import {STORE,APP,CLIENT} from '../../../apps/film-printing-staging/configuration/schema.mjs';
import {SHOP,INSTALLATION} from '../../../apps/film-printing-staging/backend/config.mjs';
import {PRODUCT,VARIANT} from '../../../apps/film-printing-staging/checkout/authority.js';
import {hash} from '../../../apps/film-printing-staging/orders/shopify.mjs';
import {createOrderHandoff} from '../../../apps/film-printing-staging/orders/service.mjs';
export {owner,customer,id};
export const orderId='gid://shopify/Order/700000001';
export const secret='synthetic-order-secret-never-a-credential';
export const config={store:STORE,app:APP,clientId:CLIENT,installation:INSTALLATION,adminToken:'synthetic-admin-read-only-token'};
export const connection=nodes=>({nodes,pageInfo:{hasNextPage:false,hasPreviousPage:false}});
export function signal(order=orderId,body={admin_graphql_api_id:order},headers={}) {
 const rawBody=Buffer.from(JSON.stringify(body));return {rawBody,headers:{'content-type':'application/json','x-shopify-topic':'orders/create',
  'x-shopify-shop-domain':STORE,'x-shopify-api-version':'2026-10','x-shopify-webhook-id':randomUUID(),'x-shopify-event-id':randomUUID(),
  'x-shopify-hmac-sha256':createHmac('sha256',secret).update(rawBody).digest('base64'),...headers}};
}
export const response=(data,headers={},status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json','x-shopify-api-version':'2026-10',...headers}});
export function orderResponse(prepared) {
 return {data:{shop:{id:SHOP,myshopifyDomain:STORE},currentAppInstallation:{id:INSTALLATION,app:{id:APP,apiKey:CLIENT},
  accessScopes:['read_orders','read_assigned_fulfillment_orders','read_merchant_managed_fulfillment_orders','read_third_party_fulfillment_orders'].map(handle=>({handle}))},
  order:{id:orderId,legacyResourceId:'700000001',createdAt:'2026-10-21T05:00:00Z',updatedAt:'2026-10-21T05:00:00Z',
   cartToken:'synthetic-order-cart-token',customer:{id:customer},edited:false,cancelledAt:null,currencyCode:'USD',
   lineItems:connection([{id:'gid://shopify/LineItem/800000001',quantity:15,currentQuantity:15,requiresShipping:true,
    product:{id:PRODUCT},variant:{id:VARIANT},sellingPlan:null,lineItemGroup:null,
    originalUnitPriceSet:{shopMoney:{amount:'1.20',currencyCode:'USD'}},customAttributes:Object.entries(prepared.item.properties).map(([key,value])=>({key,value}))}]),
   fulfillmentOrders:connection([{id:'gid://shopify/FulfillmentOrder/900000001',status:'OPEN',assignedLocation:{location:{id:'gid://shopify/Location/92443803759'}},deliveryMethod:{methodType:'SHIPPING'},
    lineItems:connection([{id:'gid://shopify/FulfillmentOrderLineItem/910000001',totalQuantity:15,remainingQuantity:15,lineItem:{id:'gid://shopify/LineItem/800000001'}}])}])}}};
}
export async function fixture(path,{bound=true}={}) {
 const f=await cartFixture({path});f.data.data.cart.buyerIdentity.customer={id:customer};await f.run();
 f.path=path;f.order=orderResponse(f.prepared);f.requests=[];f.beforeOrderRead=null;
 f.seed=()=>{
  const db=new DatabaseSync(path);
  // Intentionally no supported runtime writer yet. This row simulates evidence
  // that the absent authenticated host would need to actually establish.
  db.prepare('INSERT INTO order_source_bindings VALUES (?,?,?,?,?)').run(hash(id),hash(owner),hash('synthetic-order-cart-token'),hash(customer),hash('synthetic-cross-surface-evidence-only'));
  db.close();
 };
 if(bound)f.seed();
 f.fetch=async(url,request)=>{f.requests.push({url,body:JSON.parse(request.body)});if(f.beforeOrderRead)await f.beforeOrderRead();return response(f.order);};
 f.receive=createOrderHandoff({store:f.store,jobs:f.jobs,config,enabled:true,secret,transport:{fetchImpl:f.fetch}});
 f.signal=signal();return f;
}
