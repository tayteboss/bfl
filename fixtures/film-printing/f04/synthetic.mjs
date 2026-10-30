// OFFLINE ONLY. These confirmations are artificial test inputs, never publication data.
import { readFileSync } from 'node:fs';
import { makeRelease } from '../../../apps/film-printing-staging/configuration/config.mjs';
export const active = JSON.parse(readFileSync(new URL('../f03/release-2.json',import.meta.url))).release;
export const boundaries = JSON.parse(readFileSync(new URL('../v1/expected-cases.json',import.meta.url))).packing_cases;
export function syntheticRelease(change = () => {}) {
  const c = structuredClone(active.config);
  for (const p of c.packages) Object.assign(p,{enabled:true,weight_status:'confirmed'});
  for (const r of c.rules.filter(r => r.capacity)) Object.assign(r,{enabled:true,paper:'synthetic-paper',capacity_status:'confirmed',weight_status:'confirmed'});
  const lab = c.labs.find(l => l.id === 'miami');
  Object.assign(lab,{enabled:true,origin_status:'verified'});
  // Clearly artificial second origin. NEVER use the alternate identity-only lab as a real origin.
  c.labs.push({...lab,id:'synthetic-second-lab',location_id:'gid://shopify/Location/999999999',origin:{...lab.origin,address1:'1 Synthetic Origin',city:'Chicago',province_code:'IL',postal_code:'60601'}});
  Object.assign(c.policies[0],{enabled:true,rate_access:'verified'});
  change(c);
  return makeRelease(c);
}
export const destination = {address1:'1 Synthetic Destination',address2:'',city:'Miami',province_code:'FL',country_code:'US',postal_code:'33127',residential:false};
export function job(release, extra={}) { return {id:'job-a',revision:'r1',config_version:release.version,service:'Photo Prints',size:'4" × 6″',paper:'synthetic-paper',lab:'miami',copies:4,completed_asset_ids:['asset-a','asset-b','asset-c'],...extra}; }
export function input(release, jobs=[job(release)]) { return {currency:'USD',jobs,groups:jobs.map((j,i)=>({id:`group-${i}`,job_ids:[j.id],lab:j.lab,location_id:release.config.labs.find(l=>l.id===j.lab)?.location_id,destination:{...destination},ship_date:'2026-10-20',pickup_type:'DROPOFF_AT_FEDEX_LOCATION'}))}; }
export const fedexReply = (amount=12.34) => ({output:{rateReplyDetails:[{serviceType:'FEDEX_2_DAY',ratedShipmentDetails:[{rateType:'ACCOUNT',currency:'USD',totalNetCharge:amount}]}]}});
