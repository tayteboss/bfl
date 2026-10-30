/** F07A offline preparation. NOT imported by runtime/theme. No reader or mutation transport.
 * Inputs are proposed trusted-adapter contracts, not browser attestations. Even complete
 * synthetic evidence only produces a review plan; it can never authorize execution.
 */
import {fingerprint} from '../jobs/lifecycle.mjs';
import {freeze} from '../configuration/config.mjs';

export const LIMITS = Object.freeze({lines: 100, bytes: 262144, removals: 20});
const roles = new Set(['legacy-print', 'print-companion', 'current-print', 'send-rolls', 'return-shipping']);
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const text = x => typeof x === 'string' && x.length > 0 && x.length <= 256 && !/[\x00-\x1f\x7f]/.test(x);
const id = x => typeof x === 'string' && /^[1-9]\d{0,19}$/.test(x);
const need = (ok, reason) => { if (!ok) throw new Error(reason); };
const result = (state, reasons, extra = {}) => freeze({state, reasons, executable: false, checkout_ready: false, ...extra});
const hints = p => Object.keys(p).some(k => k.startsWith('_bfl_'));
const returning = p => p._role === 'return_shipping' || p._return_shipping_required === 'true' ||
  Object.entries(p).some(([k,v]) => k.toLowerCase().includes('negatives shipped back') && String(v).toLowerCase() === 'yes');

// JSON-only data, bounded before canonical hashing; no raw cart/file data in results.
function validateSnapshot(s) {
  const bytes = JSON.stringify(s);
  need(bytes && Buffer.byteLength(bytes) <= LIMITS.bytes, 'SNAPSHOT_BOUNDS');
  need(object(s) && text(s.store) && text(s.cart_binding) && Array.isArray(s.items) && s.items.length <= LIMITS.lines,
    'SNAPSHOT_INVALID');
  const keys = new Set();
  for (const l of s.items) {
    need(object(l) && text(l.key) && !/^\d+$/.test(l.key) && !keys.has(l.key), 'LINE_KEY_INVALID');
    keys.add(l.key);
    need(id(l.product_id) && id(l.variant_id) && Number.isSafeInteger(l.quantity) && l.quantity > 0 &&
      object(l.properties) && Object.entries(l.properties).every(([k,v]) => text(k) && ['string','number','boolean'].includes(typeof v)),
      'LINE_INVALID');
    need(!l.parent_relationship && !l.components && !l.selling_plan, 'LINE_UNSUPPORTED');
  }
  return fingerprint(s);
}

function validateMap(m, store) {
  need(object(m) && m.store === store && text(m.review_ref) && Array.isArray(m.entries), 'IDENTITY_REVIEW_MISSING');
  // There is no production or real staging configuration shipped with this module.
  need(['synthetic', 'isolated-staging'].includes(m.environment), 'TARGET_UNSUPPORTED');
  need(m.environment !== 'synthetic' || store.endsWith('.invalid'), 'SYNTHETIC_TARGET_REQUIRED');
  need(m.environment !== 'isolated-staging' || store === 'bellows-film-printing-staging.myshopify.com', 'TARGET_UNSUPPORTED');
  const products = new Map(), variants = new Set();
  for (const e of m.entries) {
    need(object(e) && id(e.product_id) && id(e.variant_id) && roles.has(e.kind), 'IDENTITY_MAP_INVALID');
    need(!variants.has(e.variant_id) && (!products.has(e.product_id) || products.get(e.product_id) === e.kind), 'IDENTITY_MAP_CONFLICT');
    if (m.environment === 'isolated-staging') {
      // Only the independently recorded F00 identity is known. No companion/SR IDs invented.
      need(e.product_id === '15620086005871' && e.variant_id === '67852705202287' && e.kind === 'current-print',
        'STAGING_IDENTITY_UNREVIEWED');
    }
    products.set(e.product_id,e.kind); variants.add(e.variant_id);
  }
  return m.entries;
}

