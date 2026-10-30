import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import '../theme/film-printing-job.js';
import {createJobStore,createJobService} from '../jobs/service.mjs';
import {extendProductCatalog} from '../pricing/product-catalog.mjs';
import {active} from '../../../fixtures/film-printing/f04/synthetic.mjs';

const read=path=>readFileSync(new URL('../../../fixtures/film-printing/f05a/'+path,import.meta.url),'utf8');
const source=JSON.parse(read('proposed/price-catalog.proposed.json'));
const expanded=extendProductCatalog(source,read('metafield-value.json'));
const catalog={...expanded.catalog,version:expanded.version};
const standard='Standard (4-5 days)',border='Borderless (Edge-to-edge)';
const dark={service:'Darkroom Prints',size:'8” × 10”',paper:'RC Matte',lab:'Miami',copies:2,asset_ids:[],
  options:{Process:'Color',Borders:border,Turnaround:standard,'Scanning Options':'Yes',Negatives:'Mail In'},message:'Frame 7'};

function formRig(){
  let values={'[name="service"]:checked':'Darkroom Prints','[name="location"]:checked':'Miami','[name="quantity"]':'2',
    '[name="properties[Turnaround]"]:checked':standard,'[name="delivery"]:checked':'Mail In','[name="properties[Message]"]':'Frame 7'};
  let groups={Sizes:'8” × 10”',Paper:'RC Matte',Process:'Color',Borders:border,'Scanning Options':'Yes'};
  const form={querySelector:s=>Object.hasOwn(values,s)?{value:values[s]}:null,
    querySelectorAll:s=>{const group=/data-group="([^"]+)"/.exec(s)?.[1];return groups[group]?[{value:groups[group],disabled:false,closest:()=>({style:{display:''}})}]:[];}};
  return {values,groups,form};
}

test('Darkroom selection has no files, ignores hidden stale scan values, and requires negatives',()=>{
  const rig=formRig(),adapter={snapshot:()=>({pending:4,failed:1,completedAssetIds:['prior-digital-asset']})};
  const first=globalThis.BFLPrintJob.readSelection(rig.form,adapter);assert.deepEqual(first,dark);
  rig.groups.Sizes='16” × 20”';
  assert.equal(globalThis.BFLPrintJob.readSelection(rig.form,adapter).options['Scanning Options'],undefined);
  delete rig.values['[name="delivery"]:checked'];assert.throws(()=>globalThis.BFLPrintJob.readSelection(rig.form,adapter));
  rig.values['[name="service"]:checked']='Photo Prints';assert.throws(()=>globalThis.BFLPrintJob.readSelection(rig.form,adapter));
});

test('Custom reader preserves orientation and mode, clears dimensions from fixed selections',()=>{
  const rig=formRig();rig.values['[name="service"]:checked']='Fine Arts';rig.groups.Sizes='Custom';rig.groups.Paper='Fibre Paper';
  rig.values['[data-custom-size-input="width"]']='16';rig.values['[data-custom-size-input="height"]']='20';
  const adapter={snapshot:()=>({pending:0,failed:0,completedAssetIds:['digital-asset-1']})};
  const selected=globalThis.BFLPrintJob.readSelection(rig.form,adapter);
  assert.equal(selected.size_mode,'custom');assert.deepEqual(selected.custom_dimensions,{width:16,height:20});
  assert.equal(selected.options.Process,undefined);assert.equal(selected.options.Negatives,undefined);
  rig.values['[data-custom-size-input="width"]']='45';assert.throws(()=>globalThis.BFLPrintJob.readSelection(rig.form,adapter));
  rig.groups.Sizes='16” × 20”';const fixed=globalThis.BFLPrintJob.readSelection(rig.form,adapter);
  assert.equal(fixed.custom_dimensions,undefined);assert.equal(fixed.size_mode,undefined);
});

test('owned immutable Darkroom jobs price without fabricated uploads; digital jobs still require them',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'bfl-product-'));const store=createJobStore(join(dir,'jobs.sqlite'));
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  let validated=0;
  const jobs=createJobService({store,loader:{load:async()=>active},loadCatalog:async()=>catalog,secret:'test-only-full-product-32-character-secret',
    validateUploads:async()=>{validated++;}});
  const result=await jobs.prepare('owner-a',{...dark,request_key:'darkroom-request-1'});
  assert.equal(result.file_count,0);assert.equal(result.unit_price_cents,4800);assert.equal(result.item.quantity,2);
  assert.equal(result.item.properties['Files Uploaded'],'0');assert.equal(result.item.properties.Process,'Color');
  assert.equal(result.item.properties['Scanning Options'],'Yes');assert.equal(result.item.properties.Negatives,'Mail In');
  const job=await jobs.resolve('owner-a',result.reference);assert.equal(job.billing_basis,'specification');assert.deepEqual(job.files,[]);
  assert.equal(validated,0);await assert.rejects(jobs.resolve('owner-b',result.reference),/JOB_UNAVAILABLE/);
  await assert.rejects(jobs.prepare('owner-a',{...dark,asset_ids:['invented-file'],request_key:'darkroom-request-2'}),/INVALID_COMPLETED_ASSETS/);
  await assert.rejects(jobs.prepare('owner-a',{...dark,service:'Photo Prints',size:'4” × 6”',paper:null,options:{Turnaround:standard},request_key:'photo-request-1'}),/INVALID_COMPLETED_ASSETS/);
  store.revoke({id:'revoke-darkroom-owner',kind:'owner',owner:'owner-a'});
  await assert.rejects(jobs.resolve('owner-a',result.reference),/OWNER_REVOKED/);
});

test('Custom and fixed jobs with identical dimensions have distinct source prices and immutable fingerprints',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'bfl-custom-'));const store=createJobStore(join(dir,'jobs.sqlite'));
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  store.recordUpload('owner-a',{id:'digital-asset-1',state:'complete',verified:true,url:'https://fixture.invalid/photo.jpg'});
  const jobs=createJobService({store,loader:{load:async()=>active},loadCatalog:async()=>catalog,secret:'test-only-full-product-32-character-secret'});
  const input={service:'Fine Arts',size:'Custom',size_mode:'custom',custom_dimensions:{width:16,height:20},paper:'Fibre Paper',lab:'Miami',copies:1,
    asset_ids:['digital-asset-1'],options:{Borders:border,Turnaround:standard},message:'Keep centred',request_key:'custom-request-1'};
  const custom=await jobs.prepare('owner-a',input);assert.equal(custom.unit_price_cents,2600);
  const fixed=await jobs.prepare('owner-a',{...input,size:'16” × 20”',size_mode:'fixed',custom_dimensions:null,request_key:'fixed-request-1'});
  assert.equal(fixed.unit_price_cents,3000);assert.notEqual(custom.reference.revision,fixed.reference.revision);
  await assert.rejects(jobs.prepare('owner-a',{...input,custom_dimensions:{width:20,height:16}}),/IDEMPOTENCY_CONFLICT/);
});
