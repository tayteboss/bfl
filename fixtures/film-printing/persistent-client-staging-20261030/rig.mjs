import {createPublicSource} from '../../../apps/film-printing-staging/uploads/public-source.mjs';
import {EventEmitter} from 'node:events';
// Generated external transports only. The complete final operator, source
// writer, proof/session HTTP handler, normal uploads/jobs and lifecycle are real.
import {readFileSync,mkdtempSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash,createHmac} from 'node:crypto';
import {Readable} from 'node:stream';
import {DatabaseSync} from 'node:sqlite';
import {configuration} from '../f06p-composition/rig.mjs';
import {createPersistentStagingRuntime} from '../../../apps/film-printing-staging/backend/staging-runtime.mjs';
import {emptyAuthority,serializeAuthority} from '../../../apps/film-printing-staging/checkout/projector.mjs';
import {decodeCatalog} from '../../../apps/film-printing-staging/checkout/shopify.mjs';
import {leaseOwners,leaseEnvelope,LEASE_KEY} from '../../../apps/film-printing-staging/checkout/lease.mjs';
import {VARIANTS_BY_LAB} from '../../../apps/film-printing-staging/checkout/authority.js';
import {mockLeaseAdmin} from '../f06v3-candidate/mock-admin.mjs';
import {ATTRIBUTES,FULL_PRODUCT_ATTRIBUTES} from '../../../apps/film-printing-staging/checkout/authority.js';
import {cartTransformRun} from '../../../apps/film-printing-staging/checkout/functions.js';
import {cartResponse} from '../f06c-continuation/synthetic.mjs';
import {migrateCheckoutComposition,migratePreparedCart} from '../../../apps/film-printing-staging/backend/storage.mjs';
import {startDiagnosticOperator,RUN_ID,INVENTORY_QUERY} from '../../../apps/film-printing-staging/backend/diagnostic-operator.mjs';
import {CONTROL_QUERY,CONTROL_TITLE,CUSTOMER_TARGET_QUERY,PERSISTENT_CUSTOMER_TARGET_QUERY,PERSISTENT_CUSTOMER_PUBLICATION} from '../../../apps/film-printing-staging/backend/diagnostic-control.mjs';
import {createResourceSession} from '../../../apps/film-printing-staging/theme/resource-session.js';
import {preparePersistentStagingSources,createPersistentStagingScope,assertEngineeringScope,rawHash} from '../../../apps/film-printing-staging/configuration/engineering.mjs';
import {canonical} from '../../../apps/film-printing-staging/configuration/config.mjs';
import {ACTIVE_QUERY} from '../../../apps/film-printing-staging/configuration/shopify.mjs';
import {CATALOG_DELETE} from '../../../apps/film-printing-staging/backend/admin.mjs';
import {BINDING_QUERY,BINDING_MUTATION,BINDING_DELETE,BINDING_NAMESPACE,BINDING_KEY} from '../../../apps/film-printing-staging/checkout/cart-capability.mjs';
import {CADDY_PEER} from '../../../apps/film-printing-staging/backend/buyer-ip.mjs';
import {STORE,CLIENT} from '../../../apps/film-printing-staging/configuration/schema.mjs';

