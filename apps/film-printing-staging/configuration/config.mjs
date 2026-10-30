import { createHash } from 'node:crypto';
import { definitions, groupTypes, STORE } from './schema.mjs';
import {assertEngineeringConfig} from './engineering.mjs';

export class ConfigurationError extends Error {
  constructor(code, detail) { super(`${code}: ${detail}`); this.code = code; }
}
const fail = (code, detail) => { throw new ConfigurationError(code, detail); };
const check = (ok, detail) => { if (!ok) fail('INVALID_CONFIGURATION', detail); };
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const text = x => typeof x === 'string' && x.trim().length > 0;
const number = (x, max) => typeof x === 'number' && Number.isFinite(x) && x > 0 && x <= max;
const integer = (x, max) => Number.isSafeInteger(x) && x > 0 && x <= max;
const id = x => typeof x === 'string' && /^[a-z0-9][a-z0-9_-]{0,80}$/.test(x);
const oneOf = (x, values) => values.includes(x);

export function validateConfig(config,{sourceScope,intent='admit'}={}) {
  const engineering=config?.engineering?assertEngineeringConfig(sourceScope,config,intent):false;
  check(config && config.schema_version === 1 && config.store === STORE, 'schema/store');
  check(Object.keys(config).sort().join() === ['schema_version', 'store', ...Object.keys(groupTypes),...(engineering?['engineering']:[])].sort().join(), 'unknown/missing root fields');
  for (const [group, type] of Object.entries(groupTypes)) {
    const fields = definitions.find(d => d.type === type).fieldDefinitions;
    const allowed = new Set(['id', ...fields.map(f => f.key)]);
    check(Array.isArray(config[group]) && config[group].length > 0 && config[group].length <= 250, `${group} count`);
    const ids = new Set();
    for (const row of config[group]) {
      check(row && id(row.id) && !ids.has(row.id), `${group}: invalid/duplicate id`); ids.add(row.id);
      check(Object.keys(row).every(k => allowed.has(k)), `${row.id}: unknown field`);
      for (const f of fields) {
        const v = row[f.key];
        if (v === undefined || v === null) { check(!f.required, `${row.id}: missing ${f.key}`); continue; }
        check(f.type === 'boolean' ? typeof v === 'boolean' : f.type.startsWith('number_') ?
          typeof v === 'number' && Number.isFinite(v) && (f.type !== 'number_integer' || Number.isSafeInteger(v)) :
          f.type === 'json' ? typeof v === 'object' && !Array.isArray(v) : text(v), `${row.id}: invalid ${f.key}`);
      }
      check(row.enabled || text(row.disabled_reason), `${row.id}: disabled reason required`);
      check(row.provenance && text(row.provenance.source) && text(row.provenance.evidence), `${row.id}: provenance required`);
      check(Object.keys(row.provenance).every(k => ['source','evidence','sha256','range','checked_date'].includes(k)), `${row.id}: unknown provenance field`);
    }
  }
  const packages = new Map(config.packages.map(p => [p.id, p]));
  for (const p of config.packages) {
    check(oneOf(p.kind, ['mailer','box','tube']), `${p.id}: package kind`);
    check([p.length_in,p.width_in,p.height_in].every(x => number(x,1000)) && number(p.empty_weight_oz,100000), `${p.id}: dimensions/weight in inches/ounces`);
    check(oneOf(p.dimensions_status,['confirmed','observed']) && oneOf(p.weight_status,['confirmed','observed']), `${p.id}: evidence status`);
    check(!p.enabled || engineering || (p.dimensions_status === 'confirmed' && p.weight_status === 'confirmed'), `${p.id}: unconfirmed package`);
  }
  const labs = new Map(config.labs.map(l => [l.id,l]));
  const locations = new Set();
  for (const l of config.labs) {
    check(l.id !== 'all_labs', 'All Labs is not a location');
    check(oneOf(l.origin_status,['verified','staging_address_only','identity_test_only','unverified']), `${l.id}: origin status`);
    if (l.location_id != null) {
      check(/^gid:\/\/shopify\/Location\/[1-9]\d*$/.test(l.location_id) && !locations.has(l.location_id), `${l.id}: invalid/duplicate location`);
      locations.add(l.location_id);
    }
    if (l.origin != null) {
      check(Object.keys(l.origin).every(k => ['address1','address2','city','province_code','country_code','postal_code','name','company','phone','email','residential'].includes(k)), `${l.id}: origin fields`);
      check(['address1','city','province_code','postal_code'].every(k => text(l.origin[k])) && l.origin.country_code === 'US' && typeof l.origin.address2 === 'string', `${l.id}: origin values`);
      check(['name','company','phone','email'].every(k => l.origin[k] === undefined || (text(l.origin[k]) && l.origin[k].length <= 100)) &&
        (l.origin.residential === undefined || typeof l.origin.residential === 'boolean'), `${l.id}: origin contact`);
    }
    check(!l.enabled || (l.location_id && l.origin && (engineering || l.origin_status === 'verified')), `${l.id}: origin not verified`);
  }
  const selectors = new Set();
  for (const r of config.rules) {
    check(oneOf(r.service,['photo','fine_art','darkroom']), `${r.id}: service`);
    check(r.lab === 'all_labs' || labs.has(r.lab), `${r.id}: unknown lab`);
    check(r.paper == null || (id(r.paper) && r.paper !== 'all'), `${r.id}: exact paper required, no wildcard`);
    const size = /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/.exec(r.size_key);
    check(size ? number(Number(size[1]),1000) && number(Number(size[2]),1000) && Number(size[1]) <= Number(size[2]) && `${Number(size[1])}x${Number(size[2])}` === r.size_key : ['custom','unspecified'].includes(r.size_key), `${r.id}: normalized size in inches`);
    const key = [r.service,r.size_key,r.paper ?? '',r.lab].join('|');
    check(!selectors.has(key), `${r.id}: ambiguous selector`); selectors.add(key);
    check(r.package_id == null || packages.has(r.package_id), `${r.id}: unknown package`);
    check(r.capacity == null || integer(r.capacity,10000), `${r.id}: capacity`);
    check(r.print_weight_oz == null || number(r.print_weight_oz,100000), `${r.id}: print weight`);
    check(oneOf(r.capacity_status,['confirmed','observed','missing']) && oneOf(r.weight_status,['confirmed','observed','missing']), `${r.id}: evidence status`);
    check(!r.enabled || (size && r.service !== 'darkroom' && r.paper && packages.get(r.package_id)?.enabled && r.capacity && r.print_weight_oz && (engineering || r.capacity_status === 'confirmed' && r.weight_status === 'confirmed') && (r.lab === 'all_labs' || labs.get(r.lab).enabled)), `${r.id}: incomplete/unsupported enabled rule`);
  }
  check(config.policies.length === 1 && config.policies[0].id === 'film-printing', 'one carrier policy required');
  const p = config.policies[0];
  if (p.provider === 'shippo') {
    check(p.service === 'eligible_services' && p.rate_source === 'configured_shippo_accounts', 'Shippo policy');
    const s = p.shippo;
    check(s && Object.keys(s).sort().join() === 'mode,services' && oneOf(s.mode,['test','live']), 'Shippo mode/fields');
    check(Array.isArray(s.services) && s.services.length <= 40 && (!p.enabled || s.services.length > 0), 'Shippo services');
    const keys = new Set(), accounts = new Map();
    const prefixes = {USPS:'usps_',UPS:'ups_',FedEx:'fedex_','DHL Express':'dhl_express_'};
    for (const option of s.services) {
      check(option && Object.keys(option).sort().join() === 'account_id,carrier,service_token', 'Shippo service fields');
      check(typeof option.account_id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(option.account_id), 'Shippo account object ID');
      check(Object.hasOwn(prefixes,option.carrier) && typeof option.service_token === 'string' && /^[a-z0-9_]{1,100}$/.test(option.service_token) && option.service_token.startsWith(prefixes[option.carrier]), 'Shippo carrier/service token');
      const key = `${option.account_id}:${option.service_token}`;
      check(!keys.has(key) && (!accounts.has(option.account_id) || accounts.get(option.account_id) === option.carrier), 'Shippo duplicate/mismatched account');
      keys.add(key); accounts.set(option.account_id,option.carrier);
    }
  } else {
    check(p.provider === 'fedex' && p.service === 'FEDEX_2_DAY' && p.rate_source === 'bellows_own_account' && p.shippo == null, 'unapproved carrier policy');
  }
  check(p.currency === 'USD', 'unapproved currency');
  check(p.markup_basis_points === 0 && p.markup_cents === 0 && p.coverage === 'existing_us_62_regions_subject_to_carrier_eligibility', 'unapproved markup/coverage');
  check(p.failure === 'shipping_unavailable' && p.pickup === 'native_free' && p.sharing === 'unavailable', 'unapproved failure/pickup/sharing policy');
  check(oneOf(p.rate_access,['unverified','verified']) && (!p.enabled || p.rate_access === 'verified'), 'rate access not verified');
  return config;
}

