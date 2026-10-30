import {authenticateOrderSignal,createOrderReader,hash} from './shopify.mjs';
import {packDeliveryGroups,normalizeJob,ShippingError} from '../shipping/packing.mjs';
import {verifyRelease,canonical,ConfigurationError} from '../configuration/config.mjs';
import {need,safeCode} from '../backend/config.mjs';

const reason=error=>error instanceof ShippingError||error instanceof ConfigurationError?error.code:safeCode(error);

function decideOrder(order,store,jobs) {
  const unresolved=[],resolved=[];
  if(order.edited||order.cancelled||order.lines.some(l=>l.current_quantity!==l.quantity))unresolved.push('ORDER_EDIT_CANCEL_OR_REFUND');
  const prints=order.lines.filter(l=>l.print);
  if(!prints.length)return {state:'unrelated',unresolved:[],lines:[],packing:null,consume:[]};
  if(new Set(prints.map(l=>l.reference.id)).size!==prints.length)unresolved.push('ORDER_DUPLICATE_JOB');
  for(const line of prints) {
    try {
      const stored=store.orders.job(line.reference.id);need(stored,'ORDER_JOB_UNKNOWN');
      const {owner}=stored,job=jobs.verifyRevocation(owner,line.reference),binding=store.orders.binding(job.id);
      need(binding&&binding.owner_hash===hash(owner),'ORDER_CART_BINDING_MISSING');
      need(order.cart_token_hash&&order.customer_hash&&binding.evidence_hash&&/^[a-f0-9]{64}$/.test(binding.evidence_hash)&&
        binding.cart_token_hash===order.cart_token_hash&&binding.customer_hash===order.customer_hash,'ORDER_SOURCE_LINK_UNPROVEN');
      const consumed=store.orders.consumed(job.id);
      need(!store.lifecycle.retired('owner',owner)&&(!consumed&&!store.lifecycle.retired('job',owner,job.id)||consumed?.order_id===order.id),'ORDER_JOB_REPLAY');
      need(line.variant_id===`gid://shopify/ProductVariant/${job.variant_id}`&&line.unit_cents===job.unit_price_cents,'ORDER_JOB_MISMATCH');
      const snapshot=store.orders.snapshot(job.id);need(snapshot,'ORDER_HISTORICAL_SNAPSHOT_MISSING');verifyRelease(snapshot.release);
      need(snapshot.release.version===job.config_version&&snapshot.release.sha256===job.config_sha256&&snapshot.catalog.version===job.price_version,'ORDER_SNAPSHOT_MISMATCH');
      const rows=snapshot.catalog.rows.filter(r=>r.enabled&&r.physical&&r.variant_id===job.variant_id&&r.service===job.service&&r.size===job.size&&r.paper===job.paper&&r.lab===job.lab&&canonical(r.options??{})===canonical(job.options));
      need(rows.length===1&&rows[0].per_file_cents*job.completed_asset_ids.length===job.unit_price_cents,'ORDER_SNAPSHOT_MISMATCH');
      const normalized=normalizeJob({...job,copies:line.quantity});
      need(normalized.physical_count<=10000&&job.unit_price_cents*line.quantity<=200000,'ORDER_JOB_LIMIT');
      let assetsAvailable=true;try {store.uploads(owner,job.completed_asset_ids);}catch {assetsAvailable=false;}
      resolved.push({line,owner,job,snapshot,normalized,assetsAvailable});
    }catch(error){unresolved.push(reason(error));}
  }
  // No partial consumption when any line/source association is unproved.
  if(unresolved.length)return {state:'pending',unresolved:[...new Set(unresolved)],lines:[],packing:null,consume:[]};
  need(resolved.reduce((sum,r)=>sum+r.line.quantity*r.job.unit_price_cents,0)<=200000,'ORDER_PRICE_LIMIT');
  const lines=resolved.map(({line,job,normalized,assetsAvailable})=>({order_line_id:line.id,job_id:job.id,revision:job.revision,
    config_version:job.config_version,config_sha256:job.config_sha256,price_version:job.price_version,variant_id:line.variant_id,
    service:job.service,size:job.size,paper:job.paper,lab:job.lab,options:job.options,unit_price_cents:job.unit_price_cents,
    ordered_copies:line.quantity,original_copies:job.copies,asset_ids:job.completed_asset_ids,file_count:normalized.file_count,
    physical_count:normalized.physical_count,assets_available_at_recording:assetsAvailable}));
  let packing=null;
  try {
    need(resolved.every(r=>r.assetsAvailable),'ORDER_ASSETS_UNAVAILABLE');
    const release=resolved[0].snapshot.release;
    need(resolved.every(r=>r.job.config_sha256===release.sha256),'ORDER_MIXED_CONFIG_VERSIONS');
    const groups=[];
    for(const g of order.groups) {
      const members=resolved.filter(r=>g.lines.some(l=>l.line_id===r.line.id));if(!members.length)continue;
      need(g.status==='OPEN'&&g.method==='SHIPPING'&&g.location_id,'ORDER_GROUP_NOT_PACKABLE');
      need(g.lines.length===1&&members.length===1,'SHARING_UNAVAILABLE');
      const r=members[0],assigned=g.lines[0];
      need(assigned.total===r.line.quantity&&assigned.remaining===r.line.quantity,'ORDER_SPLIT_OR_FULFILLED');
      groups.push({id:g.id,lab:r.job.lab,location_id:g.location_id,job_ids:[r.job.id]});
    }
    need(groups.length===resolved.length&&new Set(groups.flatMap(g=>g.job_ids)).size===resolved.length,'ORDER_GROUPS_UNPROVEN');
    const result=packDeliveryGroups(release,{jobs:resolved.map(r=>({...r.job,copies:r.line.quantity})),groups});
    // Keep staff packing arithmetic/IDs, not sender contact/address or file URLs.
    packing={config_version:result.config_version,config_sha256:result.config_sha256,group_kind:'fulfillment_order',
      groups:result.groups.map(({id,lab,location_id,parcels,total_weight_oz})=>({id,lab,location_id,parcels,total_weight_oz}))};
  }catch(error){unresolved.push(reason(error));}
  return {state:packing?'recorded':'packing_pending',unresolved,lines,packing,
    consume:resolved.filter(r=>!store.orders.consumed(r.job.id)).map(r=>({owner:r.owner,reference:r.line.reference}))};
}

