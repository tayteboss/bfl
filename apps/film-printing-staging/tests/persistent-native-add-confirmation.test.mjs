import test from 'node:test';
import assert from 'node:assert/strict';
import {persistentRig} from '../../../fixtures/film-printing/persistent-client-staging-20261030/rig.mjs';
import {createResourceSession} from '../theme/resource-session.js';
import {createPreparedCheckout} from '../theme/prepared-checkout.js';
import {quantitySignature} from '../checkout/quantity-signature.js';
import {retainCartReadReceipt} from '../theme/film-printing-form.js';

const darkroom={service:'Darkroom Prints',size:'8” × 10”',paper:'RC Matte',lab:'Chicago',options:{Process:'Color',Borders:'Borderless (Edge-to-edge)',Turnaround:'Standard (4-5 days)','Scanning Options':'Yes',Negatives:'Mail In'},asset_ids:[],copies:1,message:''};
const money=cents=>({amount:(cents/100).toFixed(2),currencyCode:'USD'});
async function setup(t,{legacyAdd=false}={}){
 const f=await persistentRig(t,{sourceFlow:true}),saved=new Map(),storage={getItem:key=>saved.get(key)??null,setItem:(key,value)=>saved.set(key,value)};
 let writes=0,serial=0,lostConfirmation=false,confirmationFault=null,lostDiagnosis=false,lostCancellation=false,diagnosisFault=null,cancelReceiptFault=null,cancelling=false;
 const requests=[];
 const rows=()=>f.carts.get(f.ids.A).cart.lines.nodes;
 const props=line=>Object.fromEntries(line.attributes.map(({key,value})=>[key,value]));
 const key=line=>'ajax-'+line.id.split('/').at(-1);
 const native=()=>{f.reprice();const lines=rows().map(line=>({id:line.id,quantity:line.quantity,cost:{totalAmount:{...line.cost.subtotalAmount}}}));return {id:f.ids.A,lines:{nodes:lines,pageInfo:{hasNextPage:false}},totalQuantity:lines.reduce((n,l)=>n+l.quantity,0),cost:{totalAmount:money(lines.reduce((n,l)=>n+Math.round(Number(l.cost.totalAmount.amount)*100),0))}};};
 const ajax=()=>{f.reprice();const items=rows().map(line=>({key:key(line),variant_id:line.merchandise.id.split('/').at(-1),quantity:line.quantity,properties:props(line),final_price:Math.round(Number(line.cost.subtotalAmount.amount)*100)/line.quantity,final_line_price:Math.round(Number(line.cost.subtotalAmount.amount)*100)}));return {currency:'USD',items,item_count:items.reduce((n,l)=>n+l.quantity,0),total_price:items.reduce((n,l)=>n+l.final_line_price,0)};};
 const response=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
 const fetchImpl=async(url,options={})=>{
  if(url==='/cart.js')return response(ajax());
  if(url==='/cart?sections=cart-drawer')return response({'cart-drawer':'<div>Fixture cart</div>'});
  if(url==='/api/2026-07/graphql.json'){
   writes++;const {query,variables}=JSON.parse(options.body);assert.equal(variables.i,f.ids.A);const prior=[...rows()];let kind;
   if(query.includes('cartLinesAdd(')){
    kind='cartLinesAdd';const line=variables.lines[0];f.addJob({id:line.merchandiseId.split('/').at(-1),quantity:line.quantity,properties:Object.fromEntries(line.attributes.map(({key,value})=>[key,value]))});
    const added=rows()[0];added.id='gid://shopify/CartLine/native-'+(++serial);f.carts.get(f.ids.A).cart.lines.nodes=[...prior,added];
   }else if(query.includes('cartLinesRemove(')){kind='cartLinesRemove';f.carts.get(f.ids.A).cart.lines.nodes=prior.filter(line=>!variables.lines.includes(key(line)));}
   else {kind='cartLinesUpdate';for(const update of variables.lines){const line=prior.find(line=>key(line)===update.viewKey);assert.ok(line);line.quantity=update.quantity;line.attributes=update.attributes;}}
   const cart=native();return response({data:{[kind]:{cart:{id:cart.id,totalQuantity:cart.totalQuantity,lines:{nodes:cart.lines.nodes.map(({id,quantity})=>({id,quantity})),pageInfo:{hasNextPage:false}}},userErrors:[],warnings:[]}}});
  }
  const path=new URL(url,'https://bellows-film-printing-staging.myshopify.com').pathname,input=typeof options.body==='string'?JSON.parse(options.body):null;
  requests.push({path,kind:input?.operation?.kind});if(path==='/checkout/cancel_preparation')cancelling=true;
  const result=await f.browserFetch(url,options);
  if(path==='/checkout/continue'&&cancelling){cancelling=false;if(lostCancellation){lostCancellation=false;throw new TypeError('lost cancellation receipt');}}
  if(path==='/checkout/resume'&&input?.operation?.kind==='recover_preparation'){
   if(lostDiagnosis){lostDiagnosis=false;throw new TypeError('lost diagnosis');}
   if(diagnosisFault){const data=await result.json();diagnosisFault(data);return response(data);}
  }
  if(path==='/checkout/resume'){
   if(input?.operation?.kind==='cancel_preparation'&&cancelReceiptFault){const data=await result.json();cancelReceiptFault(data);return response(data);}
   if(lostConfirmation){lostConfirmation=false;throw new TypeError('lost confirmation response');}
   if(confirmationFault){const data=await result.json();confirmationFault(data);return response(data);}
  }
  return result;
 };
 const sessionFor=()=>createResourceSession({fetchImpl,now:()=>f.clock.time,reloadStorage:storage,preparedMode:true,clientPolicy:'bfl-persistent-staging-client-v1'});
 const flowFor=session=>createPreparedCheckout(session,{actions:{getCart:async()=>({cart:native()})},fetchImpl,now:()=>f.clock.time});
 const session=sessionFor();await session.issue();const flow=flowFor(legacyAdd?{...session,receipt:()=>({...session.receipt(),client_policy:undefined})}:session);await flow.initialize();
 return {...f,session,flow,sessionFor,flowFor,saved,storage,requests,get writes(){return writes;},set lostConfirmation(v){lostConfirmation=v;},set confirmationFault(v){confirmationFault=v;},set lostDiagnosis(v){lostDiagnosis=v;},set lostCancellation(v){lostCancellation=v;},set diagnosisFault(v){diagnosisFault=v;},set cancelReceiptFault(v){cancelReceiptFault=v;}};
}
test('persistent native Add confirms before acceptance, then remove and Direct Link Add work without a reload',async t=>{
 const f=await setup(t),first=await f.flow.prepare({...darkroom,request_key:'native-darkroom-first',generation:1});
 assert.equal(f.rows().cart_prepared_jobs[0].state,'issued');
 const added=await f.flow.addPrepared({prepared:first,quantity:1});assert.equal(added.accepted,true);
 assert.equal(f.rows().cart_prepared_jobs[0].state,'confirmed');
 await f.flow.change({job:first.reference.id,quantity:0});assert.equal(f.writes,2);
 const file=f.inputFiles[0],intent=await f.session.request('/uploads/intents',{request_key:'native-direct-link'});
 const uploaded=await f.session.request(`/uploads/${intent.intent_id}/source`,{url:file.source_url});
 const second=await f.flow.prepare({...f.plan.selection,asset_ids:[uploaded.asset_id],copies:1,message:'',request_key:'native-photo-second',generation:2});
 const next=await f.flow.addPrepared({prepared:second,quantity:1});assert.equal(next.cart.items[0].subtotal_cents,40);assert.equal(f.writes,3);
 assert.deepEqual(f.rows().cart_prepared_jobs.map(row=>row.state),['confirmed','confirmed']);
 assert.equal(second.expires_at,first.expires_at);assert.equal(f.rows().jobs.length,2);
});
test('lost persistent Add confirmation leaves one native write pending and reload confirms without replay',async t=>{
 const f=await setup(t),p=await f.flow.prepare({...darkroom,request_key:'native-lost-confirmation',generation:1});f.lostConfirmation=true;
 await assert.rejects(f.flow.addPrepared({prepared:p,quantity:1}),error=>error.cartUncertain===true);
 assert.equal(f.writes,1);assert.equal(f.flow.canRetry(),false);assert.equal(f.rows().cart_prepared_jobs[0].state,'confirmed');
 await assert.rejects(f.flow.addPrepared({prepared:p,quantity:1}));assert.equal(f.writes,1);
 const session=f.sessionFor(),recovery=session.restore();assert.equal(recovery.state,'pending');assert.equal(recovery.operation.kind,'add');
 const recovered=await f.flowFor(session).initialize({recovery});assert.equal(recovered.resumed,true);assert.equal(recovered.cart.items[0].subtotal_cents,4800);assert.equal(f.writes,1);assert.equal(session.restore().state,'accepted');
});
for(const fault of ['quantity','identity','price','expiry','receipt'])test(`persistent Add confirmation ${fault} mismatch cannot checkpoint acceptance or replay`,async t=>{
 const f=await setup(t),p=await f.flow.prepare({...darkroom,request_key:'native-fault-'+fault,generation:1});
 f.confirmationFault=receipt=>{if(fault==='quantity')receipt.items[0].quantity++;if(fault==='identity')receipt.items[0].id+='-different';if(fault==='price')receipt.items[0].subtotal_cents++;if(fault==='expiry')receipt.expires_at++;if(fault==='receipt')receipt.resumed=false;};
 await assert.rejects(f.flow.addPrepared({prepared:p,quantity:1}),error=>error.cartUncertain===true);assert.equal(f.writes,1);assert.equal(f.flow.canRetry(),false);assert.equal(f.sessionFor().restore().state,'pending');
});

