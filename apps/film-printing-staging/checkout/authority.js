// Candidate Function contract; not wired to the released F02 extensions.
// Only shop.metafield($app:bfl-checkout, authority) is authority. Attributes are claims.
export const STORE = 'bellows-film-printing-staging.myshopify.com';
export const PRODUCT = 'gid://shopify/Product/15620086005871';
export const VARIANT = 'gid://shopify/ProductVariant/67852705202287';
// Exact schema5 staging variants. VARIANT remains the historical schemas1–4 identity.
export const VARIANTS_BY_LAB = Object.freeze({
  miami:'gid://shopify/ProductVariant/68068335714415',
  chicago:'gid://shopify/ProductVariant/68068358848623',
  orlando:'gid://shopify/ProductVariant/68068358881391',
  atlanta:'gid://shopify/ProductVariant/68068358914159',
});
export const variantForLab = lab => typeof lab==='string' && Object.hasOwn(VARIANTS_BY_LAB,lab) ? VARIANTS_BY_LAB[lab] : null;
const knownVariants = new Set([VARIANT,...Object.values(VARIANTS_BY_LAB)]);
const knownVariant = id => knownVariants.has(id);
export const NAMESPACE = '$app:bfl-checkout';
export const KEY = 'authority';
export const BINDING_KEY = 'binding_v2';
export const AUTHORITY_SCHEMA = 2;
export const ELIGIBILITY_SCHEMA = 4;
export const LAB_VARIANT_SCHEMA = 5;
export const isFullProductSchema = schema => schema === ELIGIBILITY_SCHEMA || schema === LAB_VARIANT_SCHEMA;
export const isEligibilitySchema = schema => schema === 3 || isFullProductSchema(schema);
export const MAX_BYTES = 6000;
export const MAX_GRANTS = 8;
export const MAX_LINES = 8;
export const MAX_CART_LINES = 20;
export const ATTRIBUTES = {
  flow: '_bfl_flow', job: '_bfl_job', revision: '_bfl_revision', config: '_bfl_config',
  signature: '_bfl_signature', service: 'Service', size: 'Sizes', paper: 'Paper',
  lab: 'Location', message: 'Message', borders: 'Borders', turnaround: 'Turnaround', files: 'Files Uploaded',
};
export const FULL_PRODUCT_ATTRIBUTES = {...ATTRIBUTES,
  size_mode: '_bfl_size_mode', width: 'Custom Width', height: 'Custom Height',
  process: 'Process', scanning: 'Scanning Options', negatives: 'Negatives',
};
const HEX = /^[a-f0-9]{64}$/, CONFIG = /^f03-[a-f0-9]{24}$/, DAY = /^\d{4}-\d{2}-\d{2}$/, SIZE = /^\d+(?:\.\d+)?x\d+(?:\.\d+)?$/;
const ROOT_KEYS = 'schema,store,config_version,config_sha256,price_version,valid_on,grants'.split(',');
const GRANT_KEYS = 'cart,owner,customer_id,lines'.split(',');
const BOUND_GRANT_KEYS = [...GRANT_KEYS,'binding','generation','epoch'];
const LINE_KEYS = 'id,quantity,unit_cents,file_count,location_id,claims'.split(',');
const CLAIM_KEYS = Object.keys(ATTRIBUTES), FULL_CLAIM_KEYS = Object.keys(FULL_PRODUCT_ATTRIBUTES);
const EXTRA_CLAIM_KEYS = FULL_CLAIM_KEYS.filter(key => !CLAIM_KEYS.includes(key));
export const claimKeysForSchema = schema => isFullProductSchema(schema) ? FULL_CLAIM_KEYS : CLAIM_KEYS;
const hex = value => typeof value === 'string' && HEX.test(value);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 200;
const gid = (value, type) => typeof value === 'string' && value.startsWith(`gid://shopify/${type}/`) && value.length <= 200;
const integer = value => Number.isSafeInteger(value) && value > 0 && value <= 10000;
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(k => Object.prototype.hasOwnProperty.call(value,k));
// Extended selection fields are protected claims, never optional unsigned metadata.
function validSelection(claims, files, full) {
  if (!SIZE.test(claims.size)) return false;
  if (!full) return integer(files) && ['photo','fine_art'].includes(claims.service);
  if (!['fixed','custom'].includes(claims.size_mode)) return false;
  if (claims.size_mode === 'custom') {
    if (claims.service !== 'fine_art' || !/^[1-9]\d*$/.test(claims.width) || !/^[1-9]\d*$/.test(claims.height)) return false;
    const width=Number(claims.width),height=Number(claims.height);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width>44 ||
        claims.size !== [width,height].sort((a,b)=>a-b).join('x')) return false;
  } else if (claims.width !== '' || claims.height !== '') return false;
  if (claims.service === 'darkroom') {
    return files === 0 && claims.size_mode === 'fixed' && ['8x10','11x14','12x16','16x20'].includes(claims.size) &&
      ['Color','Black and White'].includes(claims.process) && ['Already at Bellows','Drop Off','Mail In'].includes(claims.negatives) &&
      (['8x10','11x14'].includes(claims.size) ? ['Yes','No'].includes(claims.scanning) : claims.scanning === '');
  }
  return integer(files) && ['photo','fine_art'].includes(claims.service) &&
    claims.process === '' && claims.scanning === '' && claims.negatives === '';
}
// Presentation is a deterministic projection of the signed canonical claims.
// Schema5 can read complete historical canonical or complete customer labels;
// individual aliases, mixed representations and arbitrary normalization reject.
export function displayClaims(claims) {
  const service=({photo:'Photo Prints',fine_art:'Fine Arts',darkroom:'Darkroom Prints'})[claims.service];
  const paper=({matte:'Matte',luster:'Luster',glossy:'Glossy','fibre-paper':'Fibre Paper','rc-matte':'RC Matte','rc-luster':'RC Luster','photo-premium-luster':'premium luster paper'})[claims.paper];
  const lab=({miami:'Miami',chicago:'Chicago',orlando:'Orlando',atlanta:'Atlanta'})[claims.lab];
  if(typeof service!=='string'||typeof paper!=='string'||typeof lab!=='string'||!SIZE.test(claims.size))return null;
  const size=claims.size_mode==='custom'?`${claims.width}" × ${claims.height}" (Custom)`:claims.size.split('x').map(side=>`${side}”`).join(' × ');
  return {...claims,service,size,paper,lab};
}
export function claimValuesMatch(read,claims,keys,{display=false,quantity=null}={}) {
  const matches=expected=>expected&&keys.every(key=>read(key)===(quantity!==null&&key==='signature'?`v3:${expected.signature}:${quantity}`:expected[key]));
  return Boolean(matches(claims)||display&&matches(displayClaims(claims)));
}

