import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,chmodSync,rmSync,existsSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHmac} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {readConfig,INSTALLATION,SHOP} from '../backend/config.mjs';
import {initializeDatabase,openDatabase,releaseAbandonedLock} from '../backend/storage.mjs';
import {createAdminTransport} from '../backend/admin.mjs';
import {verifyAdminSession} from '../backend/auth.mjs';
import {createRuntime} from '../backend/server.mjs';
import {STORE,APP,CLIENT} from '../configuration/schema.mjs';
import {mockAdmin,now} from '../../../fixtures/film-printing/f06d/mock-admin.mjs';
import {VARIANT,PRODUCT} from '../checkout/authority.js';
const keys={jobSecret:'synthetic-job-key-'.repeat(3),sessionSecret:'synthetic-session-key-'.repeat(3),appSecret:'synthetic-app-key-'.repeat(3),adminToken:'synthetic-admin-token-'.repeat(3)};
const selection={request_key:'runtime-request-01',copies:4,service:'Photo Prints',size:'4x6',paper:'synthetic-paper',lab:'miami',asset_ids:['asset-0001','asset-0002','asset-0003'],options:{}};
const temporaryDirectories=[];
after(()=>{for(const dir of temporaryDirectories)rmSync(dir,{recursive:true,force:true});});
function configFor(t) {
 const dir=mkdtempSync(join(tmpdir(),'bfl-f06e-'));chmodSync(dir,0o700);temporaryDirectories.push(dir);
 return {store:STORE,app:APP,clientId:CLIENT,installation:INSTALLATION,dataDir:dir,host:'127.0.0.1',port:0,origin:'http://127.0.0.1:6076',mode:'reconcile-only',...keys};
}
function envFor(c) {
 const env={BFL_STORE:STORE,BFL_APP:APP,BFL_CLIENT_ID:CLIENT,BFL_INSTALLATION:INSTALLATION,BFL_DATA_DIR:c.dataDir,BFL_STORAGE:'local-persistent'};
 for(const [name,key] of [['BFL_JOB_SECRET','jobSecret'],['BFL_SESSION_SECRET','sessionSecret'],['BFL_APP_SECRET','appSecret'],['BFL_ADMIN_TOKEN','adminToken']]) {
  const path=join(c.dataDir,key);writeFileSync(path,c[key],{mode:0o600});env[`${name}_FILE`]=path;
 }
 return env;
}
function mockApi(m) {return async(q,v)=>{
 if(q.includes('BflActiveConfiguration'))return {shop:m.data.shop,currentAppInstallation:{...m.data.currentAppInstallation,metafield:m.data.currentAppInstallation.active}};
 if(q.includes('F05PriceCatalog'))return {currentAppInstallation:{metafield:m.data.currentAppInstallation.catalog}};
 return m.api(q,v);
};}
async function fixture(t,{adapters={},config,api,mock=mockAdmin()}={}) {
 const c=config??configFor(t);if(!c.databaseId)c.databaseId=initializeDatabase(c);
 const r=createRuntime(c,{api:api??mockApi(mock),adapters,now,pollMs:60000});t.after(()=>r.close());
 await r.start();await r.refresh();const base=`http://127.0.0.1:${r.server.address().port}`;
 return {r,c,mock,base};
}
const adapters=()=>({resolveOwner:async({sessionOwner})=>sessionOwner,verifyUpload:async e=>e}); // EXPLICIT OFFLINE TRUST MOCKS
async function seed(f) {for(const id of selection.asset_ids)await f.r.recordUpload({store:STORE,app:APP,owner:'owner-a',asset:{id,state:'complete',verified:true,url:`https://example.invalid/${id}`}});await f.r.refresh();}
async function post(f,input=selection,path='/jobs',extra={}) {
 return fetch(f.base+path,{method:'POST',headers:{origin:f.c.origin,cookie:f.r.session.issue('owner-a').split(';')[0],'content-type':'application/json',...extra},body:JSON.stringify(input)});
}
function jwt(claims={},header={alg:'HS256',typ:'JWT'},secret=keys.appSecret) {
 const t=now().getTime()/1000;
 const h=Buffer.from(JSON.stringify(header)).toString('base64url'),p=Buffer.from(JSON.stringify({iss:`https://${STORE}/admin`,dest:`https://${STORE}`,aud:CLIENT,sub:'42',exp:t+60,nbf:t,iat:t,...claims})).toString('base64url');
 return `Bearer ${h}.${p}.${createHmac('sha256',secret).update(`${h}.${p}`).digest('base64url')}`;
}
const response=(data,status=200,headers={})=>new Response(JSON.stringify({data}),{status,headers:{'content-type':'application/json','x-shopify-api-version':'2026-10',...headers}});
const identity=()=>({shop:{id:SHOP,myshopifyDomain:STORE},currentAppInstallation:{id:INSTALLATION,app:{id:APP,apiKey:CLIENT}}});

