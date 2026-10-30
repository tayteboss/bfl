// OFFLINE ONLY. No real owner/capability/Function correspondence or Shopify I/O.
import {createJobStore,createJobService} from '../../../apps/film-printing-staging/jobs/service.mjs';
import {createAuthorityAdmin} from '../../../apps/film-printing-staging/checkout/shopify.mjs';
import {createCartRefresh} from '../../../apps/film-printing-staging/checkout/refresh.mjs';
import {createStorefrontReader,cartHash} from '../../../apps/film-printing-staging/checkout/storefront.mjs';
import {STORE,PRODUCT,VARIANT} from '../../../apps/film-printing-staging/checkout/authority.js';
import {SHOP} from '../../../apps/film-printing-staging/backend/config.mjs';
import {mockAdmin,now} from '../f06d/mock-admin.mjs';
export const id='gid://shopify/Cart/synthetic-cart?key=synthetic-key-only';
export const owner='synthetic-owner-a';
export const customer='gid://shopify/Customer/123';
export const selection={request_key:'synthetic-job-0001',copies:4,service:'Photo Prints',size:'4x6',paper:'synthetic-paper',lab:'miami',asset_ids:['asset-0001','asset-0002','asset-0003'],options:{}};
export const proof=({owner,cart})=>({store:STORE,owner,cart_hash:cartHash(cart.id),customer_id:cart.customer_id,
  binding_id:'synthetic-binding-0001',customer_context:'unredacted',capability:'verified',kind:cart.customer_id===null?'guest':'customer',
  verified_at:now().getTime(),expires_at:now().getTime()+60000});
export function response(body,headers={},status=200){return new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json','x-shopify-api-version':'2026-07',...headers}});}
export function cartResponse(prepared=null,cartId=id) {
  return {data:{shop:{id:SHOP},cart:{id:cartId,updatedAt:now().toISOString(),totalQuantity:prepared?4:0,
    buyerIdentity:{customer:null,purchasingCompany:null},lines:{pageInfo:{hasNextPage:false,hasPreviousPage:false},nodes:prepared?[{
      __typename:'CartLine',id:'gid://shopify/CartLine/synthetic-line?cart=opaque-synthetic',quantity:4,
      attributes:Object.entries(prepared.item.properties).map(([key,value])=>({key,value})),parentRelationship:null,sellingPlanAllocation:null,
      cost:{subtotalAmount:{amount:'4.80',currencyCode:'USD'}},merchandise:{__typename:'ProductVariant',id:VARIANT,requiresComponents:false,product:{id:PRODUCT}},
    }]:[]}}}};
}
export async function fixture({path=':memory:',publicationEnabled=true}={}) {
  const m=mockAdmin(),store=createJobStore(path),admin=createAuthorityAdmin(m.api,{writesEnabled:true,lifecycle:store.lifecycle,now});
  const jobs=createJobService({store,loader:{load:async()=>m.release},loadCatalog:async()=>(await admin.read()).catalog,secret:'synthetic-job-signature-only'.repeat(3)});
  for(const asset of selection.asset_ids)store.recordUpload(owner,{id:asset,state:'complete',verified:true,url:`https://example.invalid/${asset}`});
  const prepared=await jobs.prepare(owner,selection);
  const f={m,store,jobs,admin,prepared,data:cartResponse(prepared),reads:0,beforeRead:null,verify:proof,verifyFunction:async()=>true};
  const reader=createStorefrontReader({store:STORE,shopId:SHOP,privateToken:'synthetic-private-token'.repeat(3),enabled:true},{fetchImpl:async()=>{
    f.reads++;if(f.beforeRead)await f.beforeRead();return response(f.data);
  }});
  f.readCart=x=>reader({...x,buyerIp:'127.0.0.1'});
  f.refresh=createCartRefresh({store,jobs,admin,readCart:f.readCart,verifyOwnership:x=>f.verify(x),verifyFunctionIdentity:x=>f.verifyFunction(x),publicationEnabled,now:()=>now().getTime()});
  f.run=(key='refresh-request-0001',changes={})=>f.refresh({request:{synthetic:true},owner,cart_id:id,request_key:key,...changes});
  f.quantity=n=>{f.data.data.cart.lines.nodes[0].quantity=n;f.data.data.cart.totalQuantity=n;f.data.data.cart.lines.nodes[0].cost.subtotalAmount.amount=(n*1.2).toFixed(2);};
  f.grants=()=>JSON.parse(m.data.shop.authority.value).grants;
  return f;
}