const artifact=name=>JSON.parse(readFileSync(new URL('../f06p-integration/'+name,import.meta.url)));
export const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
export async function persistentRig(t,{sourceFlow=false,initialTime=Date.parse('2026-10-30T05:00:00Z'),resolveBuyerIp}={}){
 const customerFlow=true,customerJobs=2,customerEdits=true,fullProduct=true;
 const cleanup=[],base=configuration({after:fn=>cleanup.push(fn)});migrateCheckoutComposition(base);migratePreparedCart(base);
 const clock={time:initialTime};
 const config={...base,mode:'disabled',resourceSessions:'disabled',storefrontSessions:'disabled',origin:'https://film-printing-staging.bellowsfilmlab.com',host:'0.0.0.0',port:0,buyerIpMode:'caddy-direct',adminToken:null};
 const dir=mkdtempSync(join(tmpdir(),'bfl-full-operator-'));chmodSync(dir,0o700);
 const specificationOwner=fullProduct?{id:'gid://shopify/Validation/999',functionId:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'}:null;
 const m=mockLeaseAdmin({specificationOwner});m.data.currentAppInstallation.app.apiKey=CLIENT;m.data.currentAppInstallation.catalog=null;
 m.data.shop.storefrontAccessTokens={nodes:[],pageInfo:{hasNextPage:false,hasPreviousPage:false}};
 const original=m.data.currentAppInstallation.active.value;
 const fullArtifact=name=>JSON.parse(readFileSync(new URL('../full-product-lab-routing-20261030/'+name,import.meta.url)));
 const engineering=preparePersistentStagingSources({config:fullProduct?fullArtifact('engineering-config-proposal.json'):artifact('engineering-config-proposal.json'),catalog:fullProduct?fullArtifact('engineering-catalog-proposal.json'):JSON.parse(readFileSync(new URL('./engineering-catalog-proposal.json',import.meta.url))),issuedAt:clock.time,until:clock.time+(fullProduct?3600000:1200000)});
 const control={run_id:RUN_ID,product_id:'gid://shopify/Product/9990001',variant_id:'gid://shopify/ProductVariant/9990002',title:CONTROL_TITLE,currency:'USD',price:'1.00',quantity:1,requires_shipping:false,tracked:false};
 const pin={product_id:control.product_id,variant_id:control.variant_id,publication_id:'gid://shopify/Publication/9990003',sha256:rawHash(canonical(control))};
 const inputFiles=artifact('fixture-files.json').map(f=>({...f,bytes:readFileSync(new URL('../f06p-integration/'+f.path,import.meta.url))}));
 if(sourceFlow)for(const file of inputFiles)file.source_url=`https://${STORE}/cdn/shop/t/1/assets/${file.path}?v=1`;
 const sourceRoot=resolve('apps/film-printing-staging');
 const source_pins=Object.fromEntries(['backend/diagnostic-operator.mjs','backend/checkout-diagnostic.mjs','backend/diagnostic-resources.mjs','backend/admin.mjs','configuration/engineering.mjs','configuration/engineering-operator.mjs','configuration/config.mjs','jobs/service.mjs','checkout/projector.mjs','checkout/shopify.mjs'].map(p=>[p,createHash('sha256').update(readFileSync(join(sourceRoot,p))).digest('hex')]));
 const plan={...(specificationOwner?{specification_owner:specificationOwner}:{}),customer_eligibility:true,customer_flow:customerFlow,customer_jobs:customerJobs,customer_edits:customerEdits,phase:'reviewed-integrated',run_id:RUN_ID,source_eligibility:'staging_engineering',until:engineering.contract.expires_at,watchdog_registered:true,expected_epoch:0,source_pins,engineering,control:pin,selection:{service:'Photo Prints',size:'4x6',paper:null,lab:'Miami',copies:3,options:{Turnaround:'Standard (4-5 days)'}}};
 const uploadConfig={store:STORE,app:config.app,publicKey:'synthetic-public-key',projectId:699888,cdnOrigin:'https://synthetic.ucarecd.net',secret:'synthetic-upload-secret'.repeat(3),delivery:{projectKey:'synthetic-public-key',origin:'https://synthetic.s.ucarecd.net',publicAccessDisabled:true,legacyAccessDisabled:true,signingSecret:'a'.repeat(64)}};
 const ids={A:'gid://shopify/Cart/generated-full-A?key=private-generated-A',B:'gid://shopify/Cart/generated-full-B?key=private-generated-B'};
 const carts=new Map(Object.values(ids).map(id=>[id,{cart:{...cartResponse(null,id).data.cart,note:'',attributes:[]},marker:null}]));
 // These generated buyers are anonymous. Storefront cart snapshots omit the
 // Function-only authentication flag; project it without changing cart data.
 const functionInput=state=>{
  const field=m.data.leasePricing.nodes[0].lease;
  let envelope;try{envelope=JSON.parse(field?.value);}catch{}
  return {leaseOwner:{lease:field},shop:{localTime:{beforeDeadline:!!envelope?.authority?.grants?.length&&clock.time<envelope.authority.lease.expires_at}},
   cart:{binding:{value:state.marker},buyerIdentity:{...state.cart.buyerIdentity,isAuthenticated:false},
    lines:state.cart.lines.nodes.map(line=>({...line,cost:{...line.cost,amountPerQuantity:{amount:'1.00',currencyCode:'USD'}},
     ...Object.fromEntries(Object.entries(fullProduct?FULL_PRODUCT_ATTRIBUTES:ATTRIBUTES).map(([alias,key])=>[alias,{value:line.attributes.find(a=>a.key===key)?.value??''}]))}))}};
 };
 const reprice=(role='A')=>{
  const state=carts.get(ids[role]);
  const prices=new Map(cartTransformRun(functionInput(state)).operations.map(op=>[op.lineUpdate.cartLineId,Math.round(Number(op.lineUpdate.price.adjustment.fixedPricePerUnit.amount)*100)]));
  for(const line of state.cart.lines.nodes)line.cost.subtotalAmount={amount:((prices.get(line.id)??100)*line.quantity/100).toFixed(2),currencyCode:'USD'};
  state.cart.totalQuantity=state.cart.lines.nodes.reduce((n,l)=>n+l.quantity,0);return state.cart;
 };
 const counts={admin:0,admin_mutations:0,storefront:0,provider:0,uploads:0,deletes:0,catalog_deletes:0};let hook=null;const uploaded=new Map();
 const response=(data,version)=>new Response(JSON.stringify({data}),{headers:{'content-type':'application/json','x-shopify-api-version':version}});
 const fetchImpl=async(url,options={})=>{
  if(url===`https://${STORE}/admin/api/2026-10/graphql.json`){
   const {query,variables}=JSON.parse(options.body);counts.admin++;if(query.startsWith('mutation'))counts.admin_mutations++;
   if(hook)await hook('admin',{query,variables});let d;
   if(query===CATALOG_DELETE){m.data.currentAppInstallation.catalog=null;counts.catalog_deletes++;d={metafieldsDelete:{deletedMetafields:variables.metafields,userErrors:[]}};}
   else if(query===ACTIVE_QUERY)d={shop:{myshopifyDomain:STORE},currentAppInstallation:{...m.data.currentAppInstallation,metafield:m.data.currentAppInstallation.active}};
   else if(query.includes('F05PriceCatalog'))d={currentAppInstallation:{metafield:m.data.currentAppInstallation.catalog}};
   else if(query===PERSISTENT_CUSTOMER_TARGET_QUERY)d={shop:{...structuredClone(m.data.shop),currencyCode:'USD'},currentAppInstallation:structuredClone(m.data.currentAppInstallation),publications:{nodes:[{id:PERSISTENT_CUSTOMER_PUBLICATION,name:'Online Store'}],pageInfo:{hasNextPage:false}},product:{id:'gid://shopify/Product/15620086005871',title:'F00 Film Printing Test',status:'ACTIVE',handle:'f00-film-printing-test',publishedOnPublication:true,onlineStoreUrl:null,hasOnlyDefaultVariant:false,variants:{nodes:Object.entries(VARIANTS_BY_LAB).map(([lab,id])=>({id,selectedOptions:[{name:'Lab',value:lab[0].toUpperCase()+lab.slice(1)}],price:'1.00',inventoryItem:{tracked:false,requiresShipping:true}})),pageInfo:{hasNextPage:false}}}};
   else if(query===CUSTOMER_TARGET_QUERY)d={shop:{...structuredClone(m.data.shop),currencyCode:'USD'},currentAppInstallation:structuredClone(m.data.currentAppInstallation),product:{id:'gid://shopify/Product/15620086005871',title:'F00 Film Printing Test',status:'ACTIVE',onlineStoreUrl:null,hasOnlyDefaultVariant:true,variants:{nodes:[{id:'gid://shopify/ProductVariant/67852705202287',price:'1.00',inventoryItem:{tracked:false,requiresShipping:true}}],pageInfo:{hasNextPage:false}}}};
   else if(query===CONTROL_QUERY)d={...structuredClone(m.data),shop:{...structuredClone(m.data.shop),currencyCode:'USD'},product:{id:pin.product_id,title:CONTROL_TITLE,status:'ACTIVE',productType:'F06P engineering control',tags:['f06p-engineering'],hasOnlyDefaultVariant:true,publishedOnPublication:true,variants:{nodes:[{id:pin.variant_id,price:'1.00',inventoryItem:{tracked:false,requiresShipping:false}}],pageInfo:{hasNextPage:false}}}};
   else {d=await m.api(query,variables);if(query.startsWith('mutation')&&m.data.currentAppInstallation.catalog)m.data.currentAppInstallation.catalog.id??='gid://shopify/Metafield/9991001';}
   if(hook)await hook('after_admin',{query,variables});return response(d,'2026-10');
  }
  if(url===`https://${STORE}/api/2026-07/graphql.json`){
   counts.storefront++;const {query,variables}=JSON.parse(options.body);
   if(hook)await hook('storefront',{query,variables});
   const id=variables.id??variables.cartId??variables.fields?.[0]?.ownerId??variables.input?.ownerId,state=carts.get(id);
   if(!state)throw Error('unknown generated cart');reprice(id===ids.A?'A':'B');const cart=structuredClone(state.cart);let d;
   if(query===BINDING_MUTATION){state.marker=variables.fields[0].value;d={cartMetafieldsSet:{userErrors:[]}};}
   else if(query===BINDING_DELETE){state.marker=null;d={cartMetafieldDelete:{deletedId:'gid://shopify/Metafield/9992001',userErrors:[]}};}
   else if(query.startsWith('mutation'))d={cartLinesUpdate:{cart,userErrors:[],warnings:[]}};
   else {if(query===BINDING_QUERY)cart.binding=state.marker===null?null:{namespace:BINDING_NAMESPACE,key:BINDING_KEY,type:'single_line_text_field',value:state.marker};d={shop:{id:m.data.shop.id},cart};}
   return response(d,'2026-07');
  }
  if(url.startsWith('https://api.uploadcare.com/')||url==='https://upload.uploadcare.com/base/'){
   counts.provider++;if(hook)await hook('provider',{url,options});let body;
   if(url.endsWith('/project/'))body={pub_key:uploadConfig.publicKey};
   else if(options.method==='POST'){counts.uploads++;body={file:`00000000-0000-4000-8000-${String(counts.uploads).padStart(12,'0')}`};uploaded.set(body.file,Buffer.from(await options.body.get('file').arrayBuffer()));}
   else {const asset=url.split('/')[4];if(options.method==='DELETE')counts.deletes++;
    body={uuid:asset,url:`https://api.uploadcare.com/files/${asset}/`,datetime_removed:options.method==='DELETE'?'2026-10-26T00:00:00Z':null,is_ready:true,is_image:true,size:79,mime_type:'image/png',content_info:{image:{width:16,height:16}},datetime_uploaded:'2026-10-26T00:00:00Z',datetime_stored:'2026-10-26T00:00:00Z',original_file_url:`https://synthetic.ucarecd.net/${asset}/test.png`};}
   if(hook)await hook('provider_info',{url,body});
   if(hook)await hook('after_provider',{url,options});return new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
  }
  if(url.startsWith('https://synthetic.s.ucarecd.net/')){
   const path=new URL(url).pathname;const match=/^\/[a-f0-9-]{36}\/-\/crop\/(\d+)x(\d+)\/(\d+),(\d+)\/-\/format\/png\/$/.exec(path);
   if(!match){if(hook)await hook('original',{bytes:uploaded.get(path.split('/')[1])});return new Response(uploaded.get(path.split('/')[1]),{headers:{'content-type':'image/png'}});}
   const png=Buffer.alloc(24);Buffer.from([137,80,78,71,13,10,26,10]).copy(png);png.write('IHDR',12);png.writeUInt32BE(Number(match[1]),16);png.writeUInt32BE(Number(match[2]),20);
   return new Response(png,{headers:{'content-type':'image/png'}});
  }
  throw Error('unrecognized generated endpoint');
 };
 const importSource=createPublicSource({resolve:async()=>[{address:'93.184.216.34',family:4}],requestImpl:(url,options,callback)=>{
  const req=new EventEmitter();req.destroy=()=>{};req.end=()=>{(async()=>{
   if(hook)await hook('source',{url:url.href,options});
   const file=inputFiles.find(f=>new URL(f.source_url).pathname===url.pathname)??inputFiles[0];
   const response=Readable.from([file.bytes]);response.statusCode=200;response.headers={'content-type':'image/png'};callback(response);
  })().catch(error=>req.emit('error',error));};return req;
 }});
 const sourceScope=createPersistentStagingScope({...engineering,identity:m.data,now:()=>clock.time});
 const scope=assertEngineeringScope(sourceScope),empty=serializeAuthority(emptyAuthority(scope.release,decodeCatalog(scope.catalogValue),'2026-10-30',{sourceScope}));
 const set=(field,value)=>({...field,value,compareDigest:rawHash(value)});
 m.data.currentAppInstallation.active=set(m.data.currentAppInstallation.active,engineering.releaseValue);
 m.data.currentAppInstallation.catalog={id:'gid://shopify/Metafield/9991001',type:'json',value:engineering.catalogValue,compareDigest:rawHash(engineering.catalogValue)};
 m.data.shop.authority=set(m.data.shop.authority,empty);
 for(const owner of leaseOwners(specificationOwner)){
  const rows=owner.alias==='leaseLab'?m.data[owner.alias]:m.data[owner.alias].nodes;
  rows.find(row=>row.id===owner.id).lease={type:'json',namespace:'app--436988772353--bfl-checkout',key:LEASE_KEY,value:leaseEnvelope(empty),compareDigest:rawHash(leaseEnvelope(empty))};
 }
 const manifest={kind:'bfl-persistent-staging-v1',engineering,specification_owner:specificationOwner};
 const events=[];
 const runtimeOptions={config,manifest,files:inputFiles,uploadConfig,fetchImpl,importSource,...(resolveBuyerIp?{resolveBuyerIp}:{}),now:()=>clock.time,credentialProvider:{read:async()=> 'generated-current-credential'.repeat(3)},record:event=>events.push(event)};
 let runtime=await createPersistentStagingRuntime({...runtimeOptions,initialize:true});await runtime.start();
 const previous=globalThis.location;globalThis.location={origin:`https://${STORE}`};
 const browserFetch=async(url,options={})=>{
  const parsed=new URL(url,`https://${STORE}`);let path=parsed.pathname+parsed.search,headers=Object.fromEntries(Object.entries(options.headers??{}).map(([k,v])=>[k.toLowerCase(),v]));
  if(parsed.pathname==='/apps/bfl-staging/resource-proof'){
   const q=parsed.searchParams;q.set('shop',STORE);q.set('path_prefix','/apps/bfl-staging');q.set('logged_in_customer_id','');q.set('timestamp',String(Math.floor(clock.time/1000)));
   q.set('signature',createHmac('sha256',config.appSecret).update([...q].map(([k,v])=>`${k}=${v}`).sort().join('')).digest('hex'));path='/proxy/resource-proof?'+q;
  }else headers.origin=`https://${STORE}`;
  headers['x-bfl-direct-peer']='127.0.0.1';
  const payload=options.body instanceof Blob?Buffer.from(await options.body.arrayBuffer()):options.body?Buffer.from(options.body):null;
  const req=Readable.from(payload?[payload]:[]);Object.assign(req,{method:options.method??'GET',url:path,headers,rawHeaders:Object.entries(headers).flat(),socket:{remoteAddress:CADDY_PEER}});
  let code=200,body='',responseHeaders={},ended=false;
  const res={headersSent:false,destroyed:false,setHeader(k,v){responseHeaders[k]=v;},writeHead(status,values={}){code=status;Object.assign(responseHeaders,values);this.headersSent=true;},end(v=''){body+=v;ended=true;},destroy(){this.destroyed=true;}};
  await runtime.handle(req,res);if(!ended)throw Error('generated response not completed');if(code>=400)t.diagnostic(`generated HTTP ${parsed.pathname}: ${body}`);
  if(hook)await hook('browser_response',{status:code,path:parsed.pathname});
  return new Response(body,{status:code,headers:responseHeaders});
 };
 const clients=Object.fromEntries(['A','B'].map(role=>{const session=createResourceSession({fetchImpl:browserFetch,now:()=>clock.time,preparedMode:true,clientPolicy:'bfl-persistent-staging-client-v1'});return [role,{session,act:action=>session.checkoutDiagnostic(action,async()=>ids[role])}];}));
 const rows=()=>{const db=new DatabaseSync(join(config.dataDir,'jobs.sqlite'),{readOnly:true});try{return Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(({name})=>[name,db.prepare(`SELECT * FROM ${name}`).all()]));}finally{db.close();}};
 t.after(async()=>{try{await runtime.close();}catch{}finally{globalThis.location=previous;for(const fn of cleanup)fn();rmSync(dir,{recursive:true,force:true});}});
 return {async restart(){await runtime.close();runtime=await createPersistentStagingRuntime(runtimeOptions);await runtime.start();},get runtime(){return runtime;},reprice,functionInput,clients,config,clock,m,plan,counts,original,carts,ids,rows,browserFetch,inputFiles,journal:()=>structuredClone(events),set hook(fn){hook=fn;},addJob(item,role='A'){const cart={...cartResponse({item},ids[role]).data.cart,note:'',attributes:[]};cart.lines.nodes[0].quantity=item.quantity;cart.lines.nodes[0].merchandise.id='gid://shopify/ProductVariant/'+item.id;cart.totalQuantity=item.quantity;carts.get(ids[role]).cart=cart;}};
}
