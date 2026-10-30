import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto,createHash} from 'node:crypto';
import {mountPersistentCustomer,createPersistentCartCoordinator,PERSISTENT_CLIENT_POLICY as POLICY} from '../theme/persistent-cart.js';
import {createResourceSession} from '../theme/resource-session.js';
import {createPreparedCheckout} from '../theme/prepared-checkout.js';
import {createFilmPrintingForm} from '../theme/film-printing-form.js';

const origin='https://bellows-film-printing-staging.myshopify.com',cartId='gid://shopify/Cart/empty-recovery?key=synthetic';
const key='bfl:persistent-cart:v1:'+createHash('sha256').update(cartId).digest('hex');
const money=value=>({amount:(value/100).toFixed(2),currencyCode:'USD'});
const flush=async()=>{for(let i=0;i<4;i++)await new Promise(setImmediate);};
function rig(t,{kind='empty',fault,rejected=false,widget,sourceFailure=false,removalFailure=false}={}){
 const prior={location:globalThis.location,document:globalThis.document};t.after(()=>Object.assign(globalThis,prior));
 globalThis.location={origin,hostname:new URL(origin).hostname};
 const nodes=[];const node=()=>{const value=Object.assign(new EventTarget(),{style:{},append(){},after(){},remove(){},setAttribute(){}});nodes.push(value);return value;};
 const errors=[{textContent:'',style:{}},{textContent:'',style:{}}],choose=Object.assign(new EventTarget(),{disabled:false,parentElement:node()});
 const form=Object.assign(new EventTarget(),{dataset:{filmPrintingForm:''},append(){},bflSelectionComplete:()=>false,
  querySelector:s=>s==='[data-uploadly-fallback-button]'?choose:null,querySelectorAll:s=>s.includes('data-film-service-error')?errors:[]});
 globalThis.document={createElement:node,querySelector:()=>({refreshOwnedCart:async()=>{}}),querySelectorAll:()=>errors};
 const expires=Date.now()+86400000,record={state:'pending',operation:null,token:'bflr1_'+'a'.repeat(43),expires,generation:1,prepared_generation:26,client_policy:POLICY,cart_revision:3};
 const data=new Map([[key,JSON.stringify(record)]]),storage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};
 let tail=Promise.resolve();const locks={request(_key,_options,work){const p=tail.catch(()=>{}).then(work);tail=p;return p;}},events=new EventTarget(),calls=[];let intents=0;const receipts=new Map();
 const props=kind==='print'?{_bfl_flow:'f05',_bfl_job:'kept-job',_bfl_revision:'1',_bfl_config:'config',_bfl_signature:'v3:'+'a'.repeat(64)+':1',Service:'photo',Sizes:'4x6',Location:'miami','Files Uploaded':'1'}:{};
 const items=kind==='empty'?[]:[{id:'native-line',variant_id:kind==='print'?'67852705202287':'123',quantity:1,properties:props,subtotal_cents:40}];
 const native=()=>({id:cartId,totalQuantity:items.length,lines:items.map(i=>({id:i.id,quantity:i.quantity,cost:{totalAmount:money(i.subtotal_cents)}})),cost:{totalAmount:money(items.length*40)}});
 const actions={getCart:async()=>({cart:native()})};
 const fetchImpl=async(url,options={})=>{
  const path=new URL(url,origin).pathname,input=options.body instanceof Blob?null:options.body?JSON.parse(options.body):null;calls.push({path,input});let value;
  if(path==='/uploads/intents'){value={schema:1,intent_id:'00000000-0000-4000-8000-'+String(++intents).padStart(12,'0'),state:'issued',version:1,expires_at:expires,asset_id:null,checkout_ready:false};}
  else if(path.endsWith('/source')&&sourceFailure)return Response.json({code:'SOURCE_RESPONSE_REJECTED',message:'private provider detail'},{status:422});
  else if(path.endsWith('/bytes')){const intent=path.split('/')[2];value={schema:1,intent_id:intent,state:'complete',version:2,expires_at:expires,asset_id:intent.replace(/^00000000/,'10000000'),checkout_ready:false,file:{bytes:options.body.size,mime:options.body.type,sha256:createHash('sha256').update(Buffer.from(await options.body.arrayBuffer())).digest('hex')}};receipts.set(intent,value);}
  else if(path.endsWith('/status')){value={...receipts.get(path.split('/')[2])};}
  else if(path.endsWith('/remove')){const failure=typeof removalFailure==='function'?removalFailure(path):removalFailure;if(failure){if(failure==='lost')throw new TypeError('private transport detail');return Response.json({code:'UPLOAD_PROVIDER_UNAVAILABLE',message:'private provider detail'},{status:422});}const intent=path.split('/')[2];value={schema:1,intent_id:intent,state:'removed',version:(receipts.get(intent)?.version??1)+1,expires_at:expires,asset_id:null,checkout_ready:false};}
  else if(path==='/resource-proof/challenge')value={challenge:'p'.repeat(43),verifier:'p'.repeat(43),purpose:'bfl:resource-fresh-proof:v1',audience:origin+'/bfl-application-resources',action:input.action,expires_in:30};
  else if(path==='/apps/bfl-staging/resource-proof')value={ticket:'p'.repeat(43)};
  else if(path==='/checkout/resume'){
   assert.deepEqual(input.operation,{kind:'recover_preparation'});
   if(rejected)return Response.json({code:'PREPARED_UNCERTAIN'},{status:422});
   value={resumed:true,recovery:'known-current-v1',expires_at:Math.floor(expires/1000)*1000,items:structuredClone(items),cart_verified:false,checkout_ready:false,upload_recovery:'uncommitted-v1'};fault?.(value);
  }else if(path==='/cart.js')value={currency:'USD',items:items.map(i=>({key:'ajax-line',product_id:kind==='print'?'15620086005871':'456',variant_id:i.variant_id,quantity:1,properties:i.properties,final_price:40,final_line_price:40})),item_count:items.length,total_price:items.length*40};
  else if(path==='/cart')value={'cart-drawer':'<div>Verified cart</div>'};
  else assert.fail('Unexpected mutation or owner issuance '+path);
  return Response.json(value);
 };
 return {nodes,form,choose,errors,expires,record,data,storage,locks,events,calls,actions,fetchImpl,
  async mount(){const mounted=await mountPersistentCustomer({form,widget,publicKey:'12345678901234567890',storage,locks,events,actions,fetchImpl,sessionOptions:{fetchImpl},reload:()=>assert.fail('No reload loop')});t.after(()=>{mounted.dispose();globalThis.BFLPrintJob.forForm(form).invalidateSharedCart();});return mounted;},
  async checkout(){const c=await createPersistentCartCoordinator({cartId,storage,locks,events,cryptoImpl:webcrypto});t.after(()=>c.dispose());const session=createResourceSession({reloadStorage:c.storage,reloadKey:key,preparedMode:true,clientPolicy:POLICY,fetchImpl}),flow=createPreparedCheckout(session,{actions,fetchImpl});await c.run(async()=>{const recovery=session.restore();await flow.initialize({recovery});});return {c,session,flow};}};
}
function pinnedWidget(){
 let settings,removed,opened;
 const wrap=promise=>({_promise:promise,then:(...args)=>promise.then(...args)});
 const Deferred=()=>{let state='pending',resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j;});promise.catch(()=>{});const api=wrap(promise);
  const df={promise:()=>api,state:()=>state,notify(){},resolve(value){if(state==='pending'){state='resolved';resolve(value);}return df;},reject(code,info){if(state==='pending'){state='rejected';reject({code,info});}return df;}};return df;};
 const widget={version:'3.25.3',jQuery:{Deferred},plugin:fn=>fn({utils:{fixedPipe:(api,...args)=>wrap(api._promise.then(...args))}}),openDialog(_files,options){opened=[..._files];settings=options;return {fileColl:{onRemove:{add:fn=>{removed=fn;}}}};}};
 return {widget,opened:()=>opened,file:(type,value)=>settings.bflOwnedFileFactory(type,value),remove:file=>removed(file)};
}
test('real mounted form reports a failed source immediately and retains it across option changes, without Add',async t=>{
 const ui=pinnedWidget(),f=rig(t,{widget:ui.widget,sourceFailure:true});
 // The preserved film-service summary clears errors on these events before
 // the customer adapter runs; selectionFailed also emits uploads-changed.
 for(const name of ['change','input','bfl:uploads-changed'])f.form.addEventListener(name,()=>{for(const e of f.errors){e.textContent='';e.style.display='none';}});
 const mounted=await f.mount();await mounted.ready;f.choose.dispatchEvent(new Event('click'));await flush();
 const failed=ui.file('url','https://fixture.example.org/image.png');await assert.rejects(Promise.resolve(failed));await flush();
 const message=f.errors[0].textContent;assert.match(message,/image could not be uploaded/);assert.ok(f.errors.every(e=>e.textContent===message&&e.style.display===''));assert.equal(message.includes('private provider detail'),false);assert.equal(message.includes('SOURCE_RESPONSE_REJECTED'),false);
 for(const name of ['change','input','bfl:uploads-changed']){f.form.dispatchEvent(new Event(name));await flush();assert.ok(f.errors.every(e=>e.textContent===message&&e.style.display===''));}
 assert.equal(f.calls.filter(c=>c.path.endsWith('/source')).length,1);assert.equal(f.calls.filter(c=>c.path.endsWith('/remove')).length,0);assert.ok(!f.calls.some(c=>c.path==='/jobs'||c.path.includes('/graphql')));
 ui.remove(failed);await flush();assert.ok(f.errors.every(e=>e.textContent===''&&e.style.display==='none'));assert.equal(f.calls.filter(c=>c.path.endsWith('/remove')).length,1);assert.equal(f.calls.filter(c=>c.path.endsWith('/source')).length,1);
});
test('removing one failed dialog item keeps feedback until all failures are explicitly removed',async t=>{
 const ui=pinnedWidget(),f=rig(t,{widget:ui.widget}),mounted=await f.mount();await mounted.ready;f.choose.dispatchEvent(new Event('click'));await flush();
 const one=ui.file('uploaded','unsupported-one'),two=ui.file('uploaded','unsupported-two');await assert.rejects(Promise.resolve(one));await assert.rejects(Promise.resolve(two));const message=f.errors[0].textContent;assert.match(message,/image could not be uploaded/);
 ui.remove(one);assert.ok(f.errors.every(e=>e.textContent===message));ui.remove(two);assert.ok(f.errors.every(e=>e.textContent===''));assert.equal(f.calls.filter(c=>c.path.startsWith('/uploads/')).length,0);
});
test('removing a failed dialog item does not clear a newer cart error',async t=>{
 const ui=pinnedWidget(),f=rig(t,{widget:ui.widget}),mounted=await f.mount();await mounted.ready;f.choose.dispatchEvent(new Event('click'));await flush();
 const failed=ui.file('uploaded','unsupported');await assert.rejects(Promise.resolve(failed));for(const e of f.errors)e.textContent='The cart could not be confirmed. Please contact us before trying again.';
 ui.remove(failed);assert.ok(f.errors.every(e=>e.textContent.includes('cart could not be confirmed')));
});
test('another pending source failure cannot replace a newer cart uncertainty error',async t=>{
 const ui=pinnedWidget(),f=rig(t,{widget:ui.widget,sourceFailure:true}),mounted=await f.mount();await mounted.ready;f.choose.dispatchEvent(new Event('click'));await flush();
 const first=ui.file('url','https://fixture.example.org/first.png');await assert.rejects(Promise.resolve(first));await flush();const message='The cart could not be confirmed. Please contact us before trying again.';for(const e of f.errors)e.textContent=message;
 const second=ui.file('url','https://fixture.example.org/second.png');await assert.rejects(Promise.resolve(second));await flush();assert.ok(f.errors.every(e=>e.textContent===message));
 assert.equal(f.calls.filter(c=>c.path.endsWith('/source')).length,2);assert.equal(f.calls.filter(c=>c.path.endsWith('/remove')).length,0);assert.ok(!f.calls.some(c=>c.path==='/jobs'||c.path.includes('/graphql')));
});