export const attribute = (line, alias) => line?.[alias]?.value ?? '';
export const targeted = line => {
  const merchandise=line.merchandise;
  return knownVariant(merchandise?.id) || merchandise?.product?.id === PRODUCT || attribute(line,'flow') !== '';
};

// Shopify may return JSON strings with literal Unicode after storing escaped JSON.
// Charge the original ASCII-escaped budget in either form; never normalize the
// strings themselves (Unicode normalization would change signed specifications).
export function boundedAuthorityJSON(raw,max=MAX_BYTES) {
  if(typeof raw!=='string'||raw.length>max||/[\x00-\x1f]/.test(raw))return null;
  const escaped=raw.replace(/[\u007f-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
  return escaped.length<=max?escaped:null;
}
export function decodeAuthority(raw) {
  raw=boundedAuthorityJSON(raw);if(raw===null)return null;
  let a; try { a = JSON.parse(raw); } catch { return null; }
  const eligibility = isEligibilitySchema(a?.schema);
  if (!exactKeys(a,eligibility ? [...ROOT_KEYS,'lease'] : ROOT_KEYS) ||
      ![1,AUTHORITY_SCHEMA,3,ELIGIBILITY_SCHEMA,LAB_VARIANT_SCHEMA].includes(a.schema) || a.store !== STORE || !CONFIG.test(a.config_version) ||
      !hex(a.config_sha256) || a.config_version !== `f03-${a.config_sha256.slice(0,24)}` ||
      !text(a.price_version) || !DAY.test(a.valid_on) ||
      !Array.isArray(a.grants) || a.grants.length > MAX_GRANTS) return null;
  if (eligibility && (!exactKeys(a.lease,['token','deadline','expires_at']) || !hex(a.lease.token) ||
      typeof a.lease.deadline !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(a.lease.deadline) ||
      !Number.isSafeInteger(a.lease.expires_at) || a.lease.expires_at <= 0)) return null;
  const carts = new Set(), lineIds = new Set(), jobs = new Set(), bindings = new Set();
  for (const g of a.grants) {
    if (!exactKeys(g,a.schema===1?GRANT_KEYS:BOUND_GRANT_KEYS) || !hex(g.cart) || !hex(g.owner) ||
        (g.customer_id !== null && !gid(g.customer_id,'Customer')) || carts.has(g.cart) ||
        !Array.isArray(g.lines) || !g.lines.length || g.lines.length > MAX_LINES) return null;
    if(a.schema>=AUTHORITY_SCHEMA && (!hex(g.binding) || bindings.has(g.binding) || !Number.isSafeInteger(g.generation) || g.generation<1 || !Number.isSafeInteger(g.epoch) || g.epoch<0))return null;
    bindings.add(g.binding); carts.add(g.cart);
    for (const l of g.lines) {
      if (!exactKeys(l,a.schema===1?LINE_KEYS:[...LINE_KEYS.filter(k=>k!=='id'&&(!eligibility||k!=='quantity')),...(isFullProductSchema(a.schema)?['shipping_eligible']:[]),...(a.schema===LAB_VARIANT_SCHEMA?['variant_id']:[])]) ||
          (a.schema===1 && (!gid(l.id,'CartLine') || lineIds.has(l.id))) || (!eligibility&&!integer(l.quantity)) ||
          !Number.isSafeInteger(l.unit_cents) || l.unit_cents <= 0 || l.unit_cents * (eligibility?1:l.quantity) > 200000 ||
          (isFullProductSchema(a.schema)&&typeof l.shipping_eligible!=='boolean') ||
          (a.schema===LAB_VARIANT_SCHEMA&&(!gid(l.variant_id,'ProductVariant')||l.variant_id!==variantForLab(l.claims?.lab))) || !gid(l.location_id,'Location') || !exactKeys(l.claims,claimKeysForSchema(a.schema)) ||
          Object.values(l.claims).some(v => typeof v !== 'string' || v.length > 2000) ||
          l.claims.flow !== 'f05' || !text(l.claims.job) || jobs.has(l.claims.job) ||
          !hex(l.claims.revision) || !hex(l.claims.signature) || l.claims.config !== a.config_version ||
          l.claims.files !== String(l.file_count) || !text(l.claims.lab) || !text(l.claims.paper) ||
          !validSelection(l.claims,l.file_count,isFullProductSchema(a.schema))) return null;
      lineIds.add(l.id); jobs.add(l.claims.job);
      if (jobs.size > MAX_LINES) return null; // Total registry budget, across all carts.
    }
    if (!eligibility && g.lines.reduce((sum,l) => sum + l.unit_cents*l.quantity,0) > 200000) return null;
  }
  return a;
}

export function decodeEligibility(raw) {
  raw=boundedAuthorityJSON(raw,MAX_BYTES+128);if(raw===null)return null;
  let envelope;try { envelope=JSON.parse(raw); } catch { return null; }
  if (!exactKeys(envelope,['deadline','authority'])) return null;
  const encoded=JSON.stringify(envelope.authority)?.replace(/[\u007f-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
  const authority=decodeAuthority(encoded);
  return isEligibilitySchema(authority?.schema) && envelope.deadline===authority.lease.deadline ? authority : null;
}

// V2 requires the protected cart marker and protected Shop grant together.
// Same-app untrusted-writer exclusion is an external integration prerequisite.
// Current IDs are output addresses only. Schema 1 is readable for old clearing,
// but cannot authorize this candidate. Equivalent current content is intentional.
export function inspectCart(input, {claimScope='all'}={}) {
  if (!['all','base','specification'].includes(claimScope)) return {targeted:[],valid:false,lines:[]};
  const lines = input.cart?.lines ?? [];
  if (lines.length > MAX_CART_LINES) {
    // One error blocks checkout. Avoid inspecting every claim of a large cart.
    const first=lines.find(line => knownVariant(line.merchandise?.id) || line.merchandise?.product?.id===PRODUCT);
    return {targeted:first?[first]:[],valid:!first,lines:[]};
  }
  const selected = lines.filter(targeted);
  const invalid = { targeted: selected, valid: false, lines: [] };
  if (!selected.length) return { targeted: [], valid: true, lines: [] };
  const eligibility=Object.hasOwn(input,'leaseOwner');
  const authority = eligibility ? decodeEligibility(input.leaseOwner?.lease?.value) : decodeAuthority(input.shop?.authority?.value);
  if (!authority || (eligibility?!isEligibilitySchema(authority.schema):authority.schema!==AUTHORITY_SCHEMA) || !hex(input.cart?.binding?.value) ||
      (eligibility ? input.shop?.localTime?.beforeDeadline!==true : authority.valid_on !== input.shop?.localTime?.date)) return invalid;
  const matches = authority.grants.filter(g => g.binding===input.cart.binding.value &&
    (eligibility ? selected.every(s=>g.lines.some(l=>attribute(s,'job')===l.claims.job)) :
      g.lines.length === selected.length && g.lines.every(l => selected.some(s => attribute(s,'job') === l.claims.job))));
  if (matches.length !== 1 || new Set(selected.map(l=>l.id)).size !== selected.length || new Set(selected.map(l=>attribute(l,'job'))).size !== selected.length || selected.some(l=>!gid(l.id,'CartLine'))) return invalid;
  const grant = matches[0], buyer = input.cart.buyerIdentity;
  // Shopify may associate a guest email with a customer without authenticating
  // that account. Shopify also returns a null buyer before any identity exists.
  const anonymous = Object.hasOwn(input.cart,'buyerIdentity') && (buyer === null ||
    typeof buyer === 'object' && !Array.isArray(buyer) && buyer?.isAuthenticated === false);
  if (grant.customer_id === null ? !anonymous :
      (buyer?.isAuthenticated !== true || buyer?.customer?.id !== grant.customer_id)) return invalid;
  const checkedKeys=claimScope==='base'?CLAIM_KEYS:claimScope==='specification'?[...CLAIM_KEYS.slice(0,5),...(isFullProductSchema(authority.schema)?EXTRA_CLAIM_KEYS:[])]:claimKeysForSchema(authority.schema);
  const approved = [];
  for (const line of selected) {
    const l = grant.lines.find(l => l.claims.job === attribute(line,'job'));
    if (line.merchandise?.id !== (authority.schema===LAB_VARIANT_SCHEMA?l.variant_id:VARIANT) || line.merchandise?.product?.id !== PRODUCT ||
        (!eligibility && line.quantity !== l.quantity) || !integer(line.quantity) || l.unit_cents*line.quantity>200000 || line.sellingPlanAllocation ||
        line.cost?.amountPerQuantity?.currencyCode !== 'USD' ||
        (claimScope!=='base' && !isFullProductSchema(authority.schema) && EXTRA_CLAIM_KEYS.some(key => attribute(line,key)!=='')) ||
        !claimValuesMatch(key=>attribute(line,key),l.claims,checkedKeys,{display:authority.schema===LAB_VARIANT_SCHEMA,quantity:eligibility?line.quantity:null})) return invalid;
    approved.push({ line, ...l, id:line.id, quantity:line.quantity, physical_count: l.claims.service==='darkroom' ? null : l.file_count*line.quantity });
  }
  if (eligibility && approved.reduce((sum,l)=>sum+l.unit_cents*l.quantity,0)>200000) return invalid;
  return { targeted: selected, valid: true, lines: approved };
}
