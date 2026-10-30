import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {verifyCustomerTarget,CUSTOMER_VARIANTS_TARGET_QUERY,PERSISTENT_CUSTOMER_TARGET_QUERY,PERSISTENT_CUSTOMER_PUBLICATION} from '../backend/diagnostic-control.mjs';
import {preparePersistentStagingSources,createPersistentStagingScope} from '../configuration/engineering.mjs';
import {STORE,APP,CLIENT} from '../configuration/schema.mjs';
import {SHOP,INSTALLATION} from '../backend/config.mjs';
import {VARIANTS_BY_LAB,PRODUCT} from '../checkout/authority.js';
const now=()=>Date.parse('2026-10-30T05:00:00Z');
const read=name=>JSON.parse(readFileSync(new URL('../../../fixtures/film-printing/full-product-lab-routing-20261030/'+name,import.meta.url)));
const identity={shop:{id:SHOP,myshopifyDomain:STORE},currentAppInstallation:{id:INSTALLATION,app:{id:APP,apiKey:CLIENT}}};
const sources=preparePersistentStagingSources({config:read('engineering-config-proposal.json'),catalog:read('engineering-catalog-proposal.json'),issuedAt:now()});
const sourceScope=createPersistentStagingScope({...sources,identity,now});
const target=()=>({...structuredClone(identity),shop:{...identity.shop,currencyCode:'USD'},publications:{nodes:[{id:PERSISTENT_CUSTOMER_PUBLICATION,name:'Online Store'},{id:'gid://shopify/Publication/229344280687',name:'Shop'},{id:'gid://shopify/Publication/229344313455',name:'Point of Sale'}],pageInfo:{hasNextPage:false}},product:{id:PRODUCT,title:'F00 Film Printing Test',status:'ACTIVE',handle:'f00-film-printing-test',onlineStoreUrl:null,publishedOnPublication:true,hasOnlyDefaultVariant:false,variants:{nodes:Object.entries(VARIANTS_BY_LAB).map(([lab,id])=>({id,selectedOptions:[{name:'Lab',value:lab[0].toUpperCase()+lab.slice(1)}],price:'1.00',inventoryItem:{tracked:false,requiresShipping:true}})),pageInfo:{hasNextPage:false}}}});
for(const url of [null,`https://${STORE}/products/f00-film-printing-test`])test(`persistent target accepts verified publication with ${url===null?'nullable':'exact'} storefront URL`,async()=>{
 const data=target();data.product.onlineStoreUrl=url;
 const value=await verifyCustomerTarget(async(query,variables)=>{assert.equal(query,PERSISTENT_CUSTOMER_TARGET_QUERY);assert.deepEqual(variables,{id:PRODUCT,publication:'gid://shopify/Publication/229344215151'});assert.match(query,/publishedOnPublication\(publicationId:\$publication\)/);assert.match(query,/publications\(first:100\)\{nodes\{id name\} pageInfo\{hasNextPage\}\}/);return data;},{sourceScope,persistentStaging:true});
 assert.equal(value.published,true);assert.deepEqual(value.variants,VARIANTS_BY_LAB);
});
const rejected=[
 ['unpublished',d=>d.product.publishedOnPublication=false],
 ['unknown publication',d=>delete d.product.publishedOnPublication],
 ['wrong handle',d=>d.product.handle='other-product'],
 ['foreign URL',d=>d.product.onlineStoreUrl='https://example.com/products/f00-film-printing-test'],
 ['wrong product URL',d=>d.product.onlineStoreUrl=`https://${STORE}/products/other-product`],
 ['missing URL field',d=>delete d.product.onlineStoreUrl],
 ['incomplete publications',d=>d.publications.pageInfo.hasNextPage=true],
 ['missing publications',d=>delete d.publications],
 ['wrong Online Store ID',d=>d.publications.nodes[0].id='gid://shopify/Publication/1'],
 ['wrong publication name',d=>d.publications.nodes[0].name='Other Store'],
 ['duplicate Online Store name',d=>d.publications.nodes.push({id:'gid://shopify/Publication/2',name:'Online Store'})],
 ['duplicate publication ID',d=>d.publications.nodes.push({...d.publications.nodes[0],name:'Duplicate'})],
 ['wrong store',d=>d.shop.myshopifyDomain='1jukgy-dc.myshopify.com'],
 ['wrong app',d=>d.currentAppInstallation.app.id='gid://shopify/App/1'],
 ['wrong product',d=>d.product.id='gid://shopify/Product/1'],
 ['draft product',d=>d.product.status='DRAFT'],
 ['incomplete variants',d=>d.product.variants.pageInfo.hasNextPage=true],
 ['extra variant',d=>d.product.variants.nodes.push({...d.product.variants.nodes[0],id:'gid://shopify/ProductVariant/1'})],
 ['wrong variant price',d=>d.product.variants.nodes[0].price='2.00'],
 ['tracked variant',d=>d.product.variants.nodes[0].inventoryItem.tracked=true],
 ['wrong lab option',d=>d.product.variants.nodes[0].selectedOptions[0].value='Other Lab'],
];
for(const [name,change] of rejected)test(`persistent target rejects ${name}`,async()=>{const data=target();change(data);await assert.rejects(verifyCustomerTarget(async()=>data,{sourceScope,persistentStaging:true}),/CUSTOMER_TARGET_READBACK|WRONG_TARGET/);});
test('historical routed target keeps its original nullable URL query and guard',async()=>{
 const data=target();delete data.publications;delete data.product.handle;delete data.product.publishedOnPublication;
 await verifyCustomerTarget(async(query,variables)=>{assert.equal(query,CUSTOMER_VARIANTS_TARGET_QUERY);assert.deepEqual(variables,{id:PRODUCT});return data;},{sourceScope});
 data.product.onlineStoreUrl=`https://${STORE}/products/f00-film-printing-test`;
 await assert.rejects(verifyCustomerTarget(async()=>data,{sourceScope}),/CUSTOMER_TARGET_READBACK/);
});
