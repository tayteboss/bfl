import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {configuration} from '../../../fixtures/film-printing/f06p-composition/rig.mjs';
import {mockLeaseAdmin} from '../../../fixtures/film-printing/f06v3-candidate/mock-admin.mjs';
import {leaseEnvelope} from '../checkout/lease.mjs';
import {mockAdmin} from '../../../fixtures/film-printing/f06d/mock-admin.mjs';
import {migrateCheckoutComposition,openDatabase} from '../backend/storage.mjs';
import {prepareEngineeringSources,createEngineeringScope,revokeEngineeringScope,rawHash} from '../configuration/engineering.mjs';
import {verifyRelease} from '../configuration/config.mjs';
import {createEngineeringSourceOperator} from '../configuration/engineering-operator.mjs';
import {CLIENT} from '../configuration/schema.mjs';
import {CATALOG_DELETE} from '../backend/admin.mjs';

const read=name=>JSON.parse(readFileSync(new URL('../../../fixtures/film-printing/f06p-integration/'+name,import.meta.url)));
function setup(t,{specificationOwner=null}={}){
 const config=configuration(t);migrateCheckoutComposition(config);const clock={time:Date.parse('2026-10-26T00:00:00Z')};
 const storage=openDatabase(config,{resourceSessions:true,checkoutOwner:true,now:()=>clock.time});config.localClosers.push(storage.close);
 const m=specificationOwner?mockLeaseAdmin({specificationOwner}):mockAdmin();m.data.currentAppInstallation.app.apiKey=CLIENT;m.data.currentAppInstallation.catalog=null;
 // Restore the actual preimage, including noncanonical whitespace/key order.
 m.data.currentAppInstallation.active.value='\n'+JSON.stringify(JSON.parse(m.data.currentAppInstallation.active.value),null,2)+'\n';
 m.data.currentAppInstallation.active.compareDigest=rawHash(m.data.currentAppInstallation.active.value);
 const plan=prepareEngineeringSources({config:read('engineering-config-proposal.json'),catalog:read('engineering-catalog-proposal.json'),issuedAt:clock.time,until:clock.time+1200000});
 const scope=createEngineeringScope({...plan,identity:m.data,now:()=>clock.time});
 const history=[],calls=[];let loseDelete=false,beforeDelete=null;
 const fetchImpl=async(url,options)=>{
  const {query,variables}=JSON.parse(options.body);calls.push(query);let data;
  if(query===CATALOG_DELETE){
   if(beforeDelete)beforeDelete();m.data.currentAppInstallation.catalog=null;
   if(loseDelete)throw Error('generated lost delete response');data={metafieldsDelete:{deletedMetafields:variables.metafields,userErrors:[]}};
  }else {
   data=await m.api(query,variables);
   if(query.startsWith('mutation')&&m.data.currentAppInstallation.catalog){m.data.currentAppInstallation.catalog.id??='gid://shopify/Metafield/900001';}
  }
  return new Response(JSON.stringify({data}),{headers:{'content-type':'application/json','x-shopify-api-version':'2026-10'}});
 };
 const make=(sourceScope=scope,events=[],currentStorage=storage)=>createEngineeringSourceOperator({config:{...config,mode:'reconcile-only',adminToken:'generated-source-token'.repeat(3)},storage:currentStorage,sourceScope,append:e=>history.push(structuredClone(e)),history:events,eligibility:!!specificationOwner,specificationOwner,fetchImpl,now:()=>clock.time});
 return {config,storage,clock,m,plan,scope,history,calls,make,set loseDelete(v){loseDelete=v;},set beforeDelete(v){beforeDelete=v;}};
}

test('exact private engineering scope preserves provenance while ordinary, altered-target/content and expired admission reject',t=>{
 const f=setup(t),release=JSON.parse(f.plan.releaseValue);assert.equal(verifyRelease(release,{sourceScope:f.scope}).config.labs[0].origin_status,'staging_address_only');
 assert.equal(release.config.packages[0].weight_status,'observed');assert.equal(release.config.policies[0].enabled,false);
 assert.throws(()=>verifyRelease(release),/ENGINEERING_SCOPE/);assert.throws(()=>verifyRelease(release,{sourceScope:{kind:'staging_engineering'}}),/ENGINEERING_SCOPE/);
 const changed=structuredClone(release);changed.config.packages[0].weight_status='confirmed';assert.throws(()=>verifyRelease(changed,{sourceScope:f.scope}),/ENGINEERING_SOURCE/);
 assert.throws(()=>createEngineeringScope({...f.plan,identity:{...f.m.data,shop:{id:'wrong'}},now:()=>f.clock.time}),/ENGINEERING_TARGET/);
 for(const contract of [{...f.plan.contract,extra:true},{...f.plan.contract,target:{...f.plan.contract.target,draft:'wrong'}},{...f.plan.contract,files:[...f.plan.contract.files,'extra']}])assert.throws(()=>createEngineeringScope({...f.plan,contract,identity:f.m.data,now:()=>f.clock.time}));
 f.clock.time+=1200000;assert.throws(()=>verifyRelease(release,{sourceScope:f.scope}),/ENGINEERING_EXPIRED/);verifyRelease(release,{sourceScope:f.scope,intent:'protect'});
});

