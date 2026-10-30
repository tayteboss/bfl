import { ConfigurationError, freeze, verifyRelease } from '../configuration/config.mjs';
import { ShippingError, requireValue, packDeliveryGroups } from './packing.mjs';

export function validateDestination(address, {allowPOBox = false} = {}) {
  requireValue(address && ['address1','city','province_code','postal_code'].every(k => typeof address[k] === 'string' && address[k].trim().length > 0 && address[k].length <= 200) && typeof address.address2 === 'string' && typeof address.residential === 'boolean', 'INCOMPLETE_DESTINATION');
  // Preserve the configured US scope. Territory/military/service eligibility is a carrier check.
  requireValue(address.country_code === 'US', 'OUTSIDE_COVERAGE');
  requireValue(allowPOBox || !/\b(?:p\.?\s*o\.?\s*box|post\s+office\s+box)\b/i.test(address.address1+' '+address.address2), 'INELIGIBLE_ADDRESS');
}
export function validateTender(group) {
  requireValue(typeof group.ship_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(group.ship_date) && !Number.isNaN(Date.parse(group.ship_date)) && new Date(group.ship_date).toISOString().slice(0,10) === group.ship_date, 'INVALID_SHIP_DATE');
  requireValue(['DROPOFF_AT_FEDEX_LOCATION','USE_SCHEDULED_PICKUP','CONTACT_FEDEX_TO_SCHEDULE'].includes(group.pickup_type), 'MISSING_TENDER_METHOD');
}

// resolveRequest MUST authenticate/authorize references and resolve immutable server jobs,
// current copies, completed assets and actual fulfillment groups. No default trusts cart data.
export function createQuoteService({ loader, resolveRequest, provider, timeoutMs = 2000 }) {
  requireValue(typeof loader?.load === 'function' && typeof resolveRequest === 'function' && typeof provider?.quote === 'function', 'MISSING_SERVER_DEPENDENCY');
  requireValue(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 2500, 'INVALID_TIMEOUT');
  return { async quote(request, {signal} = {}) {
    const controller = new AbortController();
    let timer, cancel;
    const work = async () => {
      const input = freeze(structuredClone(await resolveRequest(request, { signal:controller.signal })));
      requireValue(input.currency === 'USD', 'UNSUPPORTED_CURRENCY');
      requireValue(Array.isArray(input.jobs) && input.jobs.length > 0 && input.jobs.every(j => typeof j.config_version === 'string' && j.config_version === input.jobs[0].config_version), 'VERSION_MISMATCH');
      // One verified release per request; no per-parcel or per-group reload.
      const release = freeze(verifyRelease(await loader.load({expectedVersion:input.jobs[0].config_version})));
      requireValue(release.version === input.jobs[0].config_version, 'VERSION_MISMATCH');
      const policy = release.config.policies[0];
      requireValue(policy.enabled && policy.rate_access === 'verified', 'RATE_ACCESS_UNAVAILABLE');
      const packing = packDeliveryGroups(release,input);
      const shipments = packing.groups.map(group => {
        const context = input.groups.find(g => g.id === group.id);
        if (policy.provider === 'shippo') {
          requireValue(provider.kind === 'shippo', 'PROVIDER_MISMATCH');
          validateDestination(context.destination,{allowPOBox:true});
          return freeze({...group,config_version:release.version,currency:'USD',policy,
            destination:context.destination,shipment_date:context.shipment_date,tender:context.tender ?? null});
        }
        validateDestination(context.destination); validateTender(context);
        return freeze({ ...group, config_version:release.version, currency:'USD', service:'FEDEX_2_DAY', rate_source:'bellows_own_account',
          destination:context.destination, ship_date:context.ship_date, pickup_type:context.pickup_type });
      });
      const quotes = await Promise.all(shipments.map(async shipment => {
        requireValue(!controller.signal.aborted, 'QUOTE_TIMEOUT');
        const rate = await provider.quote(shipment,{signal:controller.signal});
        requireValue(!controller.signal.aborted, 'QUOTE_TIMEOUT');
        if (policy.provider === 'shippo') {
          requireValue(rate?.eligible === true && rate.mode === policy.shippo.mode && Array.isArray(rate.options) && rate.options.length > 0, 'INVALID_PROVIDER_QUOTE');
          const identities = new Set();
          for (const option of rate.options) {
            requireValue(policy.shippo.services.some(s => s.account_id === option.account_id && s.carrier === option.carrier && s.service_token === option.service) &&
              option.id === `shippo:${policy.shippo.mode}:${option.account_id}:${option.service}` && !identities.has(option.id) &&
              option.currency === 'USD' && Number.isSafeInteger(option.total_cents) && option.total_cents > 0, 'INVALID_PROVIDER_QUOTE');
            identities.add(option.id);
          }
          return {group_id:shipment.id,lab:shipment.lab,location_id:shipment.location_id,options:rate.options};
        }
        requireValue(rate?.eligible === true && rate.service === 'FEDEX_2_DAY' && rate.rate_source === 'bellows_own_account' && rate.currency === 'USD' && Number.isSafeInteger(rate.total_cents) && rate.total_cents > 0, 'INVALID_PROVIDER_QUOTE');
        return { group_id:shipment.id, lab:shipment.lab, service:rate.service, currency:rate.currency, total_cents:rate.total_cents };
      }));
      return freeze({status:'available',config_version:release.version,packing,quotes,
        ...(policy.provider === 'shippo' ? {provider:'shippo',mode:policy.shippo.mode,checkout_ready:false} : {})});
    };
    try {
      requireValue(!signal?.aborted, 'QUOTE_CANCELLED');
      const cancelled = new Promise((_,reject) => {
        cancel = () => { controller.abort(); reject(new ShippingError('QUOTE_CANCELLED')); };
        signal?.addEventListener('abort',cancel,{once:true});
      });
      return await Promise.race([work(), cancelled, new Promise((_,reject) => { timer = setTimeout(() => { controller.abort(); reject(new ShippingError('QUOTE_TIMEOUT')); },timeoutMs); })]);
    } catch (error) {
      controller.abort();
      // Do not leak provider bodies, addresses, account IDs or credentials.
      return {status:'unavailable',code:error instanceof ShippingError || error instanceof ConfigurationError ? error.code : 'DEPENDENCY_FAILED',quotes:[]};
    } finally { clearTimeout(timer); signal?.removeEventListener('abort',cancel); }
  } };
}
