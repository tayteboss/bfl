import test from 'node:test';
import assert from 'node:assert/strict';
import {fullRig} from '../../../fixtures/film-printing/f06p-engineering/full-rig.mjs';
import {createResourceSession} from '../theme/resource-session.js';
import {createCustomerCheckout} from '../theme/customer-checkout.js';
import {createOwnedUploads} from '../theme/owned-uploads.js';

const storage=()=>{const data=new Map();return {getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)};};
async function accepted(t){
 const f=await fullRig(t,{customerFlow:true,customerJobs:2,customerEdits:true}),saved=storage();
 const session=()=>createResourceSession({fetchImpl:f.browserFetch,now:()=>f.clock.time,reloadStorage:saved});
 const original=session();await original.issue();
 const act=(action,id=f.ids.A)=>original.checkout(action,async()=>id);
 await act('bind');await act('install');
 const uploads=createOwnedUploads({},original),assets=[];
 for(const [i,file] of f.inputFiles.slice(0,2).entries()){
  const {intent_id}=await uploads.intent('reload-upload-'+i);
  assets.push((await uploads.bytes(intent_id,new Blob([file.bytes],{type:file.mime}))).asset_id);
 }
 const job=await original.request('/jobs',{...f.plan.selection,asset_ids:assets,copies:3,request_key:'reload-job-accepted'});
 f.addJob(job.item);const state=f.carts.get(f.ids.A);state.cart.lines.nodes[0].quantity=3;state.cart.totalQuantity=3;await act('publish');
 state.cart.lines.nodes[0].cost.subtotalAmount.amount='2.40';original.checkpoint();
 return Object.assign(f,{saved,session,original,act,state,job});
}
test('reload authenticates original accepted owner/publication, verifies native money, then edits/removes without new issuance or deadline',async t=>{
 const f=await accepted(t),before=f.rows(),expiry=f.runtime.status().expires,counts={...f.runtime.status().counts};let updates=0;
 const actions={getCart:async()=>({cart:{id:f.ids.A,lines:f.state.cart.lines.nodes.map(l=>({...l,cost:{totalAmount:l.cost.subtotalAmount}})),totalQuantity:f.state.cart.totalQuantity,cost:{totalAmount:{amount:(f.state.cart.lines.nodes.reduce((n,l)=>n+Number(l.cost.subtotalAmount.amount),0)).toFixed(2),currencyCode:'USD'}}}}),updateCart:async({lines})=>{
  updates++;for(const change of lines){const line=f.state.cart.lines.nodes.find(l=>l.id===change.id);line.quantity=change.quantity;line.cost.subtotalAmount.amount=(change.quantity*.80).toFixed(2);}
  f.state.cart.lines.nodes=f.state.cart.lines.nodes.filter(l=>l.quantity);f.state.cart.totalQuantity=f.state.cart.lines.nodes.reduce((n,l)=>n+l.quantity,0);return actions.getCart();
 }};
 const restored=f.session();assert.equal(restored.restore(),true);
 const flow=createCustomerCheckout(restored,{actions});assert.equal((await flow.initialize({resume:true})).resumed,true);assert.equal(updates,0);
 const after=f.rows();assert.deepEqual(after.resource_sessions,before.resource_sessions);assert.deepEqual(after.checkout_owner_admissions,before.checkout_owner_admissions);
 assert.deepEqual(after.cart_refresh_requests,before.cart_refresh_requests);assert.deepEqual(after.jobs,before.jobs);assert.equal(f.runtime.status().expires,expiry);
 for(const key of ['issue','bind','install','publish'])assert.equal(f.runtime.status().counts[key],counts[key]);
 assert.equal((await flow.change({job:f.job.reference.id,quantity:2})).cart.items[0].subtotal_cents,160);
 assert.equal((await flow.change({job:f.job.reference.id,quantity:0})).cart.items.length,0);
 assert.deepEqual(f.rows().jobs,before.jobs);assert.equal(f.runtime.status().expires,expiry);
 assert.throws(()=>f.session().restore());
});
test('resume rejects a different full cart even with copied job and protected marker; bare locator rejected',async t=>{
 const f=await accepted(t);const copied=structuredClone(f.state);copied.cart.id=f.ids.B;f.carts.set(f.ids.B,copied);
 await assert.rejects(f.act('resume',f.ids.B));await assert.rejects(f.act('resume',f.ids.A.split('?')[0]));
 assert.equal((await f.act('resume')).resumed,true);
});
test('resume rejects changed quantity/price and never republishes the prior accepted job',async t=>{
 const f=await accepted(t),count=f.runtime.status().counts.publish;
 f.state.cart.lines.nodes[0].cost.subtotalAmount.amount='3.00';await assert.rejects(f.act('resume'));
 f.state.cart.lines.nodes[0].cost.subtotalAmount.amount='2.40';f.state.cart.lines.nodes[0].quantity=4;f.state.cart.totalQuantity=4;await assert.rejects(f.act('resume'));
 assert.equal(f.runtime.status().counts.publish,count);
});
test('original publication expiry rejects resume while original session remains live',async t=>{
 const f=await accepted(t),expires=f.runtime.status().expires;f.clock.time=expires;
 await assert.rejects(f.act('resume'));assert.equal(f.runtime.status().expires,expires);
});
test('revocation rejects a retained accepted record and cannot issue a replacement',async t=>{
 const f=await accepted(t),copy=storage(),key='bfl:accepted-cart-session:v1';copy.setItem(key,f.saved.getItem(key));await f.original.revoke();
 const restored=createResourceSession({fetchImpl:f.browserFetch,now:()=>f.clock.time,reloadStorage:copy});assert.equal(restored.restore(),true);
 await assert.rejects(restored.checkout('resume',async()=>f.ids.A));assert.equal(f.runtime.status().counts.issue,1);
});
test('pending native edit is durably blocked before send and reload cannot replay it',async t=>{
 const f=await accepted(t);let sent=0;
 const session=f.session();assert.equal(session.restore(),true);
 const actions={getCart:async()=>({cart:{id:f.ids.A,lines:f.state.cart.lines.nodes.map(l=>({...l,cost:{totalAmount:l.cost.subtotalAmount}})),totalQuantity:3,cost:{totalAmount:{amount:'2.40',currencyCode:'USD'}}}}),updateCart:async()=>{sent++;assert.throws(()=>f.session().restore());throw Error('lost native response');}};
 const flow=createCustomerCheckout(session,{actions});await flow.initialize({resume:true});
 await assert.rejects(flow.change({job:f.job.reference.id,quantity:2}));assert.throws(()=>f.session().restore());
 await assert.rejects(flow.change({job:f.job.reference.id,quantity:2}));assert.equal(sent,1);
});