test('F06E exact target, one process, local storage and private separate mounted secrets are required',t=>{
 const c=configFor(t),env=envFor(c);assert.equal(readConfig(env).mode,'disabled');
 assert.equal(readConfig({...env,BFL_ORIGIN:'https://film-printing-staging.bellowsfilmlab.com',BFL_BIND:'0.0.0.0'}).origin,'https://film-printing-staging.bellowsfilmlab.com');
 assert.equal(readConfig({...env,BFL_ORIGIN:'https://film-printing-staging.bellowsfilmlab.com',BFL_BIND:'0.0.0.0',BFL_BUYER_IP:'caddy-direct'}).buyerIpMode,'caddy-direct');
 assert.equal(readConfig(env).resourceSessions,'disabled');
 const limited={...env,BFL_ADMIN_TOKEN_FILE:undefined,BFL_ORIGIN:'https://film-printing-staging.bellowsfilmlab.com',BFL_BIND:'0.0.0.0',BFL_STOREFRONT_SESSIONS:'context-only',BFL_BUYER_IP:'caddy-direct',BFL_RESOURCE_SESSIONS:'session-only'};
 assert.equal(readConfig(limited).resourceSessions,'session-only');
 assert.equal(readConfig({...limited,BFL_RESOURCE_SESSIONS:'session-only-closed'}).resourceSessions,'session-only-closed');
 for(const patch of [{BFL_RESOURCE_SESSIONS:'enabled'},{BFL_ADMIN_TOKEN_FILE:env.BFL_ADMIN_TOKEN_FILE},{BFL_ADMIN_WRITES:'reconcile-only'},{BFL_ORIGIN:'https://example.com'},{BFL_STOREFRONT_SESSIONS:'disabled'}])assert.throws(()=>readConfig({...limited,...patch}));
 assert.throws(()=>readConfig({...env,BFL_BUYER_IP:'caddy-direct'}),/INVALID_BUYER_IP_TARGET/);
 assert.throws(()=>readConfig({...env,BFL_BUYER_IP:'forwarded'}),/INVALID_BUYER_IP_MODE/);
 for(const origin of ['https://www.bellowsfilmlab.com','https://other.bellowsfilmlab.com','http://film-printing-staging.bellowsfilmlab.com','https://film-printing-staging.bellowsfilmlab.com:8443'])assert.throws(()=>readConfig({...env,BFL_ORIGIN:origin}),/INVALID_ORIGIN/);
 for(const patch of [{BFL_STORE:'1jukgy-dc.myshopify.com'},{BFL_APP:'gid://shopify/App/1'},{BFL_CLIENT_ID:'wrong'},
  {BFL_INSTALLATION:'gid://shopify/AppInstallation/1'},{WEB_CONCURRENCY:'2'},{BFL_STORAGE:'ephemeral'},
  {BFL_ORIGIN:'https://bellowsfilmlab.com'},{BFL_ORIGIN:'http://outside.example'},{BFL_BIND:'0.0.0.0'},
  {BFL_ADMIN_WRITES:'enabled'},{BFL_JOB_SECRET:'do-not-log-me'},{BFL_JOB_SECRET_FILE:undefined},
  {BFL_SESSION_SECRET_FILE:env.BFL_JOB_SECRET_FILE}]) assert.throws(()=>readConfig({...env,...patch}));
 chmodSync(env.BFL_JOB_SECRET_FILE,0o644);assert.throws(()=>readConfig(env),/SECRET_FILE_INVALID/);
});
test('F06E init is exclusive; missing DB, lost state, wrong ID/key and second process never reset storage',t=>{
 const c=configFor(t);assert.throws(()=>openDatabase(c),/DATABASE_UNAVAILABLE/);assert.equal(existsSync(join(c.dataDir,'jobs.sqlite')),false);
 c.databaseId=initializeDatabase(c);assert.throws(()=>initializeDatabase(c));
 const s=openDatabase(c);s.store.lifecycle.startRecovery();assert.throws(()=>openDatabase(c),/DATABASE_LOCKED/);s.close();
 for(const patch of [{databaseId:'wrong'},{jobSecret:'other'.repeat(10)}])assert.throws(()=>openDatabase({...c,...patch}),/DATABASE_IDENTITY_MISMATCH/);
 const next=openDatabase(c);assert.equal(next.store.lifecycle.state().operation.kind,'recovery');next.close();
 const db=new DatabaseSync(join(c.dataDir,'jobs.sqlite'));db.exec('DELETE FROM authority_state');db.close();
 assert.throws(()=>openDatabase(c),/DATABASE_STATE_MISSING/);
});
test('F06E storage rejects symlink, loose permissions and corrupt existing bytes without replacement',t=>{
 const c=configFor(t);writeFileSync(join(c.dataDir,'jobs.sqlite'),'corrupt',{mode:0o600});
 assert.throws(()=>openDatabase(c),/DATABASE_UNAVAILABLE/);assert.equal(readFileSync(join(c.dataDir,'jobs.sqlite'),'utf8'),'corrupt');
 chmodSync(c.dataDir,0o755);assert.throws(()=>openDatabase(c),/PRIVATE_STORAGE_REQUIRED/);chmodSync(c.dataDir,0o700);
 rmSync(join(c.dataDir,'jobs.sqlite'));writeFileSync(join(c.dataDir,'other'),'sentinel');symlinkSync(join(c.dataDir,'other'),join(c.dataDir,'jobs.sqlite'));
 assert.throws(()=>openDatabase(c),/PRIVATE_DATABASE_REQUIRED/);
});
test('F06E crash lock requires exact operator token and stopped writers; no timeout takeover',t=>{
 const c=configFor(t);c.databaseId=initializeDatabase(c);const s=openDatabase(c);
 const owner=JSON.parse(readFileSync(join(c.dataDir,'runtime.lock/owner.json')));
 assert.throws(()=>releaseAbandonedLock(c,owner.token,false),/STOP_ALL_WRITERS_FIRST/);
 assert.throws(()=>releaseAbandonedLock(c,'wrong',true),/LOCK_CHANGED/);
 assert.throws(()=>releaseAbandonedLock(c,owner.token,true),/WRITER_STILL_ALIVE/);s.close();
});
test('F06E health is live while credentials, recovery and all integrations remain unavailable',async t=>{
 const c=configFor(t);c.mode='disabled';c.adminToken=null;c.appSecret=null;
 const f=await fixture(t,{config:c,api:createAdminTransport(c,{fetchImpl:()=>{throw Error('must not call network');}})});
 assert.deepEqual(await (await fetch(f.base+'/healthz')).json(),{live:true,checkout_ready:false});
 const ready=await fetch(f.base+'/readyz');assert.equal(ready.status,503);assert.equal((await ready.json()).ready,false);
 assert.equal((await fetch(f.base+'/admin/status')).status,503);
 assert.equal(f.r.status().sources,'ADMIN_CREDENTIAL_REQUIRED');assert.equal(f.r.status().recovery,'AUTHORITY_WRITES_DISABLED');
 const result=await post(f);assert.equal(result.status,503);assert.equal((await result.json()).code,'OWNER_RESOLVER_UNAVAILABLE');
});
test('F06E real HTTP handler creates immutable signed jobs from one snapshot and persists across restart',async t=>{
 const c=configFor(t),a=adapters(),m=mockAdmin();let contextReads=0;
 const baseApi=mockApi(m),api=async(q,v)=>{if(q.includes('F06DAuthorityContext'))contextReads++;return baseApi(q,v);};
 const f=await fixture(t,{config:c,mock:m,api,adapters:a});await seed(f);const before=contextReads;
 const res=await post(f,{...selection,unit_price_cents:1,owner:'owner-b',file_count:99});assert.equal(res.status,200);
 const p=await res.json();assert.equal(contextReads-before,1);assert.equal(p.checkout_ready,false);assert.equal(p.unit_price_cents,120);assert.equal(p.file_count,3);assert.equal(p.item.quantity,4);
 assert.deepEqual((await (await post(f)).json()).reference,p.reference);
 const body=f.r.store.get(p.reference.id,'owner-a');assert.throws(()=>f.r.store.get(p.reference.id,'owner-b'));
 await f.r.close();const next=await fixture(t,{config:c,mock:m,adapters:a});
 assert.deepEqual(next.r.store.get(p.reference.id,'owner-a'),body);assert.deepEqual((await (await post(next)).json()).reference,p.reference);
 assert.equal(next.r.status().ready,false);assert.equal(next.r.status().checkout_ready,false);
});
test('F06E missing uploader/catalog, rejected owner and proxy/body/Staff JWT claims cannot prepare jobs',async t=>{
 const f=await fixture(t,{adapters:{resolveOwner:async({sessionOwner})=>sessionOwner}});
 assert.equal((await (await post(f)).json()).code,'UPLOADER_UNAVAILABLE');
 const bad=await fixture(t,{adapters:{...adapters(),resolveOwner:async()=> 'owner-b'}});
 assert.equal((await post(bad)).status,403);
 const valid=await fixture(t,{adapters:adapters()});await seed(valid);valid.mock.data.currentAppInstallation.catalog=null;
 assert.equal((await post(valid)).status,422);
 const unauth=await fetch(f.base+'/jobs',{method:'POST',headers:{'content-type':'application/json',authorization:jwt()},body:JSON.stringify({...selection,owner:'owner-a',logged_in_customer_id:'42'})});
 assert.equal(unauth.status,401);
 assert.equal((await fetch(f.base+'/jobs?shop='+STORE+'&signature=forged',{method:'POST'})).status,404);
});
test('F06E JSON/body/Origin bounds and no unsigned upload/event/publication/session endpoints',async t=>{
 const f=await fixture(t,{adapters:adapters()});await seed(f);
 assert.equal((await post(f,selection,'/jobs',{origin:'https://evil.invalid'})).status,401);
 assert.equal((await post(f,selection,'/jobs',{'content-type':'text/plain'})).status,415);
 assert.equal((await post(f,selection,'/jobs',{'content-encoding':'gzip'})).status,415);
 assert.equal((await post(f,{message:'x'.repeat(33000)})).status,413);
 const invalid=await fetch(f.base+'/jobs',{method:'POST',headers:{origin:f.c.origin,cookie:f.r.session.issue('owner-a').split(';')[0],'content-type':'application/json'},body:'{'});
 assert.equal(invalid.status,400);
 for(const path of ['/uploads','/events','/session','/publish','/reconcile','/webhooks/orders/paid','/webhooks/app-uninstalled'])assert.equal((await fetch(f.base+path,{method:'POST'})).status,404);
 await assert.rejects(f.r.receive('order',{owner:'owner-a'}),/EVENT_VERIFIER_UNAVAILABLE/);
});
test('F06E Shopify ID token exact bytes, HS256, audience, destination and time; replay only read-only until expiry',async t=>{
 assert.ok(verifyAdminSession(jwt(),keys.appSecret,now().getTime()));
 for(const claim of [{aud:'wrong'},{dest:'https://1jukgy-dc.myshopify.com'},{iss:'https://evil.invalid/admin'},
  {exp:now().getTime()/1000},{nbf:now().getTime()/1000+1},{iat:now().getTime()/1000+1},{exp:now().getTime()/1000+3600},{sub:'owner-a'}])assert.equal(verifyAdminSession(jwt(claim),keys.appSecret,now().getTime()),null);
 assert.equal(verifyAdminSession(jwt({}, {alg:'none'}),keys.appSecret,now().getTime()),null);
 assert.equal(verifyAdminSession(jwt({},undefined,'wrong'),keys.appSecret,now().getTime()),null);
 assert.equal(verifyAdminSession(jwt()+'x',keys.appSecret,now().getTime()),null);
 const f=await fixture(t),headers={authorization:jwt()};
 for(let i=0;i<2;i++)assert.equal((await fetch(f.base+'/admin/status',{headers})).status,200); // bearer replay is documented, not one-time
 assert.equal(verifyAdminSession(jwt(),keys.appSecret,now().getTime()+60000),null);
 assert.equal((await fetch(f.base+'/admin/status',{method:'POST',headers})).status,404);
 assert.equal((await fetch(f.base+'/admin/status?token='+encodeURIComponent(jwt()))).status,404);
});
test('F06E Admin uses fixed HTTPS destination and revalidates exact app/client/installation on every query',async t=>{
 const c=configFor(t),calls=[];const api=createAdminTransport(c,{fetchImpl:async(url,opts)=>{calls.push({url,opts});return response(JSON.parse(opts.body).query.includes('F06EIdentity')?identity():{answer:42});}});
 assert.equal((await api('query Test { shop { id } }')).answer,42);await api('query Other { shop { id } }');assert.equal(calls.length,4);
 for(const call of calls){assert.equal(call.url,`https://${STORE}/admin/api/2026-10/graphql.json`);assert.equal(call.opts.redirect,'error');assert.equal(call.opts.headers['X-Shopify-Access-Token'],keys.adminToken);}
 for(const mutate of [d=>d.shop.myshopifyDomain='1jukgy-dc.myshopify.com',d=>d.currentAppInstallation.app.id='wrong',d=>d.currentAppInstallation.app.apiKey='wrong',d=>d.currentAppInstallation.id='wrong']) {
  const d=identity();mutate(d);let n=0;const wrong=createAdminTransport(c,{fetchImpl:async()=>{n++;return response(d);}});await assert.rejects(wrong('query Test { shop { id } }'),/WRONG_TARGET/);assert.equal(n,1);
 }
 assert.throws(()=>createAdminTransport({...c,store:'1jukgy-dc.myshopify.com'}),/WRONG_TARGET/);
});
test('F06E Admin denies credentials, redirects/version drift/large/error responses and redacts upstream secrets',async t=>{
 const c=configFor(t);let calls=0;
 await assert.rejects(createAdminTransport({...c,adminToken:null},{fetchImpl:()=>{calls++;}})('query Test { shop { id } }'),/ADMIN_CREDENTIAL_REQUIRED/);assert.equal(calls,0);
 for(const reply of [()=>response({},401),()=>response({},403),()=>response({},302),()=>response(identity(),200,{'x-shopify-api-version':'2027-01'}),
  ()=>new Response(JSON.stringify({errors:[{message:keys.adminToken}]}),{headers:{'content-type':'application/json','x-shopify-api-version':'2026-10'}}),
  ()=>new Response('x'.repeat(1025),{headers:{'content-type':'application/json','x-shopify-api-version':'2026-10'}}),()=>{throw Error(keys.adminToken);}]) {
  try{await createAdminTransport(c,{maxBytes:1024,fetchImpl:async()=>reply()})('query Test { shop { id } }');assert.fail();}
  catch(e){assert.equal(e.message.includes(keys.adminToken),false);assert.match(e.message,/ADMIN_/);}
 }
 const timed=createAdminTransport(c,{timeoutMs:10,fetchImpl:async(_,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error(keys.adminToken))))});
 await assert.rejects(timed('query Test { shop { id } }'),/ADMIN_UNAVAILABLE/);
});
test('F06E transport permits only guarded empty-authority reconciliation, never arbitrary mutations',async t=>{
 const c=configFor(t);let calls=0;
 const api=createAdminTransport(c,{fetchImpl:async()=>{calls++;return response(identity());}});
 for(const query of ['mutation ProductUpdate { productUpdate { id } }','{ shop { id } }'])await assert.rejects(api(query),/ADMIN_OPERATION_REJECTED/);
 await assert.rejects(api('mutation F06DCommitAuthority($fields:[MetafieldsSetInput!]!) { metafieldsSet(metafields:$fields) { userErrors { code } } }',{fields:[]}),/ADMIN_OPERATION_REJECTED/);
 const readonly=createAdminTransport({...c,mode:'disabled'},{fetchImpl:async()=>{calls++;}});await assert.rejects(readonly('mutation X { x }'),/AUTHORITY_WRITES_DISABLED/);assert.equal(calls,0);
});
test('F06E actual transport plus F06D reconcile uses mocked external HTTP and records uncertain writes durably',async t=>{
 const c=configFor(t),m=mockAdmin();let lose=true,mutations=0;
 const api=createAdminTransport(c,{fetchImpl:async(_url,opts)=>{
  const {query,variables}=JSON.parse(opts.body);if(query.includes('F06EIdentity'))return response(identity());
  const d=await mockApi(m)(query,variables);
  if(query.startsWith('mutation')){mutations++;if(lose){lose=false;throw Error('lost '+keys.adminToken);}}
  return response(d);
 }});
 const f=await fixture(t,{config:c,api,mock:m});assert.equal(f.r.status().unknown_write,true);assert.equal(f.r.status().checkout_ready,false);
 assert.equal(mutations,1);await f.r.close();
 const next=await fixture(t,{config:c,api,mock:m});assert.equal(next.r.status().unknown_write,false);assert.equal(next.r.status().recovery,'RECONCILED');assert.equal(mutations,2);
});
test('F06E startup recovery failure retains event and operation across restart; successful recovery acknowledges',async t=>{
 const c=configFor(t);c.databaseId=initializeDatabase(c);const s=openDatabase(c);
 s.store.revoke({id:'pending-owner-event',kind:'owner',owner:'owner-a'});s.close();
 const m=mockAdmin();m.reject=true;const f=await fixture(t,{config:c,mock:m});
 assert.equal(f.r.status().pending_events,1);assert.equal(f.r.status().unknown_write,true);await f.r.close();
 m.reject=false;const next=await fixture(t,{config:c,mock:m});assert.equal(next.r.status().pending_events,0);assert.equal(next.r.status().unknown_write,false);
 assert.equal(next.r.store.lifecycle.retired('owner','owner-a'),true);assert.equal(next.r.status().ready,false);
});
test('F06E concurrent event during startup recovery cannot be falsely acknowledged; next reconcile completes',async t=>{
 const c=configFor(t),m=mockAdmin();let release,started;const began=new Promise(r=>started=r),gate=new Promise(r=>release=r);
 m.beforeWrite=async()=>{m.beforeWrite=null;started();await gate;};
 c.databaseId=initializeDatabase(c);const r=createRuntime(c,{api:mockApi(m),now,pollMs:60000});t.after(()=>r.close());await r.start();await began;
 const health=await fetch(`http://127.0.0.1:${r.server.address().port}/healthz`);assert.equal(health.status,200);
 r.store.revoke({id:'during-recovery-event',kind:'owner',owner:'owner-a'});release();await r.refresh();
 assert.equal(r.status().pending_events,1);assert.equal(r.status().unknown_write,true);await r.refresh();assert.equal(r.status().pending_events,0);
});
test('F06E internal verified event receiver schedules reconciliation; forged ownership leaves assets untouched',async t=>{
 const a={...adapters(),eventVerifiers:{upload:async e=>e}},f=await fixture(t,{adapters:a});await seed(f);
 const e={id:'offline-upload-event',store:STORE,app:APP,kind:'upload',scope:'upload:invalidate',owner:'owner-a',asset_id:'asset-0001',state:'removed'};
 await assert.rejects(f.r.receive('upload',{...e,owner:'owner-b'}));assert.equal(f.r.store.uploads('owner-a',['asset-0001']).length,1);
 await assert.rejects(f.r.receive('upload',{...e,scope:'upload:complete'}));
 assert.equal((await f.r.receive('upload',e)).revoked,false);await f.r.refresh();assert.equal((await f.r.receive('upload',e)).revoked,true);
 assert.throws(()=>f.r.store.uploads('owner-a',['asset-0001']));assert.equal(f.r.status().pending_events,0);
});
test('F06E recovery precedes real projector; current copies/assets and missing owner remain enforced',async t=>{
 let cart;const a={...adapters(),resolveCart:async()=>cart},f=await fixture(t,{adapters:a});await seed(f);
 const p=await (await post(f)).json();cart={id:'gid://shopify/Cart/synthetic-runtime',store:STORE,owner:'owner-a',customer_id:null,complete:true,
  lines:[{id:'gid://shopify/CartLine/synthetic-runtime',variant_id:VARIANT,product_id:PRODUCT,quantity:5,reference:p.reference,properties:p.item.properties}]};
 await assert.rejects(f.r.prepareAuthority({owner:'owner-b'}),/OWNER_REJECTED/);
 const prepared=await f.r.prepareAuthority({owner:'owner-a'});assert.equal(prepared.authority.grants[0].lines[0].quantity,5);assert.equal(prepared.authority.grants[0].lines[0].unit_cents,120);
 f.r.store.revoke({id:'projector-pending-event',kind:'owner',owner:'owner-a'});await assert.rejects(f.r.prepareAuthority({owner:'owner-a'}),/RECOVERY_REQUIRED/);
});

