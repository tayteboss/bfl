import {need,SHOP,INSTALLATION} from './config.mjs';
import {STORE,APP} from '../configuration/schema.mjs';
import {canonical} from '../configuration/config.mjs';
import {VARIANTS_BY_LAB,PRODUCT} from '../checkout/authority.js';
import {isLabVariantCatalog} from '../jobs/selection.mjs';
import {assertEngineeringScope,rawHash,ENGINEERING_RUN} from '../configuration/engineering.mjs';

export const CONTROL_TITLE='F06P engineering control — f06p-integrated-v1';
export const CONTROL_QUERY='query F06PControl($id:ID!,$publication:ID!){shop{id myshopifyDomain currencyCode} currentAppInstallation{id app{id}} product(id:$id){id title status productType tags hasOnlyDefaultVariant publishedOnPublication(publicationId:$publication) variants(first:2){nodes{id price inventoryItem{tracked requiresShipping}} pageInfo{hasNextPage}}}}';
export async function verifyDiagnosticControl(api,pin){
 need(pin&&Object.keys(pin).sort().join()==='product_id,publication_id,sha256,variant_id'&&/^gid:\/\/shopify\/Product\/\d+$/.test(pin.product_id)&&/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(pin.variant_id)&&/^gid:\/\/shopify\/Publication\/\d+$/.test(pin.publication_id)&&/^[a-f0-9]{64}$/.test(pin.sha256),'CONTROL_PIN_REQUIRED');
 need(!['gid://shopify/Product/15640832180335','gid://shopify/Product/15620086005871'].includes(pin.product_id)&&!['gid://shopify/ProductVariant/67974376128623','gid://shopify/ProductVariant/67852705202287'].includes(pin.variant_id),'CONTROL_ID_REJECTED');
 const d=await api(CONTROL_QUERY,{id:pin.product_id,publication:pin.publication_id}),p=d.product,v=p?.variants?.nodes?.[0];
 need(d.shop?.id===SHOP&&d.shop.myshopifyDomain===STORE&&d.shop.currencyCode==='USD'&&d.currentAppInstallation?.id===INSTALLATION&&d.currentAppInstallation.app?.id===APP,'WRONG_TARGET');
 need(p?.id===pin.product_id&&p.title===CONTROL_TITLE&&p.status==='ACTIVE'&&p.productType==='F06P engineering control'&&canonical(p.tags)===canonical(['f06p-engineering'])&&p.hasOnlyDefaultVariant===true&&p.publishedOnPublication===true&&p.variants.nodes.length===1&&p.variants.pageInfo?.hasNextPage===false&&v.id===pin.variant_id&&v.price==='1.00'&&v.inventoryItem?.tracked===false&&v.inventoryItem.requiresShipping===false,'CONTROL_READBACK');
 const control={run_id:ENGINEERING_RUN,product_id:p.id,variant_id:v.id,title:p.title,currency:'USD',price:'1.00',quantity:1,requires_shipping:false,tracked:false};
 need(rawHash(canonical(control))===pin.sha256,'CONTROL_PIN_CHANGED');return control;
}