test('normal source CAS applies exact release/catalog, then expiry/recovery restores original bytes and catalog absence once',async t=>{
 const f=setup(t),original=f.m.data.currentAppInstallation.active.value,op=f.make();await op.apply();
 assert.equal(f.m.data.currentAppInstallation.active.value,f.plan.releaseValue);assert.equal(f.m.data.currentAppInstallation.catalog.value,f.plan.catalogValue);
 f.clock.time+=1200000;revokeEngineeringScope(f.scope);
 f.storage.close();const reopened=openDatabase(f.config,{resourceSessions:true,checkoutOwner:true,now:()=>f.clock.time});f.config.localClosers.push(reopened.close);
 const recovery=createEngineeringScope({...f.plan,identity:f.m.data,now:()=>f.clock.time,mode:'recovery'}),restart=f.make(recovery,structuredClone(f.history),reopened);
 await restart.restore();assert.equal(f.m.data.currentAppInstallation.active.value,original);assert.equal(f.m.data.currentAppInstallation.catalog,null);
 assert.equal(reopened.store.lifecycle.state().pending,0);assert.equal(reopened.store.lifecycle.state().operation,null);
 assert.equal(f.calls.filter(q=>q===CATALOG_DELETE).length,1);assert.ok(f.m.archives.size>=2);
 await assert.rejects(restart.restore(),/SOURCE_RESTORE_SPENT/);assert.equal(f.calls.filter(q=>q===CATALOG_DELETE).length,1);
 t.diagnostic(JSON.stringify({source_counts_before_replay:op.status(),restoration_and_rejected_replay:restart.status()}));
});

test('changed catalog ID/digest blocks restoration and never deletes another writer field',async t=>{
 const f=setup(t),op=f.make();await op.apply();f.m.data.currentAppInstallation.catalog.id='gid://shopify/Metafield/900002';
 await assert.rejects(op.restore(),/SOURCE_RESTORE_CONFLICT/);assert.equal(f.calls.filter(q=>q===CATALOG_DELETE).length,0);
 assert.equal(JSON.parse(f.m.data.shop.authority.value).grants.length,0);
});

test('lost deletion leaves durable unknown; restart can clear but cannot repeat the delete',async t=>{
 const f=setup(t),op=f.make();await op.apply();f.loseDelete=true;await assert.rejects(op.restore());
 assert.equal(f.calls.filter(q=>q===CATALOG_DELETE).length,1);assert.ok(f.history.some(e=>e.event==='catalog_delete_unknown'));
 assert.ok(f.storage.store.lifecycle.state().operation);
 const recovery=createEngineeringScope({...f.plan,identity:f.m.data,now:()=>f.clock.time,mode:'recovery'}),restart=f.make(recovery,f.history);
 await assert.rejects(restart.restore(),/SOURCE_RESTORE_SPENT/);assert.equal(f.calls.filter(q=>q===CATALOG_DELETE).length,1);
 assert.equal(f.storage.store.lifecycle.state().operation,null);assert.equal(JSON.parse(f.m.data.shop.authority.value).grants.length,0);
});

test('source mutations require the still-owned actual exclusive writer lock',async t=>{
 const f=setup(t),op=f.make(),path=join(f.config.dataDir,'runtime.lock/owner.json'),original=readFileSync(path),owner=JSON.parse(original);
 writeFileSync(path,JSON.stringify({...owner,token:'different-generated-owner'}));
 try{await assert.rejects(op.apply(),/LOCK_CHANGED/);assert.equal(f.calls.length,0);}finally{writeFileSync(path,original);}
 f.storage.assertExclusiveWriter();f.storage.close();assert.throws(()=>f.storage.assertExclusiveWriter(),/DATABASE_CLOSED/);
});

const fifth={id:'gid://shopify/Validation/999',functionId:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'};
test('source lifecycle preserves five exact owners through apply and expired recovery before registration removal',async t=>{
 const f=setup(t,{specificationOwner:fifth}),original=f.m.data.currentAppInstallation.active.value,op=f.make();await op.apply();
 assert.equal(f.history.find(e=>e.event==='source_preimage').function_owners.length,5);
 for(const write of f.m.writes)assert.equal(write.filter(f=>f.key==='lease_v3').length,5);
 assert.equal(f.m.data.leaseValidation.nodes[1].lease.value,leaseEnvelope(f.m.data.shop.authority.value));
 f.clock.time+=1200000;revokeEngineeringScope(f.scope);
 f.storage.close();const reopened=openDatabase(f.config,{resourceSessions:true,checkoutOwner:true,now:()=>f.clock.time});f.config.localClosers.push(reopened.close);
 const scope=createEngineeringScope({...f.plan,identity:f.m.data,mode:'recovery',now:()=>f.clock.time}),recovery=f.make(scope,structuredClone(f.history),reopened);
 await recovery.restore();assert.equal(f.m.data.currentAppInstallation.active.value,original);assert.equal(f.m.data.currentAppInstallation.catalog,null);
 assert.equal(f.m.data.leaseValidation.nodes[1].lease.value,leaseEnvelope(f.m.data.shop.authority.value));
 assert.equal(f.m.data.leaseValidation.nodes.length,2);assert.equal(reopened.store.lifecycle.state().operation,null);
});
test('fifth owner missing or replaced blocks source activation before any mutation',async t=>{
 const f=setup(t,{specificationOwner:fifth});f.m.data.leaseValidation.nodes[1].shopifyFunction.id='bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee';
 await assert.rejects(f.make().apply(),/FUNCTION_OWNER_CHANGED/);assert.equal(f.m.writes.length,0);
});