async function abandoned(t){
 const f=await setup(t,{legacyAdd:true}),first=await f.flow.prepare({...darkroom,request_key:'abandoned-old-darkroom',generation:1});
 await f.flow.addPrepared({prepared:first,quantity:1});await f.flow.change({job:first.reference.id,quantity:0});
 const intent=await f.session.request('/uploads/intents',{request_key:'abandoned-new-file'}),uploaded=await f.session.request(`/uploads/${intent.intent_id}/source`,{url:f.inputFiles[0].source_url});
 await assert.rejects(f.flow.prepare({...f.plan.selection,asset_ids:[uploaded.asset_id],copies:1,message:'',request_key:'abandoned-unreserved-photo',generation:2}));
 assert.equal(f.rows().cart_prepared_jobs.length,1);assert.equal(f.rows().cart_prepared_jobs[0].state,'issued');assert.equal(f.rows().jobs.length,2);
 return f;
}
const restore=f=>{
 const key='bfl:accepted-cart-session:v1',saved=f.storage.getItem(key),record=JSON.parse(saved),session=f.sessionFor(),recovery=session.restore(),checkpoint=f.storage.getItem(key),flow=f.flowFor(session);
 return {session,recovery,flow:{...flow,initialize:async options=>{try{return await flow.initialize(options);}catch(error){retainCartReadReceipt(f.storage,key,saved,checkpoint,record,error);throw error;}}}};
};
test('old Add/remove orphan recovers by authenticated diagnosis and one cancellation, never replaying the unreserved job',async t=>{
 const f=await abandoned(t),bodies=f.rows().jobs.map(row=>row.body),uploads=f.counts.uploads,writes=f.writes,original=f.session.receipt(),next=restore(f);
 assert.deepEqual(next.recovery,{state:'pending',operation:null});const result=await next.flow.initialize({recovery:next.recovery});
 assert.deepEqual(result.cart.items,[]);assert.equal(f.writes,writes);assert.equal(f.counts.uploads,uploads);assert.deepEqual(f.rows().jobs.map(row=>row.body),bodies);assert.equal(f.rows().cart_prepared_jobs[0].state,'cancelled');
 assert.equal(next.session.receipt().expires_at,original.expires_at);assert.equal(restore(f).recovery.state,'initialized');assert.equal(f.requests.filter(r=>r.path==='/checkout/cancel_preparation').length,1);
 const p=await next.flow.prepare({...darkroom,request_key:'after-orphan-recovery',generation:3});await next.flow.addPrepared({prepared:p,quantity:1});
 assert.equal(f.writes,writes+1);assert.equal(f.rows().jobs.length,3);assert.deepEqual(f.rows().jobs.slice(0,2).map(row=>row.body),bodies);assert.deepEqual(f.rows().cart_prepared_jobs.map(row=>row.state),['cancelled','confirmed']);
});
test('lost read-only diagnosis retains the same finite pending/null credential for another authenticated read',async t=>{
 const f=await abandoned(t),saved=[...f.saved.values()][0],before=f.counts.admin_mutations;f.lostDiagnosis=true;const first=restore(f);
 await assert.rejects(first.flow.initialize({recovery:first.recovery}));assert.equal(f.requests.filter(r=>r.path==='/checkout/cancel_preparation').length,0);assert.equal(f.counts.admin_mutations,before);assert.deepEqual(JSON.parse([...f.saved.values()][0]),JSON.parse(saved));
 const again=restore(f);assert.deepEqual(again.recovery,{state:'pending',operation:null});assert.equal((await again.flow.initialize({recovery:again.recovery})).cart.items.length,0);assert.equal(f.writes,2);assert.equal(f.requests.filter(r=>r.path==='/checkout/cancel_preparation').length,1);
});
test('lost completed cancellation stays pending and reload observes it without repeating cancellation or Add',async t=>{
 const f=await abandoned(t);f.lostCancellation=true;const first=restore(f);
 await assert.rejects(first.flow.initialize({recovery:first.recovery}),e=>e.cartUncertain===true);assert.equal(f.rows().cart_prepared_jobs[0].state,'cancelled');
 const again=restore(f);assert.equal(again.recovery.state,'pending');assert.equal(again.recovery.operation.kind,'cancel_preparation');
 assert.equal((await again.flow.initialize({recovery:again.recovery})).cart.items.length,0);assert.equal(f.requests.filter(r=>r.path==='/checkout/cancel_preparation').length,1);assert.equal(f.requests.filter(r=>r.kind==='recover_preparation').length,1);assert.equal(f.writes,2);assert.equal(f.rows().jobs.length,2);
});
for(const fault of ['ticket','generation','expiry','receipt'])test(`altered preparation diagnosis ${fault} cannot cancel or checkpoint`,async t=>{
 const f=await abandoned(t);f.diagnosisFault=reply=>{if(fault==='ticket')reply.reservation.extra=true;if(fault==='generation')reply.reservation.generation=3;if(fault==='expiry')reply.reservation.expires_at++;if(fault==='receipt')reply.recovery='unexpected';};const next=restore(f);
 await assert.rejects(next.flow.initialize({recovery:next.recovery}));assert.equal(f.requests.filter(r=>r.path==='/checkout/cancel_preparation').length,0);assert.equal(f.writes,2);assert.deepEqual(restore(f).recovery,{state:'pending',operation:null});
});
for(const reloaded of [false,true])for(const fault of ['state','ticket','expiry','missing'])test(`altered cancellation ${fault} blocks ${reloaded?'reloaded':'immediate'} acknowledgement without replay`,async t=>{
 const f=await abandoned(t);let next=restore(f);
 if(reloaded){f.lostCancellation=true;await assert.rejects(next.flow.initialize({recovery:next.recovery}));next=restore(f);}
 f.cancelReceiptFault=reply=>{if(fault==='state')reply.prepared_recovery.state='issued';if(fault==='ticket')reply.prepared_recovery.reservation.operation_id='other';if(fault==='expiry')reply.prepared_recovery.reservation.expires_at++;if(fault==='missing')delete reply.prepared_recovery;};
 await assert.rejects(next.flow.initialize({recovery:next.recovery}));assert.equal(restore(f).recovery.operation.kind,'cancel_preparation');assert.equal(f.requests.filter(r=>r.path==='/checkout/cancel_preparation').length,1);assert.equal(f.writes,2);
});
test('prepared Darkroom reload cancels its exact unused reservation without auto-Add, then accepts a new selection',async t=>{
 const f=await setup(t),p=await f.flow.prepare({...darkroom,request_key:'darkroom-before-reload',generation:1}),next=restore(f);
 assert.equal(next.recovery.state,'prepared');assert.equal(next.recovery.selection,undefined);
 const result=await next.flow.initialize({recovery:next.recovery});assert.deepEqual(result.cart.items,[]);assert.equal(f.writes,0);assert.equal(f.rows().cart_prepared_jobs[0].state,'cancelled');
 const replacement=await next.flow.prepare({...darkroom,request_key:'darkroom-after-reload',generation:2});assert.equal(replacement.expires_at,p.expires_at);await next.flow.addPrepared({prepared:replacement,quantity:1});
 assert.equal(f.writes,1);assert.deepEqual(f.rows().cart_prepared_jobs.map(row=>row.state),['cancelled','confirmed']);assert.equal(f.requests.filter(r=>r.path==='/checkout/cancel_preparation').length,1);
});

