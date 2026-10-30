import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHmac} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import {Readable} from 'node:stream';
import {createProxyContextVerifier} from '../checkout/proxy-context.mjs';
import {createJobHandler} from '../jobs/http.mjs';
import {createCheckoutProjector, revokeAuthority} from '../checkout/projector.mjs';
import {STORE} from '../checkout/authority.js';
import {cartTransformRun as price, cartValidationsGenerateRun as validate} from '../checkout/functions.js';
import {scenario} from '../../../fixtures/film-printing/f06a/synthetic.mjs';
import {scenario as boundScenario} from '../../../fixtures/film-printing/f06p-candidate/synthetic.mjs';

// Entirely offline protocol tests. No real owner, CartLine or Shopify acceptance
// is established by these mocks; see the separate staging observation record.
const locatorSource = await readFile(new URL('../theme/cart-locator.js', import.meta.url), 'utf8');
const id = 'gid://shopify/Cart/offline-only-cart?key=offline-only-capability';
const secret = 'offline-proxy-secret-not-an-actual-credential';
const timestamp = 1792539000;
const pathPrefix = '/apps/bfl-printing';
function sign(changes = {}, extras = []) {
  const params = new URLSearchParams({shop: STORE, path_prefix: pathPrefix, timestamp: String(timestamp), logged_in_customer_id: '', ...changes});
  for (const [key, value] of extras) params.append(key, value);
  const message = [...new Set(params.keys())].map(k => `${k}=${params.getAll(k).join(',')}`).sort().join('');
  params.append('signature', createHmac('sha256', secret).update(message).digest('hex'));
  return params.toString();
}
const verifier = (seconds = timestamp) => createProxyContextVerifier({secret, pathPrefix, now: () => seconds * 1000});
function locator({host = STORE, getCart = async () => ({cart: {id}})} = {}) {
  const window = {location: {hostname: host}, Shopify: {actions: {getCart}}};
  runInNewContext(locatorSource, {window, URL});
  return window.BFLPrintCartLocator;
}
async function fixture(t, options) { const s = await scenario(options); t.after(() => s.store.close()); return s; }

