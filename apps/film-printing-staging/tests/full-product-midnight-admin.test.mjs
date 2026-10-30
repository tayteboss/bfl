import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {mockLeaseAdmin} from '../../../fixtures/film-printing/f06v3-candidate/mock-admin.mjs';
import {createLifecycle} from '../jobs/lifecycle.mjs';
import {createAuthorityAdmin} from '../checkout/shopify.mjs';
import {decodeAuthority,variantForLab} from '../checkout/authority.js';
import {serializeAuthority} from '../checkout/projector.mjs';
import {prepareEngineeringSources,createEngineeringScope,revokeEngineeringScope} from '../configuration/engineering.mjs';
const START=Date.parse('2026-10-30T03:59:59.000Z'),MIDNIGHT=Date.parse('2026-10-30T04:00:00Z');
const read=name=>JSON.parse(readFileSync(new URL('../../../fixtures/film-printing/full-product-readiness-20261030/'+name,import.meta.url)));
async function fixture(t,{schema=5,full=true}={}){
 const clock={time:START},db=new DatabaseSync(':memory:');t.after(()=>db.close());const lifecycle=createLifecycle(db);
 const specificationOwner={id:'gid://shopify/Validation/999',functionId:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'};
 const mock=mockLeaseAdmin({specificationOwner});let sourceScope;
 if(full){const source=prepareEngineeringSources({config:read('engineering-config-proposal.json'),catalog:read('engineering-catalog-proposal.json'),issuedAt:START,until:START+3600000});
  sourceScope=createEngineeringScope({...source,identity:mock.data,now:()=>clock.time});mock.replace('active',source.releaseValue);mock.replace('catalog',source.catalogValue);}
 const admin=createAuthorityAdmin(mock.api,{writesEnabled:true,lifecycle,now:()=>new Date(clock.time),eligibility:true,specificationOwner,sourceScope});
 const context=await admin.read(),claims={flow:'f05',job:'offline-midnight-job',revision:'d'.repeat(64),config:context.release.version,signature:'e'.repeat(64),service:'photo',size:'4x6',paper:'photo-premium-luster',lab:'miami',message:'',borders:'',turnaround:'Standard (4-5 days)',files:'1',
  ...(schema>=4?{size_mode:'fixed',width:'',height:'',process:'',scanning:'',negatives:''}:{})};
 const authority={schema,store:context.catalog.store,config_version:context.release.version,config_sha256:context.release.sha256,price_version:context.catalog.version,valid_on:context.shopDate,
  lease:{token:'f'.repeat(64),deadline:'2026-10-30T00:59:59',expires_at:START+3600000},
  grants:[{cart:'a'.repeat(64),owner:'b'.repeat(64),binding:'c'.repeat(64),customer_id:null,generation:1,epoch:0,lines:[{unit_cents:100,file_count:1,location_id:'gid://shopify/Location/92443803759',claims,
   ...(schema>=4?{shipping_eligible:true}:{}),...(schema===5?{variant_id:variantForLab('miami')}:{})}]}]};
 const prepared={context,authority,value:serializeAuthority(authority),ticket:null};
 const stage=()=>{prepared.value=serializeAuthority(authority);assert(decodeAuthority(prepared.value));prepared.ticket=lifecycle.beginPreparation();lifecycle.stage(prepared.ticket,prepared.value);};stage();
 return {clock,mock,admin,lifecycle,prepared,authority,sourceScope,stage};
}
for(const schema of [4,5]){
 test(`schema${schema} prepared before midnight publishes after midnight under the unchanged finite source`,async t=>{
  const f=await fixture(t,{schema}),original=JSON.stringify(f.prepared.context),lease=structuredClone(f.authority.lease);f.clock.time=MIDNIGHT+1000;
  assert.equal((await f.admin.publish(f.prepared)).published,true);assert.equal(f.mock.writes.length,1);assert.equal(f.lifecycle.state().operation,null);
  const actual=decodeAuthority(f.mock.data.shop.authority.value);assert.equal(actual.valid_on,'2026-10-29');assert.deepEqual(actual.lease,lease);assert.equal(JSON.stringify(f.prepared.context),original);
 });
 test(`schema${schema} mutation/readback straddles midnight without leaving a false unknown publication`,async t=>{
  const f=await fixture(t,{schema});f.mock.afterWrite=()=>{f.clock.time=MIDNIGHT+1000;};
  assert.equal((await f.admin.publish(f.prepared)).published,true);assert.equal(f.mock.writes.length,1);assert.equal(f.lifecycle.state().operation,null);
  assert.equal(decodeAuthority(f.mock.data.shop.authority.value).valid_on,'2026-10-29');
 });
}
for(const [name,change] of [
 ['issuance-date mismatch',f=>{f.authority.valid_on='2026-10-30';}],
 ['prepared date before admitted source',f=>{f.prepared.context={...f.prepared.context,shopDate:'2026-10-28'};f.authority.valid_on='2026-10-28';}],
 ['prepared date after current time',f=>{f.prepared.context={...f.prepared.context,shopDate:'2026-10-31'};f.authority.valid_on='2026-10-31';}],
 ['original lease expires at midnight',f=>{f.authority.lease.expires_at=MIDNIGHT;}],
 ['lease exceeds original source interval',f=>{f.authority.lease.expires_at=START+3600001;}],
 ['revoked source',f=>revokeEngineeringScope(f.sourceScope)],
 ['active source digest drift',f=>{f.mock.data.currentAppInstallation.active.compareDigest='different';}],
 ['catalog digest drift',f=>{f.mock.data.currentAppInstallation.catalog.compareDigest='different';}],
 ['fence digest drift',f=>{f.mock.data.currentAppInstallation.fence.compareDigest='different';}],
 ['timezone drift',f=>{f.mock.data.shop.ianaTimezone='America/Chicago';}],
 ['Function owner drift',f=>{f.mock.data.leasePricing.nodes[0].functionId='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';}],
])test(`midnight allowance rejects ${name} before any write`,async t=>{
 const f=await fixture(t);change(f);f.stage();f.clock.time=MIDNIGHT+1000;
 await assert.rejects(f.admin.publish(f.prepared));assert.equal(f.mock.writes.length,0);assert.equal(f.lifecycle.state().operation,null);
});
for(const [name,change] of [
 ['source',f=>{f.mock.data.currentAppInstallation.active.value+=' ';}],
 ['fence',f=>{f.mock.data.currentAppInstallation.fence.value='00000000-0000-0000-0000-000000000001';}],
 ['owner lease',f=>{f.mock.data.leasePricing.nodes[0].lease.value='{}';}],
 ['timezone',f=>{f.mock.data.shop.ianaTimezone='America/Chicago';}],
])test(`midnight readback ${name} drift leaves the actual attempted write pending`,async t=>{
 const f=await fixture(t);f.mock.afterWrite=()=>{f.clock.time=MIDNIGHT+1000;change(f);};
 await assert.rejects(f.admin.publish(f.prepared));assert.equal(f.mock.writes.length,1);assert.equal(f.lifecycle.state().operation?.kind,'publish');
});
test('lease expiry during midnight write is never acknowledged or extended',async t=>{
 const f=await fixture(t);f.authority.lease.expires_at=MIDNIGHT;f.stage();f.mock.afterWrite=()=>{f.clock.time=MIDNIGHT;};
 await assert.rejects(f.admin.publish(f.prepared),/AUTHORITY_READBACK_CHANGED/);assert.equal(f.lifecycle.state().operation?.kind,'publish');assert.equal(decodeAuthority(f.mock.data.shop.authority.value).lease.expires_at,MIDNIGHT);
});
for(const options of [{schema:3,full:true},{schema:4,full:false}])test(`historical daily checks remain for schema${options.schema}, admittedFull=${options.full}`,async t=>{
 const f=await fixture(t,options);f.clock.time=MIDNIGHT+1000;await assert.rejects(f.admin.publish(f.prepared),/AUTHORITY_CHANGED/);assert.equal(f.mock.writes.length,0);
});
test('protective clearing does not acquire the nonempty-publication date exception',async t=>{
 const f=await fixture(t);f.mock.afterWrite=()=>{f.clock.time=MIDNIGHT+1000;};await assert.rejects(f.admin.reconcile(),/AUTHORITY_READBACK_CHANGED/);assert.equal(f.lifecycle.state().operation?.kind,'recovery');assert.equal(decodeAuthority(f.mock.data.shop.authority.value).grants.length,0);
});
