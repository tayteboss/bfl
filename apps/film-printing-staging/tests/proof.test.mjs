import test from 'node:test';
import assert from 'node:assert/strict';
import { propertiesFor, lineFromCarrier, inspectJob, MIAMI, VARIANT } from '../shared/jobs.js';
import { quoteSynthetic } from '../shared/rates.js';
import { cartTransformRun } from '../extensions/f02-print-pricing/src/cart_transform_run.js';
import { cartValidationsGenerateRun } from '../extensions/f02-print-validation/src/cart_validations_generate_run.js';
import { cartFulfillmentConstraintsGenerateRun } from '../extensions/f02-print-lab/src/cart_fulfillment_constraints_generate_run.js';

function item(spec = 'photo-4x6-three', quantity = 4, id = 'f02-A') {
  return { variant_id: 67852705202287, quantity, properties: propertiesFor(spec, id) };
}
function line(source = item()) {
  return { ...lineFromCarrier(source), id: 'gid://shopify/CartLine/test',
    cost: { amountPerQuantity: { currencyCode: 'USD' } } };
}
const input = lines => ({ cart: { lines } });
const rate = items => ({ rate: { origin: { postal_code: '33127' },
  destination: { country: 'US' }, currency: 'USD', items } });
const price = lines => cartTransformRun(input(lines));
const errors = lines => cartValidationsGenerateRun(input(lines));

test('three files x four copies = 12 prints; fixed price is $7.50 per copy', () => {
  const l = line();
  assert.equal(inspectJob(l).physicalCount, 12);
  assert.equal(price([l]).operations[0].lineUpdate.price.adjustment.fixedPricePerUnit.amount, '7.50');
  assert.deepEqual(errors([l]), { operations: [] });
});
test('browser price tampering cannot lower the authoritative Function price', () => {
  const i = item(); i.properties._custom_price_cents = '1'; i.properties._fallback_price_cents = '1';
  assert.equal(price([line(i)]).operations[0].lineUpdate.price.adjustment.fixedPricePerUnit.amount, '7.50');
});
test('file-count tampering, duplicate assets, failed uploads and unknown specs reject', () => {
  for (const [key, value] of [['Files Uploaded', '1'], ['Uploaded File 2', 'https://example.invalid/f02/a.jpg'],
    ['Uploaded File 3', ''], ['_bfl_spec', 'unknown'], ['Location', 'Chicago'], ['Sizes', '20x30'],
    ['_bfl_spec_version', 'old'], ['Service', 'Darkroom Prints']]) {
    const i = item(); i.properties[key] = value;
    assert.equal(errors([line(i)]).operations[0].validationAdd.errors.length, 1, key);
    assert.deepEqual(price([line(i)]), { operations: [] }, key);
    assert.deepEqual(quoteSynthetic(rate([i])), { rates: [] }, key);
  }
});
test('direct variant purchase with absent metadata is blocked for all delivery paths', () => {
  const l = line({ variant_id: 67852705202287, quantity: 1, properties: {} });
  assert.equal(errors([l]).operations[0].validationAdd.errors.length, 1);
});
test('invalid quantities, selling plans and non-USD pricing are rejected', () => {
  for (const quantity of [0, -1, 1.5, 100]) assert.ok(errors([line(item(undefined, quantity))]).operations.length);
  const sub = line(); sub.sellingPlanAllocation = { sellingPlan: { id: 'test' } };
  assert.ok(errors([sub]).operations.length);
  const foreign = line(); foreign.cost.amountPerQuantity.currencyCode = 'AUD';
  assert.ok(errors([foreign]).operations.length);
  assert.deepEqual(price([foreign]), { operations: [] });
});
test('unrelated and Send Rolls variants remain untouched', () => {
  const unrelated = { id: 'other', merchandise: { id: 'gid://shopify/ProductVariant/999' }, quantity: 3 };
  assert.deepEqual(price([unrelated]), { operations: [] });
  assert.deepEqual(errors([unrelated]), { operations: [] });
  assert.deepEqual(cartFulfillmentConstraintsGenerateRun({ cart: { deliverableLines: [unrelated] } }), { operations: [] });
});
test('same variant, distinct jobs remain separate in Function operations', () => {
  const a = line(); const b = line(item('photo-8x10-three', 4, 'f02-B')); b.id = 'gid://shopify/CartLine/b';
  assert.equal(a.merchandise.id, VARIANT);
  assert.equal(price([a, b]).operations.length, 2);
  assert.notEqual(price([a, b]).operations[0].lineUpdate.cartLineId, price([a, b]).operations[1].lineUpdate.cartLineId);
});
test('lab output constrains each valid deliverable line to Miami', () => {
  const result = cartFulfillmentConstraintsGenerateRun({ cart: { deliverableLines: [line()] } });
  assert.deepEqual(result.operations[0].deliverableLinesMustFulfillFromAdd.locationIds, [MIAMI]);
  assert.deepEqual(result.operations[0].deliverableLinesMustFulfillFromAdd.deliverableLineIds, ['gid://shopify/CartLine/test']);
});
test('synthetic callback changes rate for size, count and multiple distinct jobs', () => {
  for (const [items, expected] of [[[item()], '1402'], [[item('photo-8x10-three')], '2206'],
    [[item(undefined, 2)], '701'], [[item('photo-4x6-one')], '701'],
    [[item(), item('photo-8x10-three', 4, 'f02-B')], '3608']]) {
    assert.equal(quoteSynthetic(rate(items)).rates[0].total_price, expected);
  }
});
test('callback refuses missing properties, unknown origin/destination, currency and unrelated item', () => {
  for (const mutation of [r => { r.rate.items[0].properties = null; }, r => { r.rate.origin.postal_code = '99999'; },
    r => { r.rate.destination.country = 'CA'; }, r => { r.rate.currency = 'AUD'; },
    r => { r.rate.items.push({ variant_id: 999, quantity: 1 }); }]) {
    const r = rate([item()]); mutation(r); assert.deepEqual(quoteSynthetic(r), { rates: [] });
  }
});
test('object and name/value property representations retain the same contract', () => {
  const i = item(); const object = lineFromCarrier(i);
  i.properties = Object.entries(i.properties).map(([name, value]) => ({ name, value }));
  assert.deepEqual(lineFromCarrier(i), object);
});

test('delivery guard excludes flat/backup shipping while retaining approved carrier and native pickup', async () => {
  const {cartDeliveryOptionsTransformRun} = await import('../extensions/f02-print-delivery/src/cart_delivery_options_transform_run.js');
  const options=[{handle:'flat',code:'Standard',deliveryMethodType:'SHIPPING'}, {handle:'carrier',code:'F02_TEST_PRINT',deliveryMethodType:'SHIPPING'}, {handle:'pickup',code:null,deliveryMethodType:'PICK_UP'}, {handle:'backup',code:null,deliveryMethodType:'SHIPPING'}];
  const group={cartLines:[{merchandise:{id:VARIANT}}],deliveryOptions:options};
  assert.deepEqual(cartDeliveryOptionsTransformRun({cart:{deliveryGroups:[group]}}),{operations:[{deliveryOptionHide:{deliveryOptionHandle:'flat'}},{deliveryOptionHide:{deliveryOptionHandle:'backup'}}]});
  group.cartLines[0].merchandise.id='gid://shopify/ProductVariant/999';
  assert.deepEqual(cartDeliveryOptionsTransformRun({cart:{deliveryGroups:[group]}}),{operations:[]});
});