// Customer runs verify the exact source-scoped print variants before source
// writes. Historical single-variant packets retain their original target check.
export const CUSTOMER_TARGET_QUERY='query F06PCustomerTarget($id:ID!){shop{id myshopifyDomain currencyCode} currentAppInstallation{id app{id}} product(id:$id){id title status onlineStoreUrl hasOnlyDefaultVariant variants(first:2){nodes{id price inventoryItem{tracked requiresShipping}} pageInfo{hasNextPage}}}}';
export const CUSTOMER_VARIANTS_TARGET_QUERY=CUSTOMER_TARGET_QUERY.replace('variants(first:2)','variants(first:5)').replace('nodes{id price','nodes{id selectedOptions{name value} price');
// Persistent staging verifies publication directly. A nullable onlineStoreUrl
// alone does not establish whether this exact staging product is published.
export const PERSISTENT_CUSTOMER_PUBLICATION='gid://shopify/Publication/229344215151';
export const PERSISTENT_CUSTOMER_TARGET_QUERY='query PersistentStagingCustomerTarget($id:ID!,$publication:ID!){shop{id myshopifyDomain currencyCode} currentAppInstallation{id app{id}} publications(first:100){nodes{id name} pageInfo{hasNextPage}} product(id:$id){id title status handle onlineStoreUrl publishedOnPublication(publicationId:$publication) hasOnlyDefaultVariant variants(first:5){nodes{id selectedOptions{name value} price inventoryItem{tracked requiresShipping}} pageInfo{hasNextPage}}}}';
export async function verifyCustomerTarget(api,{sourceScope,persistentStaging=false}={}){
 const id='gid://shopify/Product/15620086005871',variant='gid://shopify/ProductVariant/67852705202287';
 const routed=sourceScope&&isLabVariantCatalog(assertEngineeringScope(sourceScope).catalog);
 need(!persistentStaging||routed&&assertEngineeringScope(sourceScope).contract.kind==='persistent_staging','CUSTOMER_TARGET_READBACK');
 const d=await api(persistentStaging?PERSISTENT_CUSTOMER_TARGET_QUERY:routed?CUSTOMER_VARIANTS_TARGET_QUERY:CUSTOMER_TARGET_QUERY,{id,...(persistentStaging?{publication:PERSISTENT_CUSTOMER_PUBLICATION}:{})}),p=d.product,v=p?.variants?.nodes?.[0];
 need(d.shop?.id===SHOP&&d.shop.myshopifyDomain===STORE&&d.shop.currencyCode==='USD'&&d.currentAppInstallation?.id===INSTALLATION&&d.currentAppInstallation.app?.id===APP,'WRONG_TARGET');
 need(p?.id===id&&p.title==='F00 Film Printing Test'&&p.status==='ACTIVE'&&
  (persistentStaging?p.onlineStoreUrl===null||p.onlineStoreUrl===`https://${STORE}/products/f00-film-printing-test`:p.onlineStoreUrl===null)&&p.variants?.pageInfo?.hasNextPage===false,'CUSTOMER_TARGET_READBACK');
 if(persistentStaging){
  const publications=d.publications,rows=publications?.nodes;
  need(p.handle==='f00-film-printing-test'&&p.publishedOnPublication===true&&publications?.pageInfo?.hasNextPage===false&&
   Array.isArray(rows)&&rows.length>0&&rows.length<=100&&new Set(rows.map(row=>row.id)).size===rows.length&&
   rows.every(row=>/^gid:\/\/shopify\/Publication\/\d+$/.test(row.id)&&typeof row.name==='string'&&row.name.length>0)&&
   rows.filter(row=>row.name==='Online Store').length===1&&rows.some(row=>row.id===PERSISTENT_CUSTOMER_PUBLICATION&&row.name==='Online Store'),'CUSTOMER_TARGET_READBACK');
 }
 if(routed){
  const expected=Object.values(VARIANTS_BY_LAB),rows=p.variants.nodes;
  const labFor=id=>Object.keys(VARIANTS_BY_LAB).find(lab=>VARIANTS_BY_LAB[lab]===id);
  const labelFor=id=>{const lab=labFor(id);return lab?lab[0].toUpperCase()+lab.slice(1):null;};
  need(expected.length===4&&new Set(expected).size===4&&p.hasOnlyDefaultVariant===false&&Array.isArray(rows)&&rows.length===4&&
   new Set(rows.map(row=>row.id)).size===4&&rows.every(row=>expected.includes(row.id)&&row.price==='1.00'&&row.inventoryItem?.tracked===false&&row.inventoryItem.requiresShipping===true&&
    Array.isArray(row.selectedOptions)&&row.selectedOptions.length===1&&row.selectedOptions[0].name==='Lab'&&row.selectedOptions[0].value===labelFor(row.id)),'CUSTOMER_TARGET_READBACK');
  return {product_id:PRODUCT,variants:{...VARIANTS_BY_LAB},published:persistentStaging,currency:'USD',requires_shipping:true,tracked:false};
 }
 need(p.hasOnlyDefaultVariant===true&&p.variants.nodes.length===1&&v.id===variant&&v.price==='1.00'&&v.inventoryItem?.tracked===false&&v.inventoryItem.requiresShipping===true,'CUSTOMER_TARGET_READBACK');
 return {product_id:id,variant_id:variant,published:false,currency:'USD',requires_shipping:true,tracked:false};
}
