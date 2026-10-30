import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {carrierRates} from '../carrier/contract.mjs';

test('USPS display title leaves signed service identity, price and quote untouched',()=>{
 const option={id:'shippo:test:fixture_account:usps_ground_advantage',carrier:'USPS',account_id:'fixture_account',service:'usps_ground_advantage',currency:'USD',total_cents:2359};
 const result={status:'available',provider:'shippo',mode:'test',packing:{groups:[{id:'group',lab:'chicago',location_id:'gid://shopify/Location/92906258543'}]},quotes:[{group_id:'group',lab:'chicago',location_id:'gid://shopify/Location/92906258543',options:[option]}]};
 const before=structuredClone(result);
 assert.deepEqual(carrierRates(result),{rates:[{service_name:'USPS Ground Advantage',service_code:'BFL_SHIPPO_'+createHash('sha256').update(option.id).digest('hex'),description:'Carrier-calculated shipping',currency:'USD',total_price:'2359'}]});
 assert.deepEqual(result,before);
 for(const [carrier,service] of [['UPS','ups_ground'],['USPS','usps_priority']]){
  const changed=structuredClone(result),o=changed.quotes[0].options[0];Object.assign(o,{carrier,service,id:`shippo:test:${o.account_id}:${service}`});
  assert.equal(carrierRates(changed).rates[0].service_name,`${carrier} ${service}`);
 }
 const tampered=structuredClone(result);tampered.quotes[0].options[0].service='USPS Ground Advantage';assert.throws(()=>carrierRates(tampered),{code:'CALLBACK_RATE'});
});