for(const retained of [false,true])test(`combined known-current recovery preserves ${retained?'accepted print':'empty'} native cart and original owner after last upload removal`,async t=>{
 const f=await setup(t),p=await f.flow.prepare({...darkroom,request_key:'combined-known-current-'+retained,generation:1});
 if(retained)await f.flow.addPrepared({prepared:p,quantity:1});else await f.flow.cancelPreparation(p);
 const intent=await f.session.request('/uploads/intents',{request_key:'combined-known-current-upload'});await f.session.request(`/uploads/${intent.intent_id}/source`,{url:f.inputFiles[0].source_url});
 await f.session.request(`/uploads/${intent.intent_id}/remove`,{});
 const before=f.rows(),writes=f.writes,counts={...f.counts},receipt=f.session.receipt(),next=restore(f);
 assert.deepEqual(next.recovery,{state:'pending',operation:null});
 const result=await next.flow.initialize({recovery:next.recovery});
 assert.equal(result.resumed,true);assert.equal(result.cart.items.length,retained?1:0);assert.equal(restore(f).recovery.state,retained?'accepted':'initialized');
 assert.equal(next.session.receipt().expires_at,receipt.expires_at);assert.equal(f.writes,writes);assert.equal(f.counts.admin_mutations,counts.admin_mutations);assert.equal(f.counts.uploads,counts.uploads);assert.equal(f.rows().jobs.length,before.jobs.length);
 assert.deepEqual(f.rows().resource_sessions,before.resource_sessions);assert.deepEqual(f.rows().cart_prepared_jobs,before.cart_prepared_jobs);assert.deepEqual(f.rows().staging_resource_state,before.staging_resource_state);
 assert.equal(f.requests.filter(row=>row.kind==='recover_preparation').length,1);
});

