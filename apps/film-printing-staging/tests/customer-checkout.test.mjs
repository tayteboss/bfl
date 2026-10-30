import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {RESOURCE_BOUNDS} from '../backend/resource-session.mjs';
import {fullRig} from '../../../fixtures/film-printing/f06p-engineering/full-rig.mjs';
import {createCustomerCheckout} from '../theme/customer-checkout.js';
import {createResourceSession} from '../theme/resource-session.js';
import {createOwnedUploads} from '../theme/owned-uploads.js';

async function customer(t,options={}){
  const f=await fullRig(t,{customerFlow:true,...options}),session=f.clients.A.session;
  const act=action=>session.checkout(action,async()=>f.ids.A);
  await session.issue();await act('bind');await act('install');
  return Object.assign(f,{session,act});
}
async function upload(f){
  const ids=[];
  for(const [i,file] of f.inputFiles.entries()){
    const intent=await f.session.request('/uploads/intents',{request_key:`customer-file-${i}`});
    const result=await f.session.request(`/uploads/${intent.intent_id}/bytes`,new Blob([file.bytes],{type:file.mime}),{mime:file.mime});
    assert.equal(result.state,'complete');ids.push(result.asset_id);
  }
  return ids;
}
test('finite customer routes accept browser bytes, prepare an owned job and return actual cart fields through publication',async t=>{
  const f=await customer(t);assert.deepEqual((await f.act('current')).items,[]);
  await assert.rejects(f.clients.A.act('resources')); // No diagnostic fixture shortcut.
  const asset_ids=await upload(f);
  const job=await f.session.request('/jobs',{...f.plan.selection,asset_ids,request_key:'customer-job-1'});
  assert.equal(f.counts.uploads,3);assert.equal(job.checkout_ready,false);assert.equal(job.file_count,3);
  f.addJob(job.item);
  const current=await f.act('current');
  assert.deepEqual(Object.keys(current).sort(),['cart_verified','checkout_ready','items']);
  assert.equal(current.items[0].properties._bfl_job,job.reference.id);
  assert.equal(current.items[0].variant_id,job.item.id);assert.equal(current.items[0].quantity,4);
  assert.equal((await f.act('publish')).state,'published_unverified');
  f.clock.time+=20000;await f.runtime.tick();assert.equal(f.runtime.status().phase,'admitting');
  assert.ok(f.rows().upload_intents.every(r=>r.checked_until>f.clock.time&&r.checked_until<=r.expires));
  await f.runtime.close();assert.equal(f.counts.deletes,3);assert.equal(f.rows().authority_state[0].operation,null);
});

test('unknown file bytes and diagnostic paths cannot produce an upload or job',async t=>{
  const f=await customer(t),intent=await f.session.request('/uploads/intents',{request_key:'unknown-file'});
  const original=f.rows().upload_intents.find(r=>r.id===intent.intent_id);
  await assert.rejects(f.session.request(`/uploads/${intent.intent_id}/bytes`,new Blob(['not the pinned file'],{type:'image/png'}),{mime:'image/png'}));
  const rejected=f.rows().upload_intents.find(r=>r.id===intent.intent_id);
  assert.equal(rejected.state,'failed');assert.equal(rejected.expires,original.expires);assert.equal(rejected.asset,null);
  await assert.rejects(f.session.request(`/uploads/${intent.intent_id}/bytes`,new Blob([f.inputFiles[0].bytes],{type:'image/png'}),{mime:'image/png'}));
  assert.equal(f.counts.uploads,0);await assert.rejects(f.session.request('/jobs',{...f.plan.selection,asset_ids:[],request_key:'incomplete-job'}));
  await assert.rejects(f.clients.A.act('copy_item'));assert.equal(f.rows().jobs.length,0);
  const replacement=await f.session.request('/uploads/intents',{request_key:'valid-after-rejected'});
  assert.equal((await f.session.request(`/uploads/${replacement.intent_id}/bytes`,new Blob([f.inputFiles[0].bytes],{type:'image/png'}),{mime:'image/png'})).state,'complete');
  assert.equal(f.counts.uploads,1);
});