/** Evidence must originate outside cart properties: full-snapshot review, exact main
 * lineage and COMPLETE companion set, or exact immutable current-job resolution.
 * No implementation exists here to obtain that evidence from real carts/owners/jobs.
 */
export function classifyLegacyCart({snapshot, identities, evidence, pending = true} = {}) {
  try {
    const snapshot_hash = validateSnapshot(snapshot);
    const entries = validateMap(identities, snapshot.store);
    need(pending === false, 'PENDING_OR_UNKNOWN_OPERATION');
    need(object(evidence) && evidence.snapshot_hash === snapshot_hash && evidence.identity_hash === fingerprint(identities) &&
      text(evidence.review_ref) && Array.isArray(evidence.groups) && Array.isArray(evidence.current), 'INDEPENDENT_EVIDENCE_MISSING');
    const rows = snapshot.items.map(l => {
      const matches = entries.filter(e => e.product_id === l.product_id || e.variant_id === l.variant_id);
      const exact = matches.find(e => e.product_id === l.product_id && e.variant_id === l.variant_id);
      need(matches.length === 0 || exact && matches.every(e => e.product_id === l.product_id), 'LINE_IDENTITY_CONFLICT');
      return {line: l, kind: exact?.kind ?? 'unrelated'};
    });
    const byKey = new Map(rows.map(r => [r.line.key,r]));
    const groups = new Map(), children = new Set(), verified = new Set();
    for (const g of evidence.groups) {
      need(object(g) && text(g.proof_ref) && g.complete === true && text(g.main) && Array.isArray(g.companions) &&
        !groups.has(g.main) && g.companions.length > 0, 'ASSOCIATION_INCOMPLETE');
      need(byKey.get(g.main)?.kind === 'legacy-print', 'ASSOCIATION_MAIN_INVALID');
      for (const key of g.companions) {
        need(text(key) && !children.has(key) && byKey.get(key)?.kind === 'print-companion', 'ASSOCIATION_CONFLICT');
        children.add(key);
      }
      groups.set(g.main,g.companions);
    }
    for (const c of evidence.current) {
      need(object(c) && text(c.key) && text(c.proof_ref) && c.state === 'verified-active-immutable' &&
        !verified.has(c.key) && ['current-print','legacy-print'].includes(byKey.get(c.key)?.kind), 'CURRENT_JOB_UNRESOLVED');
      need(hints(byKey.get(c.key).line.properties) && !groups.has(c.key), 'CURRENT_JOB_CONFLICT');
      verified.add(c.key);
    }
    const remove = [], preserve = [], holds = [];
    for (const {line:l,kind} of rows) {
      const p = l.properties, claim = hints(p);
      if ((kind === 'legacy-print' && p._role != null) ||
          (kind === 'print-companion' && p._role !== 'shipping_size')) holds.push('ROLE_CONFLICT');
      if (claim) {
        preserve.push(l.key);
        if (!verified.has(l.key)) holds.push('CURRENT_JOB_UNRESOLVED');
      } else if (kind === 'send-rolls' || kind === 'return-shipping') {
        preserve.push(l.key);
      } else if (returning(p)) {
        preserve.push(l.key);
        if (kind !== 'unrelated') holds.push('RETURN_DEPENDENCY_CONFLICT');
      } else if (kind === 'legacy-print') {
        if (groups.has(l.key)) remove.push(l.key);
        else { preserve.push(l.key); holds.push('LEGACY_LINEAGE_MISSING'); }
      } else if (kind === 'print-companion') {
        if (children.has(l.key)) remove.push(l.key);
        else { preserve.push(l.key); holds.push('ORPHAN_OR_UNPROVEN_COMPANION'); }
      } else {
        preserve.push(l.key);
        if (kind === 'current-print') holds.push('CURRENT_JOB_UNRESOLVED');
        if (kind === 'unrelated' && (['film-printing','film-service','print-shipping','print-size-shipping-items'].includes(l.handle) || p._role === 'shipping_size'))
          holds.push('UNMAPPED_IDENTITY_HINT');
      }
    }
    // Timestamps never establish lineage. Conflicting/missing hints veto even reviewed
    // groups; multiple companions sharing ONE main's timestamp are legitimate.
    for (const [main, companions] of groups) {
      const ts = byKey.get(main).line.properties._timestamp;
      if (!/^[1-9]\d{9,15}$/.test(String(ts ?? '')) || rows.filter(r => String(r.line.properties._timestamp ?? '') === String(ts)).length !== 1 ||
          companions.some(k => String(byKey.get(k).line.properties._parent_timestamp ?? '') !== String(ts)))
        holds.push('TIMESTAMP_AMBIGUOUS');
      if (companions.some(k => !remove.includes(k)) || !remove.includes(main)) holds.push('GROUP_HELD');
    }
    if (remove.length > LIMITS.removals) holds.push('REMOVAL_BOUNDS');
    return result(holds.length ? 'hold' : remove.length ? 'review-only' : 'no-change', [...new Set(holds)], {
      snapshot_hash, identity_hash: fingerprint(identities), evidence_hash: fingerprint(evidence),
      remove_keys: holds.length ? [] : remove, preserve_keys: holds.length ? snapshot.items.map(l=>l.key) : preserve,
    });
  } catch (e) {
    const reason = /^[A-Z_]+$/.test(e.message) ? e.message : 'INPUT_INVALID';
    return result('hold',[reason],{remove_keys: [], preserve_keys: []});
  }
}

