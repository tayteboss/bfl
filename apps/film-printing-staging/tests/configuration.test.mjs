import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateConfig, makeRelease, verifyRelease, resolveRule, canonical } from '../configuration/config.mjs';
import { createConfigLoader, publishDrafts, encodeRecord } from '../configuration/shopify.mjs';
import {createJobStore} from '../jobs/service.mjs';
import {mockAdmin,now} from '../../../fixtures/film-printing/f06d/mock-admin.mjs';
import { APP, STORE, groupTypes } from '../configuration/schema.mjs';
const seed = JSON.parse(readFileSync(new URL('../../../fixtures/film-printing/f03/import.json', import.meta.url)));
const copy = () => structuredClone(seed);
const invalid = change => { const c = copy(); change(c); assert.throws(() => validateConfig(c)); };
const envelope = c => ({ shop: { myshopifyDomain: STORE }, currentAppInstallation: { id: 'gid://shopify/AppInstallation/1073784553583', app: { id: APP }, metafield: { value: canonical(makeRelease(c)), compareDigest: 'initial' } } });

test('F01 import retains 6 packages, 13 fixed rows, custom/darkroom, 5 lab identities and current policy; nothing enabled', () => {
  assert.equal(validateConfig(seed),seed);
  assert.equal(seed.packages.length,6); assert.equal(seed.rules.length,15);
  assert.equal(seed.rules.filter(r => r.capacity_status === 'confirmed' && r.capacity === 3).length,6);
  assert.equal(seed.rules.filter(r => r.capacity_status === 'confirmed' && r.capacity === 4).length,2);
  for (const group of Object.keys(groupTypes)) assert.ok(seed[group].every(r => r.enabled === false));
  assert.equal(seed.policies[0].provider,'fedex'); assert.equal(seed.policies[0].markup_cents,0);
});
test('missing values, undeclared fields/units and malformed numeric types are rejected', () => {
  invalid(c => delete c.packages[0].length_in);
  invalid(c => c.packages[0].length_cm = 5);
  for (const v of [0,-1,NaN,Infinity,'24',null,1001]) invalid(c => c.packages[0].length_in = v);
  for (const v of [0,-1,0.5,10001,Number.MAX_SAFE_INTEGER,'3']) invalid(c => c.rules.find(r => r.capacity).capacity = v);
  invalid(c => c.rules[0].size_key = '6x4'); invalid(c => c.rules[0].size_key = '4x6cm');
  invalid(c => c.rules[0].service = 'send_rolls'); invalid(c => delete c.rules[0].provenance);
});
test('unknown references, duplicate IDs/selectors and incomplete enabled paths rejected', () => {
  invalid(c => c.rules[0].package_id = 'unknown'); invalid(c => c.rules[0].lab = 'unknown');
  invalid(c => c.packages.push(c.packages[0]));
  invalid(c => c.rules.push({...c.rules[1],id:'duplicate-selector'}));
  for (const group of ['packages','rules','labs','policies']) invalid(c => c[group][0].enabled = true);
  invalid(c => c.rules[0].paper = 'all');
  invalid(c => c.labs[0].id = 'all_labs');
  invalid(c => c.labs[0].location_id = 'gid://shopify/Location/92443803759');
});
test('settled policy cannot drift to markup, fixed fallback, other service, international or sharing', () => {
  for (const [k,v] of Object.entries({provider:'ups',service:'FEDEX_GROUND',rate_source:'list',markup_cents:1,markup_basis_points:1,coverage:'world',failure:'free_shipping',pickup:'paid',sharing:'combine',rate_access:'yes'})) invalid(c => c.policies[0][k] = v);
});
function syntheticEnabled() {
  const c = copy();
  const p = c.packages[0]; p.enabled = true; p.weight_status = 'confirmed';
  const lab = c.labs.find(l => l.id === 'miami'); lab.enabled = true; lab.origin_status = 'verified';
  const rule = c.rules.find(r => r.size_key === '4x6');
  Object.assign(rule,{enabled:true,paper:'test-paper',capacity_status:'confirmed',weight_status:'confirmed',package_id:p.id});
  return { c, rule };
}
test('exact paper/service/size/lab matching; local overrides All Labs; disabled override denies fallback', () => {
  const { c,rule } = syntheticEnabled();
  const job = {service:'photo',size_key:'4x6',paper:'test-paper',lab:'miami'};
  assert.equal(resolveRule(c,job).id,rule.id);
  const local = {...rule,id:'test-local',lab:'miami'}; c.rules.push(local);
  assert.equal(resolveRule(c,job).id,'test-local');
  local.enabled = false; local.disabled_reason = 'Test explicit denial';
  assert.throws(() => resolveRule(c,job),{code:'UNAVAILABLE_RULE'});
  for (const change of [{paper:null},{paper:'unknown'},{service:'darkroom'},{size_key:'custom'},{lab:'all_labs'},{lab:'unknown'}]) assert.throws(() => resolveRule(c,{...job,...change}));
});
test('content hash stable across object key order, changes on update, detects modified envelopes', () => {
  const a = makeRelease(copy()); const reordered = JSON.parse(canonical(a)); assert.deepEqual(verifyRelease(reordered),a);
  const b = copy(); b.rules[1].label += ' reviewed'; assert.notEqual(makeRelease(b).version,a.version);
  a.config.rules[1].label += ' tamper'; assert.throws(() => verifyRelease(a));
});
test('loader uses one consistent immutable snapshot, coalesces reads and refreshes expired cache', async () => {
  let clock = 0, reads = 0; const c = copy();
  const loader = createConfigLoader(async () => { reads++; return envelope(c); },{now:()=>clock,ttlMs:30});
  const [a,b] = await Promise.all([loader.load(),loader.load()]); assert.equal(a,b); assert.equal(reads,1);
  assert.throws(() => a.config.packages[0].empty_weight_oz = 8);
  c.rules[1].label += ' changed'; clock = 29; assert.equal((await loader.load()).version,a.version);
  clock = 30; assert.notEqual((await loader.load()).version,a.version); assert.equal(reads,2);
  loader.invalidate(); await loader.load(); assert.equal(reads,3);
});
test('version mismatch refreshes then rejects old jobs; never substitutes a new version', async () => {
  const c = copy(); const old = makeRelease(c).version;
  const loader = createConfigLoader(async () => envelope(c)); await loader.load();
  c.rules[1].label += ' changed'; const current = makeRelease(c).version;
  assert.equal((await loader.load({expectedVersion:current})).version,current);
  await assert.rejects(loader.load({expectedVersion:old}),{code:'VERSION_MISMATCH'});
});
test('expired cache fails closed on network/missing/invalid/foreign configuration; no stale fallback', async () => {
  let clock = 0, mode = 'good';
  const loader = createConfigLoader(async () => {
    if (mode === 'network') throw Error('offline');
    const d = envelope(copy());
    if (mode === 'missing') d.currentAppInstallation.metafield = null;
    if (mode === 'invalid') d.currentAppInstallation.metafield.value = '{}';
    if (mode === 'foreign') d.shop.myshopifyDomain = '1jukgy-dc.myshopify.com';
    return d;
  },{ttlMs:1,now:()=>clock});
  await loader.load(); clock = 2;
  for (mode of ['network','missing','invalid','foreign']) await assert.rejects(loader.load());
});
// F06D: retain the F03 archive/draft/CAS assertions through the current guarded writer.
function publisherApi(t,{changeDuringRead=false,casConflict=false}={}) {
  const mock=mockAdmin(),store=createJobStore(':memory:');t.after(()=>store.close());
  mock.changeDrafts=changeDuringRead;mock.reject=casConflict;
  return {...mock,options:{writesEnabled:true,lifecycle:store.lifecycle,now}};
}
test('publisher sends atomic archive creation and active compare-and-set with authority invalidation', async t => {
  const {api,writes,options} = publisherApi(t); await publishDrafts(api,options);
  assert.equal(writes.length,1); assert.equal(writes[0].length,5);
  assert.ok(writes[0].find(f=>f.key==='active_config').compareDigest);
  assert.equal(writes[0].find(f=>f.key.startsWith('release_')).compareDigest,null);
  assert.deepEqual(JSON.parse(writes[0].find(f=>f.key==='authority').value).grants,[]);
});
test('editing during draft reads prevents publication; concurrent publishers reject CAS conflict', async t => {
  const changing = publisherApi(t,{changeDuringRead:true}); await assert.rejects(publishDrafts(changing.api,changing.options),{code:'DRAFT_CHANGED'}); assert.equal(changing.writes.length,0);
  const conflict = publisherApi(t,{casConflict:true}); await assert.rejects(publishDrafts(conflict.api,conflict.options),{code:'AUTHORITY_WRITE_REJECTED'});
});
