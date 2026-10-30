import { inspectJob } from '../../../shared/jobs.js';
export function cartValidationsGenerateRun(input) {
  // Expired or invalid staging lines must remain removable. Checkout still
  // validates every targeted line, including absent/unknown journey steps.
  if (input.buyerJourney?.step === 'CART_INTERACTION') return { operations: [] };
  const errors = input.cart.lines.flatMap((line, index) => {
    const job = inspectJob(line);
    if (!job.targeted || (job.valid && line.cost.amountPerQuantity.currencyCode === 'USD')) return [];
    return [{ message: 'This staging print job is incomplete or invalid. Return to the print form.',
      target: `$.cart.lines[${index}]` }];
  });
  return { operations: errors.length ? [{ validationAdd: { errors } }] : [] };
}
