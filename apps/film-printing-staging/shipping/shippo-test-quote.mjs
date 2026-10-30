import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { digest, freeze } from '../configuration/config.mjs';
import { ShippingError, requireValue } from './packing.mjs';
import { createShippoProvider, createShippoTransport } from './shippo.mjs';
import { createShippoTestEligibility } from './shippo-eligibility.mjs';

// Server/operator only. stdout is captured directly into memory; no shell,
// credential argv, environment export, temp file, logging or live-key lookup.
export async function readShippoTestKey({signal} = {}) {
  try {
    const {stdout} = await promisify(execFile)('/usr/bin/security', ['find-generic-password',
      '-s','com.bellows.film-printing.staging.shippo.test','-a','bellows-film-printing-staging','-w'],
    {encoding:'utf8',signal,timeout:1800,maxBuffer:4096});
    const token = stdout.trim();
    requireValue(/^shippo_test_[a-zA-Z0-9]+$/.test(token), 'SHIPPO_TEST_ACCESS_MISSING');
    return token;
  } catch { throw new ShippingError('SHIPPO_TEST_ACCESS_MISSING'); }
}

const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value) && !/shippo_(test|live)_/i.test(value) ? value : null;
const safeNumber = value => typeof value === 'string' && /^\d{1,6}(?:\.\d{1,4})?$/.test(value) ? value : null;
const messages = value => Array.isArray(value) ? value.map(m => ({sha256:digest(m),code:safeId(m?.code),source:safeId(m?.source)})) : null;
const parcels = value => Array.isArray(value) ? value.map(p => ({
  length:safeNumber(p?.length),width:safeNumber(p?.width),height:safeNumber(p?.height),weight:safeNumber(p?.weight),
  distance_unit:p?.distance_unit === 'in' ? 'in' : null,mass_unit:p?.mass_unit === 'oz' ? 'oz' : null,
})) : null;
const addressCheck = (actual,expected) => ({
  complete:actual?.is_complete === true,invalid:actual?.validation_results?.is_valid === false,
  matches:Object.fromEntries(Object.keys(expected ?? {}).map(key => [key,actual?.[key] === expected[key]])),
});
// Allowlist only. No addresses, contacts, provider error text, owner information,
// response URLs or raw JSON escapes in the persisted diagnostic evidence.
function redactResponse(response,body) {
  return {shipment_id:safeId(response?.object_id),status:safeId(response?.status),test:response?.test === true,
    metadata_matches:response?.metadata === body.metadata,
    shipment_date_matches:Date.parse(response?.shipment_date) === Date.parse(body.shipment_date),
    account_ids:Array.isArray(response?.carrier_accounts) ? response.carrier_accounts.map(safeId) : null,
    address_from:addressCheck(response?.address_from,body.address_from),address_to:addressCheck(response?.address_to,body.address_to),
    parcels:parcels(response?.parcels),messages:messages(response?.messages),
    rates:Array.isArray(response?.rates) ? response.rates.map(r => ({
      rate_id:safeId(r?.object_id),shipment_id:safeId(r?.shipment),account_id:safeId(r?.carrier_account),
      carrier:['USPS','UPS','FedEx','DHL Express'].includes(r?.provider) ? r.provider : null,
      service_token:safeId(r?.servicelevel?.token),terms:safeId(r?.servicelevel?.terms),
      amount:typeof r?.amount === 'string' && /^\d{1,14}(?:\.\d{1,2})?$/.test(r.amount) ? r.amount : null,
      currency:r?.currency === 'USD' ? 'USD' : null,test:r?.test === true,messages:messages(r?.messages),
    })) : null};
}

// A diagnostic for ONE trusted manifest; never builds/publishes an enabled F03
// release or bypasses the authenticated job/config loader in the checkout path.
// All permitted services are inspected before reading the credential. No retries.
export async function runShippoTestQuote({enabled=false,shipment,inventory,reviews=[],readToken=readShippoTestKey,
  fetchImpl=globalThis.fetch,now=Date.now,signal,timeoutMs=2000} = {}) {
  const evidence = {mode:'test',checkout_ready:false,shipment_requests:0};
  const started = performance.now();
  const controller = new AbortController();
  let timer, cancel;
  const work = async () => {
    requireValue(enabled === true, 'SHIPPO_DISABLED');
    requireValue(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 2500, 'INVALID_TIMEOUT');
    const input = freeze(structuredClone(shipment));
    const eligibility = createShippoTestEligibility({inventory,reviews,now});
    const options = input?.policy?.shippo?.services;
    requireValue(Array.isArray(options) && options.length > 0, 'MISSING_SERVICE');
    evidence.preflight = options.map(option => ({account_id:safeId(option.account_id),service_token:safeId(option.service_token),...eligibility.inspect(input,option)}));
    requireValue(evidence.preflight.some(p => p.eligible), 'CARRIER_INELIGIBLE');
    requireValue(!controller.signal.aborted, 'QUOTE_TIMEOUT');
    const token = await readToken({signal:controller.signal});
    requireValue(!controller.signal.aborted, 'QUOTE_TIMEOUT');
    const transport = createShippoTransport({enabled:true,mode:'test',token,fetchImpl:async (...args) => {
      evidence.shipment_requests++;
      const start = performance.now();
      try {
        const response = await fetchImpl(...args);
        evidence.http_status = response.status;
        return response;
      } finally { evidence.http_ms = Math.round(performance.now()-start); }
    }});
    const provider = createShippoProvider({mode:'test',checkEligibility:eligibility.checkEligibility,
      postShipment:async (body,context) => {
        evidence.request = {mode:'test',api_version:'2018-02-08',account_ids:body.carrier_accounts,
          shipment_date:body.shipment_date,parcels:parcels(body.parcels),async:body.async};
        const response = await transport(body,context);
        evidence.response = redactResponse(response,body);
        return response;
      }});
    const result = await provider.quote(input,{signal:controller.signal});
    requireValue(!controller.signal.aborted, 'QUOTE_TIMEOUT');
    return {status:'available',mode:'test',checkout_ready:false,options:result.options};
  };
  let result;
  try {
    requireValue(!signal?.aborted, 'QUOTE_CANCELLED');
    const cancelled = new Promise((_,reject) => {
      cancel = () => {controller.abort();reject(new ShippingError('QUOTE_CANCELLED'));};
      signal?.addEventListener('abort',cancel,{once:true});
    });
    result = await Promise.race([work(),cancelled,new Promise((_,reject) => {
      timer = setTimeout(() => {controller.abort();reject(new ShippingError('QUOTE_TIMEOUT'));},
        Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 2500 ? timeoutMs : 2000);
    })]);
  } catch (error) {
    controller.abort();
    result = {status:'unavailable',code:error instanceof ShippingError ? error.code : 'DEPENDENCY_FAILED',options:[]};
  } finally {clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
  // Snapshot evidence so ignored cancellation/late network results cannot mutate it.
  return freeze({result,evidence:structuredClone({...evidence,total_ms:Math.round(performance.now()-started)})});
}
