import test from 'node:test';
import assert from 'node:assert/strict';
import '../theme/film-printing-job.js';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function rig(overrides={}){
 let input={service:'Photo Prints',size:'4x6',paper:null,lab:'Miami',copies:2,asset_ids:['11111111-2222-4333-8444-555555555555'],options:{},message:''};
 const sequence=[],preparations=[],adds=[],cancels=[];
 const receipt=v=>({prepared:true,generation:v.generation,checkout_ready:false,cart_verified:false,expires_at:Date.now()+60000,reservation:{operation_id:`operation-${v.request_key}`},reference:{id:v.request_key}});
 const protocol={read:()=>structuredClone(input),id:()=>`request-${preparations.length+1}`,
  prepare:async v=>{preparations.push(v);sequence.push(`prepare:${v.request_key}`);return receipt(v);},
  cancelPreparation:async v=>{cancels.push(v);sequence.push(`cancel:${v.reference.id}`);return {cancelled:true,revoked:true};},
  addPrepared:async v=>{v.assertSelection();v.onWriteStarted();adds.push(v);sequence.push(`add:${v.prepared.reference.id}`);return {accepted:true,cart:{items:[]}};},...overrides};
 const controller=globalThis.BFLPrintJob.createPreparedController(protocol);
 return {controller,receipt,preparations,adds,cancels,sequence,edit:v=>{input={...input,...v};controller.selectionChanged();}};
}
test('early Add joins pending preparation, retains click boundary, and writes once',async()=>{
 const gate=deferred();let count=0;const r=rig({prepare:async i=>{count++;await gate.promise;return r.receipt(i);}});
 const background=r.controller.prepare(),a=r.controller.submit(),b=r.controller.submit();assert.equal(a,b);let completed=false;a.then(()=>{completed=true;});
 await Promise.resolve();assert.equal(completed,false);assert.equal(r.adds.length,0);assert.equal(count,1);gate.resolve();await background;assert.equal((await a).accepted,true);
 await r.controller.submit();assert.equal(r.adds.length,1);assert.equal(count,1);
});
test('copies-only edits reuse immutable preparation',async()=>{const r=rig();await r.controller.prepare();r.edit({copies:5});await r.controller.prepare();await r.controller.submit();assert.equal(r.preparations.length,1);assert.equal(r.cancels.length,0);assert.equal(r.adds[0].quantity,5);});
test('rapid changes cancel stale preparation before preparing latest content',async()=>{
 const gate=deferred();let count=0;const r=rig({id:()=>`request-${count+1}`,prepare:async i=>{count++;r.preparations.push(i);r.sequence.push(`prepare:${i.request_key}`);if(count===1)await gate.promise;return r.receipt(i);}});
 const background=r.controller.prepare();r.edit({message:'first'});r.edit({message:'latest'});const submission=r.controller.submit();gate.resolve();await background;await submission;
 assert.equal(count,2);assert.equal(r.preparations[1].message,'latest');assert.deepEqual(r.sequence,['prepare:request-1','cancel:request-1','prepare:request-2','add:request-2']);
});
test('selection changes during native pre-read reject before spending Add',async()=>{
 const r=rig({addPrepared:async v=>{r.edit({copies:9});v.assertSelection();v.onWriteStarted();throw Error('unreachable');}});await r.controller.prepare();await assert.rejects(r.controller.submit());assert.equal(r.controller.canRetry(),true);assert.equal(r.controller.reset(),false);
});
test('unknown preparation never allocates another request key',async()=>{
 let count=0;const r=rig({prepare:async()=>{count++;throw Error('lost response');}});await assert.rejects(r.controller.prepare());r.edit({message:'changed'});await assert.rejects(r.controller.prepare());await assert.rejects(r.controller.submit());assert.equal(count,1);assert.equal(r.controller.canRetry(),false);
});
test('unknown native Add blocks automatic replay and reset',async()=>{
 let writes=0;const r=rig({addPrepared:async v=>{v.assertSelection();v.onWriteStarted();writes++;throw Error('lost response');}});await assert.rejects(r.controller.submit());await assert.rejects(r.controller.submit());r.edit({message:'changed'});await assert.rejects(r.controller.submit());assert.equal(writes,1);assert.equal(r.controller.canRetry(),false);assert.equal(r.controller.reset(),false);
});
test('accepted reset retains submitted grant and begins distinct next job',async()=>{
 const r=rig();await r.controller.submit();assert.equal(r.controller.reset(),true);r.edit({message:'second'});await r.controller.submit();assert.equal(r.preparations.length,2);assert.equal(r.adds.length,2);assert.equal(r.cancels.length,0);assert.notEqual(r.adds[0].prepared.reference.id,r.adds[1].prepared.reference.id);
});
test('two resource removals wait for preparation, one cancellation, and serialized server removal',async()=>{
 const preparation=deferred(),cancellation=deferred(),removed=deferred(),events=[];
 const r=rig({prepare:async input=>{events.push('prepare');await preparation.promise;return r.receipt(input);},cancelPreparation:async()=>{events.push('cancel');await cancellation.promise;events.push('cancelled');return {cancelled:true,revoked:true};}});
 const background=r.controller.prepare();
 const first=r.controller.beforeResourceChange(async()=>{events.push('remove-1');await removed.promise;events.push('removed-1');});
 const second=r.controller.beforeResourceChange(async()=>{events.push('remove-2');});
 await assert.rejects(r.controller.submit());assert.deepEqual(events,['prepare']);
 preparation.resolve();await background;await new Promise(setImmediate);assert.deepEqual(events,['prepare','cancel']);
 cancellation.resolve();await new Promise(setImmediate);assert.deepEqual(events,['prepare','cancel','cancelled','remove-1']);
 await assert.rejects(r.controller.prepare());assert.equal(r.adds.length,0);
 removed.resolve();await Promise.all([first,second]);assert.deepEqual(events,['prepare','cancel','cancelled','remove-1','removed-1','remove-2']);
});
test('unknown preparation prevents resource mutation and cancellation of an unproven receipt',async()=>{
 const gate=deferred();let removed=0,cancelled=0;
 const r=rig({prepare:async()=>{await gate.promise;throw Error('unknown eligibility');},cancelPreparation:async()=>{cancelled++;}});
 const background=r.controller.prepare(),backgroundRejected=assert.rejects(background);
 const changing=r.controller.beforeResourceChange(async()=>{removed++;}),changeRejected=assert.rejects(changing);
 gate.resolve();await Promise.all([backgroundRejected,changeRejected]);assert.equal(removed,0);assert.equal(cancelled,0);assert.equal(r.controller.canRetry(),false);
});