for(const removalFailure of [true,'lost'])test(`completed image removal ${removalFailure==='lost'?'lost response':'rejection'} inside the dialog retains custody and displays existing removal feedback`,async t=>{
 const prior=globalThis.createImageBitmap;t.after(()=>{globalThis.createImageBitmap=prior;});globalThis.createImageBitmap=async()=>({width:1,height:1,close(){}});
 const ui=pinnedWidget(),f=rig(t,{widget:ui.widget,removalFailure});
 for(const name of ['change','input','bfl:uploads-changed'])f.form.addEventListener(name,()=>{for(const e of f.errors){e.textContent='';e.style.display='none';}});
 const mounted=await f.mount();await mounted.ready;f.choose.dispatchEvent(new Event('click'));await flush();
 const complete=ui.file('object',new File(['synthetic'],'fixture.png',{type:'image/png'}));await Promise.resolve(complete);await flush();
 assert.equal(mounted.snapshot().displayCompletedCount,1);assert.ok(f.errors.every(e=>e.textContent===''));
 ui.remove(complete);await flush();
 assert.equal(f.calls.filter(c=>c.path.endsWith('/remove')).length,1);assert.equal(f.calls.filter(c=>c.path.endsWith('/bytes')).length,1);
 const saved=JSON.parse(f.data.get(key));assert.equal(saved.state,'pending');assert.equal(saved.expires,f.expires);assert.equal(saved.token,f.record.token);assert.ok(mounted.snapshot().pending>0);
 f.choose.dispatchEvent(new Event('click'));await flush();assert.deepEqual(ui.opened(),[complete]);
 assert.ok(f.errors.every(e=>e.textContent==='The image could not be removed. Please contact us.'&&e.style.display===''));
 for(const name of ['change','input','bfl:uploads-changed']){f.form.dispatchEvent(new Event(name));await flush();assert.ok(f.errors.every(e=>e.textContent==='The image could not be removed. Please contact us.'));}
 assert.equal(f.calls.filter(c=>c.path.endsWith('/remove')).length,1);assert.ok(!f.calls.some(c=>c.path==='/jobs'||c.path.includes('/graphql')));
});

