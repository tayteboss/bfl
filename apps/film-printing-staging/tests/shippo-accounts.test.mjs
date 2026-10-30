import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectShippoTestAccounts } from '../shipping/shippo-accounts.mjs';

const account = () => ({object_id:'synthetic_usps', carrier:'usps', active:true, test:true,
  is_shippo_account:true, object_owner:'synthetic@example.invalid', account_id:'PRIVATE_NUMBER',
  parameters:{password:'PRIVATE_SECRET'}, metadata:'PRIVATE_METADATA',
  service_levels:[{token:'usps_priority'}], object_info:{authentication:{status:'connected'}}});
const config = (payload={next:null,results:[account()]}) => ({enabled:true,
  token:'shippo_test_SYNTHETIC', expectedOwner:'synthetic@example.invalid',
  fetchImpl:async () => ({ok:true,json:async () => payload})});

test('test account diagnostic is disabled by default and rejects live/missing keys before network', async () => {
  let calls=0;
  const options={...config(),fetchImpl:async () => { calls++; }};
  for (const change of [{enabled:false},{token:'shippo_live_SYNTHETIC'},{token:undefined},{expectedOwner:''}]) {
    await assert.rejects(inspectShippoTestAccounts({...options,...change}));
  }
  assert.equal(calls,0);
});

test('account diagnostic pins read-only endpoint and exports only non-secret inventory', async () => {
  const result=await inspectShippoTestAccounts({...config(),fetchImpl:async (url,options) => {
    assert.equal(url,'https://api.goshippo.com/carrier_accounts/?service_levels=true&results=100&page=1');
    assert.equal(options.method,'GET'); assert.equal(options.redirect,'error');
    assert.equal(options.headers['Shippo-API-Version'],'2018-02-08');
    assert.equal(options.headers.Authorization,'ShippoToken shippo_test_SYNTHETIC');
    assert.equal(options.body,undefined);
    return {ok:true,json:async () => ({next:null,results:[account()]})};
  }});
  assert.equal(result.complete,true); assert.equal(result.checkout_ready,false);
  assert.equal(result.eligibility_verified,false); assert.equal(result.accounts[0].owner_matches,true);
  assert.deepEqual(result.accounts[0].service_tokens,['usps_priority']);
  assert.equal(JSON.stringify(result).includes('PRIVATE'),false);
  assert.equal(JSON.stringify(result).includes('example.invalid'),false);
  assert.ok(Object.isFrozen(result.accounts[0]));
});

test('partial inventory is explicit and never follows next URL; inactive/mismatched owner is not approval', async () => {
  const a={...account(),active:false,object_owner:'another@example.invalid',object_info:{}};
  let calls=0;
  const result=await inspectShippoTestAccounts({...config(),fetchImpl:async () => {
    calls++; return {ok:true,json:async () => ({next:'https://untrusted.invalid/?secret=x',results:[a]})};
  }});
  assert.equal(calls,1); assert.equal(result.complete,false);
  assert.equal(result.accounts[0].active,false); assert.equal(result.accounts[0].owner_matches,false);
  assert.equal(result.accounts[0].authentication_status,'unverified');
  assert.equal(result.eligibility_verified,false); assert.equal(JSON.stringify(result).includes('untrusted'),false);
  const unknownOwner=await inspectShippoTestAccounts({...config(),expectedOwner:undefined});
  assert.equal(unknownOwner.accounts[0].owner_matches,null);
  assert.equal(unknownOwner.eligibility_verified,false);
});

test('malformed, duplicate and wrong-mode account results fail closed', async () => {
  for (const payload of [{results:[]},{next:null,results:[account(),account()]},
    ...[{test:false},{test:undefined},{active:undefined},{service_levels:undefined},{service_levels:[{token:'bad token'}]}]
      .map(change => ({next:null,results:[{...account(),...change}]}))]) {
    await assert.rejects(inspectShippoTestAccounts(config(payload)));
  }
  assert.deepEqual((await inspectShippoTestAccounts(config({next:null,results:[]}))).accounts,[]);
});

test('provider errors and cancellation cannot expose credentials or return late evidence', async () => {
  for (const fetchImpl of [async () => {throw Error('PRIVATE_TOKEN');},
    async () => ({ok:false,json:async () => ({secret:'PRIVATE_TOKEN'})}),
    async () => ({ok:true,json:async () => {throw Error('PRIVATE_TOKEN');}})]) {
    await assert.rejects(inspectShippoTestAccounts({...config(),fetchImpl}), {message:'SHIPPO_ACCOUNT_READ_FAILED'});
  }
  const controller=new AbortController(); controller.abort();
  await assert.rejects(inspectShippoTestAccounts({...config(),signal:controller.signal}),{code:'QUOTE_TIMEOUT'});
  await assert.rejects(inspectShippoTestAccounts({...config(),timeoutMs:1,fetchImpl:async () => {
    await new Promise(resolve => setTimeout(resolve,10));
    return {ok:true,json:async () => ({next:null,results:[account()]})};
  }}),{code:'QUOTE_TIMEOUT'});
});
