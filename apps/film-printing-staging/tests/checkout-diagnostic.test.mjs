import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHmac} from 'node:crypto';
import {rig,id,deferred} from '../../../fixtures/film-printing/f06p-composition/rig.mjs';
import {createCheckoutDiagnostic} from '../backend/checkout-diagnostic.mjs';
import {createDiagnosticAdminTransport} from '../backend/diagnostic-admin.mjs';
import {createAuthorityAdmin} from '../checkout/shopify.mjs';
import {createResourceSession} from '../theme/resource-session.js';
import {STORE,CLIENT} from '../configuration/schema.mjs';
import {createAdminTransport} from '../backend/admin.mjs';
import {retireDiagnostic} from '../backend/diagnostic-retire.mjs';

async function setup(t,{enabled=true}={}){
 const cleanup=[],f=rig({after(fn){cleanup.push(fn);}}),events=[];f.m.data.currentAppInstallation.app.apiKey=CLIENT;
 const cfg={...f.config,mode:'reconcile-only',adminToken:'generated-admin-token'.repeat(3),diagnosticUntil:f.clock.time+1200000};
 const adminTransport=createDiagnosticAdminTransport(cfg,{lifecycle:f.store.lifecycle,enabled,permit:()=>f.clock.time<cfg.diagnosticUntil,record:e=>events.push(e),fetchImpl:async(url,opts)=>{
  assert.equal(url,`https://${STORE}/admin/api/2026-10/graphql.json`);const q=JSON.parse(opts.body);
  return new Response(JSON.stringify({data:await f.m.api(q.query,q.variables)}),{headers:{'content-type':'application/json','x-shopify-api-version':'2026-10'}});
 }});
 const admin=createAuthorityAdmin(adminTransport.api,{writesEnabled:true,lifecycle:f.store.lifecycle,now:()=>new Date(f.clock.time)});
 const diagnostic=createCheckoutDiagnostic({config:cfg,store:f.store,jobs:f.jobs,admin,transport:f.transport,resolveBuyerIp:()=> '127.0.0.1',now:()=>f.clock.time,enabled,record:e=>events.push(e),armPublication:adminTransport.arm});
 const server=createServer(async(req,res)=>{if(await diagnostic.handle(req,res))return;res.writeHead(404);res.end('{}');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 globalThis.location={origin:`https://${STORE}`};let token,continuations=0;const requests=[];
 const fetchImpl=async(url,options={})=>{
  const parsed=new URL(url,`https://${STORE}`),headers={...options.headers};let path=parsed.pathname+parsed.search;
  if(path.startsWith('/apps/bfl-staging/resource-proof?')){
   const q=parsed.searchParams;q.set('shop',STORE);q.set('path_prefix','/apps/bfl-staging');q.set('logged_in_customer_id','');q.set('timestamp',String(Math.floor(f.clock.time/1000)));
   q.set('signature',createHmac('sha256',cfg.appSecret).update([...q].map(([k,v])=>`${k}=${v}`).sort().join('')).digest('hex'));path='/proxy/resource-proof?'+q;
  }else headers.origin=`https://${STORE}`;
  if(headers.Authorization)token=headers.Authorization.slice(7);
  if(parsed.pathname.endsWith('/continue'))continuations++;
  requests.push({path:parsed.pathname,epoch:f.store.lifecycle.state().epoch});
  return fetch(base+path,{...options,headers});
 };
 const client=createResourceSession({fetchImpl,now:()=>f.clock.time});
 const act=action=>client.checkoutDiagnostic(action,async()=>id);
 t.after(async()=>{try{await diagnostic.close();}finally{server.closeAllConnections();await new Promise(r=>server.close(r));for(const fn of cleanup)await fn();}});
 const freshProof=async()=>{
  const headers={'Content-Type':'application/json',Authorization:'Bearer '+token};
  const post=async(path,input)=>(await fetchImpl('https://film-printing-staging.bellowsfilmlab.com'+path,{method:'POST',headers,body:JSON.stringify(input)})).json();
  const c=await post('/resource-proof/challenge',{action:'cart-capability'});
  const query=new URLSearchParams({challenge:c.challenge,purpose:c.purpose,audience:c.audience,action:c.action});
  const b=await(await fetchImpl('/apps/bfl-staging/resource-proof?'+query)).json();
  return (await post('/resource-proof/exchange',{action:c.action,challenge:c.challenge,verifier:c.verifier,ticket:b.ticket})).proof;
 };
 return {...f,cfg,client,act,diagnostic,adminTransport,events,requests,get token(){return token;},get continuations(){return continuations;},fetchImpl,base,freshProof};
}

test('parallel binds preserve the unfinished-attempt guard and record a safe failure receipt',async t=>{
 const f=await setup(t),other=createResourceSession({fetchImpl:f.fetchImpl,now:()=>f.clock.time});
 await f.client.issue();await other.issue();
 const entered=deferred(),release=deferred();
 f.state.hook=async kind=>{if(kind==='reads'){entered.resolve();await release.promise;}};
 const first=f.act('bind');await entered.promise;
 try{
  await assert.rejects(other.checkoutDiagnostic('bind',async()=>id.replace('composition-synthetic','second-synthetic')),/RESOURCE_UNAVAILABLE/);
  assert.deepEqual(f.events.filter(e=>e.event==='action_failed'),[{event:'action_failed',action:'bind',code:'CART_CAPABILITY_UNKNOWN'}]);
  assert.equal(f.rows('checkout_capability_attempts').length,1);
  assert.equal(f.state.checks,0);
 }finally{release.resolve();}
 assert.equal((await first).owned,true);
 assert.equal(f.state.checks,1);
});

test('sequential fresh-cart binds succeed for both owners without relaxing the guard',async t=>{
 const f=await setup(t),other=createResourceSession({fetchImpl:f.fetchImpl,now:()=>f.clock.time});
 await f.client.issue();await other.issue();
 assert.equal((await f.act('bind')).owned,true);
 const second=id.replace('composition-synthetic','second-synthetic');f.state.cart.id=second;
 assert.equal((await other.checkoutDiagnostic('bind',async()=>second)).owned,true);
 assert.equal(f.rows('checkout_capability_attempts').length,2);
 assert.ok(f.rows('checkout_capability_attempts').every(r=>r.state==='capability_only'));
 assert.equal(f.state.checks,2);
 assert.deepEqual(f.events.filter(e=>e.event==='action_failed'),[]);
});

test('failure receipts exclude request bodies, credentials and arbitrary exception text',async t=>{
 const f=await setup(t);await f.client.issue();await f.act('bind');
 const secret='private-cart-and-proof-sentinel';
 const response=await fetch(f.base+'/diagnostic/checkout/bind',{method:'POST',headers:{origin:`https://${STORE}`,'Content-Type':'application/json',Authorization:'Bearer '+f.token},body:JSON.stringify({unexpected:secret})});
 assert.equal(response.status,403);
 assert.deepEqual(f.events.filter(e=>e.event==='action_failed'),[{event:'action_failed',action:'bind',code:'DIAGNOSTIC_BODY'}]);
 f.state.hook=()=>{throw Error(secret);};
 await assert.rejects(f.act('observe'),/RESOURCE_UNAVAILABLE/);
 assert.ok(!JSON.stringify(f.events).includes(secret)&&!JSON.stringify(f.events).includes(f.token));
});

test('real browser helper drives signed HTTP continuation after clearing and one normal CAS publication',async t=>{
 const f=await setup(t);await f.client.issue();await f.act('bind');await f.act('install');
 assert.deepEqual(f.adminTransport.status(),{requests:4,mutations:1,publication_spent:false});
 await f.addJob(f.token);const result=await f.act('publish');
 assert.equal(result.state,'published_unverified');assert.equal(result.cart_verified,false);assert.equal(result.checkout_ready,false);
 assert.equal(f.continuations,2);assert.equal(f.adminTransport.status().publication_spent,true);
 assert.equal(JSON.parse(f.m.data.shop.authority.value).grants.length,1);
 const challenges=f.requests.filter(r=>r.path==='/resource-proof/challenge');assert.ok(new Set(challenges.map(r=>r.epoch)).size>=3);
 assert.ok(f.events.every(e=>!JSON.stringify(e).includes(id)&&!JSON.stringify(e).includes(f.token)));
 await assert.rejects(f.act('publish'));assert.equal(f.state.markerWrites,1);
 assert.deepEqual(f.adminTransport.status(),{requests:13,mutations:3,publication_spent:true});
 assert.equal(f.state.reads,2);assert.equal(f.state.markerReads,8);assert.equal(f.state.checks,1);
 await f.diagnostic.close();assert.equal(f.adminTransport.status().requests,17);
 t.diagnostic(JSON.stringify({one_owner_bind_install_publish_and_close:{admin_requests:17,admin_mutations:4,full_reads:2,binding_reads:8,capability_checks:1,marker_sets:1},sources_and_job_completion:'generated; resource pipeline counted separately'}));
});

test('expiry while a real generated remote grant exists retires owner/marker and verifies EMPTY via writer',async t=>{
 const f=await setup(t);await f.client.issue();await f.act('bind');await f.act('install');await f.addJob(f.token);await f.act('publish');
 f.clock.time+=300001;await f.diagnostic.maintenance();
 assert.equal(JSON.parse(f.m.data.shop.authority.value).grants.length,0);assert.equal(f.store.lifecycle.state().pending,0);
 assert.equal(f.rows('cart_checkout_bindings')[0].state,'retired');assert.equal(f.diagnostic.status().lease_active,false);
 const attempts=f.adminTransport.status().requests;await f.diagnostic.maintenance();assert.equal(f.adminTransport.status().requests,attempts);
});

test('default-closed diagnostic has no challenge, admission or mutation and teardown does not reconcile',async t=>{
 const f=await setup(t,{enabled:false});await assert.rejects(f.client.issue());
 assert.equal(f.diagnostic.status().counts.issue,0);assert.equal(f.adminTransport.status().requests,0);
});

test('closing after marker install but before publication durably retires that marker',async t=>{
 const f=await setup(t);await f.client.issue();await f.act('bind');await f.act('install');
 await f.diagnostic.close();assert.equal(f.rows('cart_checkout_bindings')[0].state,'retired');
 assert.equal(JSON.parse(f.m.data.shop.authority.value).grants.length,0);
});

test('finite new issuances reject a third session and all routes close at deadline',async t=>{
 const f=await setup(t);await f.client.issue();const other=createResourceSession({fetchImpl:f.fetchImpl,now:()=>f.clock.time});await other.issue();
 const third=createResourceSession({fetchImpl:f.fetchImpl,now:()=>f.clock.time});await assert.rejects(third.issue());
 f.clock.time+=1200001;const r=await fetch(f.base+'/diagnostic/checkout/bind',{method:'POST'});assert.equal(r.status,404);
});

test('foreign or replayed continuation cannot supply post-clear evidence',async t=>{
 const f=await setup(t);await f.client.issue();await f.act('bind');
 const initial={proof:await f.freshProof()},headers={origin:`https://${STORE}`,authorization:'Bearer '+f.token,'content-type':'application/json'};
 const start=await fetch(f.base+'/diagnostic/checkout/install',{method:'POST',headers,body:JSON.stringify({proof:initial.proof,cart_id:id})});
 assert.equal(start.status,202);const c=await start.json();const proof=f.input(f.token).proof;
 let r=await fetch(f.base+'/diagnostic/checkout/continue',{method:'POST',headers,body:JSON.stringify({proof,cart_id:id,continuation:'x'.repeat(43)})});assert.equal(r.status,403);
 r=await fetch(f.base+'/diagnostic/checkout/continue',{method:'POST',headers,body:JSON.stringify({proof,cart_id:id,continuation:c.continuation})});assert.equal(r.status,403); // proof belongs to a different proof-service instance
 assert.equal(f.rows('cart_checkout_bindings')[0].state,'retired');
 r=await fetch(f.base+'/diagnostic/checkout/continue',{method:'POST',headers,body:JSON.stringify({proof,cart_id:id,continuation:c.continuation})});assert.equal(r.status,403);
});

test('lost nonempty CAS response is never resent and normal recovery verifies EMPTY',async t=>{
 const f=await setup(t);await f.client.issue();await f.act('bind');await f.act('install');await f.addJob(f.token);
 f.m.afterWrite=fields=>{if(JSON.parse(fields.find(x=>x.key==='authority').value).grants.length)throw Error('generated lost response');};
 await assert.rejects(f.act('publish'));assert.equal(f.adminTransport.status().publication_spent,true);
 assert.equal(f.m.writes.filter(fields=>JSON.parse(fields.find(x=>x.key==='authority').value).grants.length).length,1);
 assert.equal(JSON.parse(f.m.data.shop.authority.value).grants.length,0);assert.equal(f.store.lifecycle.state().operation,null);
 await assert.rejects(f.act('publish'));
});

test('owner retirement during Admin identity await blocks the nonempty wire send',async t=>{
 const f=await setup(t);await f.client.issue();await f.act('bind');await f.act('install');await f.addJob(f.token);let once=false;
 f.m.beforeRead=()=>{if(!once&&f.store.lifecycle.state().operation?.kind==='publish'){
  once=true;const owner=f.store.resourceSessions.authenticate(f.request(f.token)).owner;f.store.revoke({id:'publication-race',kind:'owner',owner});
 }};
 await assert.rejects(f.act('publish'));assert.equal(once,true);
 assert.equal(f.m.writes.filter(fields=>JSON.parse(fields.find(x=>x.key==='authority').value).grants.length).length,0);
 assert.equal(JSON.parse(f.m.data.shop.authority.value).grants.length,0);
});

test('normal default Admin transport cannot resend a prepared nonempty value; recovery uses its EMPTY-only path',async t=>{
 const f=await setup(t);await f.client.issue();await f.act('bind');await f.act('install');await f.addJob(f.token);await f.act('publish');
 let calls=0;const api=createAdminTransport(f.cfg,{fetchImpl:async(url,opts)=>{
  calls++;const q=JSON.parse(opts.body);return new Response(JSON.stringify({data:await f.m.api(q.query,q.variables)}),{headers:{'content-type':'application/json','x-shopify-api-version':'2026-10'}});
 }});
 const fields=f.m.writes.find(fields=>JSON.parse(fields.find(x=>x.key==='authority').value).grants.length);
 await assert.rejects(api('mutation F06DCommitAuthority($fields:[MetafieldsSetInput!]!){metafieldsSet(metafields:$fields){userErrors{code}}}',{fields}),/ADMIN_OPERATION_REJECTED/);assert.equal(calls,0);
 const admin=createAuthorityAdmin(api,{writesEnabled:true,lifecycle:f.store.lifecycle,now:()=>new Date(f.clock.time)});
 const history=[{event:'reserved',run_id:'f06p-integrated-v1',plan_sha256:'a'.repeat(64)},...f.events];
 await retireDiagnostic({store:f.store,admin,history,planHash:'a'.repeat(64),enabled:true});
 assert.equal(calls,4);assert.equal(JSON.parse(f.m.data.shop.authority.value).grants.length,0);
});
