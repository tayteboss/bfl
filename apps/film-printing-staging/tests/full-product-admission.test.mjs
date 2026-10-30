import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareEngineeringSources,createEngineeringScope,bindEngineeringCustomerJob} from '../configuration/engineering.mjs';
import {decodeCatalog} from '../checkout/shopify.mjs';
import {createJobStore,createJobService} from '../jobs/service.mjs';
import {jobEligibility,jobClaims} from '../checkout/job-eligibility.mjs';
import {preparedPolicy} from '../checkout/prepared-limits.mjs';
import {mockAdmin} from '../../../fixtures/film-printing/f06d/mock-admin.mjs';

// Local database and synthetic uploads; actual reviewed source/route identities.
test('admitted compact four-lab source saves and resolves fixed, Custom and no-upload Darkroom jobs',async t=>{
 const fixture=name=>JSON.parse(readFileSync(new URL('../../../fixtures/film-printing/full-product-readiness-20261030/'+name,import.meta.url)));
 let now=1000;
 const prepared=prepareEngineeringSources({config:fixture('engineering-config-proposal.json'),catalog:fixture('engineering-catalog-proposal.json'),issuedAt:now,until:3601000});
 const sourceScope=createEngineeringScope({...prepared,identity:mockAdmin().data,now:()=>now});
 assert.equal(preparedPolicy(sourceScope).preparations,64);
 const release=JSON.parse(prepared.releaseValue),catalog=decodeCatalog(prepared.catalogValue);
 const dir=mkdtempSync(join(tmpdir(),'bfl-admitted-')),store=createJobStore(join(dir,'jobs.sqlite'));
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 store.recordUpload('test-owner',{id:'synthetic-asset-1',state:'complete',verified:true,url:'https://fixture.invalid/nonpersonal.png'});
 const jobs=createJobService({store,loader:{load:async()=>release},loadCatalog:async()=>catalog,secret:'local-only-product-admission-test-secret',sourceScope,
  beforeSave:(owner,input,job)=>bindEngineeringCustomerJob(sourceScope,owner,input.asset_ids,input.copies,job,64)});
 const standard='Standard (4-5 days)',border='Borderless (Edge-to-edge)';
 const cases=[
  ...['Miami','Chicago','Orlando','Atlanta'].map(lab=>({service:'Fine Arts',size:'16” × 20”',paper:'Luster',lab,options:{Borders:border,Turnaround:standard},expected:2500,shipping:true})),
  {service:'Fine Arts',size:'Custom',size_mode:'custom',custom_dimensions:{width:16,height:20},paper:'Fibre Paper',lab:'Chicago',options:{Borders:border,Turnaround:standard},expected:2600,shipping:true},
  ...['Miami','Chicago','Atlanta'].map(lab=>({service:'Darkroom Prints',size:'8” × 10”',paper:'RC Matte',lab,options:{Process:'Color',Borders:border,Turnaround:standard,'Scanning Options':'Yes',Negatives:'Mail In'},expected:4800,shipping:true})),
 ];
 for(const [i,{expected,shipping,...selection}] of cases.entries()){
  const result=await jobs.prepare('test-owner',{...selection,asset_ids:selection.service==='Darkroom Prints'?[]:['synthetic-asset-1'],copies:2,message:'Client fixture '+i,request_key:'full-admission-'+i});
  assert.equal(result.unit_price_cents,expected);
  const job=await jobs.resolve('test-owner',result.reference),eligible=jobEligibility(release,catalog,job,{sourceScope});
  assert.equal(eligible.full,true);assert.equal(eligible.shipping_eligible,shipping);
  assert.equal(eligible.location_id,release.config.labs.find(l=>l.id===job.lab).location_id);
  const claims=jobClaims(job,result.reference,{full:true});assert.equal(Object.keys(claims).length,19);
  assert.equal(claims.files,selection.service==='Darkroom Prints'?'0':'1');
  assert.equal(result.item.properties._bfl_size_mode,claims.size_mode);
  await assert.rejects(jobs.resolve('other-owner',result.reference),/JOB_UNAVAILABLE/);
 }
 now=3601000;
 await assert.rejects(jobs.prepare('test-owner',{...cases[0],copies:1,asset_ids:['synthetic-asset-1'],request_key:'expired-full-admission'}),/ENGINEERING_EXPIRED/);
});
