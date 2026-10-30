import { inspectJob } from '../../../shared/jobs.js';
export function cartTransformRun(input) {
  return { operations: input.cart.lines.flatMap(line => {
    const job = inspectJob(line);
    if (!job.valid || line.cost.amountPerQuantity.currencyCode !== 'USD') return [];
    return [{ lineUpdate: { cartLineId: line.id,
      price: { adjustment: { fixedPricePerUnit: { amount: (job.unitCents / 100).toFixed(2) } } } } }];
  }) };
}
