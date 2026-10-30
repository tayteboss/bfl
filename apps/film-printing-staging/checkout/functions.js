import { inspectCart, targeted, attribute } from './authority.js';

export function cartTransformRun(input) {
  const checked = inspectCart(input,{claimScope:'base'});
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
  const checked = inspectCart(input,{claimScope:'base'});
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
  const checked = inspectCart(input,{claimScope:'base'});
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
  const checked = inspectCart(input,{claimScope:'base'});
  const ids = new Set((input.cart?.lines??[]).filter(targeted).map(l=>l.id));
  const operations = [];
  for (const group of input.cart.deliveryGroups ?? []) {
    if (!group.cartLines.some(l => ids.has(l.id))) continue;
    const shippingEligible=group.cartLines.filter(l=>ids.has(l.id)).every(line=>checked.lines.some(approved=>approved.id===line.id&&approved.shipping_eligible!==false));
    for (const option of group.deliveryOptions) {
      // Exact staging TEST service only; invalid jobs and all other rates stay hidden.
      if (checked.valid && (option.deliveryMethodType === 'PICK_UP' || option.deliveryMethodType === 'SHIPPING' && shippingEligible && option.code === 'BFL_SHIPPO_c355361391ae286b9b8d2d4bf6057208a9161b0a5865ac1956d083a9eb46a9c4')) continue;
      operations.push({ deliveryOptionHide: { deliveryOptionHandle: option.handle } });
    }
  }
  return { operations };
}

// Complements the existing validation: together both protected owner leases
// validate every visible selection without exceeding Shopify's query limit.
export function cartSpecificationValidationsGenerateRun(input) {
  if (input.buyerJourney?.step === 'CART_INTERACTION') return {operations:[]};
  const checked=inspectCart(input,{claimScope:'specification'});
  const choosing=input.buyerJourney?.step==='CHECKOUT_INTERACTION';
  const pickupValid=checked.lines.filter(line=>line.shipping_eligible===false).every(line=>{
    const groups=(input.cart.deliveryGroups??[]).filter(group=>group.cartLines.some(item=>item.id===line.id));
    if(groups.length===0)return choosing;
    if(groups.length!==1||groups[0].cartLines.filter(item=>item.id===line.id).length!==1)return false;
    const option=groups[0].selectedDeliveryOption;
    return option==null?choosing:option.deliveryMethodType==='PICK_UP';
  });
  return {operations:checked.valid&&pickupValid||!checked.targeted.length?[]:[{validationAdd:{errors:checked.targeted.map(line=>({
    message:checked.valid&&!pickupValid?'This print selection is available for pickup only. Choose pickup to continue.':'This staging print specification has changed. Return to the print form.',
    target:`$.cart.lines[${input.cart.lines.indexOf(line)}]`,
  }))}}]};
}
