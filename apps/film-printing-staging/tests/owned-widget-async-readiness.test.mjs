import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createOwnedWidget} from '../theme/owned-widget.js';

const deferred=()=>{let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j;});return {promise,resolve,reject};};
function harness(t,{selectionReady,selectionFailed=()=>{},remote=false}={}){
 const events=[],observed=[];let settings;
 const wrap=promise=>({_promise:promise,then:(...args)=>promise.then(...args)});
 const Deferred=()=>{const wait=deferred();wait.promise.catch(()=>{});let state='pending';
  const api=wrap(wait.promise),df={promise:()=>api,state:()=>state,
   notify:value=>events.push(value.state),
   resolve(value){if(state==='pending'){state='resolved';events.push('resolved');wait.resolve(value);}return df;},
   reject(code,info){if(state==='pending'){state='rejected';events.push('rejected');wait.reject({code,info});}return df;}};return df;};
 const widget={version:'3.25.3',jQuery:{Deferred},plugin:fn=>fn({utils:{fixedPipe:(api,...args)=>wrap(api._promise.then(...args))}}),
  openDialog(_files,options){settings=options;return {fileColl:{onRemove:{add(){}}}};}};
 const bytes='fixture',file=new File([bytes],'fixture.png',{type:'image/png'}),proof={bytes:file.size,mime:file.type,sha256:createHash('sha256').update(bytes).digest('hex')};
 const selection={key:'owned-file',file:proof,completion:Promise.resolve({state:'complete',asset_id:'asset',file:proof})};
 const prior=globalThis.createImageBitmap;globalThis.createImageBitmap=async()=>({width:2,height:2,close(){}});t.after(()=>{globalThis.createImageBitmap=prior;});
 const flow={select:()=>[selection],selectSource:()=>selection,original:async()=>({url:'https://example.test/private'}),remove:async()=>{},crop:async()=>{},selectionReady,selectionFailed};
 const uploader=createOwnedWidget(widget,flow,{publicKey:'12345678901234567890',observe:event=>observed.push(event),
  fetchImpl:async()=>({ok:true,redirected:false,blob:async()=>new Blob([bytes],{type:'image/png'})}),
  urls:{createObjectURL:()=> 'blob:verified',revokeObjectURL(){}}});t.after(()=>uploader.dispose());
 uploader.open();
 return {events,observed,uploader,selection,file,start:()=>settings.bflOwnedFileFactory('object',file)};
}

test('widget stays pending until asynchronous owned selection checkpoint succeeds',async t=>{
 const checkpoint=deferred(),entered=deferred();
 const h=harness(t,{selectionReady:key=>{assert.equal(key,'owned-file');entered.resolve();return checkpoint.promise;}});
 const file=h.start(),resolved=Promise.resolve(file);await entered.promise;
 assert.deepEqual(h.events,['uploading']);
 checkpoint.resolve();const info=await resolved;assert.equal(info.uuid,'asset');assert.deepEqual(h.events,['uploading','ready','resolved']);
});

test('rejected async owned checkpoint rejects widget and consumes failed-status rejection',async t=>{
 const checkpoint=deferred(),entered=deferred(),failed=deferred();let failures=0;
 const h=harness(t,{selectionReady:()=>{entered.resolve();return checkpoint.promise;},selectionFailed:key=>{
  assert.equal(key,'owned-file');failures++;failed.resolve();return Promise.reject(Error('stale owner cannot checkpoint'));}});
 const file=h.start(),result=Promise.resolve(file);result.catch(()=>{});await entered.promise;checkpoint.reject(Error('RESOURCE_SUPERSEDED'));
 await assert.rejects(result,error=>error.code==='upload'&&error.info.isStored===false);await failed.promise;await new Promise(setImmediate);
 assert.equal(failures,1);assert.deepEqual(h.events,['uploading','rejected']);assert.equal(h.observed.at(-1).phase,'selection-ready');
});

test('restored widget readiness awaits the same asynchronous owned checkpoint',async t=>{
 const checkpoint=deferred(),entered=deferred();let finished=false;
 const h=harness(t,{selectionReady:()=>{entered.resolve();return checkpoint.promise;}});
 const restoring=h.uploader.restore([h.selection]).then(()=>{finished=true;});await entered.promise;
 assert.equal(finished,false);assert.deepEqual(h.events,['uploading']);checkpoint.resolve();await restoring;
 assert.equal(finished,true);assert.deepEqual(h.events,['uploading','ready','resolved']);
});

test('synchronous legacy owned checkpoint still resolves once after completion',async t=>{
 let checkpoints=0;const h=harness(t,{selectionReady:()=>{checkpoints++;}});await Promise.resolve(h.start());
 assert.equal(checkpoints,1);assert.deepEqual(h.events,['uploading','ready','resolved']);
});