test('F06E shutdown drains authenticated internal workers before unlocking durable pending events',async t=>{
 let release,started;const began=new Promise(r=>started=r),gate=new Promise(r=>release=r);
 const f=await fixture(t,{adapters:{eventVerifiers:{owner:async e=>{started();await gate;return e;}}}});
 const receipt=f.r.receive('owner',{id:'shutdown-owner-event',store:STORE,app:APP,kind:'owner',scope:'owner:revoke',owner:'owner-a'});
 await began;let closed=false;const closing=f.r.close().then(()=>{closed=true;});
 await new Promise(r=>setImmediate(r));assert.equal(closed,false);assert.ok(existsSync(join(f.c.dataDir,'runtime.lock')));
 release();assert.equal((await receipt).revoked,false);await closing;
 const reopened=openDatabase(f.c);assert.equal(reopened.store.lifecycle.state().pending,1);reopened.close();
});
test('F06E quotes without a provider fail unavailable; public responses redact thrown upstream content',async t=>{
 const a=adapters(),f=await fixture(t,{adapters:a});await seed(f);
 assert.equal((await (await post(f,{},'/quote')).json()).code,'CART_RESOLVER_UNAVAILABLE');
 a.resolveOwner=async()=>{throw Error(keys.adminToken);};
 const res=await post(f);assert.equal(res.status,503);const body=await res.text();assert.equal(body.includes(keys.adminToken),false);assert.equal(JSON.parse(body).code,'UNAVAILABLE');
});
test('F06E partial secret mount, expired same-origin session and duplicate cookie reject without ownership calls',async t=>{
 const c=configFor(t),env=envFor(c);env.BFL_ADMIN_TOKEN_FILE=join(c.dataDir,'missing-token');assert.throws(()=>readConfig(env),/SECRET_FILE_INVALID/);
 let reads=0;const f=await fixture(t,{adapters:{...adapters(),resolveOwner:async({sessionOwner})=>{reads++;return sessionOwner;}}});
 const cookie=f.r.session.issue('owner-a').split(';')[0];
 assert.equal((await post(f,selection,'/jobs',{cookie:cookie+'; '+cookie})).status,401);assert.equal(reads,0);
 const {createSessionAuth}=await import('../jobs/session.mjs');
 const expired=createSessionAuth({secret:f.c.sessionSecret,origin:f.c.origin,now:()=>now().getTime()-3600001}).issue('owner-a').split(';')[0];
 assert.equal((await post(f,selection,'/jobs',{cookie:expired})).status,401);assert.equal(reads,0);
});

