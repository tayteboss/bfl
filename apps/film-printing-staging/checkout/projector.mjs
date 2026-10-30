import {assertEngineeringConfig,assertEngineeringScope} from '../configuration/engineering.mjs';
import { createHash } from 'node:crypto';
import { freeze, verifyRelease, resolveRule, canonical } from '../configuration/config.mjs';
import { requireValue } from '../shipping/packing.mjs';
import { ATTRIBUTES, STORE, VARIANT, PRODUCT, MAX_BYTES, AUTHORITY_SCHEMA, decodeAuthority } from './authority.js';
import {resolveSelection,isFullProductCatalog} from '../jobs/selection.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
export const serializeAuthority = value => JSON.stringify(value).replace(/[\u007f-\uffff]/g,c=>`\\u${c.charCodeAt(0).toString(16).padStart(4,'0')}`);
const validDate = day => /^\d{4}-\d{2}-\d{2}$/.test(day) && new Date(day).toISOString().slice(0,10) === day;
export function emptyAuthority(release,catalog,day,options) {
  verifyRelease(release,options);
  requireValue(validDate(day) && catalog?.store===STORE && catalog.currency==='USD' && typeof catalog.version==='string','INVALID_AUTHORITY_CONTEXT');
  return {schema:1,store:STORE,config_version:release.version,config_sha256:release.sha256,price_version:catalog.version,valid_on:day,grants:[]};
}

function claimsFor(job, reference) {
  return {flow:'f05',job:job.id,revision:job.revision,config:job.config_version,signature:reference.signature,
    service:job.service,size:job.size,paper:job.paper,lab:job.lab,message:job.message,
    borders:job.options.Borders ?? '',turnaround:job.options.Turnaround ?? '',files:String(job.completed_asset_ids.length)};
}

