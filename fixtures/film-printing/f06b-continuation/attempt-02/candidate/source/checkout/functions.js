import { inspectCart, targeted, attribute } from './authority.js';

export function cartTransformRun(input) {
  const checked = inspectCart(input);
  return { operations: checked.valid ? checked.lines.map(l => ({ lineUpdate: {
    cartLineId: l.id, price: { adjustment: { fixedPricePerUnit: { amount: (l.unit_cents/100).toFixed(2) } } },
  } })) : [] };
}

const cents = value => typeof value === 'string' && /^\d+(?:\.\d{1,2})?$/.test(value) ? Math.round(Number(value)*100) : null;
export function cartValidationsGenerateRun(input) {
  // Shopify must first create a real line ID, and shoppers must be able to remove
  // invalid lines. Only the trusted Shopify journey field permits cart edits;
  // checkout interaction/completion (including absent/unknown steps) stay gated.
  if (input.buyerJourney?.step === 'CART_INTERACTION') return { operations: [] };
  const checked = inspectCart(input);
  // subtotal is explicitly before line discounts; detect missing/failed pricing.
  const priceValid = checked.lines.every(l => cents(l.line.cost?.subtotalAmount?.amount) === l.unit_cents*l.quantity);
  const mappingValid = checked.lines.every(l => (input.cart.deliverableLines??[]).filter(d=>attribute(d,'job')===l.claims.job).length===1);
  const errors = checked.valid && priceValid && mappingValid ? [] : checked.targeted.map(line => ({
    message: 'This staging print job is unavailable or has changed. Return to the print form.',
    target: `$.cart.lines[${input.cart.lines.indexOf(line)}]`,
  }));
  return { operations: errors.length ? [{ validationAdd: { errors } }] : [] };
}

export function cartFulfillmentConstraintsGenerateRun(input) {
  const checked = inspectCart(input);
  if (!checked.valid) return { operations: [] }; // Validation is the checkout gate.
  const deliverable = input.cart.deliverableLines ?? [];
  return { operations: checked.lines.flatMap(l => {
    // Deliverable IDs need not equal CartLine IDs. Join only on the unique job.
    const matches = deliverable.filter(d => attribute(d,'job') === l.claims.job);
    if (matches.length !== 1) return [];
    return [{ deliverableLinesMustFulfillFromAdd: { deliverableLineIds: [matches[0].id], locationIds: [l.location_id] } }];
  }) };
}

export function cartDeliveryOptionsTransformRun(input) {
  const checked = inspectCart(input);
  const ids = new Set(checked.targeted.map(l=>l.id));
  const operations = [];
  for (const group of input.cart.deliveryGroups ?? []) {
    if (!group.cartLines.some(l => ids.has(l.id) || targeted(l))) continue;
    for (const option of group.deliveryOptions) {
      // F06A authorizes no carrier transport. Valid jobs retain native pickup.
      if (checked.valid && option.deliveryMethodType === 'PICK_UP') continue;
      operations.push({ deliveryOptionHide: { deliveryOptionHandle: option.handle } });
    }
  }
  return { operations };
}
