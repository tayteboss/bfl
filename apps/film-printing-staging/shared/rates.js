import { inspectJob, lineFromCarrier } from './jobs.js';

// Synthetic transport probe, deliberately NOT FedEx rates or merchant packing.
export function quoteSynthetic(request) {
  const rate = request?.rate;
  if (!rate || rate.currency !== 'USD' || rate.destination?.country !== 'US' ||
      rate.origin?.postal_code !== '33127' || !Array.isArray(rate.items) ||
      !rate.items.length || rate.items.length > 20) return { rates: [] };
  const jobs = rate.items.map(item => inspectJob(lineFromCarrier(item)));
  if (jobs.some(job => !job.valid)) return { rates: [] };
  const total = jobs.reduce((sum, job) => sum + Math.ceil(job.physicalCount / 10) * job.packageCents, 0);
  return { rates: [{ service_name: 'F02 test shipping', service_code: 'F02_TEST_PRINT',
    description: 'Synthetic staging probe only — not FedEx pricing', currency: 'USD', total_price: String(total) }] };
}
