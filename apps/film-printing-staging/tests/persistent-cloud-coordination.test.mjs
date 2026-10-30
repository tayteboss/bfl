// Real frontend modules with a deterministic synthetic HTTP boundary. No provider or native browser acceptance is claimed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {createPersistentCartCoordinator,PERSISTENT_CLIENT_POLICY as POLICY} from '../theme/persistent-cart.js';
import {createFilmPrintingForm} from '../theme/film-printing-form.js';

const origin='https://bellows-film-printing-staging.myshopify.com',cart='gid://shopify/Cart/synthetic?key=synthetic';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {resolve,promise};};
const flush=async()=>{for(let i=0;i<5;i++)await new Promise(setImmediate);};
class Form extends EventTarget{
 dataset={filmPrintingForm:''};
 bflSelectionComplete=()=>true;
 querySelector(selector){
  const values={'[name="quantity"]':'1','[name="service"]:checked':'Photo Prints','[name="location"]:checked':'Miami','[name="properties[Message]"]':''};
  return selector in values?{value:values[selector],closest:()=>({style:{display:''}})}:null;
 }
 querySelectorAll(selector){return selector.includes('data-group="Sizes"')?[{value:'4 × 6',closest:()=>({style:{display:''}})}]:[];}
}
async function rig(t){
 const old=globalThis.location;globalThis.location={origin,hostname:new URL(origin).hostname};t.after(()=>globalThis.location=old);
 const data=new Map(),storage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};
 let queue=Promise.resolve();const locks={request(_name,_options,work){const p=queue.catch(()=>{}).then(work);queue=p;return p;}};
 const coordinator=await createPersistentCartCoordinator({cartId:cart,storage,locks,events:new EventTarget(),cryptoImpl:webcrypto});t.after(()=>coordinator.dispose());
 const clock=Date.now(),expiry=clock+86400000,opaque='p'.repeat(43),token='bflr1_'+'a'.repeat(43);
 const intentEntered=deferred(),intentRelease=deferred(),cancelEntered=deferred(),cancelRelease=deferred(),prepared=deferred(),cancelled=deferred();
 const calls=[],receipts=new Map(),jobs=[],adds=[];let count=0;
 const receipt=(id,state,version=1)=>({schema:1,intent_id:id,state,version,expires_at:expiry,checkout_ready:false,asset_id:state==='complete'?`10000000-0000-4000-8000-${id.slice(-12)}`:null});
 const fetchImpl=async(url,init={})=>{
  const path=new URL(url,origin).pathname,body=init.body?JSON.parse(init.body):null;calls.push(path);let value;
  if(path==='/resource-proof/challenge')value={challenge:opaque,verifier:opaque,purpose:'bfl:resource-fresh-proof:v1',audience:origin+'/bfl-application-resources',action:body.action,expires_in:30};
  else if(path==='/apps/bfl-staging/resource-proof')value={ticket:opaque};
  else if(path==='/resource-proof/exchange')value={proof:opaque,expires_in:30};
  else if(path==='/resource-sessions/issue')value={token,resource_only:true,cart_verified:false,checkout_ready:false,generation:1,expires_in:86400,expires_at:expiry,client_policy:POLICY};
  else if(path==='/uploads/intents'){
   const id=`00000000-0000-4000-8000-${String(++count).padStart(12,'0')}`;value=receipt(id,'issued');receipts.set(id,value);
   if(count===2){intentEntered.resolve();await intentRelease.promise;}
  }else if(path.endsWith('/source')){const id=path.split('/')[2];value=receipt(id,'complete',2);receipts.set(id,value);}
  else if(path.endsWith('/remove')){const id=path.split('/')[2];value=receipt(id,'removed',receipts.get(id).version+1);receipts.set(id,value);}
  else if(path.endsWith('/status')){const id=path.split('/')[2];value={...receipts.get(id),version:receipts.get(id).version+1};receipts.set(id,value);}
  else if(path==='/checkout/cancel_preparation'){cancelEntered.resolve();await cancelRelease.promise;value={cancelled:true,cart_verified:false,checkout_ready:false};}
  else throw Error('Unexpected synthetic path '+path);
  return Response.json(value);
 };
 const form=new Form();let session;
 const flow=createFilmPrintingForm(form,{operation:coordinator.run,sessionOptions:{clientPolicy:POLICY,preparedMode:true,reloadStorage:coordinator.storage,reloadKey:coordinator.key,fetchImpl,verifyNewCart:async()=>cart,assertInitial:coordinator.assertInitial,assertCurrent:coordinator.assertCurrent},checkoutForSession:s=>{
  session=s;return {mode:'prepared-unit-v3',initialize:async()=>{s.checkpoint('initialized');return {upload_recovery:'uncommitted-v1'};},
   prepare:async input=>{jobs.push(input);const operation={kind:'prepared',operation_id:'synthetic-prepared',job:'synthetic-job',generation:input.generation};s.rememberPreparationGeneration(input.generation);s.checkpoint('prepared',operation);prepared.resolve();return {prepared:true,generation:input.generation,checkout_ready:false,expires_at:expiry,unit_price_cents:input.asset_ids.length*40,file_count:input.asset_ids.length,reservation:{operation_id:operation.operation_id}};},
   cancelPreparation:async input=>{s.beginMutation({kind:'cancel_preparation',operation_id:input.reservation.operation_id,job:'synthetic-job',generation:input.generation});await s.checkout('cancel_preparation',async()=>cart,{reservation:input.reservation});s.checkpoint('initialized');cancelled.resolve();},
   addPrepared:async input=>{adds.push(input);s.checkpoint('accepted');return {accepted:true,total:input.prepared.unit_price_cents*input.quantity};}};
 }});
 t.after(()=>globalThis.BFLPrintJob.forForm(form).invalidateSharedCart());
 await flow.issue();const widget=coordinator.widgetFlow(flow);
 const first=widget.selectSource('https://fixture.example.org/drive.png');await first.completion;await widget.selectionReady(first.key);await prepared.promise;await flush();
 assert.equal(JSON.parse(coordinator.storage.getItem(coordinator.key)).state,'prepared');
 return {widget,flow,session,coordinator,calls,receipts,jobs,adds,intentEntered,intentRelease,cancelEntered,cancelRelease,cancelled,expiry};
}
test('second cloud source finishes before prepared-order cancellation, then both files add once',async t=>{
 const f=await rig(t),second=f.widget.selectSource('https://fixture.example.org/dropbox.png');
 await f.intentEntered.promise;await new Promise(r=>setTimeout(r,300));
 assert.equal(f.calls.filter(path=>path==='/checkout/cancel_preparation').length,0);
 f.intentRelease.resolve();await second.completion;await f.cancelEntered.promise;f.cancelRelease.resolve();await f.cancelled.promise;await f.widget.selectionReady(second.key);
 assert.equal(f.calls.filter(path=>path==='/uploads/intents').length,2);
 assert.equal(f.calls.filter(path=>path.endsWith('/source')).length,2);
 assert.equal(f.flow.snapshot().pending,0);assert.equal(f.flow.snapshot().failed,0);assert.equal(f.flow.snapshot().completedAssetIds.length,2);
 const result=await f.flow.submit();assert.equal(result.accepted,true);assert.equal(result.total,80);assert.equal(f.adds.length,1);assert.equal(f.jobs.at(-1).asset_ids.length,2);
 assert.equal(JSON.parse(f.coordinator.storage.getItem(f.coordinator.key)).expires,f.expiry);
});