test('session upload budget rejects before allocating an intent and retains spent admissions',async t=>{
  const f=await customer(t);
  const db=new DatabaseSync(join(f.config.dataDir,'jobs.sqlite')),owner=f.rows().resource_sessions[0].owner;
  try{for(let i=0;i<RESOURCE_BOUNDS.uploads-1;i++)db.prepare('INSERT INTO resource_admissions VALUES (?,?,?)').run(owner,'uploads',`spent-${i}`);}finally{db.close();}
  const intent=await f.session.request('/uploads/intents',{request_key:'rejected-last-budget'});
  await assert.rejects(f.session.request(`/uploads/${intent.intent_id}/bytes`,new Blob(['invalid'],{type:'image/png'}),{mime:'image/png'}));
  await assert.rejects(f.session.request('/uploads/intents',{request_key:'over-upload-budget'}));
  assert.equal(f.rows().upload_intents.length,1);assert.ok(f.rows().upload_intents.every(r=>r.state==='failed'));
  assert.equal(f.rows().resource_admissions.filter(r=>r.kind==='uploads').length,RESOURCE_BOUNDS.uploads);assert.equal(f.counts.uploads,0);
});

test('conflicting replay cannot invalidate an already completed asset',async t=>{
  const f=await customer(t),intent=await f.session.request('/uploads/intents',{request_key:'completed-replay'});
  const send=bytes=>f.session.request(`/uploads/${intent.intent_id}/bytes`,new Blob([bytes],{type:'image/png'}),{mime:'image/png'});
  const completed=await send(f.inputFiles[0].bytes);
  await assert.rejects(send(f.inputFiles[1].bytes));
  const row=f.rows().upload_intents.find(r=>r.id===intent.intent_id);
  assert.equal(row.state,'complete');assert.equal(row.asset,completed.asset_id);assert.equal(row.digest,f.inputFiles[0].sha256);assert.equal(f.counts.uploads,1);
});