test('F06E real HTTP quote composes signed jobs, current copies, packing and one source snapshot; provider is explicitly mocked',async t=>{
 let cart,reads=0;const m=mockAdmin(),baseApi=mockApi(m),calls=[];
 const a={...adapters(),resolveCart:async()=>cart,provider:{quote:async shipment=>{calls.push(shipment);return {eligible:true,service:'FEDEX_2_DAY',rate_source:'bellows_own_account',currency:'USD',total_cents:1234};}}};
 const f=await fixture(t,{mock:m,adapters:a,api:async(q,v)=>{if(q.includes('F06DAuthorityContext'))reads++;return baseApi(q,v);}});await seed(f);
 const p=await (await post(f)).json();const {destination}=await import('../../../fixtures/film-printing/f04/synthetic.mjs');
 cart={store:STORE,owner:'owner-a',complete:true,lines:[{reference:p.reference,variant_id:'67852705202287',quantity:15}],groups:[
  {id:'actual-mock-group',job_ids:[p.reference.id],lab:'miami',location_id:'gid://shopify/Location/92443803759',destination,ship_date:'2026-10-21',pickup_type:'DROPOFF_AT_FEDEX_LOCATION'}]};
 const before=reads,result=await (await post(f,{owner:'owner-b',copies:1,groups:[],price:0},'/quote')).json();
 assert.equal(result.status,'available');assert.equal(reads-before,1);assert.equal(result.checkout_ready,false);
 assert.equal(result.packing.groups[0].job.physical_count,45);assert.deepEqual(result.packing.groups[0].parcels.map(p=>p.print_count),[40,5]);
 assert.equal(result.quotes[0].total_cents,1234);assert.equal(calls.length,1);
 cart.owner='owner-b';const rejected=await (await post(f,{},'/quote')).json();assert.equal(rejected.status,'unavailable');assert.equal(calls.length,1);
});
test('F06E transport refuses source changes and nonempty grants even with valid field structure and credentials',async t=>{
 const c=configFor(t),m=mockAdmin();const f=await fixture(t,{config:c,mock:m});
 // Capture a legitimate empty recovery write, then reset its digest guards to
 // the current remote snapshot so these tests target scope rather than stale CAS.
 const fields=structuredClone(m.writes[0]);
 for(const field of fields){const old=field.key==='authority'?m.data.shop.authority:m.data.currentAppInstallation[{active_config:'active',price_catalog:'catalog',authority_fence:'fence'}[field.key]];field.compareDigest=old.compareDigest;if(field.key==='authority_fence')field.value='00000000-0000-0000-0000-000000000001';}
 let mutations=0;
 const api=createAdminTransport(c,{fetchImpl:async(_,{body})=>{const {query}=JSON.parse(body);if(query.startsWith('mutation'))mutations++;return response(query.includes('F06EIdentity')?identity():m.data);}});
 const query='mutation F06DCommitAuthority($fields:[MetafieldsSetInput!]!) { metafieldsSet(metafields:$fields) { userErrors { code } } }';
 const changed=structuredClone(fields);changed.find(f=>f.key==='price_catalog').value=JSON.stringify({...m.catalog,rows:[]});
 await assert.rejects(api(query,{fields:changed}),/ADMIN_OPERATION_REJECTED/);assert.equal(mutations,0);
 const malformed=structuredClone(fields);malformed.find(f=>f.key==='authority').value='{"grants":[{"forged":true}]}';
 await assert.rejects(api(query,{fields:malformed}),/ADMIN_OPERATION_REJECTED/);assert.equal(mutations,0);
});

