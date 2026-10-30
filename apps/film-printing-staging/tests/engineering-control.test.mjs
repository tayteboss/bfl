import test from 'node:test';
import assert from 'node:assert/strict';
import {CONTROL_TITLE,verifyDiagnosticControl} from '../backend/diagnostic-control.mjs';
import {rawHash} from '../configuration/engineering.mjs';
import {canonical} from '../configuration/config.mjs';
import {STORE,APP} from '../configuration/schema.mjs';
import {SHOP,INSTALLATION} from '../backend/config.mjs';
test('control requires exact fresh privately pinned nonphysical USD1 default variant and rejects spent F06M/F00',async()=>{
 const control={run_id:'f06p-integrated-v1',product_id:'gid://shopify/Product/9990001',variant_id:'gid://shopify/ProductVariant/9990002',title:CONTROL_TITLE,currency:'USD',price:'1.00',quantity:1,requires_shipping:false,tracked:false};
 const pin={product_id:control.product_id,variant_id:control.variant_id,publication_id:'gid://shopify/Publication/9990003',sha256:rawHash(canonical(control))};
 const good={shop:{id:SHOP,myshopifyDomain:STORE,currencyCode:'USD'},currentAppInstallation:{id:INSTALLATION,app:{id:APP}},product:{id:pin.product_id,title:CONTROL_TITLE,status:'ACTIVE',productType:'F06P engineering control',tags:['f06p-engineering'],hasOnlyDefaultVariant:true,publishedOnPublication:true,variants:{nodes:[{id:pin.variant_id,price:'1.00',inventoryItem:{tracked:false,requiresShipping:false}}],pageInfo:{hasNextPage:false}}}};
 assert.deepEqual(await verifyDiagnosticControl(async()=>good,pin),control);
 for(const mutate of [d=>d.product=null,d=>d.product.title='another',d=>d.product.variants.nodes[0].price='2.00',d=>d.product.variants.nodes[0].inventoryItem.requiresShipping=true,d=>d.product.variants.nodes[0].inventoryItem.tracked=true,d=>d.product.variants.pageInfo.hasNextPage=true,d=>d.product.publishedOnPublication=false,d=>d.shop.currencyCode='AUD']){
  const d=structuredClone(good);mutate(d);await assert.rejects(verifyDiagnosticControl(async()=>d,pin));
 }
 for(const variant_id of ['gid://shopify/ProductVariant/67974376128623','gid://shopify/ProductVariant/67852705202287'])await assert.rejects(verifyDiagnosticControl(async()=>{throw Error('must not fetch');},{...pin,variant_id}),/CONTROL_ID_REJECTED/);
 await assert.rejects(verifyDiagnosticControl(async()=>good,{...pin,sha256:'0'.repeat(64)}),/CONTROL_PIN_CHANGED/);
});