test('customer private delivery signs only the owned original or preview after provider revalidation',async t=>{
  const f=await customer(t),client=createOwnedUploads({},f.session),file=f.inputFiles[0];
  const intent=await client.intent('private-original-1'),id=intent.intent_id;
  await assert.rejects(client.original(id)); // No pending-file delivery.
  const completed=await client.bytes(id,new Blob([file.bytes],{type:file.mime}));
  const before=f.counts.provider;
  const original=await client.original(id),preview=await client.preview(id);
  assert.ok(f.counts.provider>=before+2);
  for(const [receipt,path] of [[original,`/${completed.asset_id}/`],[preview,`/${completed.asset_id}/-/resize/640x/`]]){
    const url=new URL(receipt.url);
    assert.equal(url.origin,'https://synthetic.s.ucarecd.net');assert.equal(url.pathname,path);
    assert.match(url.searchParams.get('token'),new RegExp(`^exp=\\d+~acl=${path}~hmac=[a-f0-9]{64}$`));
    assert.equal(receipt.expires_at,f.clock.time+30000);assert.ok(!receipt.url.includes('bflr1_'));
  }
  assert.throws(()=>client.original(completed.asset_id),/UPLOAD_INTENT_UNAVAILABLE/);
  await assert.rejects(f.session.request(`/uploads/${completed.asset_id}/original`,{}));
  await assert.rejects(f.session.request(`/uploads/${id}/original`,{variant:'original'}));
  const unauthenticated=await f.browserFetch(`https://film-printing-staging.bellowsfilmlab.com/uploads/${id}/original`,{
    method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  assert.equal(unauthenticated.status,403);assert.equal((await unauthenticated.json()).url,undefined);
  await client.remove(id);await assert.rejects(client.original(id));
});

test('customer original-file revalidation cannot return a URL after the session expires during provider await',async t=>{
  const f=await customer(t),client=createOwnedUploads({},f.session),file=f.inputFiles[0];
  const {intent_id:id}=await client.intent('private-original-expiry');
  await client.bytes(id,new Blob([file.bytes],{type:file.mime}));
  let response;
  f.hook=async(stage,{url,status}={})=>{
    if(stage==='after_provider'&&url.includes('/files/'))f.clock.time+=300001;
    if(stage==='browser_response')response=status;
  };
  await assert.rejects(client.original(id));assert.notEqual(response,200);
});

test('public source handoff uses owned verified original once, independently of fixture URL allowlist',async t=>{
  const f=await customer(t,{sourceFlow:true}),client=createOwnedUploads({},f.session);
  const {intent_id:id}=await client.intent('source-fixture-1');let fetches=0;
  f.hook=async stage=>{if(stage==='source')fetches++;};
  const result=await client.source(id,'https://public-images.org/customer.png?size=small');
  assert.equal(result.state,'complete');assert.equal(fetches,1);assert.equal(f.counts.uploads,1);
  assert.ok((await client.original(id)).url);
  await assert.rejects(client.source(id,f.inputFiles[0].source_url));assert.equal(fetches,1);
  await client.remove(id);await assert.rejects(client.original(id));
});

test('session expiry during source fetch cannot send bytes to the upload provider',async t=>{
  const f=await customer(t,{sourceFlow:true}),client=createOwnedUploads({},f.session);
  const {intent_id:id}=await client.intent('source-expiry-1');
  const expires=f.rows().upload_intents.find(r=>r.id===id).expires;
  f.hook=async stage=>{if(stage==='source')f.clock.time+=300001;};
  await assert.rejects(client.source(id,f.inputFiles[0].source_url));assert.equal(f.counts.uploads,0);
  const rejected=f.rows().upload_intents.find(r=>r.id===id);
  assert.equal(rejected.state,'failed');assert.equal(rejected.expires,expires);assert.equal(rejected.asset,null);
});

test('customer native adapter verifies actual server properties and actual recalculated price',async()=>{
  let items=[],amount='0.00',updates=0;const calls=[],cartId='gid://shopify/Cart/native-test?key=private-test';
  const actions={getCart:async()=>({cart:{id:cartId,lines:items.map(l=>({id:l.id,quantity:l.quantity,cost:{totalAmount:{amount:(l.subtotal_cents/100).toFixed(2),currencyCode:'USD'}}})),totalQuantity:items.reduce((n,l)=>n+l.quantity,0),cost:{totalAmount:{amount,currencyCode:'USD'}}}}),
    updateCart:async({lines})=>{
      updates++;const value=lines[0];
      if(value.merchandiseId)items=[{id:'line-1',variant_id:'67852705202287',quantity:value.quantity,properties:Object.fromEntries(value.attributes.map(a=>[a.key,a.value])),subtotal_cents:0}];
      else{items[0].subtotal_cents=80;amount='0.80';}
      return actions.getCart();
    }};
  const session={checkout:async(action,locate)=>{
    assert.equal(await locate(),cartId);calls.push(action);
    return action==='current'?{items:structuredClone(items)}:action==='publish'?{state:'published_unverified'}:{};
  }};
  const flow=createCustomerCheckout(session,{actions});await flow.initialize();
  await flow.add({id:'67852705202287',quantity:2,properties:{_bfl_job:'job-1'}});
  const input={reference:{id:'job-1'},lineId:'line-1',quantity:2,unit_price_cents:40};
  assert.equal((await flow.publish(input)).published,true);
  assert.equal((await flow.recalculate(input)).recalculated,true);assert.equal(updates,2);
  await assert.rejects(flow.recalculate(input));assert.equal(updates,2);
  assert.deepEqual(calls.slice(0,2),['bind','install']);
});

test('native adapter bounds confirmed stale-price recalculation and rejects changed capabilities',async()=>{
  let id='gid://shopify/Cart/native-test?key=private-test',updates=0;
  const line={id:'line-1',quantity:2,variant_id:'67852705202287',properties:{_bfl_job:'job-1'},subtotal_cents:79};
  let populated=false;
  const actions={getCart:async()=>({cart:{id,lines:populated?[line]:[],totalQuantity:populated?2:0,cost:{totalAmount:{amount:'0.79',currencyCode:'USD'}}}}),updateCart:async()=>{updates++;return actions.getCart();}};
  const session={checkout:async action=>action==='current'?{items:populated?[line]:[]}:{}},flow=createCustomerCheckout(session,{actions});
  await flow.initialize();populated=true;
  await assert.rejects(flow.recalculate({reference:{id:'job-1'},lineId:'line-1',quantity:2,unit_price_cents:40}));
  assert.equal(updates,2);id='gid://shopify/Cart/different?key=private-other';await assert.rejects(flow.cart());assert.equal(updates,2);
});

test('customer can remove and replace a file before publication without losing remaining selections',async t=>{
  const f=await customer(t),client=createOwnedUploads({},f.session),ids=[];
  for(const [i,file] of f.inputFiles.slice(0,2).entries()){
    const {intent_id:id}=await client.intent(`replace-before-publish-${i}`);ids.push(id);
    await client.bytes(id,new Blob([file.bytes],{type:file.mime}));
  }
  const owner=f.rows().resource_sessions.find(r=>r.revoked===null),expires=owner.expires;
  await client.remove(ids[0]);f.clock.time+=20000;await f.runtime.tick();
  assert.equal(f.runtime.status().phase,'admitting');assert.equal(f.runtime.status().admissions_closed,false);
  assert.equal(f.rows().authority_state[0].operation,null);
  assert.equal(f.rows().resource_sessions.find(r=>r.owner===owner.owner).expires,expires);
  assert.ok((await client.original(ids[1])).url);
  const {intent_id:replacement}=await client.intent('replacement-same-source');
  assert.equal((await client.bytes(replacement,new Blob([f.inputFiles[0].bytes],{type:'image/png'}))).state,'complete');
  await assert.rejects(client.original(ids[0]));
  await f.runtime.close();assert.equal(f.counts.deletes,3);
});

test('pre-publication removal cannot keep an owner alive past its original expiry',async t=>{
  const f=await customer(t),client=createOwnedUploads({},f.session),file=f.inputFiles[0];
  const {intent_id:id}=await client.intent('remove-before-expiry');
  await client.bytes(id,new Blob([file.bytes],{type:file.mime}));await client.remove(id);
  const expires=f.rows().resource_sessions[0].expires;f.clock.time=expires+1;
  await f.runtime.tick();assert.equal(f.rows().resource_sessions[0].expires,expires);
  await assert.rejects(client.intent('cannot-replace-expired'));
  assert.ok(!f.journal().some(x=>x.event==='unpublished_resources_reconciled'));
});

test('removal after publication still retires authority and cannot admit a replacement',async t=>{
  const f=await customer(t),asset_ids=await upload(f);
  const job=await f.session.request('/jobs',{...f.plan.selection,asset_ids,request_key:'publish-before-remove'});
  f.addJob(job.item);await f.act('publish');
  const id=f.rows().upload_intents.find(r=>r.state==='complete').id;
  await f.session.request(`/uploads/${id}/remove`,{});await f.runtime.tick();
  assert.equal(f.runtime.status().admissions_closed,true);
  assert.ok(!f.journal().some(x=>x.event==='unpublished_resources_reconciled'));
  await assert.rejects(f.session.request('/uploads/intents',{request_key:'no-post-publish-replacement'}));
});

test('native update diagnostics retain outcome counts without exporting server errors or cart secrets',async()=>{
  const events=[],cartId='gid://shopify/Cart/native-test?key=private-test';
  const cart={id:cartId,lines:[],totalQuantity:0};let calls=0;
  const actions={getCart:async()=>({cart}),updateCart:async()=>{calls++;return {cart,userErrors:[{code:'INVALID',message:'secret payload'}],warnings:[]};}};
  const session={checkout:async action=>action==='current'?{items:[]}:{}},flow=createCustomerCheckout(session,{actions,observe:e=>events.push(e)});
  await flow.initialize();const item={id:'67852705202287',quantity:3,properties:{_bfl_job:'job-private'}};
  await assert.rejects(flow.add(item));await assert.rejects(flow.add(item));assert.equal(calls,1);
  assert.deepEqual(events.filter(e=>e.stage!=='timing'),[{stage:'native-update',state:'returned',errors:1,codes:['INVALID'],warnings:0,sameCart:true}]);
  assert.equal(JSON.stringify(events).includes('secret'),false);
});

test('two distinct customer jobs publish the whole same cart without extending the first lease',async t=>{
  const f=await customer(t,{customerJobs:2}),client=createOwnedUploads({},f.session),asset_ids=[];
  const uploadOne=async i=>{
    const {intent_id}=await client.intent(`two-jobs-file-${i}`),file=f.inputFiles[i];
    return (await client.bytes(intent_id,new Blob([file.bytes],{type:file.mime}))).asset_id;
  };
  asset_ids.push(await uploadOne(0),await uploadOne(1));
  const first=await f.session.request('/jobs',{...f.plan.selection,copies:3,asset_ids,request_key:'two-jobs-first'});
  f.addJob(first.item);const state=f.carts.get(f.ids.A),one=state.cart.lines.nodes[0];
  one.quantity=3;one.cost.subtotalAmount.amount='2.40';state.cart.totalQuantity=3;
  assert.equal((await f.act('publish')).state,'published_unverified');
  const expires=f.runtime.status().expires,firstBody=f.rows().jobs[0].body;
  f.clock.time+=1000;
  const second=await f.session.request('/jobs',{...f.plan.selection,copies:2,asset_ids:[await uploadOne(2)],request_key:'two-jobs-second'});
  assert.notEqual(second.reference.id,first.reference.id);
  f.addJob(second.item);const two=state.cart.lines.nodes[0];two.id='gid://shopify/CartLine/second?cart=opaque-synthetic';two.quantity=2;two.cost.subtotalAmount.amount='0.80';
  state.cart.lines.nodes=[one,two];state.cart.totalQuantity=5;
  assert.equal((await f.act('publish')).state,'published_unverified');
  assert.equal(f.runtime.status().expires,expires);
  assert.equal((await f.act('current')).items.length,2);
  assert.equal(f.rows().jobs.find(j=>j.id===first.reference.id).body,firstBody);
  const authority=JSON.parse(f.m.data.shop.authority.value);
  assert.equal(authority.grants.length,1);
  assert.equal(authority.grants[0].lines.length,2);
  await assert.rejects(f.act('publish'));
  f.clock.time=expires;await f.runtime.tick();
  assert.equal(f.runtime.status().admissions_closed,true);
  assert.deepEqual(JSON.parse(f.m.data.shop.authority.value).grants,[]);
  f.clock.time+=90001;await f.runtime.tick();
  assert.equal(f.runtime.status().phase,'closed');
  assert.equal(f.counts.deletes,3);
});

test('native customer adapter preserves first job and verifies both actual prices on second addition',async()=>{
  let items=[],updates=0;
  const total=()=>items.reduce((n,l)=>n+l.subtotal_cents,0);
  const actions={getCart:async()=>({cart:{id:'gid://shopify/Cart/two-jobs?key=private-test',lines:items.map(l=>({id:l.id,quantity:l.quantity,cost:{totalAmount:{amount:(l.subtotal_cents/100).toFixed(2),currencyCode:'USD'}}})),totalQuantity:items.reduce((n,l)=>n+l.quantity,0),cost:{totalAmount:{amount:(total()/100).toFixed(2),currencyCode:'USD'}}}}),
    updateCart:async({lines})=>{
      updates++;
      if(lines[0].merchandiseId){const l=lines[0];items.push({id:`line-${items.length+1}`,variant_id:'67852705202287',quantity:l.quantity,properties:Object.fromEntries(l.attributes.map(a=>[a.key,a.value])),subtotal_cents:0});}
      else for(const l of items)l.subtotal_cents=l.quantity*(l.properties._bfl_job==='first'?80:40);
      return actions.getCart();
    }};
  const session={checkout:async action=>action==='current'?{items:structuredClone(items)}:action==='publish'?{state:'published_unverified'}:{}};
  const flow=createCustomerCheckout(session,{actions});await flow.initialize();
  for(const [id,quantity,unit,lineId] of [['first',3,80,'line-1'],['second',2,40,'line-2']]){
    await flow.add({id:'67852705202287',quantity,properties:{_bfl_job:id}});
    const input={reference:{id},lineId,quantity,unit_price_cents:unit};
    await flow.publish(input);assert.equal((await flow.recalculate(input)).recalculated,true);
  }
  assert.equal(items.length,2);assert.equal(total(),320);assert.equal(updates,4);
  await assert.rejects(flow.add({id:'67852705202287',quantity:2,properties:{_bfl_job:'second'}}));
  items[0].quantity=4;
  await assert.rejects(flow.add({id:'67852705202287',quantity:1,properties:{_bfl_job:'third'}}));assert.equal(updates,4);
});

test('actual resource client crop route reaches owned backend and immutable job selection',async t=>{
  const f=await customer(t),client=createOwnedUploads({},f.session),ids=[];let first;
  for(const [i,file] of f.inputFiles.entries()){
    const intent=await client.intent(`crop-client-${i}`);first??=intent.intent_id;
    const receipt=await client.bytes(intent.intent_id,new Blob([file.bytes],{type:file.mime}));ids.push(receipt.asset_id);
  }
  const selected=await client.crop(first,{left:2,top:3,width:10,height:8});
  assert.deepEqual(selected.file.crop,{left:2,top:3,width:10,height:8});assert.equal(selected.file.id,ids[0]);
  await assert.rejects(f.session.request(`/uploads/${first}/crop`,{left:0,top:0,width:100,height:8}));
  await assert.rejects(f.session.request('/jobs',{...f.plan.selection,asset_ids:ids,request_key:'crop-blocked-job'}));
});
test('verified crop metadata and private original survive client-to-job round trip',async t=>{
  const f=await customer(t),client=createOwnedUploads({},f.session),ids=[];let first;
  for(const [i,file] of f.inputFiles.entries()){
    const intent=await client.intent(`crop-job-${i}`);first??=intent.intent_id;
    const receipt=await client.bytes(intent.intent_id,new Blob([file.bytes],{type:file.mime}));ids.push(receipt.asset_id);
  }
  const selected=await client.crop(first,{left:2,top:3,width:10,height:8});
  const prepared=await f.session.request('/jobs',{...f.plan.selection,asset_ids:ids,request_key:'crop-complete-job'});
  const job=JSON.parse(f.rows().jobs.find(r=>r.id===prepared.reference.id).body);
  assert.equal(job.files[0].sha256,selected.file.sha256);assert.deepEqual(job.files[0].crop,selected.file.crop);
  assert.equal(job.files[0].original.sha256,f.inputFiles[0].sha256);assert.equal(prepared.file_count,3);
  assert.equal(prepared.item.properties['Uploaded File 1'],selected.file.url);assert.equal(f.counts.uploads,3);
});


test('public source provenance and verified bytes enter immutable job without pinning source URL',async t=>{
  const f=await customer(t,{sourceFlow:true}),client=createOwnedUploads({},f.session),ids=[];
  for(const [i,file] of f.inputFiles.entries()){
    const {intent_id:id}=await client.intent(`public-job-file-${i}`);
    const receipt=await client.source(id,`https://images.public.org/cdn/shop/t/1/assets/${file.path}?customer=value`);ids.push(receipt.asset_id);
  }
  const result=await f.session.request('/jobs',{...f.plan.selection,asset_ids:ids,request_key:'public-job-1'});
  const job=JSON.parse(f.rows().jobs[0].body);
  assert.equal(result.file_count,3);assert.equal(result.unit_price_cents,120);assert.equal(result.item.quantity,4);
  assert.equal(job.files.length,3);
  for(const [i,file] of job.files.entries()){
    assert.equal(file.source.kind,'public_https');assert.equal(file.source.origin,'https://images.public.org');
    assert.equal(file.source.sha256,f.inputFiles[i].sha256);assert.equal(file.source.bytes,79);
    assert.ok(!JSON.stringify(file.source).includes('customer=value'));
  }
});

test('mismatched private original cannot complete import, recover through status or prepare a job',async t=>{
  const f=await customer(t,{sourceFlow:true}),client=createOwnedUploads({},f.session);
  const {intent_id:id}=await client.intent('source-corrupt-original');
  f.hook=async(stage,{bytes}={})=>{if(stage==='original')bytes[20]^=1;};
  await assert.rejects(client.source(id,'https://images.public.org/a.png'));
  await assert.rejects(client.status(id));
  await assert.rejects(client.source(id,'https://images.public.org/a.png'));
  assert.equal(f.counts.uploads,1);assert.equal(f.rows().jobs.length,0);
});


test('provider-rejected source image and owner expiry during exact-byte verification fail closed',async t=>{
  for(const scenario of ['invalid-image','expired-owner'])await t.test(scenario,async t=>{
    const f=await customer(t,{sourceFlow:true}),client=createOwnedUploads({},f.session);
    const {intent_id:id}=await client.intent(`source-${scenario}`);
    f.hook=async(stage,{body}={})=>{
      if(scenario==='invalid-image'&&stage==='provider_info'&&body.uuid)body.is_image=false;
      if(scenario==='expired-owner'&&stage==='original')f.clock.time+=300001;
    };
    await assert.rejects(client.source(id,'https://images.public.org/customer-image.png'));
    await assert.rejects(client.status(id));assert.equal(f.rows().jobs.length,0);
  });
});

test('HTTP header and empty-body rejection terminalize only the owned unsent upload',async t=>{
 const f=await fullRig(t,{customerFlow:true});let forcedMime;
 f.session=createResourceSession({fetchImpl:(url,options)=>f.browserFetch(url,{...options,...(url.endsWith('/bytes')?{headers:{...options.headers,'Content-Type':forcedMime}}:{})}),now:()=>f.clock.time});
 await f.session.issue();await f.session.checkout('bind',async()=>f.ids.A);await f.session.checkout('install',async()=>f.ids.A);
 const cases=[['image/svg+xml',new Blob(['bad'],{type:'image/png'})],['image/png',new Blob([],{type:'image/png'})]];
 for(const [n,[mime,bytes]] of cases.entries()){
  const i=await f.session.request('/uploads/intents',{request_key:`header-reject-${n}`}),before=f.rows().upload_intents.find(r=>r.id===i.intent_id);
  forcedMime=mime;await assert.rejects(f.session.request(`/uploads/${i.intent_id}/bytes`,bytes,{mime:'image/png'}));
  const after=f.rows().upload_intents.find(r=>r.id===i.intent_id);assert.equal(after.state,'failed');assert.equal(after.expires,before.expires);assert.equal(after.asset,null);
  assert.equal((await f.session.request(`/uploads/${i.intent_id}/remove`,{})).state,'removed');
 }
 assert.equal(f.counts.uploads,0);
});

test('one post-bind provider failure leaves concurrent unsubmitted peers usable and is replaceable without replay',async t=>{
 const f=await customer(t);let failure=true;
 f.hook=async(stage,{url,body}={})=>{if(stage==='provider_info'&&url.endsWith('/files/00000000-0000-4000-8000-000000000001/')&&failure){failure=false;body.is_image=false;}};
 const epoch=f.rows().authority_state[0].epoch;
 const attempts=await Promise.allSettled(Array.from({length:4},async(_,n)=>{
  const i=await f.session.request('/uploads/intents',{request_key:`concurrent-failure-${n}`});
  return f.session.request(`/uploads/${i.intent_id}/bytes`,new Blob([f.inputFiles[n%3].bytes],{type:'image/png'}),{mime:'image/png'});
 }));
 assert.equal(attempts.filter(r=>r.status==='fulfilled').length,3);assert.equal(f.counts.uploads,4);
 assert.equal(f.rows().authority_state[0].epoch,epoch);assert.equal(f.rows().lifecycle_events?.filter(r=>r.state==='pending').length??0,0);
 const failed=f.rows().upload_intents.find(r=>r.state==='failed');assert.ok(failed.asset);assert.equal(f.rows().jobs.length,0);
 assert.equal((await f.session.request(`/uploads/${failed.id}/remove`,{})).state,'removed');
 const retry=await f.session.request('/uploads/intents',{request_key:'failure-new-selection'});
 assert.equal((await f.session.request(`/uploads/${retry.intent_id}/bytes`,new Blob([f.inputFiles[0].bytes],{type:'image/png'}),{mime:'image/png'})).state,'complete');
 assert.equal(f.counts.uploads,5);assert.equal(f.rows().upload_intents.filter(r=>r.state==='complete').length,4);
 await f.runtime.close();assert.equal(f.counts.deletes,5);
});

test('local original-byte verification cannot be bypassed through concurrent status or jobs',async t=>{
 const f=await customer(t),file=f.inputFiles[0],intent=await f.session.request('/uploads/intents',{request_key:'held-original-verify'});
 let release,arrive;const started=new Promise(r=>arrive=r);
 f.hook=async stage=>{if(stage==='original'){arrive();await new Promise(r=>release=r);}};
 const sending=f.session.request(`/uploads/${intent.intent_id}/bytes`,new Blob([file.bytes],{type:file.mime}),{mime:file.mime});await started;
 const asset=f.rows().upload_intents.find(r=>r.id===intent.intent_id).asset;
 await assert.rejects(f.session.request(`/uploads/${intent.intent_id}/status`,{}));
 await assert.rejects(f.session.request('/jobs',{...f.plan.selection,asset_ids:[asset],request_key:'premature-original-job'}));assert.equal(f.rows().jobs.length,0);
 release();const result=await sending;assert.equal(result.state,'complete');assert.equal(result.file.sha256,file.sha256);assert.equal(f.counts.uploads,1);
});