test('F06E a lifecycle change during a slow quote prevents a stale successful HTTP response',async t=>{
 let cart,release,started;const began=new Promise(r=>started=r),gate=new Promise(r=>release=r);
 const a={...adapters(),resolveCart:async()=>cart,provider:{quote:async()=>{started();await gate;return {eligible:true,service:'FEDEX_2_DAY',rate_source:'bellows_own_account',currency:'USD',total_cents:1234};}}};
 const f=await fixture(t,{adapters:a});await seed(f);const p=await (await post(f)).json();
 const {destination}=await import('../../../fixtures/film-printing/f04/synthetic.mjs');
 cart={store:STORE,owner:'owner-a',complete:true,lines:[{reference:p.reference,variant_id:'67852705202287',quantity:4}],groups:[{id:'mock-group',job_ids:[p.reference.id],lab:'miami',location_id:'gid://shopify/Location/92443803759',destination,ship_date:'2026-10-21',pickup_type:'DROPOFF_AT_FEDEX_LOCATION'}]};
 const response=post(f,{},'/quote');await began;
 f.r.store.revoke({id:'quote-racing-owner-event',kind:'owner',owner:'owner-a'});await f.r.refresh();release();
 const res=await response;assert.equal(res.status,422);assert.equal((await res.json()).code,'UNAVAILABLE');
});


