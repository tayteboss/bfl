import { digest, freeze } from '../configuration/config.mjs';
import { validateDestination } from './quote.mjs';

// Narrow TEST-only preflight, not a complete carrier compliance engine. Sources
// and deliberately unsupported paths are recorded in the F04D handoff.
const states = new Set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' '));
const reference = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 500;
const instant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value.replace('Z','.000Z');
const sameOption = (a,b) => a && b && a.carrier === b.carrier && a.account_id === b.account_id && a.service_token === b.service_token;

// inventory/reviews are PRIVATE SERVER INPUTS, never cart properties or browser
// confirmations. A hash binds evidence; it does not authenticate its author.
// Each review must be assembled by the operator from independently checked facts.
// No review is generated from a quote, inventory service token or numeric fit.
export function createShippoTestEligibility({inventory, reviews = [], now = Date.now} = {}) {
  const saved = freeze(structuredClone({inventory:inventory ?? null,reviews:Array.isArray(reviews) ? reviews : []}));
  function inspect(shipment, option) {
    const reasons = [];
    const need = (ok,code) => { if (!ok) reasons.push(code); };
    if (!shipment || typeof shipment !== 'object') return freeze({eligible:false,mode:'test',checkout_ready:false,reasons:['INVALID_SHIPMENT']});
    const time = now();
    need(Number.isFinite(time), 'INVALID_CLOCK');
    need(shipment?.policy?.provider === 'shippo' && shipment.policy.shippo?.mode === 'test' && shipment.currency === 'USD', 'TEST_ONLY');
    need(Array.isArray(shipment?.policy?.shippo?.services) && shipment.policy.shippo.services.some(o => sameOption(o,option)), 'UNCONFIGURED_SERVICE');
    need(option?.carrier === 'USPS' && option.service_token === 'usps_ground_advantage', 'SERVICE_NOT_IMPLEMENTED');
    const inv = saved.inventory;
    need(inv?.mode === 'test' && inv.complete === true, 'INCOMPLETE_TEST_INVENTORY');
    const matches = Array.isArray(inv?.accounts) ? inv.accounts.filter(a => a?.object_id === option?.account_id) : [];
    const account = matches[0];
    need(matches.length === 1 && account.carrier === 'usps' && account.test === true && account.active === true &&
      account.is_shippo_account === true && [true,null].includes(account.owner_matches) && ['connected','unverified'].includes(account.authentication_status) &&
      Array.isArray(account.service_tokens) && account.service_tokens.includes(option?.service_token), 'TEST_ACCOUNT_UNAVAILABLE');
    // A Shippo-provided USPS test account needs Bellows test-key provenance, not
    // invented own-account authentication. Unknown owner/auth flags stay unknown.
    const reviews = saved.reviews.filter(r => sameOption(r?.option,option) && r.shipment_sha256 === digest(shipment) && r.inventory_sha256 === digest(inv));
    need(reviews.length === 1, 'EXACT_REVIEW_REQUIRED');
    const review = reviews[0];
    need(instant(review?.reviewed_at) && instant(review?.expires_at) && Date.parse(review.reviewed_at) <= time &&
      Date.parse(review.expires_at) > time && Date.parse(review.expires_at)-Date.parse(review.reviewed_at) <= 86400000, 'REVIEW_EXPIRED_OR_INVALID');
    for (const key of ['connection','origin','destination','physical','packaging','tender']) {
      need(reference(review?.references?.[key]), `MISSING_${key.toUpperCase()}_EVIDENCE`);
    }
    for (const [key,a] of [['ORIGIN',shipment?.origin],['DESTINATION',shipment?.destination]]) {
      let valid = true;
      try { validateDestination(a,{allowPOBox:true}); } catch { valid = false; }
      need(valid && states.has(a?.province_code) && /^\d{5}(?:-\d{4})?$/.test(a?.postal_code ?? '') &&
        (reference(a?.name) || reference(a?.company)), `${key}_NOT_SUPPORTED`);
    }
    // 50 states + DC only in this initial implementation. Territories/military
    // remain pending service/customs checks; the retained policy is not narrowed.
    need(instant(shipment?.shipment_date) && Date.parse(shipment.shipment_date) > time, 'DISPATCH_TIME_REQUIRED');
    need(shipment?.tender?.carrier === 'USPS' && ['post_office_counter','scheduled_pickup'].includes(shipment.tender.method), 'TENDER_NOT_SUPPORTED');
    need(Array.isArray(shipment?.parcels) && shipment.parcels.length === 1, 'USPS_SINGLE_PARCEL_ONLY');
    const physical = review?.physical;
    need(physical?.contents === 'finished_paper_prints_only' && physical.packaging === 'own' &&
      physical.shape === 'rectangular' && physical.rigid === true && physical.labels_fit === true, 'PACKAGING_NOT_SUPPORTED');
    // Rigid rectangular own-packaging only. Do not infer tube diameter/girth,
    // wall strength, sealing, flexible-mailer classification or branded supplies.
    for (const p of Array.isArray(shipment.parcels) ? shipment.parcels : []) {
      const dimensions = ['length','width','height'].map(k => p?.dimensions_in?.[k]);
      const exact = value => typeof value === 'number' && value > 0 && /^\d{1,6}(?:\.\d{1,4})?$/.test(String(value));
      need(dimensions.every(exact) && exact(p?.weight_oz), 'INVALID_MEASUREMENTS');
      const [length,width,height] = dimensions.sort((a,b) => b-a);
      need(p?.weight_oz <= 70*16 && length + 2*(width+height) <= 130, 'USPS_SIZE_WEIGHT_LIMIT');
    }
    return freeze({eligible:reasons.length === 0,mode:'test',checkout_ready:false,reasons});
  }
  return {inspect, checkEligibility:async (shipment,option,{signal}) => !signal.aborted && inspect(shipment,option).eligible};
}
