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
function rig(t,{kind='empty',fault,rejected=false}={}){
 const prior={location:globalThis.location,document:globalThis.document};t.after(()=>Object.assign(globalThis,prior));
 globalThis.location={origin,hostname:new URL(origin).hostname};
 const errors=[{textContent:'',style:{}},{textContent:'',style:{}}],choose=Object.assign(new EventTarget(),{disabled:false});
 const form=Object.assign(new EventTarget(),{dataset:{filmPrintingForm:''},append(){},bflSelectionComplete:()=>false,
  querySelector:s=>s==='[data-uploadly-fallback-button]'?choose:null,querySelectorAll:s=>s.includes('data-film-service-error')?errors:[]});
 globalThis.document={createElement:()=>Object.assign(new EventTarget(),{click(){}}),querySelector:()=>({refreshOwnedCart:async()=>{}}),querySelectorAll:()=>errors};
 const expires=Date.now()+86400000,record={state:'pending',operation:null,token:'bflr1_'+'a'.repeat(43),expires,generation:1,prepared_generation:26,client_policy:POLICY,cart_revision:3};
 const data=new Map([[key,JSON.stringify(record)]]),storage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};
 let tail=Promise.resolve();const locks={request(_key,_options,work){const p=tail.catch(()=>{}).then(work);tail=p;return p;}},events=new EventTarget(),calls=[];
 const props=kind==='print'?{_bfl_flow:'f05',_bfl_job:'kept-job',_bfl_revision:'1',_bfl_config:'config',_bfl_signature:'v3:'+'a'.repeat(64)+':1',Service:'photo',Sizes:'4x6',Location:'miami','Files Uploaded':'1'}:{};
 const items=kind==='empty'?[]:[{id:'native-line',variant_id:kind==='print'?'67852705202287':'123',quantity:1,properties:props,subtotal_cents:40}];
 const native=()=>({id:cartId,totalQuantity:items.length,lines:items.map(i=>({id:i.id,quantity:i.quantity,cost:{totalAmount:money(i.subtotal_cents)}})),cost:{totalAmount:money(items.length*40)}});
 const actions={getCart:async()=>({cart:native()})};
 const fetchImpl=async(url,options={})=>{
  const path=new URL(url,origin).pathname,input=options.body?JSON.parse(options.body):null;calls.push({path,input});let value;
  if(path==='/resource-proof/challenge')value={challenge:'p'.repeat(43),verifier:'p'.repeat(43),purpose:'bfl:resource-fresh-proof:v1',audience:origin+'/bfl-application-resources',action:input.action,expires_in:30};
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
 return {form,choose,errors,expires,record,data,storage,locks,events,calls,actions,fetchImpl,
  async mount(){const mounted=await mountPersistentCustomer({form,widget:null,storage,locks,events,actions,fetchImpl,sessionOptions:{fetchImpl},reload:()=>assert.fail('No reload loop')});t.after(()=>{mounted.dispose();globalThis.BFLPrintJob.forForm(form).invalidateSharedCart();});return mounted;},
  async checkout(){const c=await createPersistentCartCoordinator({cartId,storage,locks,events,cryptoImpl:webcrypto});t.after(()=>c.dispose());const session=createResourceSession({reloadStorage:c.storage,reloadKey:key,preparedMode:true,clientPolicy:POLICY,fetchImpl}),flow=createPreparedCheckout(session,{actions,fetchImpl});await c.run(async()=>{const recovery=session.restore();await flow.initialize({recovery});});return {c,session,flow};}};
}
for(const kind of ['empty','ordinary','print'])test(`full persistent form readiness recovers known ${kind} cart under original custody`,async t=>{
 const f=rig(t,{kind}),mounted=await f.mount();const result=await mounted.ready;
 assert.equal(f.choose.disabled,false);assert.deepEqual(result.selections,[]);assert.equal(result.expires_at,f.expires);assert.equal(result.cart.items.length,kind==='empty'?0:1);
 const saved=JSON.parse(f.data.get(key));assert.equal(saved.state,kind==='print'?'accepted':'initialized');assert.equal(saved.operation,null);assert.equal(saved.token,f.record.token);assert.equal(saved.expires,f.expires);assert.equal(saved.prepared_generation,26);assert.equal(f.calls.filter(c=>c.path==='/checkout/resume').length,1);
});
for(const [name,fault] of [['extended expiry',r=>r.expires_at+=1000],['expired',r=>r.expires_at=Date.now()-1],['reservation',r=>r.reservation={}],['acknowledgement',r=>r.resumed=false],['kind',r=>r.recovery='unexpected'],['cart',r=>r.items.push({id:'foreign'})]])test(`known-current ${name} mismatch leaves original pending custody`,async t=>{
 const f=rig(t,{fault}),mounted=await f.mount();await assert.rejects(mounted.ready);const saved=JSON.parse(f.data.get(key));assert.equal(saved.state,'pending');assert.equal(saved.operation,null);assert.equal(saved.expires,f.expires);assert.equal(f.choose.disabled,true);assert.ok(f.errors.every(e=>e.textContent));
});
test('full persistent initialization rejection remains visible after option changes clear the error slots',async t=>{
 const f=rig(t,{rejected:true}),mounted=await f.mount();await assert.rejects(mounted.ready);await flush();const message=f.errors[0].textContent;assert.ok(message);assert.equal(message.includes('PREPARED_UNCERTAIN'),false);
 for(const error of f.errors){error.textContent='';error.style.display='none';}f.choose.disabled=false;f.form.dispatchEvent(new Event('change'));await flush();assert.equal(f.choose.disabled,true);assert.ok(f.errors.every(e=>e.textContent===message&&e.style.display===''));
});
for(const kind of ['empty','print'])test(`last-upload completion checkpoints verified ${kind} cart without a mutation`,async t=>{
 const f=rig(t,{kind}),{c,session,flow}=await f.checkout();await c.run(async()=>{session.clearUploadSelection();session.suspend();await flow.completeUploadRemoval();});
 const saved=JSON.parse(f.data.get(key));assert.equal(saved.state,kind==='print'?'accepted':'initialized');assert.equal(saved.expires,f.expires);assert.equal(f.calls.filter(c=>c.path==='/checkout/resume').length,2);
});
for(const failRemoval of [false,true])test(`actual form last-file removal ${failRemoval?'retains pending custody on failure':'checkpoints empty before reload'}`,async t=>{
 const f=rig(t),c=await createPersistentCartCoordinator({cartId,storage:f.storage,locks:f.locks,events:f.events,cryptoImpl:webcrypto});t.after(()=>c.dispose());
 const intent='00000000-0000-4000-8000-000000000001',asset='10000000-0000-4000-8000-000000000001',requests=[];let version=0;
 const fetchImpl=async(url,options)=>{
  const path=new URL(url,origin).pathname;if(!path.startsWith('/uploads/'))return f.fetchImpl(url,options);requests.push(path);
  if(path.endsWith('/remove')&&failRemoval)return Response.json({code:'UPLOAD_PROVIDER_UNAVAILABLE'},{status:422});
  const state=path.endsWith('/remove')?'removed':path.endsWith('/intents')?'issued':'complete';
  return Response.json({schema:1,intent_id:intent,state,version:++version,asset_id:state==='complete'?asset:null,expires_at:f.expires,checkout_ready:false});
 };
 const flow=createFilmPrintingForm(f.form,{operation:c.run,sessionOptions:{clientPolicy:POLICY,preparedMode:true,reloadStorage:c.storage,reloadKey:c.key,fetchImpl,assertInitial:c.assertInitial,assertCurrent:c.assertCurrent},checkoutForSession:s=>createPreparedCheckout(s,{actions:f.actions,fetchImpl})});
 t.after(()=>globalThis.BFLPrintJob.forForm(f.form).invalidateSharedCart());await flow.issue();const widget=c.widgetFlow(flow),selected=widget.select([new File(['synthetic'],'fixture.png',{type:'image/png'})])[0];await selected.completion;await widget.selectionReady(selected.key);
 assert.equal(JSON.parse(f.data.get(key)).state,'uploads');
 if(failRemoval){await assert.rejects(widget.remove(selected.key));assert.equal(JSON.parse(f.data.get(key)).state,'pending');assert.equal(f.calls.filter(c=>c.path==='/checkout/resume').length,1);}
 else {await widget.remove(selected.key);await flush();const saved=JSON.parse(f.data.get(key));assert.equal(saved.state,'initialized');assert.equal(saved.operation,null);assert.equal(saved.selection,undefined);assert.equal(saved.expires,f.expires);assert.equal(flow.snapshot().pending,0);assert.equal(flow.snapshot().completedAssetIds.length,0);assert.equal(f.calls.filter(c=>c.path==='/checkout/resume').length,2);}
 assert.equal(requests.filter(p=>p.endsWith('/bytes')).length,1);assert.equal(requests.filter(p=>p.endsWith('/remove')).length,1);
});
