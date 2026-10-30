import test from 'node:test';
import assert from 'node:assert/strict';
import {fullRig,deferred} from '../../../fixtures/film-printing/f06p-engineering/full-rig.mjs';

test('full actual operator: exact sources, two owners/controls, three uploads, normal job/projector publication, expiry observation and exact restoration',async t=>{
 const f=await fullRig(t),{A,B}=f.clients;
 for(const c of [A,B]){await c.session.issue();await c.act('bind');assert.equal((await c.act('control')).control.requires_shipping,false);}
 await A.act('install');const resource=await A.act('resources');assert.equal(resource.item.quantity,4);assert.equal(resource.item.properties['Files Uploaded'],'3');f.addJob(resource.item);
 const result=await A.act('publish');assert.equal(result.state,'published_unverified');assert.equal(result.checkout_ready,false);
 assert.equal(JSON.parse(f.m.data.shop.authority.value).grants.length,1);assert.equal(f.rows().jobs.length,1);assert.equal(f.counts.uploads,3);
 const expires=f.runtime.status().expires;f.clock.time=expires;await f.runtime.tick();
 assert.equal(f.runtime.status().phase,'observing');assert.equal(f.runtime.status().admissions_closed,true);assert.equal(JSON.parse(f.m.data.shop.authority.value).grants.length,0);
 assert.ok(f.carts.get(f.ids.A).marker);assert.equal(f.counts.deletes,0);assert.equal(f.counts.catalog_deletes,0);
 await assert.rejects(B.act('inspect'));await assert.rejects(A.act('publish'));
 f.clock.time+=89999;await f.runtime.tick();assert.equal(f.runtime.status().phase,'observing');
 f.clock.time++;await f.runtime.tick();assert.equal(f.runtime.status().phase,'closed');
 assert.equal(f.counts.deletes,3);assert.equal(f.counts.catalog_deletes,1);assert.equal(f.carts.get(f.ids.A).marker,null);
 assert.equal(f.m.data.currentAppInstallation.active.value,f.original);assert.equal(f.m.data.currentAppInstallation.catalog,null);
 const rows=f.rows();assert.equal(Object.keys(rows).length,26);assert.equal(rows.cart_checkout_bindings[0].state,'retired');assert.equal(rows.upload_custody.length,0);
 assert.equal(rows.authority_state[0].operation,null);assert.ok(rows.authority_events.every(e=>e.acknowledged===1));
 t.diagnostic(JSON.stringify({counts:f.counts,operator:f.runtime.status(),external_responses:'generated; no native Function acceptance'}));
});

test('late nonempty publication response after expiry cannot restore authority or report success',async t=>{
 const f=await fullRig(t),A=f.clients.A;await A.session.issue();await A.act('bind');await A.act('install');f.addJob((await A.act('resources')).item);
 const began=deferred(),release=deferred();let once=false;
 f.hook=async(kind,{query,variables})=>{if(kind==='after_admin'&&query.startsWith('mutation')&&variables.fields?.some(v=>v.key==='authority'&&JSON.parse(v.value).grants.length)&&!once){once=true;began.resolve();await release.promise;}};
 const pending=A.act('publish');pending.catch(()=>{});await began.promise;
 f.clock.time=f.runtime.status().expires;await f.runtime.tick();assert.equal(f.runtime.status().phase,'observing');assert.equal(JSON.parse(f.m.data.shop.authority.value).grants.length,0);
 release.resolve();await assert.rejects(pending);f.clock.time+=90000;await f.runtime.tick();
 assert.equal(f.runtime.status().phase,'closed');assert.equal(JSON.parse(f.m.data.shop.authority.value).grants.length,0);assert.equal(f.counts.catalog_deletes,1);
});

test('lost clear response closes admissions, retains unconfirmed receipt and still attempts exact protective cleanup',async t=>{
 const f=await fullRig(t),A=f.clients.A;await A.session.issue();await A.act('bind');await A.act('install');f.addJob((await A.act('resources')).item);await A.act('publish');
 let once=false;f.hook=async(kind,{query,variables})=>{if(kind==='after_admin'&&query.startsWith('mutation')&&variables.fields?.some(v=>v.key==='authority'&&JSON.parse(v.value).grants.length===0)&&!once){once=true;throw Error('generated lost clear');}};
 f.clock.time=f.runtime.status().expires;await assert.rejects(f.runtime.tick());
 assert.equal(f.runtime.status().phase,'closed_unconfirmed');assert.equal(f.runtime.status().admissions_closed,true);assert.equal(JSON.parse(f.m.data.shop.authority.value).grants.length,0);
 assert.equal(f.counts.deletes,3);assert.equal(f.counts.catalog_deletes,1);assert.equal(f.m.data.currentAppInstallation.active.value,f.original);
 assert.ok(f.journal().some(e=>e.event==='retirement_unconfirmed'));assert.equal(f.rows().authority_state[0].operation,null);
});