test('removal overlapping a cloud transfer waits, removes once, and permits the next selection',async t=>{
 const f=await rig(t),second=f.widget.selectSource('https://fixture.example.org/dropbox.png');
 await f.intentEntered.promise;const removing=f.widget.remove(second.key);await new Promise(r=>setTimeout(r,300));
 assert.equal(f.calls.filter(path=>path.endsWith('/remove')).length,0);assert.equal(f.calls.filter(path=>path==='/checkout/cancel_preparation').length,0);
 f.intentRelease.resolve();await second.completion;await f.cancelEntered.promise;f.cancelRelease.resolve();await removing;
 assert.equal(f.calls.filter(path=>path.endsWith('/source')).length,2);assert.equal(f.calls.filter(path=>path.endsWith('/remove')).length,1);assert.equal([...f.receipts.values()][1].state,'removed');
 const third=f.widget.selectSource('https://fixture.example.org/next.png');await third.completion;await f.widget.selectionReady(third.key);
 assert.equal(f.calls.filter(path=>path.endsWith('/source')).length,3);assert.equal(f.flow.snapshot().pending,0);assert.equal(f.flow.snapshot().failed,0);assert.equal(f.flow.snapshot().completedAssetIds.length,2);assert.equal(f.adds.length,0);
 assert.equal(JSON.parse(f.coordinator.storage.getItem(f.coordinator.key)).expires,f.expiry);
});
