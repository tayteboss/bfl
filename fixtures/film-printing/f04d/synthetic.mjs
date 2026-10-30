// OFFLINE ONLY: invented addresses, evidence references and physical assertions.
// Never pass this fixture to a real transport or publish its enabled release.
import { shippoRelease,shippoInput,job } from '../f04b/synthetic.mjs';
import { packDeliveryGroups } from '../../../apps/film-printing-staging/shipping/packing.mjs';
import { digest } from '../../../apps/film-printing-staging/configuration/config.mjs';
export const now = () => Date.parse('2026-10-21T12:00:00Z');
export const option = {carrier:'USPS',account_id:'synthetic_usps',service_token:'usps_ground_advantage'};
export function fixture() {
  const release = shippoRelease(c => c.policies[0].shippo.services = [option]);
  const input = shippoInput(release,[job(release,{size:'8x10',copies:1,completed_asset_ids:['synthetic-asset']})]);
  const group = packDeliveryGroups(release,input).groups[0];
  const shipment = {...group,config_version:release.version,currency:'USD',policy:release.config.policies[0],
    origin:{...group.origin,name:'Synthetic Origin',residential:false},
    destination:{...input.groups[0].destination,name:'Synthetic Destination'},
    shipment_date:'2026-10-22T18:00:00Z',tender:{carrier:'USPS',method:'post_office_counter'}};
  const inventory = {mode:'test',complete:true,accounts:[{object_id:option.account_id,carrier:'usps',active:true,test:true,
    is_shippo_account:true,owner_matches:null,authentication_status:'unverified',service_tokens:[option.service_token]}]};
  return {...structuredClone({shipment,inventory,reviews:[reviewFor(shipment,inventory)]}),now};
}
export function reviewFor(shipment,inventory) {
  return {option,shipment_sha256:digest(shipment),inventory_sha256:digest(inventory),
    reviewed_at:'2026-10-21T11:00:00Z',expires_at:'2026-10-22T11:00:00Z',
    references:Object.fromEntries(['connection','origin','destination','physical','packaging','tender'].map(k => [k,`SYNTHETIC ONLY ${k}`])),
    physical:{contents:'finished_paper_prints_only',packaging:'own',shape:'rectangular',rigid:true,labels_fit:true}};
}
