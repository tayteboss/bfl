import test from 'node:test';
import assert from 'node:assert/strict';
import {fullRig,deferred} from '../../../fixtures/film-printing/f06v3-candidate/full-rig.mjs';
import {createResourceSession} from '../theme/resource-session.js';
import {quantitySignature} from '../checkout/quantity-signature.js';
import {leaseEnvelope,leaseOwners} from '../checkout/lease.mjs';
const standard='Standard (4-5 days)',border='Borderless (Edge-to-edge)';
const darkroom={service:'Darkroom Prints',size:'8” × 10”',paper:'RC Matte',lab:'Chicago',options:{Process:'Color',Borders:border,Turnaround:standard,'Scanning Options':'Yes',Negatives:'Mail In'},asset_ids:[],copies:2,message:'Darkroom fixture'};
const fineArt={service:'Fine Arts',size:'16” × 20”',paper:'Luster',lab:'Chicago',options:{Borders:border,Turnaround:standard},copies:2,message:'Fine Art fixture'};
const custom={...fineArt,size:'Custom',size_mode:'custom',custom_dimensions:{width:20,height:16},paper:'Fibre Paper',copies:3,message:'Custom fixture'};
const grants=f=>JSON.parse(f.m.data.shop.authority.value);
function put(f,prepared){
 const state=f.carts.get(f.ids.A),prior=state.cart.lines.nodes.slice();
 f.addJob({...prepared.item,properties:{...prepared.item.properties,_bfl_signature:quantitySignature(prepared.reference.signature,prepared.item.quantity)}});
 const fresh=state.cart.lines.nodes[0];fresh.quantity=prepared.item.quantity;fresh.id=`gid://shopify/CartLine/full-${prepared.reference.id}?cart=synthetic`;state.cart.lines.nodes=[...prior,fresh];f.reprice();return fresh;
}
function owners(f){return leaseOwners(f.plan.specification_owner).map(o=>(f.m.data[o.alias].nodes??f.m.data[o.alias]).find(r=>r.id===o.id));}
test('full product HTTP: Darkroom first without upload, Chicago Fine Art, Custom orientation, mixed cart, reload, edit, cancel, remove and original-hour expiry',async t=>{
 const f=await fullRig(t,{fullProduct:true}),saved=new Map(),reloadStorage={getItem:k=>saved.get(k)??null,setItem:(k,v)=>saved.set(k,v)};
 const sessionFor=()=>createResourceSession({fetchImpl:f.browserFetch,now:()=>f.clock.time,preparedMode:true,reloadStorage});
 let session=sessionFor(),generation=0;
 const act=(name,input={})=>session.checkout(name,async()=>f.ids.A,input);
 await session.issue();await act('bind');await act('install');
 const issued=f.rows().resource_sessions[0];assert.equal(issued.expires-issued.created,3600000);
 const prepare=async selection=>{session.rememberPreparationGeneration(++generation);const job=await session.request('/jobs',{...selection,request_key:`full-http-${generation}`});return act('eligible',{reference:job.reference,generation});};
 const add=async p=>{const line=put(f,p);const result=await act('resume',{operation:{kind:'add',job:p.reference.id,operation_id:p.reservation.operation_id,quantity:p.item.quantity}});session.checkpoint();return {line,result};};
 const dark=await prepare(darkroom);assert.equal(dark.file_count,0);assert.equal(dark.unit_price_cents,4800);assert.equal(dark.item.properties['Files Uploaded'],'0');assert.equal(f.counts.uploads,0);
 const d=await add(dark);assert.equal(d.result.items[0].subtotal_cents,9600);assert.equal(grants(f).schema,4);assert.equal(grants(f).grants[0].lines[0].shipping_eligible,true);
 const lease=structuredClone(grants(f).lease);assert.equal(lease.expires_at,f.plan.until);
 for(const row of owners(f))assert.equal(row.lease.value,leaseEnvelope(f.m.data.shop.authority.value));
 const file=f.inputFiles[0],intent=await session.request('/uploads/intents',{request_key:'full-http-upload'});
 const asset=await session.request(`/uploads/${intent.intent_id}/bytes`,new Blob([file.bytes],{type:file.mime}),{mime:file.mime});
 const fine=await prepare({...fineArt,asset_ids:[asset.asset_id]});assert.equal(fine.unit_price_cents,2500);const a=await add(fine);assert.equal(a.result.items.length,2);
 const oriented=await prepare({...custom,asset_ids:[asset.asset_id]});assert.equal(oriented.unit_price_cents,2600);assert.equal(oriented.item.properties['Custom Width'],'20');assert.equal(oriented.item.properties['Custom Height'],'16');
 const c=await add(oriented);assert.equal(c.result.items.length,3);assert.deepEqual(c.result.items.map(i=>i.subtotal_cents),[9600,5000,7800]);
 const approved=grants(f);assert.equal(approved.grants[0].lines.length,3);assert.equal(approved.grants[0].lines[2].claims.size,'16x20');assert.equal(approved.grants[0].lines[2].claims.width,'20');assert.equal(approved.grants[0].lines[2].claims.height,'16');assert.deepEqual(approved.lease,lease);
 const bodies=f.rows().jobs.map(row=>row.body),originalSessions=f.rows().resource_sessions;
 for(let n=0;n<45;n++){f.clock.time+=20000;await f.runtime.tick();assert.equal(f.runtime.status().phase,'admitting',JSON.stringify(f.journal().filter(e=>e.event.includes('unconfirmed')||e.event.includes('retirement')||e.event==='cleanup_started')));}session=sessionFor();assert.equal(session.restore().state,'accepted');assert.equal(session.preparationGeneration(),3);assert.equal((await act('resume')).items.length,3);assert.deepEqual(f.rows().resource_sessions,originalSessions);
 const state=f.carts.get(f.ids.A);d.line.quantity=3;d.line.attributes.find(a=>a.key==='_bfl_signature').value=quantitySignature(dark.reference.signature,3);f.reprice();
 const changed=await act('resume',{operation:{kind:'change',job:dark.reference.id,operation_id:'full-http-change-darkroom',quantity:3}});assert.equal(changed.items[0].subtotal_cents,14400);assert.deepEqual(grants(f).lease,lease);
 const cancelled=await prepare({...fineArt,asset_ids:[asset.asset_id],message:'Cancelled fixture'});assert.equal((await act('cancel_preparation',{reservation:cancelled.reservation})).cancelled,true);assert.equal((await act('resume')).items.length,3);
 state.cart.lines.nodes=state.cart.lines.nodes.filter(line=>line.id!==a.line.id);f.reprice();assert.equal((await act('resume',{operation:{kind:'remove',job:fine.reference.id,operation_id:'full-http-remove-one',quantity:0}})).items.length,2);
 state.cart.lines.nodes=[];f.reprice();assert.deepEqual((await act('resume')).items,[]);assert.deepEqual(f.rows().jobs.slice(0,3).map(row=>row.body),bodies);assert.deepEqual(grants(f).lease,lease);
 f.clock.time=lease.expires_at+1;await f.runtime.tick();assert.deepEqual(grants(f).grants,[]);for(const row of owners(f))assert.equal(row.lease.value,leaseEnvelope(f.m.data.shop.authority.value));
 await f.runtime.close();assert.equal(f.runtime.status().phase,'closed');assert.equal(f.m.data.currentAppInstallation.active.value,f.original);assert.equal(f.m.data.currentAppInstallation.catalog,null);
});
test('full product HTTP rejects unavailable labs and invalid zero-upload/custom selections without spending a job',async t=>{
 const f=await fullRig(t,{fullProduct:true}),session=f.clients.A.session,act=name=>session.checkout(name,async()=>f.ids.A);
 await session.issue();await act('bind');await act('install');
 for(const [i,selection] of [{...darkroom,lab:'Orlando'},{...fineArt,asset_ids:[]},{...custom,custom_dimensions:{width:45,height:16},asset_ids:[]},{...darkroom,options:{...darkroom.options,'Scanning Options':'Maybe'}}].entries())await assert.rejects(session.request('/jobs',{...selection,request_key:`full-http-invalid-${i}`}));
 assert.equal(f.rows().jobs.length,0);assert.equal(f.rows().resource_admissions.filter(r=>r.kind==='jobs').length,0);assert.equal(f.rows().cart_prepared_jobs.length,0);assert.equal(f.counts.uploads,0);
});
test('Darkroom-only hour closes at its original deadline and restores sources with five-owner cleanup',async t=>{
 const f=await fullRig(t,{fullProduct:true}),session=f.clients.A.session,act=(name,input={})=>session.checkout(name,async()=>f.ids.A,input);
 await session.issue();await act('bind');await act('install');
 const job=await session.request('/jobs',{...darkroom,request_key:'hour-darkroom'}),p=await act('eligible',{reference:job.reference,generation:1});put(f,p);
 await act('resume',{operation:{kind:'add',job:p.reference.id,operation_id:p.reservation.operation_id,quantity:2}});
 f.clock.time=p.expires_at-1;assert.equal((await act('resume')).items[0].subtotal_cents,9600);
 f.clock.time=p.expires_at;await f.runtime.tick();assert.deepEqual(grants(f).grants,[]);
 await f.runtime.close();assert.equal(f.runtime.status().phase,'closed');assert.equal(f.m.data.currentAppInstallation.active.value,f.original);assert.equal(f.m.data.currentAppInstallation.catalog,null);
 assert.equal(f.counts.uploads,0);assert.equal(f.counts.deletes,0);for(const row of owners(f))assert.equal(row.lease.value,leaseEnvelope(f.m.data.shop.authority.value));
});
for(const mode of ['issued','completed','referenced'])test(`early full-product close terminalizes ${mode} upload intents without extending their deadline`,async t=>{
 const uploaded=mode!=='issued';
 const f=await fullRig(t,{fullProduct:true}),session=f.clients.A.session;
 await session.issue();await session.checkout('bind',async()=>f.ids.A);await session.checkout('install',async()=>f.ids.A);
 const intent=await session.request('/uploads/intents',{request_key:'close-unused-intent'});
 if(uploaded){const file=f.inputFiles[0];await session.request(`/uploads/${intent.intent_id}/bytes`,new Blob([file.bytes],{type:file.mime}),{mime:file.mime});}
 const before=f.rows().upload_intents.find(r=>r.id===intent.intent_id);assert.equal(before.expires,f.plan.until);assert.equal(before.state,uploaded?'complete':'issued');
 if(mode==='referenced'){
  const job=await session.request('/jobs',{...fineArt,asset_ids:[before.asset],request_key:'close-referenced-job'}),p=await session.checkout('eligible',async()=>f.ids.A,{reference:job.reference,generation:1});put(f,p);
  await session.checkout('resume',async()=>f.ids.A,{operation:{kind:'add',job:p.reference.id,operation_id:p.reservation.operation_id,quantity:p.item.quantity}});
 }
 const bodies=f.rows().jobs.map(row=>row.body);
 await f.runtime.close();const after=f.rows().upload_intents.find(r=>r.id===intent.intent_id);
 assert.ok(['removed','failed'].includes(after.state),JSON.stringify(after));assert.equal(after.expires,before.expires);assert.equal(after.asset,before.asset);assert.equal(f.counts.uploads,uploaded?1:0);assert.equal(f.counts.deletes,uploaded?1:0);
 assert.equal(f.runtime.status().phase,'closed');assert.equal(f.m.data.currentAppInstallation.catalog,null);
 assert.deepEqual(f.rows().jobs.map(row=>row.body),bodies);assert.equal(f.rows().authority_events.filter(row=>row.acknowledged===0).length,0);assert.equal(f.rows().authority_state[0].operation,null);
});
test('early close while provider upload is sending retains response custody and deletes the known result once',async t=>{
 const f=await fullRig(t,{fullProduct:true}),session=f.clients.A.session;
 await session.issue();await session.checkout('bind',async()=>f.ids.A);await session.checkout('install',async()=>f.ids.A);
 const intent=await session.request('/uploads/intents',{request_key:'close-sending-intent'}),entered=deferred(),release=deferred(),file=f.inputFiles[0];
 f.hook=async(stage,{url,options}={})=>{if(stage==='after_provider'&&options.method==='POST'&&url.endsWith('/base/')){entered.resolve();await release.promise;}};
 const upload=session.request(`/uploads/${intent.intent_id}/bytes`,new Blob([file.bytes],{type:file.mime}),{mime:file.mime});const rejected=assert.rejects(upload);
 await entered.promise;const before=f.rows().upload_intents.find(r=>r.id===intent.intent_id);assert.equal(before.state,'sending');assert.equal(before.asset,null);
 const closing=f.runtime.close();assert.ok(f.rows().authority_tombstones.some(row=>row.kind==='owner'&&row.owner===before.owner));release.resolve();await rejected;await closing;
 const after=f.rows().upload_intents.find(r=>r.id===intent.intent_id);assert.equal(after.state,'failed');assert.equal(after.expires,before.expires);
 const custody=f.journal().filter(row=>row.event==='fixture_custody').map(row=>row.row);assert.equal(custody.at(-1).state,'deleted');assert.equal(custody.at(-1).asset,'00000000-0000-4000-8000-000000000001');
 assert.equal(f.counts.uploads,1);assert.equal(f.counts.deletes,1);assert.equal(f.runtime.status().phase,'closed');assert.equal(f.m.data.currentAppInstallation.catalog,null);
});
test('full-product admitted eight-line cart capacity fits signed authority',async t=>{
 const f=await fullRig(t,{fullProduct:true}),session=f.clients.A.session,act=(name,input={})=>session.checkout(name,async()=>f.ids.A,input);
 await session.issue();await act('bind');await act('install');
 for(let i=1;i<=8;i++){
  const job=await session.request('/jobs',{...darkroom,copies:1,message:'',request_key:`eight-line-${i}`});
  let p;try{p=await act('eligible',{reference:job.reference,generation:i});}catch(e){t.diagnostic(`Failed line${i}; current authority bytes ${Buffer.byteLength(f.m.data.shop.authority.value)}`);throw e;}
  put(f,p);assert.equal((await act('resume',{operation:{kind:'add',job:p.reference.id,operation_id:p.reservation.operation_id,quantity:1}})).items.length,i);
 }
 assert.equal(grants(f).grants[0].lines.length,8);
});