export function createOrderHandoff({store,jobs,config,enabled=false,secret=null,transport={}}) {
  const read=createOrderReader({...config,enabled},transport);
  const process=async(s,{signal,claim}={})=>{
    need(enabled===true,'ORDER_HANDOFF_DISABLED');
    need(!signal?.aborted,'ORDER_PROCESS_ABORTED');store.orders.checkDelivery(s);
    const order=await read(s.order_id,{signal});
    // Aborted noncooperative reads cannot touch a closed DB or persist late.
    need(!signal?.aborted,'ORDER_PROCESS_ABORTED');
    return store.lifecycle.transaction(()=>{
      if(claim)store.orderInbox.claimed(claim);
      return store.orders.record(s,order,()=>decideOrder(order,store,jobs));
    });
  };
  const receive=async input=>{
    need(enabled===true,'ORDER_HANDOFF_DISABLED');
    return process(authenticateOrderSignal(input,secret));
  };
  // Only a live claim can resolve a previously authenticated persisted signal.
  // No caller supplies canonical signal fields here, and no HTTP route takes a claim.
  receive.processClaim=async(claim,{signal}={})=>{
    need(!signal?.aborted,'ORDER_PROCESS_ABORTED');
    return process(store.orderInbox.claimed(claim),{signal,claim});
  };
  return receive;
}