/** Private in-memory review intent; no global journal, endpoint, credentials, IO or
 * mutation callback. A fresh equal snapshot detects drift, NOT a remote CAS lock.
 * Restart requires a NEW review; nothing is replayed or recovered automatically.
 */
export function prepareLegacyTransition(input) {
  const plan = classifyLegacyCart(input);
  const baseline = structuredClone(input?.snapshot ?? null);
  let spent = false;
  return Object.freeze({
    plan,
    inspectFresh(freshInput) {
      if (spent) return result('hold',['INTENT_ALREADY_INSPECTED']);
      spent = true;
      const fresh = classifyLegacyCart(freshInput);
      if (plan.state !== 'review-only' || fresh.state !== 'review-only') return result('hold',['PLAN_NOT_REVIEWABLE']);
      if (fingerprint(plan) !== fingerprint(fresh)) return result('hold',['SNAPSHOT_OR_REVIEW_CHANGED']);
      // Review representation only; not a sendable URL, batch or supported atomic request.
      return result('transport-disabled',['NO_ATOMIC_COMPARE_AND_REMOVE'], {
        proposed_changes: plan.remove_keys.map(key => ({id:key,quantity:0})),
      });
    },
    observeOutcome({snapshot, outcome = 'unknown'} = {}) {
      // This method records a hypothetical/future external outcome. Never dispatches,
      // clears unknown state, retries, rolls back, restores authority or changes a job.
      spent = true;
      if (!['acknowledged','unknown','partial','rejected'].includes(outcome)) return result('hold',['OUTCOME_INVALID']);
      try {
        validateSnapshot(snapshot);
        need(plan.state === 'review-only' && snapshot.store === baseline.store && snapshot.cart_binding === baseline.cart_binding, 'OBSERVATION_INVALID');
        const removed = plan.remove_keys.filter(k => !snapshot.items.some(l=>l.key===k));
        const retainedBefore = baseline.items.filter(l=>!plan.remove_keys.includes(l.key));
        const retainedAfter = snapshot.items.filter(l=>!plan.remove_keys.includes(l.key));
        const status = removed.length === 0 ? 'targets-present' : removed.length === plan.remove_keys.length ? 'targets-absent' : 'partial';
        return result('hold',['FRESH_REVIEW_REQUIRED'], {observation:status, outcome,
          preserved_lines_equal: fingerprint(retainedBefore) === fingerprint(retainedAfter),
          // Price/attribute/delivery differences are diagnostics, never overwritten.
          cart_context_equal: fingerprint({...baseline,items:[]}) === fingerprint({...snapshot,items:[]}),
        });
      } catch { return result('hold',['OUTCOME_UNOBSERVED']); }
    },
  });
}