test('expiry during a late provider POST clears first, retains returned UUID and performs exact cleanup without completing a job',async t=>{
 const f=await fullRig(t),A=f.clients.A;await A.session.issue();await A.act('bind');await A.act('install');
 const began=deferred(),release=deferred();let once=false;
 f.hook=async(kind,{options})=>{if(kind==='provider'&&options.method==='POST'&&!once){once=true;began.resolve();await release.promise;}};
 const pending=A.act('resources');pending.catch(()=>{});await began.promise;
 f.clock.time=f.plan.until;await f.runtime.tick();assert.equal(f.runtime.status().phase,'observing');assert.equal(JSON.parse(f.m.data.shop.authority.value).grants.length,0);
 release.resolve();await assert.rejects(pending);assert.equal(f.rows().jobs.length,0);
 f.clock.time+=90000;await f.runtime.tick();assert.equal(f.runtime.status().phase,'closed');assert.equal(f.counts.uploads,1);assert.equal(f.counts.deletes,1);assert.equal(f.m.data.currentAppInstallation.catalog,null);
});

test('upload proof maintenance survives publication epoch changes without renewing the owner',async t=>{
 const f=await fullRig(t),A=f.clients.A;
 await A.session.issue();await A.act('bind');await A.act('install');
 f.addJob((await A.act('resources')).item);
 const original=f.rows().resource_sessions.map(({owner,generation,expires,deadline})=>({owner,generation,expires,deadline}));
 await A.act('publish');const expires=f.runtime.status().expires;
 for(let i=0;i<4;i++){
  f.clock.time+=20000;await f.runtime.tick();
  assert.equal(f.runtime.status().phase,'admitting');
  assert.equal(f.runtime.status().expires,expires);
  assert.ok(f.rows().upload_intents.every(row=>row.state==='complete'&&row.checked_until===f.clock.time+60000));
 }
 assert.deepEqual(f.rows().resource_sessions.map(({owner,generation,expires,deadline})=>({owner,generation,expires,deadline})),original);
 assert.equal(JSON.parse(f.m.data.shop.authority.value).grants.length,1);
 await f.runtime.close();assert.equal(f.counts.deletes,3);
});

test('upload maintenance waits through the publication continuation gap',async t=>{
 const f=await fullRig(t),A=f.clients.A;
 await A.session.issue();await A.act('bind');await A.act('install');f.addJob((await A.act('resources')).item);
 const began=deferred(),release=deferred();let once=false;
 f.hook=async(kind,{status,path})=>{
  if(kind==='browser_response'&&status===202&&path==='/diagnostic/checkout/publish'&&!once){once=true;began.resolve();await release.promise;}
 };
 const publication=A.act('publish');publication.catch(()=>{});await began.promise;
 const before=f.counts.provider;
 assert.equal(f.runtime.status().continuation_pending,true);assert.equal(f.runtime.status().operation_pending,true);
 f.clock.time+=20000;await f.runtime.tick();
 assert.equal(f.runtime.status().phase,'admitting');assert.equal(f.counts.provider,before);
 release.resolve();assert.equal((await publication).state,'published_unverified');
 await f.runtime.tick();assert.equal(f.runtime.status().phase,'admitting');assert.ok(f.counts.provider>before);
 await f.runtime.close();assert.equal(f.counts.deletes,3);
});

test('requests wait for an in-flight provider recheck without racing publication',async t=>{
 const f=await fullRig(t),A=f.clients.A;
 await A.session.issue();await A.act('bind');await A.act('install');f.addJob((await A.act('resources')).item);
 const began=deferred(),release=deferred();let once=false;
 f.hook=async(kind,{options})=>{if(kind==='provider'&&options.method==='GET'&&!once){once=true;began.resolve();await release.promise;}};
 f.clock.time+=20000;const maintenance=f.runtime.tick();await began.promise;
 const before=f.counts.admin;const publication=A.act('publish');publication.catch(()=>{});
 await Promise.resolve();await Promise.resolve();assert.equal(f.counts.admin,before);
 release.resolve();await maintenance;assert.equal((await publication).state,'published_unverified');
 assert.equal(f.runtime.status().phase,'admitting');
 await f.runtime.close();assert.equal(f.counts.deletes,3);
});
