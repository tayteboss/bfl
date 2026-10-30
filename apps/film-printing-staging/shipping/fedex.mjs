import { requireValue } from './packing.mjs';
import { validateDestination, validateTender } from './quote.mjs';
const address = a => ({streetLines:[a.address1,...(a.address2 ? [a.address2] : [])], city:a.city,
  stateOrProvinceCode:a.province_code,postalCode:a.postal_code,countryCode:a.country_code,
  ...(typeof a.residential === 'boolean' ? {residential:a.residential} : {})});

// Authenticated POST and eligibility are server adapters, not browser callbacks.
// postRate must POST /rate/v1/rates/quotes using the Bellows-associated OAuth project.
// checkEligibility must verify this exact date/origin/destination/ALL parcels with
// Service Availability + applicable package/address restrictions. Rate alone is insufficient.
export function createFedexProvider({ accountNumber, postRate, checkEligibility }) {
  return { async quote(shipment,{signal}) {
    requireValue(typeof accountNumber === 'string' && /^\d{9}$/.test(accountNumber) && typeof postRate === 'function' && typeof checkEligibility === 'function', 'FEDEX_ACCESS_MISSING');
    requireValue(shipment.service === 'FEDEX_2_DAY' && shipment.currency === 'USD' && shipment.rate_source === 'bellows_own_account', 'INVALID_PROVIDER_POLICY');
    validateDestination(shipment.destination); validateTender(shipment);
    requireValue(await checkEligibility(shipment,{signal}) === true, 'CARRIER_INELIGIBLE');
    requireValue(!signal.aborted, 'QUOTE_TIMEOUT');
    const body = {
      accountNumber:{value:accountNumber},
      requestedShipment:{
        shipper:{address:address(shipment.origin)},recipient:{address:address(shipment.destination)},
        shipDateStamp:shipment.ship_date,pickupType:shipment.pickup_type,
        serviceType:'FEDEX_2_DAY',packagingType:'YOUR_PACKAGING',preferredCurrency:'USD',rateRequestType:['ACCOUNT'],
        totalPackageCount:shipment.parcels.length,
        requestedPackageLineItems:shipment.parcels.map(p => ({groupPackageCount:1,
          weight:{units:'LB',value:p.weight_oz/16},
          // Current US service-guide rounding; original exact inches stay in manifest.
          dimensions:{units:'IN',...Object.fromEntries(Object.entries(p.dimensions_in).map(([k,v]) => [k,Math.ceil(v)]))} })),
      },
    };
    const response = await postRate(body,{signal});
    requireValue(!response?.errors?.length && Array.isArray(response?.output?.rateReplyDetails), 'INVALID_FEDEX_RESPONSE');
    const matches = response.output.rateReplyDetails.filter(r => r.serviceType === 'FEDEX_2_DAY')
      .flatMap(r => r.ratedShipmentDetails ?? []).filter(r => r.rateType === 'ACCOUNT' && r.currency === 'USD');
    requireValue(matches.length === 1, 'ACCOUNT_RATE_UNAVAILABLE');
    // Shipment total includes surcharges. Never multiply by parcels or add markup.
    const amount = matches[0].totalNetCharge;
    requireValue((typeof amount === 'number' || typeof amount === 'string') && /^\d+(?:\.\d{1,2})?$/.test(String(amount)), 'INVALID_FEDEX_AMOUNT');
    const [whole,fraction=''] = String(amount).split('.');
    const cents = Number(BigInt(whole)*100n + BigInt(fraction.padEnd(2,'0')));
    requireValue(Number.isSafeInteger(cents) && cents > 0, 'INVALID_FEDEX_AMOUNT');
    return {eligible:true,service:'FEDEX_2_DAY',currency:'USD',rate_source:'bellows_own_account',total_cents:cents};
  } };
}
