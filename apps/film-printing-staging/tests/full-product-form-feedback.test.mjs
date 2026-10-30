import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import '../theme/film-printing-job.js';
import '../theme/completed-uploads.js';
import '../theme/upload-transport.js';
import {createResourceSession} from '../theme/resource-session.js';
const {readSelection,customerError,createPreparedController}=globalThis.BFLPrintJob;
const asset='11111111-2222-4333-8444-555555555555';
const complete={completedAssetIds:[asset],pending:0,failed:0};
const input=(value,{hidden=false,disabled=false,unavailable=false}={})=>({value,disabled,closest:selector=>selector==='label'?{style:{display:hidden?'none':''},classList:{contains:()=>unavailable}}:{style:{display:hidden?'none':''}}});
function formFixture(){
 const values={'[name="service"]:checked':input('Fine Arts'),'[name="quantity"]':input('2'),'[name="location"]:checked':input('Miami'),'[name="properties[Turnaround]"]:checked':input('Standard (4-5 days)'),
  '[data-custom-size-input="width"]':input('44'),'[data-custom-size-input="height"]':input('1001'),'[name="delivery"]:checked':input('Drop Off')};
 const groups={Sizes:[input('Custom')],Paper:[input('Fibre Paper')],Borders:[input('Borderless (Edge-to-edge)')],Process:[input('Color')],'Scanning Options':[input('Yes')]};
 const form=new EventTarget();Object.assign(form,{dataset:{filmPrintingForm:''},bflSelectionComplete:()=>true,querySelector:selector=>values[selector]??null,
  querySelectorAll:selector=>groups[/data-group="([^"]+)"/.exec(selector)?.[1]]??[]});
 return {form,values,groups,read:(snapshot=complete)=>readSelection(form,{snapshot:()=>snapshot})};
}
test('safe feedback distinguishes expiry, upload, price and Custom validation without reflecting arbitrary errors',()=>{
 for(const code of ['RESOURCE_EXPIRED','PREPARED_EXPIRED','ENGINEERING_EXPIRED'])assert.match(customerError(Error(code)),/session has ended/);
 assert.match(customerError({reason:'CUSTOMER_SELECTION_REJECTED'}),/price could not be confirmed/);
 assert.match(customerError(Error('CUSTOM_SIZE_INVALID')),/width from 1 to 44/);
 assert.match(customerError(Error('UPLOAD_FAILED')),/failed image/);
 assert.match(customerError(Error('UPLOAD_INCOMPLETE')),/still uploading/);
 assert.match(customerError(Error('UPLOAD_REQUIRED')),/at least one image/);
 assert.match(customerError({reason:'PREPARATION_LIMIT'}),/reached its limit/);
 assert.match(customerError({reason:'RESOURCE_REJECTED'}),/no longer available/);
 const privateError=Error('private cart key and provider URL');assert.ok(!customerError(privateError).includes(privateError.message));
 assert.match(customerError({message:'RESOURCE_EXPIRED',cartUncertain:true}),/cart could not be confirmed.*before trying again/);
});
test('Custom dimensions use the same whole-number rules as the visible form',()=>{
 const f=formFixture();assert.deepEqual(f.read().custom_dimensions,{width:44,height:1001});
 for(const [name,value] of [['width','0'],['width','45'],['width','1e1'],['width','1.5'],['height',''],['height','-1'],['height','9007199254740992']]){
  const previous=f.values[`[data-custom-size-input="${name}"]`].value;f.values[`[data-custom-size-input="${name}"]`].value=value;
  assert.throws(()=>f.read(),/CUSTOM_SIZE_INVALID/);f.values[`[data-custom-size-input="${name}"]`].value=previous;
 }
 for(const [snapshot,code] of [[{completedAssetIds:[],pending:0,failed:0},'UPLOAD_REQUIRED'],[{...complete,pending:1},'UPLOAD_INCOMPLETE'],[{...complete,failed:1},'UPLOAD_FAILED']])assert.throws(()=>f.read(snapshot),new RegExp(code));
});
test('switching Custom to Darkroom ignores digital files, hidden options and stale scanning',()=>{
 const f=formFixture();f.values['[name="service"]:checked']=input('Darkroom Prints');
 f.groups.Sizes=[input('Custom',{hidden:true}),input('8x10',{disabled:true}),input('11x14',{unavailable:true}),input('12x16')];
 f.groups.Paper=[input('Fibre Paper',{hidden:true}),input('Glossy')];
 const dark=f.read({completedAssetIds:[asset],pending:1,failed:1});assert.deepEqual(dark.asset_ids,[]);assert.equal(dark.paper,'Glossy');assert.equal(dark.size,'12x16');
 assert.equal(dark.custom_dimensions,undefined);assert.equal(dark.options['Scanning Options'],undefined);assert.equal(dark.options.Process,'Color');
 f.groups.Sizes=[input('8x10')];assert.equal(f.read().options['Scanning Options'],'Yes');
 f.values['[name="service"]:checked']=input('Photo Prints');f.groups.Sizes=[input('4x6')];f.groups.Paper=[input('Glossy',{hidden:true})];f.groups.Borders=[input('Borderless (Edge-to-edge)',{hidden:true})];
 const photo=f.read();assert.equal(photo.paper,null);assert.equal(photo.options.Process,undefined);assert.equal(photo.options['Scanning Options'],undefined);assert.equal(photo.options.Borders,undefined);
});
test('Darkroom totals charge per copy while digital totals still require files and ignore hidden stale prices',()=>{
 const source=readFileSync(new URL('../../../assets/film-service.js',import.meta.url),'utf8');
 const summary=source.slice(source.indexOf('    // --- Totals area (consider quantity)'),source.indexOf('  // --- Total calc ---'));
 const calculation=source.slice(source.indexOf('  function calculateTotal()'),source.indexOf('  // --- Conditions'));
 for(const dark of [false,true])for(const copies of [1,3]){
  const rows=[],top={},bottom={};
  const label=hidden=>({hidden,classList:{contains:()=>false}});
  const selected=[{dataset:{price:40},closest:selector=>selector==='label'?label(false):null},{dataset:{price:999},closest:selector=>selector==='label'?label(true):null}];
  const context={getQuantity:()=>copies,getUploadedFilesCount:()=>0,usesPhysicalNegatives:()=>dark,total:40,getSizeShippingHandle:()=>null,
   osList:'main',bottomOsList:'bottom',formatMoney:value=>value.toFixed(2),createRow:(list,label,value)=>rows.push({list,label,value}),
   basePrice:0,syncCustomSizePrice(){},form:{querySelectorAll:()=>selected,querySelector:()=>null},printJobFlow:()=>({}),isVisible:el=>!el.hidden,
   totalDisplay:top,bottomTotalDisplay:bottom,setErrorMessage(){},renderSummary(){},updateOrderSummaryVisibility(){}};
  const activeOption=source.slice(source.indexOf('  const isActivePrintOption ='),source.indexOf('  const getVisibleFieldsets ='));
  vm.runInNewContext(activeOption+calculation+'calculateTotal();',context);
  assert.equal(top.textContent,(dark?40*copies:0).toFixed(2));assert.equal(bottom.textContent,top.textContent);
  vm.runInNewContext(`(()=>{${summary.trimEnd().slice(0,-2)}})()`,context);
  assert.deepEqual(rows.filter(r=>r.label==='Total').map(r=>r.value),Array(2).fill(top.textContent));
  assert.ok(!rows.some(r=>r.label==='Files Uploaded'));
  if(dark&&copies>1)assert.ok(rows.some(r=>r.label==='Copies'));
 }
});
test('a background expiry retains its actionable reason and uncertain cart writes never replay',async()=>{
 let preparations=0,writes=0;
 const selection={service:'Photo Prints',asset_ids:[asset],copies:1};
 const expired=createPreparedController({read:()=>selection,prepare:async()=>{preparations++;throw Object.assign(Error('RESOURCE_UNAVAILABLE'),{reason:'ENGINEERING_EXPIRED'});},cancelPreparation(){},addPrepared(){writes++;}});
 await assert.rejects(expired.prepare());await assert.rejects(expired.submit(),error=>/session has ended/.test(customerError(error)));
 assert.equal(preparations,1);assert.equal(writes,0);
 const uncertain=createPreparedController({read:()=>selection,prepare:async i=>({prepared:true,generation:i.generation,checkout_ready:false,reservation:{operation_id:'one'},expires_at:Date.now()+60000}),cancelPreparation(){},addPrepared:async call=>{call.onWriteStarted();writes++;throw Error('RESOURCE_EXPIRED');}});
 await assert.rejects(uncertain.submit(),error=>/cart could not be confirmed/.test(customerError(error)));
 await assert.rejects(uncertain.submit());assert.equal(writes,1);assert.equal(uncertain.canRetry(),false);
});
test('resource transport preserves only fixed feedback reasons and retry-safe selection rejection',async t=>{
 const previous=globalThis.location;globalThis.location={origin:'https://bellows-film-printing-staging.myshopify.com'};t.after(()=>{globalThis.location=previous;});
 let code='CUSTOMER_SELECTION_REJECTED';const opaque='a'.repeat(43),fetchImpl=async(url,options)=>{
  const path=new URL(url,globalThis.location.origin).pathname;
  if(path==='/resource-proof/challenge')return Response.json({challenge:opaque,verifier:opaque,purpose:'bfl:resource-fresh-proof:v1',audience:globalThis.location.origin+'/bfl-application-resources',action:'issue',expires_in:30});
  if(path==='/apps/bfl-staging/resource-proof')return Response.json({ticket:opaque});
  if(path==='/resource-proof/exchange')return Response.json({proof:opaque,expires_in:30});
  if(path==='/resource-sessions/issue')return Response.json({token:'bflr1_'+opaque,resource_only:true,cart_verified:false,checkout_ready:false,generation:1,expires_in:600});
  return Response.json({code,message:'private upstream detail'},{status:403});
 };
 const session=createResourceSession({preparedMode:true,fetchImpl});await session.issue();
 await assert.rejects(session.request('/jobs',{}),error=>error.definitive===true&&error.reason===code);
 code='ENGINEERING_EXPIRED';await assert.rejects(session.request('/jobs',{}),error=>error.reason===code&&!error.definitive);
 code='private upstream detail';await assert.rejects(session.request('/jobs',{}),error=>error.message==='RESOURCE_UNAVAILABLE'&&error.reason===undefined);
});


test('explicit failed previews stay visibly failed until removed, without replaying bytes',async()=>{
 let sends=0;const id='11111111-2222-4333-8444-555555555555';
 const receipt=(state,version)=>({schema:1,intent_id:id,state,version,asset_id:state==='complete'?id:null,expires_at:Date.now()+60000,checkout_ready:false});
 const client={intent:async()=>receipt('issued',1),bytes:async()=>{sends++;return receipt('complete',2);},status:async()=>receipt('complete',3),remove:async()=>receipt('removed',4)};
 const transport=globalThis.BFLUploadTransport.create({enabled:true,client});
 await transport.select('one',new File(['x'],'test.png',{type:'image/png'}));transport.failPreview('one');
 assert.equal(transport.snapshot().failed,1);assert.ok(transport.snapshot().pending>0);
 assert.match(customerError(Error('Upload unavailable'),{uploadState:transport.snapshot()}),/failed image/);
 await transport.refreshSuccessful();assert.equal(transport.snapshot().failed,1);assert.equal(sends,1);
 await transport.remove('one');assert.equal(transport.snapshot().failed,0);assert.equal(sends,1);
});


test('expired saved sessions report expiry without issuing or renewing a credential',t=>{
 const previous=globalThis.location;globalThis.location={origin:'https://bellows-film-printing-staging.myshopify.com'};t.after(()=>{globalThis.location=previous;});
 let saved=JSON.stringify({state:'initialized',token:'bflr1_'+'a'.repeat(43),expires:1000,generation:1,prepared_generation:0}),requests=0;
 const session=createResourceSession({preparedMode:true,now:()=>1000,fetchImpl:()=>{requests++;throw Error('must not request');},reloadStorage:{getItem:()=>saved,setItem:(_key,value)=>{saved=value;}}});
 assert.throws(()=>session.restore(),error=>error.message==='RESOURCE_EXPIRED'&&/session has ended/.test(customerError(error)));
 assert.equal(requests,0);
});
test('owned cart expiry allows zero-quantity cleanup and guards increases with the existing error slot',async()=>{
 const source=readFileSync(new URL('../../../assets/cart.js',import.meta.url),'utf8');
 const method=source.slice(source.indexOf('  async changeOwnedCart('),source.indexOf('  async refreshOwnedCart('));
 const error={textContent:''},pending=[],drawer={getAttribute:()=>false,classList:{contains:()=>false},setPending:(...args)=>pending.push(args)};
 let attempts=0;
 const flow={mode:'prepared-unit-v3',resolveCartItem:()=>({properties:{_bfl_flow:'f05',_bfl_job:'one'}}),changeCart:async()=>{attempts++;throw Error('PREPARED_EXPIRED');},errorMessage:(error,context)=>customerError(error,context)};
 const context={window:{BFLPrintJob:{forForm:()=>flow}},document:{querySelector:()=>({}),getElementById:()=>error},fetch:()=>assert.fail('no legacy fallback')};
 const target=vm.runInNewContext('({'+method+'})',context);Object.assign(target,{closest:()=>drawer,enableLoading(){},disableLoading(){}});
 assert.equal(await target.changeOwnedCart({key:'one'},0),false);assert.equal(attempts,1);
 assert.equal(await target.changeOwnedCart({key:'one'},2),true);assert.equal(attempts,2);assert.match(error.textContent,/session has ended/);
 assert.equal(pending.at(-1)[1].message,error.textContent);assert.equal(pending.at(-1)[1].failed,false);
});