export function resolveRule(config, { service, size_key, paper, lab },options) {
  validateConfig(config,options);
  const location = config.labs.find(l => l.id === lab);
  if (!location) fail('UNKNOWN_LAB', String(lab));
  if (!text(paper)) fail('MISSING_PAPER', 'Exact verified paper is required');
  const matches = config.rules.filter(r => r.service === service && r.size_key === size_key && r.paper === paper);
  const local = matches.filter(r => r.lab === lab);
  const candidates = local.length ? local : matches.filter(r => r.lab === 'all_labs');
  if (candidates.length !== 1) fail(candidates.length ? 'AMBIGUOUS_RULE' : 'MISSING_RULE', 'No unique exact rule');
  // A disabled local override blocks fallback to All Labs.
  if (!location.enabled || !candidates[0].enabled) fail('UNAVAILABLE_RULE', candidates[0].id);
  return candidates[0];
}

export function makeRelease(config,options) {
  validateConfig(config,options);
  const sha256 = digest(config);
  return { version: `f03-${sha256.slice(0,24)}`, sha256, config };
}
export function verifyRelease(release,options) {
  check(release && Object.keys(release).sort().join() === 'config,sha256,version', 'release envelope');
  const expected = makeRelease(release.config,options);
  check(release.version === expected.version && release.sha256 === expected.sha256, 'release digest/version mismatch');
  return release;
}
export function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
