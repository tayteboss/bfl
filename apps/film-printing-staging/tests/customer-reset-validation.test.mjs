import test from 'node:test';
import assert from 'node:assert/strict';
import '../theme/film-printing-job.js';

test('empty prepared Add and validation refresh preserve the original reload checkpoint',async()=>{
  const form=new EventTarget();form.dataset={filmPrintingForm:''};form.querySelectorAll=()=>[];form.querySelector=()=>null;form.bflSelectionComplete=()=>false;
  let refreshes=0,prepares=0,writes=0;
  const state={pending:0,failed:0,displayCompletedCount:0,completedAssetIds:[]};
  const flow=BFLPrintJob.mount(form,{uploadAdapter:{snapshot:()=>state,refresh:async()=>{refreshes++;}},protocol:{mode:'prepared-unit-v3',prepare:async()=>{prepares++;},cancelPreparation(){},addPrepared(){writes++;}}});
  await flow.refresh();assert.equal(await flow.submit(),null);
  assert.equal(refreshes,0);assert.equal(prepares,0);assert.equal(writes,0);assert.equal(flow.canRetry(),true);assert.equal(flow.reset(),false);
});

test('expired completed proofs still refresh; empty validation does not suppress recovery',async()=>{
  const form=new EventTarget();form.dataset={filmPrintingForm:''};form.querySelectorAll=()=>[];form.querySelector=()=>null;
  let refreshes=0;
  const flow=BFLPrintJob.mount(form,{uploadAdapter:{snapshot:()=>({pending:1,failed:0,displayCompletedCount:1,completedAssetIds:[]}),refresh:async()=>{refreshes++;}},protocol:{mode:'prepared-unit-v3',prepare(){},cancelPreparation(){},addPrepared(){}}});
  await flow.refresh();assert.equal(refreshes,1);
});
