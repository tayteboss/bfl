// Candidate Function contract; not wired to the released F02 extensions.
// Only shop.metafield($app:bfl-checkout, authority) is authority. Attributes are claims.
export const STORE = 'bellows-film-printing-staging.myshopify.com';
export const PRODUCT = 'gid://shopify/Product/15620086005871';
export const VARIANT = 'gid://shopify/ProductVariant/67852705202287';
export const NAMESPACE = '$app:bfl-checkout';
export const KEY = 'authority';
export const MAX_BYTES = 6000;
export const MAX_GRANTS = 8;
export const MAX_LINES = 8;
export const MAX_CART_LINES = 20;
export const ATTRIBUTES = {
  flow: '_bfl_flow', job: '_bfl_job', revision: '_bfl_revision', config: '_bfl_config',
  signature: '_bfl_signature', service: 'Service', size: 'Sizes', paper: 'Paper',
  lab: 'Location', message: 'Message', borders: 'Borders', turnaround: 'Turnaround', files: 'Files Uploaded',
};
const HEX = /^[a-f0-9]{64}$/, CONFIG = /^f03-[a-f0-9]{24}$/, DAY = /^\d{4}-\d{2}-\d{2}$/, SIZE = /^\d+(?:\.\d+)?x\d+(?:\.\d+)?$/;
const ROOT_KEYS = 'schema,store,config_version,config_sha256,price_version,valid_on,grants'.split(',');
const GRANT_KEYS = 'cart,owner,customer_id,lines'.split(',');
const LINE_KEYS = 'id,quantity,unit_cents,file_count,location_id,claims'.split(',');
const CLAIM_KEYS = Object.keys(ATTRIBUTES);
const hex = value => typeof value === 'string' && HEX.test(value);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 200;
const gid = (value, type) => typeof value === 'string' && value.startsWith(`gid://shopify/${type}/`) && value.length <= 200;
const integer = value => Number.isSafeInteger(value) && value > 0 && value <= 10000;
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(k => Object.prototype.hasOwnProperty.call(value,k));
export const attribute = (line, alias) => line?.[alias]?.value ?? '';
export const targeted = line => {
  const merchandise=line.merchandise;
  return merchandise?.id === VARIANT || merchandise?.product?.id === PRODUCT || attribute(line,'flow') !== '';
};

// JSON is published as ASCII (Unicode escaped), so length is the UTF-8 byte count.
// Rejecting non-ASCII also avoids runtime-specific encoders and ambiguous size checks.
export function decodeAuthority(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_BYTES || /[^\x20-\x7e]/.test(raw)) return null;
  let a; try { a = JSON.parse(raw); } catch { return null; }
  if (!exactKeys(a,ROOT_KEYS) ||
      a.schema !== 1 || a.store !== STORE || !CONFIG.test(a.config_version) ||
      !hex(a.config_sha256) || a.config_version !== `f03-${a.config_sha256.slice(0,24)}` ||
      !text(a.price_version) || !DAY.test(a.valid_on) ||
      !Array.isArray(a.grants) || a.grants.length > MAX_GRANTS) return null;
  const carts = new Set(), lineIds = new Set(), jobs = new Set();
  for (const g of a.grants) {
    if (!exactKeys(g,GRANT_KEYS) || !hex(g.cart) || !hex(g.owner) ||
        (g.customer_id !== null && !gid(g.customer_id,'Customer')) || carts.has(g.cart) ||
        !Array.isArray(g.lines) || !g.lines.length || g.lines.length > MAX_LINES) return null;
    carts.add(g.cart);
    for (const l of g.lines) {
      if (!exactKeys(l,LINE_KEYS) || !gid(l.id,'CartLine') ||
          lineIds.has(l.id) || !integer(l.quantity) || !integer(l.file_count) ||
          !Number.isSafeInteger(l.unit_cents) || l.unit_cents <= 0 || l.unit_cents * l.quantity > 200000 ||
          !gid(l.location_id,'Location') || !exactKeys(l.claims,CLAIM_KEYS) ||
          Object.values(l.claims).some(v => typeof v !== 'string' || v.length > 2000) ||
          l.claims.flow !== 'f05' || !text(l.claims.job) || jobs.has(l.claims.job) ||
          !hex(l.claims.revision) || !hex(l.claims.signature) || l.claims.config !== a.config_version ||
          l.claims.files !== String(l.file_count) || !text(l.claims.lab) || !text(l.claims.paper) ||
          !['photo','fine_art'].includes(l.claims.service) || !SIZE.test(l.claims.size)) return null;
      lineIds.add(l.id); jobs.add(l.claims.job);
      if (lineIds.size > MAX_LINES) return null; // Total registry budget, across all carts.
    }
    if (g.lines.reduce((sum,l) => sum + l.unit_cents*l.quantity,0) > 200000) return null;
  }
  return a;
}

// Globally unique Shopify cart-line IDs bind the grant to the current cart. No
// browser cart token/nonce is trusted. A replacement line requires fresh authority.
export function inspectCart(input) {
  const lines = input.cart?.lines ?? [];
  if (lines.length > MAX_CART_LINES) {
    // One error blocks checkout. Avoid inspecting every claim of a large cart.
    const first=lines.find(line => line.merchandise?.id===VARIANT || line.merchandise?.product?.id===PRODUCT);
    return {targeted:first?[first]:[],valid:!first,lines:[]};
  }
  const selected = lines.filter(targeted);
  const invalid = { targeted: selected, valid: false, lines: [] };
  if (!selected.length) return { targeted: [], valid: true, lines: [] };
  const authority = decodeAuthority(input.shop?.authority?.value);
  if (!authority || authority.valid_on !== input.shop?.localTime?.date) return invalid;
  const matches = authority.grants.filter(g => g.lines.length === selected.length &&
    g.lines.every(l => selected.some(s => s.id === l.id)));
  if (matches.length !== 1 || new Set(selected.map(l=>l.id)).size !== selected.length) return invalid;
  const grant = matches[0], buyer = input.cart.buyerIdentity;
  if (grant.customer_id === null ? (buyer?.isAuthenticated === true || buyer?.customer != null) :
      (buyer?.isAuthenticated !== true || buyer?.customer?.id !== grant.customer_id)) return invalid;
  const approved = [];
  for (const line of selected) {
    const l = grant.lines.find(l => l.id === line.id);
    if (line.merchandise?.id !== VARIANT || line.merchandise?.product?.id !== PRODUCT ||
        line.quantity !== l.quantity || line.sellingPlanAllocation ||
        line.cost?.amountPerQuantity?.currencyCode !== 'USD' ||
        CLAIM_KEYS.some(key => attribute(line,key) !== l.claims[key])) return invalid;
    approved.push({ line, ...l, physical_count: l.file_count*l.quantity });
  }
  return { targeted: selected, valid: true, lines: approved };
}
