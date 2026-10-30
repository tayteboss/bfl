import {createHmac, timingSafeEqual} from 'node:crypto';
import {STORE} from './authority.js';
import {requireValue} from '../shipping/packing.mjs';

// A supported transport prerequisite, not a cart resolver/session issuer.
// Shopify signs query parameters, NOT the request body or cart contents.
// An anonymous customer has no unique guest identity in this protocol.
// Not mounted: staging has no app proxy/host and no new access is provisioned.
export function createProxyContextVerifier({secret, pathPrefix, now = () => Date.now()}) {
  requireValue(typeof secret === 'string' && secret.length >= 32 &&
    /^\/apps\/[a-z0-9-]+$/.test(pathPrefix), 'INVALID_PROXY_CONFIG');
  return rawQuery => {
    requireValue(typeof rawQuery === 'string' && Buffer.byteLength(rawQuery) <= 8192 &&
      !rawQuery.startsWith('?') && !/%(?![a-f\d]{2})/i.test(rawQuery), 'UNVERIFIED_PROXY');
    // URLSearchParams replaces malformed UTF-8. Reject it rather than sign a
    // different decoded representation. Preserve duplicate extras per Shopify.
    try { decodeURIComponent(rawQuery.replace(/\+/g, ' ')); } catch { requireValue(false, 'UNVERIFIED_PROXY'); }
    const params = new URLSearchParams(rawQuery);
    const reserved = ['signature', 'shop', 'path_prefix', 'timestamp', 'logged_in_customer_id'];
    requireValue(reserved.every(k => params.getAll(k).length === 1), 'UNVERIFIED_PROXY');
    const signature = params.get('signature');
    requireValue(/^[a-f\d]{64}$/.test(signature), 'UNVERIFIED_PROXY');
    params.delete('signature');
    const message = [...new Set(params.keys())].map(k => `${k}=${params.getAll(k).join(',')}`).sort().join('');
    const expected = createHmac('sha256', secret).update(message).digest();
    requireValue(timingSafeEqual(expected, Buffer.from(signature, 'hex')), 'UNVERIFIED_PROXY');
    const timestamp = params.get('timestamp'), customer = params.get('logged_in_customer_id');
    const seconds = Math.floor(now() / 1000);
    requireValue(params.get('shop') === STORE && params.get('path_prefix') === pathPrefix &&
      /^\d{1,12}$/.test(timestamp) && Number.isSafeInteger(seconds) &&
      Number(timestamp) <= seconds && seconds - Number(timestamp) <= 300 &&
      (customer === '' || /^[1-9]\d*$/.test(customer)), 'UNVERIFIED_PROXY');
    // Deliberately no owner, cart, complete, authenticated guest, or readiness.
    // Freshness is a replay bound, NOT one-use/CSRF protection. The future host
    // must bind its own session + request nonce + verified cart capability.
    return Object.freeze({store: STORE, customer_id: customer ? `gid://shopify/Customer/${customer}` : null,
      signed_at: Number(timestamp)});
  };
}
