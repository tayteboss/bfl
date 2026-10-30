// Finite synthetic manifest for F02 API proof. Never merchant configuration.
export const STORE = 'bellows-film-printing-staging.myshopify.com';
export const VARIANT = 'gid://shopify/ProductVariant/67852705202287';
export const MIAMI = 'gid://shopify/Location/92443803759';
export const VERSION = 'f02-synthetic-v1';
export const ASSETS = [
  'https://example.invalid/f02/a.jpg',
  'https://example.invalid/f02/b.jpg',
  'https://example.invalid/f02/c.jpg',
];
export const SPECS = {
  'photo-4x6-three': { size: '4" x 6"', files: 3, packageCents: 701 },
  'photo-8x10-three': { size: '8" x 10"', files: 3, packageCents: 1103 },
  'photo-4x6-one': { size: '4" x 6"', files: 1, packageCents: 701 },
};
export const ATTRIBUTE_KEYS = {
  spec: '_bfl_spec', job: '_bfl_job_id', version: '_bfl_spec_version',
  service: 'Service', size: 'Sizes', lab: 'Location', files: 'Files Uploaded',
  upload1: 'Uploaded File 1', upload2: 'Uploaded File 2', upload3: 'Uploaded File 3',
};

export function propertiesFor(specId, jobId) {
  const spec = SPECS[specId];
  if (!spec) throw new Error('Unknown synthetic specification');
  return {
    _bfl_spec: specId, _bfl_job_id: jobId, _bfl_spec_version: VERSION,
    Service: 'Photo Prints', Sizes: spec.size, Location: 'Miami',
    'Files Uploaded': String(spec.files),
    ...Object.fromEntries(ASSETS.slice(0, spec.files).map((url, i) => [`Uploaded File ${i + 1}`, url])),
    _custom_price_cents: String(250 * spec.files), _fallback_price_cents: String(250 * spec.files),
    'Total Price': '$2.50',
  };
}

export function inspectJob(line) {
  if (line.merchandise?.id !== VARIANT) return { targeted: false };
  const value = key => line[key]?.value ?? '';
  const spec = SPECS[value('spec')];
  const valid = spec && value('version') === VERSION &&
    /^f02-[a-zA-Z0-9-]{1,60}$/.test(value('job')) &&
    value('service') === 'Photo Prints' && value('size') === spec.size &&
    value('lab') === 'Miami' && value('files') === String(spec.files) &&
    Number.isInteger(line.quantity) && line.quantity > 0 && line.quantity <= 99 &&
    !line.sellingPlanAllocation && [1, 2, 3].every(i =>
      value(`upload${i}`) === (i <= spec.files ? ASSETS[i - 1] : ''));
  if (!valid) return { targeted: true, valid: false };
  return { targeted: true, valid: true, unitCents: 250 * spec.files,
    physicalCount: spec.files * line.quantity, locationId: MIAMI,
    packageCents: spec.packageCents, jobId: value('job') };
}

export function lineFromCarrier(item) {
  const properties = Array.isArray(item.properties)
    ? Object.fromEntries(item.properties.map(p => [p.name, p.value])) : (item.properties ?? {});
  return {
    quantity: item.quantity,
    merchandise: { id: `gid://shopify/ProductVariant/${item.variant_id}` },
    ...Object.fromEntries(Object.entries(ATTRIBUTE_KEYS).map(([alias, key]) =>
      [alias, properties[key] == null ? null : { value: String(properties[key]) }])),
  };
}
