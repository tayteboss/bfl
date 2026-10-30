import { VARIANT } from '../../../shared/jobs.js';

// F02 only: permit the synthetic carrier code or native pickup for affected groups.
export function cartDeliveryOptionsTransformRun(input) {
  const operations = [];
  for (const group of input.cart.deliveryGroups) {
    if (!group.cartLines.some(line => line.merchandise?.id === VARIANT)) continue;
    for (const option of group.deliveryOptions) {
      if (option.deliveryMethodType === 'PICK_UP') continue;
      if (option.deliveryMethodType === 'SHIPPING' && option.code === 'F02_TEST_PRINT') continue;
      operations.push({ deliveryOptionHide: { deliveryOptionHandle: option.handle } });
    }
  }
  return { operations };
}