test('Shopify unescaped Unicode metadata can publish, add, cancel, resume and recover without changing signed claims',async t=>{
 const f=await fullRig(t,{fullProduct:true}),session=f.clients.A.session,act=(name,input={})=>session.checkout(name,async()=>f.ids.A,input);
 // Model the observed JSON-metafield storage roundtrip on the Shop and all five owners.
 f.m.afterWrite=async()=>{for(const field of [f.m.data.shop.authority,...owners(f).map(o=>o.lease)])if(field)field.value=JSON.stringify(JSON.parse(field.value));};
 await session.issue();await act('bind');await act('install');
 const intent=await session.request('/uploads/intents',{request_key:'unicode-upload'}),file=f.inputFiles[0];
 const asset=await session.request(`/uploads/${intent.intent_id}/bytes`,new Blob([file.bytes],{type:file.mime}),{mime:file.mime});
 const selection={...custom,lab:'Atlanta',copies:2,asset_ids:[asset.asset_id],options:{Borders:'Borders (0.5” white)',Turnaround:'Speedy (2-3 days)'},message:'Café 🎞️'};
 const prepare=async(generation,message)=>{const job=await session.request('/jobs',{...selection,message,request_key:`unicode-job-${generation}`});return act('eligible',{reference:job.reference,generation});};
 const first=await prepare(1,selection.message);assert.equal(first.unit_price_cents,3900);put(f,first);
 assert.equal((await act('resume',{operation:{kind:'add',job:first.reference.id,operation_id:first.reservation.operation_id,quantity:2}})).items[0].subtotal_cents,7800);
 assert.ok(f.m.data.shop.authority.value.includes('”'));assert.ok(f.m.data.shop.authority.value.includes('🎞️'));
 const second=await prepare(2,'Cancelled café');assert.equal((await act('cancel_preparation',{reservation:second.reservation})).cancelled,true);
 assert.equal((await act('resume')).items.length,1);
 const originalExpiry=first.expires_at;assert.equal(grants(f).lease.expires_at,originalExpiry);
 await f.runtime.close();assert.equal(f.runtime.status().phase,'closed');assert.deepEqual(grants(f).grants,[]);assert.equal(f.rows().authority_state[0].operation,null);
 assert.equal(f.m.data.currentAppInstallation.active.value,f.original);assert.equal(f.m.data.currentAppInstallation.catalog,null);
});
