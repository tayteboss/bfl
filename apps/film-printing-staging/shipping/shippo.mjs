import { digest, freeze } from '../configuration/config.mjs';
import { requireValue } from './packing.mjs';
import { validateDestination } from './quote.mjs';

// Local conservative ceilings, not a statement of physical eligibility. USPS has
// no multi-piece support; FedEx warns of timeouts above 12; UPS rates up to 50.
// DHL multi-piece is deliberately gated pending account/service-specific proof.
const parcelLimits = {USPS:1,UPS:50,FedEx:12,'DHL Express':1};
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const noMessages = value => Array.isArray(value) && value.length === 0;
const address = a => ({street1:a.address1,street2:a.address2,city:a.city,state:a.province_code,
  zip:a.postal_code,country:a.country_code,...Object.fromEntries(['name','company','phone','email'].filter(k => a[k] !== undefined).map(k => {
    requireValue(typeof a[k] === 'string' && a[k].trim().length > 0 && a[k].length <= 100, 'INVALID_CONTACT');
    return [k,a[k]];
  })),...(typeof a.residential === 'boolean' ? {is_residential:a.residential} : {})});
function measurement(value) {
  requireValue(typeof value === 'number' && value > 0 && /^\d{1,6}(?:\.\d{1,4})?$/.test(String(value)), 'UNSUPPORTED_SHIPPO_MEASUREMENT');
  return String(value); // Reject unsupported precision; do not invent rounding rules.
}
function cents(amount) {
  requireValue(typeof amount === 'string' && /^\d{1,14}(?:\.\d{1,2})?$/.test(amount), 'INVALID_SHIPPO_AMOUNT');
  const [whole,fraction=''] = amount.split('.');
  const result = Number(BigInt(whole)*100n + BigInt(fraction.padEnd(2,'0')));
  requireValue(Number.isSafeInteger(result) && result > 0, 'INVALID_SHIPPO_AMOUNT');
  return result;
}
function sameAddress(actual, expected) {
  return actual?.is_complete === true && actual.validation_results?.is_valid !== false &&
    Object.entries(expected).every(([key,value]) => actual[key] === value);
}
function sameParcels(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length && actual.every((p,i) =>
    p?.mass_unit === 'oz' && p.distance_unit === 'in' &&
    ['length','width','height','weight'].every(k => typeof p[k] === 'string' && /^\d+(?:\.\d+)?$/.test(p[k]) && Number(p[k]) === Number(expected[i][k])));
}

// checkEligibility is mandatory server evidence for this exact option and complete
// manifest: account ownership/mode, service, geography, address, tender and physical
// restrictions. A returned rate alone is NOT evidence. No default returns true.
export function createShippoProvider({postShipment,checkEligibility,mode='test'} = {}) {
  return {kind:'shippo', async quote(shipment,{signal}) {
    requireValue(typeof postShipment === 'function' && typeof checkEligibility === 'function', 'SHIPPO_ACCESS_MISSING');
    requireValue(['test','live'].includes(mode) && shipment.policy?.provider === 'shippo' && shipment.policy.shippo.mode === mode && shipment.currency === 'USD', 'INVALID_PROVIDER_POLICY');
    validateDestination(shipment.destination,{allowPOBox:true});
    // Explicit UTC timestamp from trusted dispatch context; never guess a date/time.
    requireValue(typeof shipment.shipment_date === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(shipment.shipment_date) &&
      !Number.isNaN(Date.parse(shipment.shipment_date)) && new Date(shipment.shipment_date).toISOString() === shipment.shipment_date.replace('Z','.000Z'), 'INVALID_SHIP_DATE');
    const eligible = [];
    for (const option of shipment.policy.shippo.services) {
      requireValue(!signal.aborted, 'QUOTE_TIMEOUT');
      if (shipment.parcels.length <= parcelLimits[option.carrier] && await checkEligibility(shipment,option,{signal}) === true) eligible.push(option);
    }
    requireValue(!signal.aborted, 'QUOTE_TIMEOUT');
    requireValue(eligible.length > 0, 'CARRIER_INELIGIBLE');
    const accounts = [...new Set(eligible.map(o => o.account_id))];
    const body = freeze({address_from:address(shipment.origin),address_to:address(shipment.destination),
      shipment_date:shipment.shipment_date,carrier_accounts:accounts,async:false,
      metadata:`bfl:${digest(shipment)}`,
      parcels:shipment.parcels.map(p => ({length:measurement(p.dimensions_in.length),width:measurement(p.dimensions_in.width),
        height:measurement(p.dimensions_in.height),distance_unit:'in',weight:measurement(p.weight_oz),mass_unit:'oz'}))});
    const response = await postShipment(body,{signal,mode});
    requireValue(!signal.aborted, 'QUOTE_TIMEOUT');
    return decodeShippoResponse(response,{body,eligible,mode});
  }};
}