test('F05D executable accepts the provider 20-character API contract without lowering app/session key bounds',t=>{
 const c=configFor(t),env=envFor(c),apiPath=join(c.dataDir,'provider-api'),deliveryPath=join(c.dataDir,'provider-delivery');
 writeFileSync(apiPath,'x'.repeat(20),{mode:0o400});writeFileSync(deliveryPath,'a'.repeat(64),{mode:0o400});
 const upload={...env,BFL_ADMIN_TOKEN_FILE:undefined,BFL_ORIGIN:'https://film-printing-staging.bellowsfilmlab.com',BFL_BIND:'0.0.0.0',BFL_STOREFRONT_SESSIONS:'context-only',BFL_BUYER_IP:'caddy-direct',BFL_RESOURCE_SESSIONS:'upload-only',BFL_UPLOAD_WINDOW_UNTIL:String(Date.now()+60000),BFL_UPLOAD_DIGEST:'b'.repeat(64),BFL_UPLOADCARE_API_FILE:apiPath,BFL_UPLOADCARE_DELIVERY_FILE:deliveryPath};
 assert.equal(readConfig(upload).uploadcare.config.secret.length,20);
 assert.throws(()=>readConfig({...upload,BFL_APP_SECRET_FILE:apiPath}),/SECRET_FILE_INVALID/);
 assert.throws(()=>readConfig({...upload,BFL_SESSION_SECRET_FILE:apiPath}),/SECRET_FILE_INVALID/);
 chmodSync(apiPath,0o600);writeFileSync(apiPath,'x'.repeat(19));assert.throws(()=>readConfig(upload),/SECRET_FILE_INVALID/);
 writeFileSync(apiPath,'x'.repeat(257));assert.throws(()=>readConfig(upload),/SECRET_FILE_INVALID/);
 writeFileSync(apiPath,'x'.repeat(20));chmodSync(apiPath,0o644);assert.throws(()=>readConfig(upload),/SECRET_FILE_INVALID/);
});
