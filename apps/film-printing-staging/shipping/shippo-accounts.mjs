import { freeze } from '../configuration/config.mjs';
import { requireValue, ShippingError } from './packing.mjs';

// Connection diagnostic only. Never publishes configuration or establishes parcel
// eligibility. A test token cannot establish live account access or live prices.
export async function inspectShippoTestAccounts({enabled=false, token, expectedOwner,
  fetchImpl=globalThis.fetch, signal, timeoutMs=5000} = {}) {
  requireValue(enabled === true, 'SHIPPO_DISABLED');
  requireValue(typeof token === 'string' && /^shippo_test_[a-zA-Z0-9]+$/.test(token), 'SHIPPO_TEST_ACCESS_MISSING');
  requireValue(expectedOwner === undefined || (typeof expectedOwner === 'string' && expectedOwner.trim().length > 0), 'INVALID_SHIPPO_OWNER');
  requireValue(typeof fetchImpl === 'function' && Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 5000, 'INVALID_TIMEOUT');
  const combined = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]);
  requireValue(!combined.aborted, 'QUOTE_TIMEOUT');
  let payload;
  try {
    const response = await fetchImpl('https://api.goshippo.com/carrier_accounts/?service_levels=true&results=100&page=1', {
      method:'GET', redirect:'error', signal:combined,
      headers:{Authorization:`ShippoToken ${token}`, 'Shippo-API-Version':'2018-02-08'},
    });
    requireValue(response.ok, 'SHIPPO_HTTP_ERROR');
    payload = await response.json();
  } catch {
    // Neither provider bodies nor fetch errors (which may include credentials)
    // escape this diagnostic boundary.
    throw new ShippingError(combined.aborted ? 'QUOTE_TIMEOUT' : 'SHIPPO_ACCOUNT_READ_FAILED');
  }
  requireValue(!combined.aborted, 'QUOTE_TIMEOUT');
  requireValue(Array.isArray(payload?.results) && payload.results.length <= 100 &&
    (payload.next === null || typeof payload.next === 'string'), 'INVALID_SHIPPO_ACCOUNTS');
  const ids = new Set();
  const accounts = payload.results.map(account => {
    requireValue(typeof account?.object_id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(account.object_id) &&
      !ids.has(account.object_id) && typeof account.carrier === 'string' && /^[a-z0-9_]{1,100}$/.test(account.carrier) &&
      typeof account.active === 'boolean' && typeof account.test === 'boolean' &&
      typeof account.is_shippo_account === 'boolean' && typeof account.object_owner === 'string' &&
      Array.isArray(account.service_levels), 'INVALID_SHIPPO_ACCOUNTS');
    requireValue(account.test === true, 'SHIPPO_ACCOUNT_MODE_MISMATCH');
    ids.add(account.object_id);
    const services = account.service_levels.map(service => {
      requireValue(typeof service?.token === 'string' && /^[a-z0-9_]{1,100}$/.test(service.token), 'INVALID_SHIPPO_ACCOUNTS');
      return service.token;
    });
    const status = account.object_info?.authentication?.status;
    return {object_id:account.object_id, carrier:account.carrier, active:account.active, test:account.test,
      is_shippo_account:account.is_shippo_account,
      owner_matches:expectedOwner === undefined ? null : account.object_owner === expectedOwner,
      authentication_status:['connected','disconnected'].includes(status) ? status : 'unverified',
      service_tokens:[...new Set(services)].sort()};
  });
  // Do not follow provider-supplied URLs with Authorization. A partial inventory
  // is explicit; further pagination can be added if a real account needs it.
  return freeze({mode:'test', complete:payload.next === null, checkout_ready:false,
    eligibility_verified:false, accounts});
}
