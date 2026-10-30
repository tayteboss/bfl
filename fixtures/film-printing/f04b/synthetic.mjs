// OFFLINE ONLY. Invented confirmations/accounts/rates; never publish this graph.
import {syntheticRelease,input,job} from '../f04/synthetic.mjs';
export {job};
export const services = [
  {carrier:'UPS',account_id:'synthetic_ups',service_token:'ups_ground'},
  {carrier:'UPS',account_id:'synthetic_ups',service_token:'ups_second_day_air'},
  {carrier:'FedEx',account_id:'synthetic_fedex',service_token:'fedex_ground'},
  {carrier:'USPS',account_id:'synthetic_usps',service_token:'usps_priority'},
];
export function shippoRelease(change=()=>{}) {
  return syntheticRelease(c => {
    Object.assign(c.policies[0],{provider:'shippo',service:'eligible_services',rate_source:'configured_shippo_accounts',
      shippo:{mode:'test',services:structuredClone(services)}});
    change(c);
  });
}
export function shippoInput(release,jobs=[job(release)]) {
  const data = input(release,jobs);
  for (const group of data.groups) {
    delete group.pickup_type; delete group.ship_date;
    group.shipment_date = '2026-10-21T15:00:00Z';
  }
  return data;
}
export function reply(body,options=services) {
  const shipment = 'synthetic_shipment';
  return {...structuredClone(body),object_id:shipment,status:'SUCCESS',test:true,messages:[],
    address_from:{...body.address_from,is_complete:true},address_to:{...body.address_to,is_complete:true},
    rates:options.filter(o=>body.carrier_accounts.includes(o.account_id)).map((o,i)=>({
      object_id:`synthetic_rate_${i}`,shipment,provider:o.carrier,carrier_account:o.account_id,
      servicelevel:{token:o.service_token},currency:'USD',amount:`${12+i}.34`,test:true,messages:[],
    }))};
}