test('F06C documented getCart locator uses current cookie context and preserves exact opaque ID only', async () => {
  let args;
  const api = locator({getCart: async (...input) => {args = input; return {cart: {id, owner: 'forged', complete: true, checkout_ready: true, lines: [{quantity: 999}]}};}});
  const result = await api.locate({cartId: 'ignored', owner: 'forged'});
  assert.deepEqual(args, []);
  assert.equal(result.cart_id, id);
  assert.equal(Object.keys(result).join(','), 'cart_id');
  assert.equal(Object.isFrozen(result), true);
});
test('F06C locator refuses another store, missing standard action, raw Ajax token, keyless and malformed IDs', async () => {
  await assert.rejects(locator({host: '1jukgy-dc.myshopify.com'}).locate(), /UNAVAILABLE/);
  await assert.rejects(locator({getCart: null}).locate(), /UNAVAILABLE/);
  for (const value of [null, '', 'raw-token?key=secret', 'gid://shopify/Cart/x', 'gid://shopify/Cart/x?key=',
    'gid://shopify/Cart/x?key=a&key=b', 'gid://shopify/Cart/?key=a', 'gid://shopify/Cart/x?key=a#fragment',
    'gid://shopify/Cart/x?key=hidden secret', 'x'.repeat(4097)]) {
    await assert.rejects(locator({getCart: async () => ({cart: {id: value}})}).locate(), /UNAVAILABLE/);
  }
  await assert.rejects(locator({getCart: async () => ({cart: null})}).locate(), /UNAVAILABLE/);
});
test('F06C locator suppresses transport error details and never claims capability verification', async () => {
  await assert.rejects(locator({getCart: async () => {throw Error(id);}}).locate(), error => error.message === 'CART_LOCATOR_UNAVAILABLE');
  assert.equal((await locator({getCart: async () => ({cart: {id: id.replace('capability', 'wrong-key')}})}).locate()).checkout_ready, undefined);
});
test('F06C signed customer proxy context is a witness, with no owner/cart/readiness or forwarded browser authority', () => {
  const result = verifier()(sign({logged_in_customer_id: '123'}, [['owner','attacker'], ['complete','true'], ['cart',id], ['extra','1'], ['extra','2']]));
  assert.deepEqual(result, {store: STORE, customer_id: 'gid://shopify/Customer/123', signed_at: timestamp});
  assert.equal(Object.isFrozen(result), true);
});
test('F06C signed anonymous proxy context does not invent a shared or unique guest owner', () => {
  const guest = verifier()(sign());
  assert.equal(guest.customer_id, null);
  assert.equal(guest.owner, undefined);
  assert.equal(guest.complete, undefined);
  assert.equal(guest.checkout_ready, undefined);
});
test('F06C tampered signature/customer/shop/path, invalid encoding and duplicate reserved fields fail', () => {
  for (const raw of [sign().replace('signature=', 'signature=0'), sign().replace('logged_in_customer_id=', 'logged_in_customer_id=123'),
    sign({shop:'1jukgy-dc.myshopify.com'}), sign({path_prefix:'/apps/another'}), sign({logged_in_customer_id:'0'}),
    sign({logged_in_customer_id:'-1'}), sign({logged_in_customer_id:'123,456'}), sign()+'&shop='+STORE,
    sign({}, [['timestamp',String(timestamp)]]), sign()+'&signature='+ '0'.repeat(64), sign()+'&bad=%FF',
    sign()+'&bad=%Q0', '?'+sign(), 'x'.repeat(8193)]) assert.throws(() => verifier()(raw), /UNVERIFIED_PROXY/);
});
test('F06C proxy freshness rejects future/expired attestations but is explicitly not one-use or body authentication', () => {
  const raw = sign();
  assert.throws(() => verifier(timestamp-1)(raw), /UNVERIFIED_PROXY/);
  assert.throws(() => verifier(timestamp+301)(raw), /UNVERIFIED_PROXY/);
  assert.equal(verifier(timestamp+300)(raw).signed_at, timestamp);
  // Replaying the same signed query still verifies. A future host must add its
  // own nonce/session/cart binding; we do not treat this as HTTP authentication.
  assert.deepEqual(verifier()(raw), verifier()(raw));
});
test('F06C verifier rejects missing or ambiguous configuration before accepting traffic', () => {
  for (const config of [{secret:'short',pathPrefix}, {secret,pathPrefix:'/not-an-app'}, {secret}])
    assert.throws(() => createProxyContextVerifier(config), /INVALID_PROXY_CONFIG/);
});
async function request(handler, url, body) {
  const req = Readable.from([JSON.stringify(body)]); req.url = url; req.method = 'POST'; req.headers = {'content-type':'application/json'};
  let status, result;
  await handler(req, {writeHead(s){status=s;},end(data){result=JSON.parse(data);}});
  return {status, result};
}
test('F06C public HTTP boundary has no bootstrap/publish route accepting an authoritative browser cart', async () => {
  let calls=0;
  const handler=createJobHandler({service:{prepare(){calls++;}},authenticate:async()=>{calls++;return 'owner';}});
  for(const path of ['/bootstrap','/refresh','/publish','/cart']) {
    const r=await request(handler,path,{store:STORE,id,owner:'owner',customer_id:null,complete:true,checkout_ready:true,lines:[]});
    assert.equal(r.status,404);
  }
  assert.equal(calls,0);
});
test('F06C public quote ignores asserted owner, complete cart, prices and quantities in request body', async () => {
  let observed;
  const handler=createJobHandler({service:{},authenticate:async()=> 'server-session',quote:{quote:async x=>{observed=x;return {checkout_ready:false};}}});
  const result=await request(handler,'/quote',{owner:'attacker',complete:true,id,quantity:999,unit_price_cents:1});
  assert.equal(result.result.checkout_ready,false);
  assert.equal(observed.owner,'server-session');
  assert.equal(observed.quantity,undefined);
  assert.equal(observed.id,undefined);
});
test('F06C guest/customer proxy witness alone cannot drive existing real job/projector contracts', async t => {
  const s=await fixture(t);
  for(const logged_in_customer_id of ['', '123']) {
    const projector=createCheckoutProjector({jobs:s.jobs,resolveCart:async()=>verifier()(sign({logged_in_customer_id})),loadContext:async()=>{throw Error('Must not load sources');}});
    await assert.rejects(projector.prepare({owner:s.cart.owner,complete:true,cart:s.cart}), /UNVERIFIED_CART/);
  }
  assert.equal(s.preparations[0].checkout_ready,false);
});
test('F06C local current-copy refresh and line-ID churn invalidate previous projection; immutable revision stays fixed', async t => {
  const s=await boundScenario();t.after(()=>s.store.close());
  const revision=s.preparations[0].reference.revision;
  s.context.field={value:s.prepared.value};
  s.cart.lines[0].quantity=5;s.cart.lines[0].id='gid://shopify/CartLine/offline-readded';
  s.input.cart.lines[0].quantity=5;s.input.cart.lines[0].id=s.cart.lines[0].id;
  s.input.cart.lines[0].cost.subtotalAmount.amount='6.00';
  assert.equal(validate(s.input).operations.length,1);
  const next=await s.projector.prepare({copies:9000});
  assert.equal(next.checkout_ready,false);
  assert.equal(next.authority.grants[0].lines[0].quantity,5);
  assert.equal(next.authority.grants[0].lines[0].file_count,3);
  assert.equal(next.authority.grants[0].lines[0].unit_cents,120);
  s.input.shop.authority.value=next.value;
  assert.deepEqual(validate(s.input),{operations:[]});
  assert.equal(price(s.input).operations[0].lineUpdate.price.adjustment.fixedPricePerUnit.amount,'1.20');
  const job=await s.jobs.resolve(s.cart.owner,s.preparations[0].reference);
  assert.equal(job.revision,revision);assert.equal(job.copies,4);
});
test('F06C removed job revocation denies stale checkout and last-line removal requires explicit revocation', async t => {
  const s=await fixture(t);
  s.input.shop.authority.value=revokeAuthority(s.prepared.value,{jobId:s.preparations[0].reference.id});
  assert.equal(validate(s.input).operations.length,1);
  s.cart.lines=[];
  await assert.rejects(s.projector.prepare({}), /UNVERIFIED_CART/);
  assert.equal(JSON.parse(s.input.shop.authority.value).grants.length,0);
});
test('F06C partial, wrong-store, wrong-owner and cross-cart replay inputs cannot produce a new grant', async t => {
  const s=await fixture(t);
  for(const change of [c=>c.complete=false,c=>c.store='1jukgy-dc.myshopify.com',c=>c.owner='another-owner',c=>c.lines[0].reference.revision='old']) {
    const before=structuredClone(s.cart);change(s.cart);await assert.rejects(s.projector.prepare({}));Object.assign(s.cart,before);
  }
  s.context.field={value:s.prepared.value};s.cart.id='gid://shopify/Cart/other-cart';
  await assert.rejects(s.projector.prepare({}), /INVALID_AUTHORITY/);
});
test('F06C a concurrent cart edit after projection cannot be accepted by the candidate checkout validation', async t => {
  const s=await fixture(t);
  const stale=await s.projector.prepare({});
  s.input.cart.lines[0].quantity=6;
  s.input.shop.authority.value=stale.value;
  assert.equal(validate(s.input).operations.length,1);
  // Publication/recalculation are distinct phases. A matching projection still
  // returns false, and this test supplies no real Shopify validation receipt.
  assert.equal(stale.checkout_ready,false);
});
test('F06C customer transition cannot renew an old grant without revocation and new owner authentication', async t => {
  const s=await fixture(t);
  s.context.field={value:s.prepared.value};s.cart.customer_id='gid://shopify/Customer/123';
  await assert.rejects(s.projector.prepare({}), /CART_OWNER_CHANGED/);
  s.input.cart.buyerIdentity={isAuthenticated:true,customer:{id:s.cart.customer_id}};
  assert.equal(validate(s.input).operations.length,1);
});