test('expired session cannot resume even if stored client expiry is extended',async t=>{
 const f=await accepted(t),key='bfl:accepted-cart-session:v1',value=JSON.parse(f.saved.getItem(key));
 f.clock.time=value.expires+1000;value.expires=f.clock.time+60000;f.saved.setItem(key,JSON.stringify(value));
 const restored=f.session();assert.equal(restored.restore(),true);await assert.rejects(restored.checkout('resume',async()=>f.ids.A));assert.equal(f.runtime.status().counts.issue,1);
});
test('uncertain pending upload leaves no resumable checkpoint or automatic retry',async t=>{
 const f=await accepted(t);let requests=0;
 const session=createResourceSession({reloadStorage:f.saved,now:()=>f.clock.time,fetchImpl:async()=>{requests++;throw Error('unknown outcome');}});
 assert.equal(session.restore(),true);
 await assert.rejects(session.request('/uploads/intents',{request_key:'unsaved-next-upload'}));assert.throws(()=>f.session().restore());assert.equal(requests,1);
});
test('lost completed publication leaves the client checkpoint blocked and never resends',async t=>{
 const f=await accepted(t),published=f.runtime.status().counts.publish;
 f.hook=async(stage,{path}={})=>{if(stage==='browser_response'&&path==='/checkout/publish')throw Error('lost publication response');};
 await assert.rejects(f.act('publish'));f.hook=null;
 assert.throws(()=>f.session().restore());assert.equal(f.runtime.status().counts.publish,published+1);
 assert.equal(f.runtime.status().operation_pending,false);
});
