import { verifyRelease, freeze, resolveRule } from '../configuration/config.mjs';

export class ShippingError extends Error {
  constructor(code) { super(code); this.code = code; }
}
export const requireValue = (ok, code) => { if (!ok) throw new ShippingError(code); };
const text = v => typeof v === 'string' && v.length > 0 && v.length <= 200 && v.trim() === v;
const positiveInteger = v => Number.isSafeInteger(v) && v > 0;
const services = new Map([
  ['photo','photo'], ['photo printing','photo'], ['photo prints','photo'],
  ['fine_art','fine_art'], ['fine art printing','fine_art'], ['fine arts','fine_art'],
]);
export function normalizeSize(value) {
  requireValue(typeof value === 'string', 'INVALID_SIZE');
  const match = /^\s*(\d+(?:\.\d+)?)\s*["″”]?\s*[x×]\s*(\d+(?:\.\d+)?)\s*["″”]?\s*$/i.exec(value);
  requireValue(match, 'UNSUPPORTED_SIZE');
  const sides = match.slice(1).map(Number).sort((a,b) => a-b);
  requireValue(sides.every(n => Number.isFinite(n) && n > 0 && n <= 1000), 'INVALID_SIZE');
  return sides.join('x');
}

// SERVER-ONLY input: the caller must resolve ownership, completed uploads and copies.
// Field validation is not authentication. Never pass browser/cart properties here directly.
export function normalizeJob(job) {
  requireValue(job && text(job.id) && text(job.revision) && /^f03-[a-f0-9]{24}$/.test(job.config_version), 'INVALID_JOB');
  requireValue(text(job.lab) && text(job.paper), 'INVALID_JOB');
  const service = services.get(typeof job.service === 'string' ? job.service.trim().toLowerCase() : '');
  requireValue(service, 'UNSUPPORTED_SERVICE');
  requireValue(positiveInteger(job.copies), 'INVALID_COPIES');
  const assets = job.completed_asset_ids;
  requireValue(Array.isArray(assets) && assets.length > 0 && assets.length <= 10000 && assets.every(text) && new Set(assets).size === assets.length, 'INVALID_COMPLETED_ASSETS');
  const physicalCount = job.copies * assets.length;
  requireValue(positiveInteger(physicalCount), 'INVALID_PRINT_COUNT');
  return { id:job.id, revision:job.revision, config_version:job.config_version, lab:job.lab, paper:job.paper,
    service, size_key:normalizeSize(job.size), copies:job.copies, file_count:assets.length, physical_count:physicalCount };
}

// Decimal arithmetic on configuration numbers; do not accumulate rounded pound displays.
function decimal(value) {
  const [mantissa, exponent='0'] = String(value).split('e');
  const [whole, fraction=''] = mantissa.split('.');
  const scale = fraction.length - Number(exponent);
  return scale < 0 ? [BigInt(whole+fraction) * 10n ** BigInt(-scale),0] : [BigInt(whole+fraction),scale];
}
function weightedSum(terms) {
  const values = terms.map(([value,count]) => { const [n,s] = decimal(value); return [n*BigInt(count),s]; });
  const scale = Math.max(...values.map(([,s]) => s));
  const total = values.reduce((sum,[n,s]) => sum + n*10n**BigInt(scale-s),0n);
  const value = Number(`${total}e-${scale}`);
  requireValue(Number.isFinite(value) && value > 0, 'INVALID_PARCEL_WEIGHT');
  return value;
}

// Pure parcel arithmetic shared by the ordinary calculator and the privately
// admitted full-product adapter. The caller verifies the rule/package source and
// authenticates the physical count; this helper grants no fulfillment authority.
export function packPhysicalJob(job,rule,pkg) {
  requireValue(text(job?.id)&&positiveInteger(job.physical_count)&&positiveInteger(rule?.capacity),'INVALID_PRINT_COUNT');
  const count=Math.ceil(job.physical_count/rule.capacity);
  requireValue(count<=200,'PARCEL_LIMIT');
  const parcels=Array.from({length:count},(_,i)=>{
    const printCount=Math.min(rule.capacity,job.physical_count-i*rule.capacity);
    return {sequence:i+1,package_id:pkg.id,rule_id:rule.id,job_id:job.id,print_count:printCount,
      tare_weight_oz:pkg.empty_weight_oz,print_weight_oz:rule.print_weight_oz,
      weight_oz:weightedSum([[pkg.empty_weight_oz,1],[rule.print_weight_oz,printCount]]),
      dimensions_in:{length:pkg.length_in,width:pkg.width_in,height:pkg.height_in}};
  });
  return {job,parcels,total_weight_oz:weightedSum([[pkg.empty_weight_oz,count],[rule.print_weight_oz,job.physical_count]])};
}

// Entire groups come from verified fulfillment context, never inferred by this calculator.
// No splitting or combining jobs to bypass the unresolved merchant sharing policy.
export function packDeliveryGroups(release, input, {sourceScope}={}) {
  freeze(verifyRelease(release,{sourceScope}));
  requireValue(input && Array.isArray(input.jobs) && input.jobs.length > 0 && input.jobs.length <= 100, 'INVALID_JOBS');
  requireValue(Array.isArray(input.groups) && input.groups.length > 0 && input.groups.length <= 20, 'INVALID_GROUPS');
  const jobs = input.jobs.map(normalizeJob);
  requireValue(jobs.every(j => j.config_version === release.version), 'VERSION_MISMATCH');
  const byId = new Map(jobs.map(j => [j.id,j]));
  requireValue(byId.size === jobs.length, 'DUPLICATE_JOB');
  const used = new Set(), groupIds = new Set();
  let parcelCount = 0;
  const groups = input.groups.map(group => {
    requireValue(group && text(group.id) && !groupIds.has(group.id) && Array.isArray(group.job_ids) && group.job_ids.length > 0, 'INVALID_GROUP');
    groupIds.add(group.id);
    requireValue(group.job_ids.every(id => byId.has(id)), 'UNKNOWN_GROUP_JOB');
    const groupJobs = group.job_ids.map(id => byId.get(id));
    requireValue(groupJobs.every(j => j.lab === group.lab), 'CROSS_LAB_GROUP');
    requireValue(groupJobs.length === 1, 'SHARING_UNAVAILABLE');
    const job = groupJobs[0];
    requireValue(!used.has(job.id), 'DUPLICATE_JOB_ASSIGNMENT'); used.add(job.id);
    const lab = release.config.labs.find(l => l.id === group.lab);
    requireValue(lab?.enabled && (lab.origin_status === 'verified' || sourceScope && release.config.engineering), 'ORIGIN_UNAVAILABLE');
    requireValue(group.location_id === lab.location_id, 'LOCATION_MISMATCH');
    const rule = resolveRule(release.config,job,{sourceScope});
    const pkg = release.config.packages.find(p => p.id === rule.package_id);
    const count = Math.ceil(job.physical_count / rule.capacity);
    parcelCount += count;
    requireValue(parcelCount <= 200, 'PARCEL_LIMIT'); // Resource limit, not merchant capacity or carrier eligibility.
    return { id:group.id, lab:lab.id, location_id:lab.location_id, origin:lab.origin,
      ...packPhysicalJob(job,rule,pkg) };
  });
  requireValue(used.size === jobs.length, 'UNASSIGNED_JOB');
  return freeze({ config_version:release.version, config_sha256:release.sha256, groups });
}