const authority=f=>JSON.parse(f.m.data.shop.authority.value);
async function peer(f){
 const session=f.clients.B.session,act=(name,input={})=>session.checkout(name,async()=>f.ids.B,input);await session.issue();await act('bind');await act('install');
 const job=await session.request('/jobs',{...darkroom,request_key:'remove-confirm-peer'}),p=await act('eligible',{reference:job.reference,generation:1});
 f.addJob({...p.item,properties:{...p.item.properties,_bfl_signature:quantitySignature(p.reference.signature,p.item.quantity)}},'B');f.reprice('B');
 await act('resume',{operation:{kind:'add',job:p.reference.id,operation_id:p.reservation.operation_id,quantity:p.item.quantity}});return p;
}
test('persistent remove acknowledges partial and final clear, releases capacity, and preserves peer grant and original deadline',async t=>{
 const f=await setup(t),first=await f.flow.prepare({...darkroom,request_key:'remove-confirm-first',generation:1});await f.flow.addPrepared({prepared:first,quantity:1});
 const second=await f.flow.prepare({...darkroom,request_key:'remove-confirm-second',generation:2});await f.flow.addPrepared({prepared:second,quantity:1});
 const other=await peer(f),peerGrant=structuredClone(authority(f).grants.find(g=>g.lines.some(l=>l.claims.job===other.reference.id))),deadline=f.session.receipt().expires_at;
 const partial=await f.flow.change({job:first.reference.id,quantity:0});assert.equal(partial.cart.items.length,1);assert.equal(partial.cart.items[0].subtotal_cents,4800);
 const own=authority(f).grants.find(g=>g.lines.some(l=>l.claims.job===second.reference.id));assert.deepEqual(own.lines.map(l=>l.claims.job),[second.reference.id]);assert.deepEqual(authority(f).grants.find(g=>g.binding===peerGrant.binding),peerGrant);
 const removed=await f.flow.change({job:second.reference.id,quantity:0});assert.deepEqual(removed.cart.items,[]);assert.deepEqual(authority(f).grants,[peerGrant]);
 const owner=f.rows().resource_sessions[0].owner;assert.equal(f.rows().staging_grant_versions.findLast(row=>row.owner===owner).state,'suspended');assert.equal(f.session.receipt().expires_at,deadline);assert.equal(f.writes,4);
 assert.equal(f.requests.filter(r=>r.path==='/checkout/resume'&&r.kind==='remove').length,2);
 const next=await f.flow.prepare({...darkroom,request_key:'remove-confirm-next',generation:3});assert.equal(next.expires_at,first.expires_at);await f.flow.addPrepared({prepared:next,quantity:1});assert.equal(f.writes,5);assert.deepEqual(authority(f).grants.find(g=>g.binding===peerGrant.binding),peerGrant);
});
test('lost persistent remove acknowledgement retains pending operation and reload observes released capacity without replay',async t=>{
 const f=await setup(t),p=await f.flow.prepare({...darkroom,request_key:'remove-lost-confirmation',generation:1});await f.flow.addPrepared({prepared:p,quantity:1});f.lostConfirmation=true;
 await assert.rejects(f.flow.change({job:p.reference.id,quantity:0}),error=>error.cartUncertain===true);assert.equal(f.writes,2);assert.equal(f.flow.canRetry(),false);assert.deepEqual(authority(f).grants,[]);
 await assert.rejects(f.flow.change({job:p.reference.id,quantity:0}));assert.equal(f.writes,2);
 const writes=f.counts.admin_mutations,session=f.sessionFor(),recovery=session.restore();assert.equal(recovery.state,'pending');assert.equal(recovery.operation.kind,'remove');
 const result=await f.flowFor(session).initialize({recovery});assert.equal(result.resumed,true);assert.deepEqual(result.cart.items,[]);assert.equal(f.writes,2);assert.equal(f.counts.admin_mutations,writes);assert.equal(session.receipt().expires_at,f.session.receipt().expires_at);
});
for(const fault of ['expiry','receipt','items'])test(`persistent remove confirmation ${fault} mismatch cannot accept or replay`,async t=>{
 const f=await setup(t),p=await f.flow.prepare({...darkroom,request_key:'remove-fault-'+fault,generation:1});await f.flow.addPrepared({prepared:p,quantity:1});
 f.confirmationFault=receipt=>{if(fault==='expiry')receipt.expires_at++;if(fault==='receipt')receipt.resumed=false;if(fault==='items')receipt.items.push({id:'different',quantity:1,subtotal_cents:1});};
 await assert.rejects(f.flow.change({job:p.reference.id,quantity:0}),error=>error.cartUncertain===true);assert.equal(f.writes,2);assert.equal(f.flow.canRetry(),false);assert.equal(f.sessionFor().restore().operation.kind,'remove');
});

test('lost remove acknowledgement plus failed first reload retains original pending removal for a second read without replay',async t=>{
 const f=await setup(t),p=await f.flow.prepare({...darkroom,request_key:'remove-two-losses',generation:1});await f.flow.addPrepared({prepared:p,quantity:1});f.lostConfirmation=true;
 await assert.rejects(f.flow.change({job:p.reference.id,quantity:0}),error=>error.cartUncertain===true);const saved=JSON.parse([...f.saved.values()][0]),admin=f.counts.admin_mutations;
 const first=restore(f);assert.equal(first.recovery.operation.kind,'remove');f.lostConfirmation=true;await assert.rejects(first.flow.initialize({recovery:first.recovery}));
 assert.deepEqual(JSON.parse([...f.saved.values()][0]),saved);assert.equal(f.writes,2);assert.equal(f.counts.admin_mutations,admin);
 const second=restore(f);assert.equal(second.recovery.operation.kind,'remove');const result=await second.flow.initialize({recovery:second.recovery});assert.deepEqual(result.cart.items,[]);assert.equal(f.writes,2);assert.equal(f.counts.admin_mutations,admin);assert.equal(second.session.receipt().expires_at,saved.expires);
});