test('dialog removal failure preserves a newer cart error without any retry',async t=>{
 const ui=pinnedWidget(),f=rig(t,{widget:ui.widget,sourceFailure:true,removalFailure:true}),mounted=await f.mount();await mounted.ready;f.choose.dispatchEvent(new Event('click'));await flush();
 const failed=ui.file('url','https://fixture.example.org/first.png');await assert.rejects(Promise.resolve(failed));await flush();
 const message='The cart could not be confirmed. Please contact us before trying again.';for(const e of f.errors)e.textContent=message;
 ui.remove(failed);await flush();assert.ok(f.errors.every(e=>e.textContent===message));
 assert.equal(f.calls.filter(c=>c.path.endsWith('/source')).length,1);assert.equal(f.calls.filter(c=>c.path.endsWith('/remove')).length,1);assert.equal(JSON.parse(f.data.get(key)).state,'pending');
});

test('successful removal of another preview does not clear an unresolved dialog removal error',async t=>{
 const prior=globalThis.createImageBitmap;t.after(()=>{globalThis.createImageBitmap=prior;});globalThis.createImageBitmap=async()=>({width:1,height:1,close(){}});
 const ui=pinnedWidget(),f=rig(t,{widget:ui.widget,removalFailure:path=>path.includes('000000000001')}),mounted=await f.mount();await mounted.ready;f.choose.dispatchEvent(new Event('click'));await flush();
 const first=ui.file('object',new File(['first'],'first.png',{type:'image/png'}));await Promise.resolve(first);await flush();
 const second=ui.file('object',new File(['second'],'second.png',{type:'image/png'}));await Promise.resolve(second);await flush();
 ui.remove(first);await flush();assert.ok(f.errors.every(e=>e.textContent==='The image could not be removed. Please contact us.'));
 const buttons=f.nodes.filter(n=>n.className==='bfl-selected-preview-remove');assert.equal(buttons.length,2);buttons[1].dispatchEvent(new Event('click'));await flush();
 assert.ok(f.errors.every(e=>e.textContent==='The image could not be removed. Please contact us.'));
 f.choose.dispatchEvent(new Event('click'));await flush();assert.deepEqual(ui.opened(),[first]);assert.equal(f.calls.filter(c=>c.path.endsWith('/remove')).length,2);assert.equal(JSON.parse(f.data.get(key)).state,'pending');
});
