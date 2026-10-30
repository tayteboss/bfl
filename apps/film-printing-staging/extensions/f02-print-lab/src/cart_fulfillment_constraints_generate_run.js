import { inspectJob } from '../../../shared/jobs.js';
export function cartFulfillmentConstraintsGenerateRun(input) {
  return { operations: input.cart.deliverableLines.flatMap(line => {
    const job = inspectJob(line);
    return job.valid ? [{ deliverableLinesMustFulfillFromAdd: {
      deliverableLineIds: [line.id], locationIds: [job.locationId],
    } }] : [];
  }) };
}
