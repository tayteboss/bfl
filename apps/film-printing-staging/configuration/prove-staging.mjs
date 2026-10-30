// Supervised F03 evidence only. No checkout/order/rate-service operations.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { graphql } from './cli.mjs';
import { APP, STORE, NAMESPACE } from './schema.mjs';
import { ACTIVE_QUERY, assertIdentity, mutationResult, publishDrafts, createConfigLoader } from './shopify.mjs';
import { canonical, verifyRelease } from './config.mjs';
const evidence = new URL('../../../fixtures/film-printing/f03/',import.meta.url);
const save = async (name,data) => writeFile(new URL(name,evidence),JSON.stringify(data,null,2)+'\n');
const update = async (id,fields) => graphql('mutation Edit($id: ID!, $metaobject: MetaobjectUpdateInput!) { metaobjectUpdate(id: $id, metaobject: $metaobject) { metaobject { id handle fields { key value } } userErrors { field code message } } }',{id,metaobject:{fields}});
const find = async (type,handle) => (await graphql('query Find($handle: MetaobjectHandleInput!) { metaobjectByHandle(handle:$handle) { id fields { key value } } }',{handle:{type,handle}})).metaobjectByHandle;
async function initial() {
  const published = await publishDrafts(graphql);
  await save('release-1.json',published);
  const loader = createConfigLoader(graphql);
  const a = await loader.load({fresh:true}); assert.equal(a.version,published.release.version);
  const rule = await find('bfl_print_rule','packaging-row-3');
  const zero = await update(rule.id,[{key:'capacity',value:'0'}]);
  assert.ok(zero.metaobjectUpdate.userErrors.length,'Shopify must reject zero capacity');
  const policy = await find('bfl_print_policy','film-printing');
  let invalid;
  try {
    mutationResult(await update(policy.id,[{key:'markup_cents',value:'1'}]),'metaobjectUpdate');
    try { await publishDrafts(graphql); assert.fail('Invalid policy must not publish'); }
    catch (error) { assert.equal(error.code,'INVALID_CONFIGURATION'); invalid = {code:error.code,message:error.message}; }
    const unchanged = await loader.load({fresh:true}); assert.equal(unchanged.version,a.version);
  } finally { mutationResult(await update(policy.id,[{key:'markup_cents',value:'0'}]),'metaobjectUpdate'); }
  const currentRule = await find('bfl_print_rule','packaging-row-3');
  assert.equal(currentRule.fields.find(f=>f.key==='capacity').value,'40');
  await save('validation-roundtrip.json',{store:STORE,app:APP,at:new Date().toISOString(),version:a.version,shopifyZeroCapacity:zero.metaobjectUpdate.userErrors,applicationRejectedPolicy:invalid,activeUnchanged:true,policyRestoredToZero:true,rule:currentRule});
  console.log(JSON.stringify({phase:'initial',version:a.version,zeroCapacityRejected:true,invalidPolicyRejected:true,restored:true}));
}
async function final() {
  const old = JSON.parse(await readFile(new URL('release-1.json',evidence),'utf8')).release;
  const loader = createConfigLoader(graphql);
  assert.equal((await loader.load({fresh:true})).version,old.version,'Draft edit must not auto-publish');
  const stale = assertIdentity(await graphql(ACTIVE_QUERY));
  const published = await publishDrafts(graphql); const current = published.release;
  assert.notEqual(current.version,old.version);
  assert.equal(current.config.rules.find(r=>r.id==='packaging-row-3').label,'Photo 4x6 — paper confirmation pending');
  await save('release-2.json',published);
  const cachedAfterPublish = (await loader.load()).version;
  assert.ok([old.version,current.version].includes(cachedAfterPublish));
  assert.equal((await loader.load({expectedVersion:current.version})).version,current.version);
  await assert.rejects(loader.load({expectedVersion:old.version}),{code:'VERSION_MISMATCH'});
  const archive = await graphql('query Archive($key: String!) { currentAppInstallation { metafield(namespace:"bfl_printing",key:$key) { value } } }',{key:`release_${old.sha256.slice(0,24)}`});
  assert.equal(canonical(verifyRelease(JSON.parse(archive.currentAppInstallation.metafield.value))),canonical(old));
  const conflict = await graphql('mutation StaleWrite($fields:[MetafieldsSetInput!]!) { metafieldsSet(metafields:$fields) { metafields { id } userErrors { field code message } } }',{fields:[{ownerId:stale.id,namespace:NAMESPACE,key:'active_config',type:'json',value:canonical(old),compareDigest:stale.metafield.compareDigest}]});
  assert.ok(conflict.metafieldsSet.userErrors.length,'Stale publisher must be rejected');
  assert.equal((await loader.load({fresh:true})).version,current.version);
  const state = await graphql(`query State {
    shop { myshopifyDomain }
    currentAppInstallation { id app { id } accessScopes { handle } }
    metaobjectDefinitions(first: 30) { nodes { id type access { admin storefront } metaobjectsCount } }
    cartTransforms(first:10) { nodes { id functionId blockOnFailure } }
    validations(first:10) { nodes { id enabled blockOnFailure } }
    fulfillmentConstraintRules { id deliveryMethodTypes }
    deliveryCustomizations(first:10) { nodes { id enabled } }
    carrierService(id:"gid://shopify/DeliveryCarrierService/89815515247") { id active }
  }`);
  assertIdentity(state);
  await save('final-state.json',state);
  await save('version-transition.json',{at:new Date().toISOString(),store:STORE,oldVersion:old.version,newVersion:current.version,draftDidNotAutoPublish:true,applicationCacheAfterPublish:cachedAfterPublish,expectedNewVersionRead:true,oldVersionRejected:true,oldArchiveUnchanged:true,staleWriteRejected:conflict.metafieldsSet.userErrors,finalActiveVersion:current.version,checkoutTested:false});
  console.log(JSON.stringify({phase:'final',version:current.version,archiveUnchanged:true,staleWriteRejected:true}));
}
const phase = process.argv[2];
if (phase === 'initial') await initial(); else if (phase === 'final') await final(); else throw Error('Specify initial or final; edit the rule label in Admin between phases.');