// Shared strict response decoder. Callers must independently authorize the exact
// shipment and service before sending; a returned rate is not eligibility proof.
export function decodeShippoResponse(response,{body,eligible,mode}) {
 const accounts=body.carrier_accounts;
    requireValue(response?.status === 'SUCCESS' && identifier(response.object_id) && response.test === (mode === 'test') &&
      response.metadata === body.metadata && Date.parse(response.shipment_date) === Date.parse(body.shipment_date) && noMessages(response.messages) &&
      Array.isArray(response.carrier_accounts) && response.carrier_accounts.length === accounts.length && accounts.every(id => response.carrier_accounts.includes(id)) &&
      sameAddress(response.address_from,body.address_from) && sameAddress(response.address_to,body.address_to) &&
      sameParcels(response.parcels,body.parcels) && Array.isArray(response.rates) && response.rates.length > 0, 'INCOMPLETE_SHIPPO_RESPONSE');
    const options = [], ids = new Set(), rateIds = new Set();
    for (const rate of response.rates) {
      const account = eligible.find(o => o.account_id === rate?.carrier_account);
      requireValue(account && rate.provider === account.carrier && rate.shipment === response.object_id &&
        rate.test === (mode === 'test') && identifier(rate.object_id) && !rateIds.has(rate.object_id) && noMessages(rate.messages) &&
        typeof rate.servicelevel?.token === 'string' && /^[a-z0-9_]{1,100}$/.test(rate.servicelevel.token), 'INVALID_SHIPPO_RATE');
      rateIds.add(rate.object_id);
      const option = eligible.find(o => o.account_id === rate.carrier_account && o.service_token === rate.servicelevel?.token);
      // Shippo returns other services for selected accounts. Never offer them.
      if (!option) continue;
      // A token can also identify a packaging-specific variant (e.g. FedEx
      // ONERATE). Custom dimensions do not prove eligibility for those terms.
      requireValue(rate.servicelevel.terms === undefined || rate.servicelevel.terms === '', 'UNSUPPORTED_SHIPPO_TERMS');
      const id = `shippo:${mode}:${option.account_id}:${option.service_token}`;
      requireValue(!ids.has(id) && rate.currency === 'USD', 'INVALID_SHIPPO_RATE');
      ids.add(id);
      options.push({id,carrier:option.carrier,account_id:option.account_id,service:option.service_token,
        currency:'USD',total_cents:cents(rate.amount),rate_id:rate.object_id,shipment_id:response.object_id});
    }
    // Missing account results cannot be distinguished safely from a partial reply.
    requireValue(accounts.every(id => options.some(o => o.account_id === id)), 'INCOMPLETE_SHIPPO_RESPONSE');
    return freeze({eligible:true,mode,options:options.sort((a,b) => a.id.localeCompare(b.id))});
}

// Server-only, explicitly enabled. No environment discovery, retry, polling,
// labels, account creation, address-book writes or fallback transport.
export function createShippoTransport({enabled=false,token,mode='test',fetchImpl=globalThis.fetch,timeoutMs=1800} = {}) {
  return async (body,{signal,mode:requestedMode}) => {
    requireValue(enabled === true, 'SHIPPO_DISABLED');
    requireValue(requestedMode === mode && ['test','live'].includes(mode) && typeof token === 'string' &&
      new RegExp(`^shippo_${mode}_[a-zA-Z0-9]+$`).test(token) && typeof fetchImpl === 'function', 'SHIPPO_ACCESS_MISSING');
    requireValue(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 2500, 'INVALID_TIMEOUT');
    const combined = AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]);
    requireValue(!combined.aborted, 'QUOTE_TIMEOUT');
    const response = await fetchImpl('https://api.goshippo.com/shipments/',{method:'POST',redirect:'error',signal:combined,
      headers:{Authorization:`ShippoToken ${token}`,'Content-Type':'application/json','Shippo-API-Version':'2018-02-08'},body:JSON.stringify(body)});
    requireValue(response.ok, 'SHIPPO_HTTP_ERROR');
    const result = await response.json();
    requireValue(!combined.aborted, 'QUOTE_TIMEOUT');
    return result;
  };
}
