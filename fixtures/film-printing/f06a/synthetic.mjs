// Entirely synthetic offline inputs. Never publish these grants or enabled records.
import {createJobStore,createJobService} from '../../../apps/film-printing-staging/jobs/service.mjs';
import {createCheckoutProjector,serializeAuthority} from '../../../apps/film-printing-staging/checkout/projector.mjs';
import {ATTRIBUTES,STORE,VARIANT,PRODUCT} from '../../../apps/film-printing-staging/checkout/authority.js';
import {syntheticRelease} from '../f04/synthetic.mjs';
export async function scenario({customer=null,count=1}={}) {
 const store=createJobStore(':memory:');
 const release=syntheticRelease();
 const catalog={version:'synthetic-offline-price-v1',store:STORE,currency:'USD',rows:[{enabled:true,physical:true,variant_id:VARIANT.split('/').pop(),service:'photo',size:'4x6',paper:'synthetic-paper',lab:'miami',options:{},per_file_cents:40}]};
 const jobs=createJobService({store,loader:{load:async()=>release},loadCatalog:async()=>catalog,secret:'offline-only-f06a-test-secret-not-a-credential'});
 for(let i=1;i<=3;i++)store.recordUpload('offline-owner',{id:`asset-000${i}`,state:'complete',verified:true,url:`https://example.invalid/f06a/${i}.jpg`});
 const cart={id:'gid://shopify/Cart/offline-cart-a',store:STORE,owner:'offline-owner',customer_id:customer,complete:true,lines:[]};
 const preparations=[];
 for(let i=0;i<count;i++) {
   const p=await jobs.prepare(cart.owner,{request_key:`offline-request-${i}`,copies:4,service:'Photo Prints',size:'4x6',paper:'synthetic-paper',lab:'miami',asset_ids:['asset-0001','asset-0002','asset-0003'],options:{},message:'Offline fixture'});
   preparations.push(p);
   cart.lines.push({id:`gid://shopify/CartLine/offline-line-${i}`,variant_id:VARIANT,product_id:PRODUCT,quantity:4,reference:p.reference,properties:p.item.properties});
 }
 const context={release,catalog,shopDate:'2026-10-21'};
 const projector=createCheckoutProjector({jobs,resolveCart:async()=>cart,loadContext:async()=>context});
 const prepared=await projector.prepare({});
 const input={buyerJourney:{step:'CHECKOUT_COMPLETION'},shop:{authority:{value:prepared.value},localTime:{date:context.shopDate}},cart:{buyerIdentity:{isAuthenticated:customer!==null,customer:customer?{id:customer}:null},lines:cart.lines.map(l=>({id:l.id,quantity:l.quantity,merchandise:{id:l.variant_id,product:{id:l.product_id}},sellingPlanAllocation:null,cost:{amountPerQuantity:{currencyCode:'USD'},subtotalAmount:{amount:'4.80'}},...Object.fromEntries(Object.entries(ATTRIBUTES).map(([alias,key])=>[alias,l.properties[key]?{value:l.properties[key]}:null]))})),deliverableLines:cart.lines.map((l,i)=>({id:`gid://shopify/DeliverableCartLine/offline-${i}`,job:{value:l.reference.id}})),deliveryGroups:[{cartLines:cart.lines.map(l=>({id:l.id,merchandise:{id:l.variant_id,product:{id:l.product_id}}})),deliveryOptions:[{handle:'flat',deliveryMethodType:'SHIPPING'},{handle:'carrier',deliveryMethodType:'SHIPPING'},{handle:'pickup',deliveryMethodType:'PICK_UP'}]}]}};
 return {store,release,catalog,jobs,cart,context,projector,prepared,input,preparations};
}
export function replaceAuthority(input,change) {
 const a=JSON.parse(input.shop.authority.value);change(a);input.shop.authority.value=serializeAuthority(a);
}