// These are internal dependencies, not flags accepted by an HTTP route. resolveCart
// must authenticate owner, read the complete current Shopify cart, and map its GIDs.
// No implementation is supplied for an Ajax token -> Storefront cart conversion.
export function createCheckoutProjector({jobs,resolveCart,loadContext,binding,guard=()=>{},sourceScope}) {
  requireValue(typeof jobs?.resolveForCheckout==='function' && typeof resolveCart==='function' && typeof loadContext==='function','MISSING_SERVER_DEPENDENCY');
  return {
    async prepare(request) {
      guard();
      requireValue(jobs.authorityLifecycle,'LIFECYCLE_REQUIRED');
      const ticket=jobs.authorityLifecycle.beginPreparation();
      requireValue(!binding || binding.epoch===ticket.epoch,'BINDING_EPOCH_MISMATCH');
      const cart=freeze(structuredClone(await resolveCart(request)));
      guard();
      requireValue(cart?.store===STORE && typeof cart.owner==='string' && cart.owner.length>0 &&
        /^gid:\/\/shopify\/Cart\//.test(cart.id) && cart.complete===true && Array.isArray(cart.lines) &&
        cart.lines.length>0 && (cart.customer_id===null || /^gid:\/\/shopify\/Customer\/\d+$/.test(cart.customer_id)), 'UNVERIFIED_CART');
      const context=freeze(structuredClone(await loadContext())); // One fresh release/catalog/day and CAS state.
      guard();
      const {release,catalog,shopDate}=context;
      requireValue(!isFullProductCatalog(catalog),'FULL_PRODUCT_LEASE_REQUIRED');
      const prior=context.field?.value??null;
      const next=emptyAuthority(release,catalog,shopDate,{sourceScope});
      if(binding)next.schema=AUTHORITY_SCHEMA;
      requireValue(Array.isArray(catalog.rows),'PRICE_UNAVAILABLE');
      const cartHash=hash(cart.id), ownerHash=hash(cart.owner);
      if(prior!==null) {
        const previous=decodeAuthority(prior);
        requireValue(previous,'INVALID_PRIOR_AUTHORITY');
        const existing=previous.grants.find(g=>g.cart===cartHash);
        requireValue(!existing || (existing.owner===ownerHash && existing.customer_id===cart.customer_id),'CART_OWNER_CHANGED');
        // Cutover drops every old-version/day grant. Never relabel an old grant.
        if(previous.schema===next.schema && ['config_version','config_sha256','price_version','valid_on'].every(k=>previous[k]===next[k]))
          next.grants=previous.grants.filter(g=>g.cart!==cartHash);
      }
      const selected=cart.lines.filter(l=>l.variant_id===VARIANT || l.product_id===PRODUCT || l.reference || Object.keys(l.properties??{}).some(k=>k.startsWith('_bfl_')));
      requireValue(selected.length>0,'NO_PRINT_JOBS');
      const resolved=await jobs.resolveForCheckout(cart.owner,selected.map(l=>l.reference),release);
      guard();
      const lines=resolved.map((job,i)=>{
        const line=selected[i];
        requireValue(line.variant_id===VARIANT && `gid://shopify/ProductVariant/${job.variant_id}`===VARIANT && line.product_id===PRODUCT && !line.selling_plan,'VARIANT_MISMATCH');
        requireValue(Number.isSafeInteger(line.quantity) && line.quantity>0 && line.quantity<=10000 && job.unit_price_cents*line.quantity<=200000,'INVALID_COPIES');
        requireValue(job.price_version===catalog.version,'PRICE_VERSION_MISMATCH');
        const priced=resolveSelection(catalog,job,{completedFileCount:job.completed_asset_ids.length,canonicalInput:true});
        requireValue(priced.variant_id===job.variant_id&&priced.unit_price_cents===job.unit_price_cents,'PRICE_UNAVAILABLE');
        const rule=resolveRule(release.config,{service:job.service,size_key:job.size,paper:job.paper,lab:job.lab},{sourceScope});
        const lab=release.config.labs.find(l=>l.id===job.lab);
        requireValue(rule && /^gid:\/\/shopify\/Location\/\d+$/.test(lab.location_id) && (lab.origin_status==='verified'||release.config.engineering&&assertEngineeringConfig(sourceScope,release.config)),'LAB_UNAVAILABLE');
        const claims=claimsFor(job,line.reference);
        requireValue(Object.entries(ATTRIBUTES).every(([alias,key])=>(line.properties?.[key]??'')===claims[alias]),'SPECIFICATION_MISMATCH');
        return {...(binding?{}:{id:line.id}),quantity:line.quantity,unit_cents:job.unit_price_cents,file_count:job.completed_asset_ids.length,location_id:lab.location_id,claims};
      });
      next.grants.push({cart:cartHash,owner:ownerHash,customer_id:cart.customer_id,lines,...(binding?{binding:binding.marker,generation:binding.generation,epoch:binding.epoch}:{})});
      const value=serializeAuthority(next);
      requireValue(value.length<=MAX_BYTES,'AUTHORITY_CAPACITY');
      requireValue(decodeAuthority(value),'INVALID_AUTHORITY');
      if(sourceScope)assertEngineeringScope(sourceScope);
      jobs.authorityLifecycle.stage(ticket,value);
      return freeze({authority:next,value,context,ticket,cart_hash:cartHash,checkout_ready:false});
    },
  };
}

// Removal is a revocation, not an expired reference's implicit renewal. Publish
// the result via the same CAS writer. Remove grants on upload deletion/order use.
export function revokeAuthority(raw,{cartHash,jobId,ownerHash}={}) {
  const a=decodeAuthority(raw);
  requireValue(a && [cartHash,jobId,ownerHash].some(v=>typeof v==='string' && v.length>0),'INVALID_REVOCATION');
  a.grants=a.grants.filter(g=>g.cart!==cartHash && g.owner!==ownerHash && !g.lines.some(l=>l.claims.job===jobId));
  return serializeAuthority(a);
}
