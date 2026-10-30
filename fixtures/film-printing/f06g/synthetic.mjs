// OFFLINE ONLY. These owner/cart/source/authority/group/physical/rate facts are
// invented fixtures. No runtime module imports this file or its enabled release.
import {createHash} from 'node:crypto';
import {createJobStore,createJobService} from '../../../apps/film-printing-staging/jobs/service.mjs';
import {createCheckoutProjector} from '../../../apps/film-printing-staging/checkout/projector.mjs';
import {createQuoteService} from '../../../apps/film-printing-staging/shipping/quote.mjs';
import {createShippoProvider} from '../../../apps/film-printing-staging/shipping/shippo.mjs';
import {resolveCarrierReferences} from '../../../apps/film-printing-staging/carrier/preparation.mjs';
import {requireValue as need} from '../../../apps/film-printing-staging/shipping/packing.mjs';
import {PRODUCT,VARIANT,ATTRIBUTES,decodeAuthority} from '../../../apps/film-printing-staging/checkout/authority.js';
import {shippoRelease,shippoInput,reply} from '../f04b/synthetic.mjs';
import {STORE} from '../../../apps/film-printing-staging/configuration/schema.mjs';
const owner='synthetic-owner-f06g';
export async function syntheticFixture() {
  const store=createJobStore(':memory:');
  const f={store,release:shippoRelease(),reads:0,posts:[],owner,mode:'shipping',source:true,complete:true};
  const catalog={version:'synthetic-f06g-prices',store:STORE,currency:'USD',rows:[{enabled:true,physical:true,service:'photo',size:'4x6',paper:'synthetic-paper',lab:'miami',per_file_cents:40,variant_id:'67852705202287',options:{}}]};
  f.catalog=catalog;
  f.jobs=createJobService({store,loader:{load:async()=>f.release},loadCatalog:async()=>catalog,secret:'synthetic-f06g-job-secret-'.repeat(3)});
  for(const id of ['asset-0001','asset-0002','asset-0003'])store.recordUpload(owner,{id,state:'complete',verified:true,url:`https://example.invalid/${id}`});
  f.prepared=await f.jobs.prepare(owner,{request_key:'synthetic-f06g-request',copies:4,service:'photo',size:'4x6',paper:'synthetic-paper',lab:'miami',options:{},asset_ids:['asset-0001','asset-0002','asset-0003']});
  f.cart={id:'gid://shopify/Cart/synthetic-f06g',store:STORE,owner,complete:true,customer_id:null,lines:[{
    id:'gid://shopify/CartLine/synthetic-f06g-line',variant_id:VARIANT,product_id:PRODUCT,quantity:15,reference:f.prepared.reference,properties:f.prepared.item.properties}]};
  const projector=createCheckoutProjector({jobs:f.jobs,resolveCart:async()=>f.cart,loadContext:async()=>({release:f.release,catalog,shopDate:'2026-10-21',field:null})});
  // This is NOT an actual published Function grant or proven callback/line ID link.
  f.authority=(await projector.prepare({})).value;
  const input=shippoInput(f.release,[{id:f.prepared.reference.id,lab:'miami'}]);
  f.group=input.groups[0];
  const origin=f.release.config.labs.find(l=>l.id==='miami').origin;
  const wire=a=>({country:a.country_code,postal_code:a.postal_code,province:a.province_code,city:a.city,address1:a.address1,address2:a.address2});
  f.body={rate:{origin:wire(origin),destination:wire(f.group.destination),currency:'USD',locale:'en',items:[{
    product_id:15620086005871,variant_id:67852705202287,quantity:15,price:120,grams:0,requires_shipping:true,properties:structuredClone(f.prepared.item.properties)}]}};
  f.post=async b=>{f.posts.push(b);return reply(b);};
  f.eligibility=async()=>true; // synthetic physical/account review only
  f.process=async({callback},{signal})=>{
    // Each condition models missing independent evidence, never fields supplied
    // by the callback. This implementation intentionally lives only in fixtures.
    need(f.source,'SYNTHETIC_SOURCE_UNAVAILABLE');
    need(f.complete&&f.cart.complete&&f.mode==='shipping'&&f.cart.lines.length===callback.items.length,'SYNTHETIC_GROUP_UNAVAILABLE');
    const authority=decodeAuthority(f.authority),grant=authority?.grants[0];
    need(grant&&authority.config_version===f.release.version&&authority.config_sha256===f.release.sha256&&authority.price_version===catalog.version&&authority.valid_on==='2026-10-21','SYNTHETIC_AUTHORITY_UNAVAILABLE');
    const hash=s=>createHash('sha256').update(s).digest('hex');
    need(grant.cart===hash(f.cart.id)&&grant.owner===hash(f.owner)&&grant.customer_id===f.cart.customer_id&&grant.lines.length===callback.items.length,'SYNTHETIC_AUTHORITY_UNAVAILABLE');
    for(const item of callback.items) {
      const line=f.cart.lines.find(l=>l.reference.id===item.reference.id),approved=grant.lines.find(l=>l.claims.job===item.reference.id);
      need(line&&approved&&line.quantity===item.quantity&&approved.quantity===item.quantity&&line.id===approved.id&&
        Object.entries(ATTRIBUTES).every(([a,k])=>(item.properties[k]??'')===approved.claims[a]),'SYNTHETIC_BINDING_UNAVAILABLE');
    }
    // One externally loaded snapshot. The quote loader below reuses those bytes.
    f.reads++;const release=structuredClone(f.release);
    const prepared=await resolveCarrierReferences({callback,owner:f.owner,jobs:f.jobs,release,signal});
    const lab=release.config.labs.find(l=>l.id===f.group.lab);
    const same=(a,b)=>['address1','address2','city','province_code','postal_code','country_code'].every(k=>(a?.[k]??'')===(b?.[k]??''));
    need(lab&&same(callback.origin,lab.origin)&&same(callback.destination,f.group.destination)&&f.group.location_id===lab.location_id&&f.group.job_ids.length===callback.items.length&&callback.items.every(i=>f.group.job_ids.includes(i.reference.id)),'SYNTHETIC_ROUTING_UNAVAILABLE');
    const quote=createQuoteService({loader:{load:async()=>release},resolveRequest:async()=>({currency:'USD',jobs:prepared.jobs,groups:[structuredClone(f.group)]}),
      provider:createShippoProvider({postShipment:(...args)=>f.post(...args),checkEligibility:(...args)=>f.eligibility(...args)})});
    const result=await quote.quote({}, {signal});
    need(store.lifecycle.state().epoch===prepared.ticket.epoch&&!store.lifecycle.state().pending&&!store.lifecycle.state().operation&&f.release.version===release.version,'AUTHORITY_FENCED');
    return result;
  };
  f.raw=()=>Buffer.from(JSON.stringify(f.body));
  return f;
}
