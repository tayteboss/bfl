import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {configuration,proofClient,id as cartId} from '../../../fixtures/film-printing/f06p-composition/rig.mjs';
import {cartResponse} from '../../../fixtures/film-printing/f06c-continuation/synthetic.mjs';
import {migrateCheckoutComposition,migratePreparedCart,openDatabase} from '../backend/storage.mjs';
import {createResourceProof} from '../backend/resource-proof.mjs';
import {createCustomerResources} from '../backend/customer-resources.mjs';
import {installStagingResourceSchema,createStagingResourceState,createStagingUploadCustody} from '../backend/staging-resource-state.mjs';
import {preparePersistentStagingSources,createPersistentStagingScope,revokeEngineeringScope} from '../configuration/engineering.mjs';
import {createCheckoutComposition} from '../checkout/composition.mjs';
import {createCartCapabilityTransport} from '../checkout/cart-capability.mjs';
import {uploadBinding} from '../uploads/uploadcare.mjs';
import {ACTIVE_QUERY} from '../configuration/shopify.mjs';
import {STORE,APP,CLIENT} from '../configuration/schema.mjs';
import {SHOP,INSTALLATION} from '../backend/config.mjs';
const read=name=>JSON.parse(readFileSync(new URL('../../../fixtures/film-printing/full-product-lab-routing-20261030/'+name,import.meta.url)));
const identity={shop:{id:SHOP,myshopifyDomain:STORE},currentAppInstallation:{id:INSTALLATION,app:{id:APP,apiKey:CLIENT}}};
const selection={service:'Fine Arts',size:'16” × 20”',paper:'Luster',lab:'Chicago',options:{Borders:'Borderless (Edge-to-edge)',Turnaround:'Standard (4-5 days)'},copies:1,message:''};
const darkroom={service:'Darkroom Prints',size:'12” × 16”',paper:'RC Matte',lab:'Miami',options:{Process:'Color',Borders:'Borderless (Edge-to-edge)',Turnaround:'Standard (4-5 days)',Negatives:'Already at Bellows'},copies:1,message:''};
async function setup(t){
 const cleanups=[];const config=configuration({after:fn=>cleanups.push(fn)});migrateCheckoutComposition(config);migratePreparedCart(config);
 const path=join(config.dataDir,'jobs.sqlite'),schema=new DatabaseSync(path);installStagingResourceSchema(schema);schema.close();
 const clock={time:Date.parse('2026-10-30T05:00:00Z')},source=preparePersistentStagingSources({config:read('engineering-config-proposal.json'),catalog:read('engineering-catalog-proposal.json'),issuedAt:clock.time});
 const sourceScope=createPersistentStagingScope({...source,identity,now:()=>clock.time});
 const files=JSON.parse(readFileSync(new URL('../../../fixtures/film-printing/f06p-integration/fixture-files.json',import.meta.url))).map(f=>({...f,bytes:readFileSync(new URL('../../../fixtures/film-printing/f06p-integration/'+f.path,import.meta.url))}));
 const uploadConfig={store:STORE,app:APP,publicKey:'synthetic-public-key',projectId:699888,cdnOrigin:'https://synthetic.ucarecd.net',secret:'synthetic-upload-secret'.repeat(3),delivery:{projectKey:'synthetic-public-key',origin:'https://synthetic.s.ucarecd.net',publicAccessDisabled:true,legacyAccessDisabled:true,signingSecret:'a'.repeat(64)}};
 const uploaded=new Map(),counts={post:0,delete:0,imports:0};let hook=null,handle,db,store,state,custody,proofs,client,composition,resources;
 const fetchImpl=async(url,options={})=>{
  if(url.startsWith('https://synthetic.s.ucarecd.net/'))return new Response(uploaded.get(new URL(url).pathname.split('/')[1]),{headers:{'content-type':'image/png'}});
  let body;if(url.endsWith('/project/'))body={pub_key:uploadConfig.publicKey};
  else if(options.method==='POST'){
   counts.post++;const asset=`00000000-0000-4000-8000-${String(counts.post).padStart(12,'0')}`;
   // Inspect the actual SQLite commit boundary before the simulated remote send.
   assert.equal(db.prepare('SELECT state FROM staging_upload_custody ORDER BY rowid DESC LIMIT 1').get().state,'sending');
   assert.equal(JSON.parse(db.prepare('SELECT body FROM staging_resource_state ORDER BY rowid DESC LIMIT 1').get().body).intents.at(-1).verifying,true);
   uploaded.set(asset,Buffer.from(await options.body.get('file').arrayBuffer()));if(hook)await hook('post');body={file:asset};
  }else{const asset=url.split('/')[4];if(options.method==='DELETE'){counts.delete++;assert.equal(db.prepare('SELECT state FROM staging_upload_custody WHERE asset=?').get(asset).state,'deleting');if(hook)await hook('delete');}
   body={uuid:asset,url:`https://api.uploadcare.com/files/${asset}/`,datetime_removed:options.method==='DELETE'?'2026-10-30T05:00:00Z':null,is_ready:true,is_image:true,size:79,mime_type:'image/png',content_info:{image:{width:16,height:16}},datetime_uploaded:'2026-10-30T05:00:00Z',datetime_stored:'2026-10-30T05:00:00Z',original_file_url:`https://synthetic.ucarecd.net/${asset}/test.png`};}
  return new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
 };
 const api=async query=>query===ACTIVE_QUERY?{...identity,currentAppInstallation:{...identity.currentAppInstallation,metafield:{value:source.releaseValue}}}:{currentAppInstallation:{metafield:{type:'json',value:source.catalogValue}}};
 const transport=createCartCapabilityTransport({store:STORE,shopId:SHOP,privateToken:'synthetic-private'.repeat(3),enabled:true},{fetchImpl:async(_url,options)=>{
  const q=JSON.parse(options.body),query=q.query,cart={...cartResponse(null,q.variables.id??q.variables.cartId).data.cart,note:'',attributes:[]};
  return new Response(JSON.stringify({data:query.startsWith('mutation')?{cartLinesUpdate:{cart,userErrors:[],warnings:[]}}:{shop:{id:SHOP},cart}}),{headers:{'content-type':'application/json','x-shopify-api-version':'2026-07'}});
 }});
 function open(){
  handle=openDatabase(config,{resourceSessions:true,checkoutOwner:true,preparedCart:true,persistentSourceScope:sourceScope,now:()=>clock.time,configureStore(s,d){db=d;state=createStagingResourceState({db,store:s,sourceScope});custody=createStagingUploadCustody({db,store:s,sourceScope,now:()=>clock.time});}});store=handle.store;custody.recover();
  proofs=createResourceProof({secret:config.appSecret,sessions:store.resourceSessions,now:()=>clock.time,cartCapability:true});client=proofClient(store.resourceSessions,proofs,config,clock);
  composition=createCheckoutComposition({store,proofs,transport,custodySecret:config.sessionSecret,resolveBuyerIp:()=> '127.0.0.1',now:()=>clock.time,enabled:true});resources=new Map();
 }
 open();t.after(()=>{proofs.close();handle.close();for(const cleanup of cleanups)cleanup();});
 let issuedCount=0;
 const issue=async()=>{
  const proof=client.proof('issue'),token=store.resourceSessions.issue(proofs.observeFreshContext({request:client.request(),proof,action:'issue',ticket:null}),{ttlMs:86400000,sourceScope}).token;
  await composition.bind({request:client.request(token),proof:client.proof('cart-capability',token),cart_id:cartId.replace('composition-synthetic',`composition-synthetic-${++issuedCount}`)});return token;
 };
 const resource=token=>{
  const owner=store.resourceSessions.authenticate(client.request(token)).owner;
  if(!resources.has(owner))resources.set(owner,createCustomerResources({store,api,config,uploadConfig,files,custody,customerJobs:2,eligibility:true,enabled:true,permit:()=>true,fetchImpl,now:()=>clock.time,sourceScope,
   persistent:{owner,state,ticketForOwner:id=>store.resourceSessions.ticketForOwner(id)},importSource:async()=>{counts.imports++;const saved=state.load(owner).intents.at(-1);assert.equal(saved.sourceStarted,true);assert.equal(saved.sourcePending,true);if(hook)await hook('source');const bytes=files[0].bytes;return {bytes,mime:'image/png',source:{kind:'public_https',origin:'https://example.test',url_sha256:'b'.repeat(64),sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,mime:'image/png'}};}}));
  return resources.get(owner);
 };
 const call=async(token,url,input={},mime='application/json')=>{
  const body=mime==='application/json'?Buffer.from(JSON.stringify(input)):input,headers={...client.request(token).headers,'content-type':mime};
  const req=Readable.from([body]);Object.assign(req,{method:'POST',url,headers,rawHeaders:Object.entries(headers).flat()});let status,wire;
  const res={headersSent:false,destroyed:false,writeHead(s){status=s;this.headersSent=true;},end(s){wire=s;}};
  await resource(token).handle(req,res,store.resourceSessions);return {status,body:JSON.parse(wire)};
 };
 const upload=async(token,key='upload-request-0001',kind='local')=>{
  const issued=await call(token,'/uploads/intents',{request_key:key});assert.equal(issued.status,200,JSON.stringify(issued));
  const id=issued.body.intent_id,result=await call(token,`/uploads/${id}/${kind==='local'?'bytes':'source'}`,kind==='local'?files[0].bytes:{url:'https://example.test/fixture.png'},kind==='local'?'image/png':'application/json');return {id,...result};
 };
 const rows=table=>db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(row=>({...row}));
 return {clock,sourceScope,source,files,counts,upload,call,issue,rows,resource,owner:token=>store.resourceSessions.authenticate(client.request(token)).owner,
  get store(){return store;},get state(){return state;},get custody(){return custody;},get db(){return db;},get binding(){return uploadBinding(uploadConfig);},
  set hook(value){hook=value;},restart(){proofs.close();handle.close();open();},
  recover:token=>{const ticket=store.resourceSessions.authenticate(client.request(token)),ids=state.load(ticket.owner).intents.filter(row=>row.asset&&!row.removed).map(row=>row.id);return resource(token).resumeUploads({ticket,guard:()=>store.resourceSessions.assert(ticket),selection:{version:'uncommitted-v1',intent_ids:ids},excludedAssetIds:[]});},
 };
}
for(const kind of ['local','source'])test(`persistent ${kind} completed upload, immutable job and admission survive a real SQLite reopen without bearer custody`,async t=>{
 const f=await setup(t),token=await f.issue(),u=await f.upload(token,'upload-request-0001',kind);assert.equal(u.status,200,JSON.stringify(u));
 const prepared=await f.call(token,'/jobs',{...selection,asset_ids:[u.body.asset_id],request_key:'job-request-0001'});assert.equal(prepared.status,200,JSON.stringify(prepared));
 const before={jobs:f.rows('jobs'),sessions:f.rows('resource_sessions'),admissions:f.rows('resource_admissions'),intents:f.rows('upload_intents')},until=before.sessions[0].expires,posts=f.counts.post;
 assert.ok(!JSON.stringify(f.rows('staging_resource_state')).includes(token));f.restart();f.clock.time+=120000;
 const state=f.state.load(f.owner(token));assert.deepEqual(state.jobIds,[prepared.body.reference.id]);assert.equal(state.jobKeys.length,1);assert.equal(f.resource(token).callbackOwner(prepared.body.reference.id),f.owner(token));
 const recovered=await f.recover(token);assert.equal(recovered[0].receipt.asset_id,u.body.asset_id);assert.equal(f.counts.post,posts);assert.equal(f.counts.imports,kind==='source'?1:0);
 const repeated=await f.call(token,'/jobs',{...selection,asset_ids:[u.body.asset_id],request_key:'job-request-0001'});assert.equal(repeated.status,200,JSON.stringify(repeated));assert.deepEqual(repeated.body.reference,prepared.body.reference);
 assert.deepEqual(f.rows('jobs'),before.jobs);assert.deepEqual(f.rows('resource_admissions'),before.admissions);assert.deepEqual(f.rows('resource_sessions'),before.sessions);assert.equal(f.rows('upload_intents')[0].expires,before.intents[0].expires);assert.equal(until,f.clock.time-120000+86400000);
});
test('committed job is recovered even if the subsequent resource-state save never returns',async t=>{
 const f=await setup(t),token=await f.issue(),u=await f.upload(token),owner=f.owner(token),before=f.rows('staging_resource_state')[0];
 const result=await f.call(token,'/jobs',{...selection,asset_ids:[u.body.asset_id],request_key:'job-crash-key-0001'});assert.equal(result.status,200,JSON.stringify(result));
 // Model the commit/response gap using the exact state snapshot from before
 // the job, leaving actual immutable job/admission commits untouched.
 f.db.prepare('UPDATE staging_resource_state SET body=?,revision=? WHERE owner=?').run(before.body,before.revision,owner);f.restart();
 assert.deepEqual(f.state.load(owner).jobIds,[result.body.reference.id]);assert.equal(f.resource(token).callbackOwner(result.body.reference.id),owner);assert.equal(f.state.load(owner).jobKeys.length,1);
});
test('source import admitted before a crash is not silently reimported on restart',async t=>{
 const f=await setup(t),token=await f.issue();f.hook=async stage=>{if(stage==='source')throw Error('lost source response');};
 const failed=await f.upload(token,'source-crash-0001','source');assert.equal(failed.status,422);assert.equal(f.counts.imports,1);f.restart();f.hook=null;
 const repeated=await f.call(token,`/uploads/${failed.id}/source`,{url:'https://example.test/fixture.png'});assert.equal(repeated.status,422);assert.equal(f.counts.imports,1);assert.equal(f.counts.post,0);await assert.rejects(f.recover(token));
});
test('unknown provider POST cannot be retried after restart and preserves original intent expiry',async t=>{
 const f=await setup(t),token=await f.issue();f.hook=async stage=>{if(stage==='post')throw Error('lost POST response');};
 const failed=await f.upload(token);assert.equal(failed.status,422);assert.equal(f.counts.post,1);const before=f.rows('upload_intents')[0];assert.equal(f.rows('staging_upload_custody')[0].state,'upload-unknown');
 f.restart();f.hook=null;const replay=await f.call(token,`/uploads/${failed.id}/bytes`,f.files[0].bytes,'image/png');assert.equal(replay.body.state,'failed');assert.equal(f.counts.post,1);assert.equal(f.rows('upload_intents')[0].expires,before.expires);assert.equal(f.rows('upload_intents')[0].state,'failed');
});
test('restart recovers a durable sending/deleting boundary as unknown without replay',async t=>{
 const f=await setup(t),token=await f.issue(),u=await f.upload(token),owner=f.owner(token);
 // Simulate process loss after durable beginDelete, before remote outcome.
 f.store.uploadLedger.invalidate(f.store.uploadLedger.read(u.id),'failed');f.custody.queue();f.custody.beginDelete(u.id);f.restart();
 assert.equal(f.rows('staging_upload_custody')[0].state,'delete-unknown');assert.deepEqual(f.custody.pending(),[]);assert.equal(f.counts.delete,0);
 const issued=await f.call(token,'/uploads/intents',{request_key:'uncertain-send-0002'});assert.equal(issued.status,200);const id=issued.body.intent_id;
 f.store.uploadLedger.claim(owner,id,f.binding,{digest:createHash('sha256').update(f.files[0].bytes).digest('hex'),size:79,mime:'image/png'});f.custody.start(id,f.binding);f.restart();
 assert.equal(f.rows('staging_upload_custody')[1].state,'upload-unknown');assert.equal(f.rows('upload_intents')[1].state,'failed');assert.equal(f.counts.post,1);
});
test('removed uploads and exact provider deletion custody survive restart without resurrection',async t=>{
 const f=await setup(t),token=await f.issue(),u=await f.upload(token);assert.equal((await f.call(token,`/uploads/${u.id}/remove`)).status,200);f.restart();
 assert.equal(f.state.load(f.owner(token)).intents[0].removed,true);await assert.rejects(f.recover(token));await f.resource(token).cleanup();assert.equal(f.counts.delete,1);f.restart();await f.resource(token).cleanup();assert.equal(f.counts.delete,1);assert.equal(f.rows('staging_upload_custody')[0].state,'deleted');
});
test('owner/source isolation and stale state writes cannot replace durable custody',async t=>{
 const f=await setup(t),a=await f.issue(),u=await f.upload(a),owner=f.owner(a),saved=f.state.load(owner),b=await f.issue();
 assert.equal((await f.call(b,`/uploads/${u.id}/status`)).status,422);const next=f.state.load(owner);f.state.save(owner,next);assert.throws(()=>f.state.save(owner,saved),/STAGING_RESOURCE_STALE/);
 const altered={...f.state.load(owner),principal:{...saved.principal,verifier:'0'.repeat(64)}};assert.throws(()=>f.state.save(owner,altered),/STAGING_RESOURCE_SCOPE/);
 const naked={...f.state.load(owner),bearer:a};assert.throws(()=>f.state.save(owner,naked),/STAGING_RESOURCE_STATE/);
});

test('expanded persistent preparation history survives restart beyond the diagnostic 64 limit',async t=>{
 const f=await setup(t),token=await f.issue(),u=await f.upload(token);
 for(let n=0;n<65;n++){const result=await f.call(token,'/jobs',{...selection,asset_ids:[u.body.asset_id],request_key:`many-jobs-${String(n).padStart(8,'0')}`});assert.equal(result.status,200,JSON.stringify(result));}
 const owner=f.owner(token),before=f.rows('resource_admissions'),jobs=f.rows('jobs');assert.equal(jobs.length,65);f.restart();
 assert.equal(f.state.load(owner).jobKeys.length,65);assert.equal(f.state.load(owner).jobIds.length,65);
 const replay=await f.call(token,'/jobs',{...selection,asset_ids:[u.body.asset_id],request_key:'many-jobs-00000064'});assert.equal(replay.status,200,JSON.stringify(replay));assert.deepEqual(f.rows('resource_admissions'),before);assert.deepEqual(f.rows('jobs'),jobs);
});
test('expired owner cannot resume uploads or prepare through a restored private ticket',async t=>{
 const f=await setup(t),token=await f.issue(),u=await f.upload(token),owner=f.owner(token),before=f.rows('resource_sessions')[0];f.restart();f.clock.time=before.expires;
 assert.throws(()=>f.store.resourceSessions.ticketForOwner(owner),/RESOURCE_REJECTED/);assert.throws(()=>f.recover(token),/RESOURCE_REJECTED/);assert.deepEqual(f.rows('resource_sessions')[0],before);assert.equal(f.counts.post,1);
});
test('known provider result without local asset binding remains cleanup custody after restart',async t=>{
 const f=await setup(t),token=await f.issue(),issued=await f.call(token,'/uploads/intents',{request_key:'known-before-bind-0001'}),id=issued.body.intent_id,owner=f.owner(token);
 f.store.uploadLedger.claim(owner,id,f.binding,{digest:createHash('sha256').update(f.files[0].bytes).digest('hex'),size:79,mime:'image/png'});f.custody.start(id,f.binding);f.custody.known(id,f.binding,'00000000-0000-4000-8000-999999999999');f.restart();
 assert.equal(f.rows('upload_intents')[0].state,'failed');assert.equal(f.custody.pending()[0].asset,'00000000-0000-4000-8000-999999999999');await f.resource(token).cleanup();assert.equal(f.counts.delete,1);assert.equal(f.rows('staging_upload_custody')[0].state,'deleted');assert.equal(f.counts.post,0);
});

test('a first zero-upload Darkroom job remains resumable after restart',async t=>{
 const f=await setup(t),token=await f.issue(),result=await f.call(token,'/jobs',{...darkroom,asset_ids:[],request_key:'zero-upload-0001'});assert.equal(result.status,200,JSON.stringify(result));const owner=f.owner(token),before=f.rows('jobs');f.restart();
 assert.equal(f.resource(token).callbackOwner(result.body.reference.id),owner);const replay=await f.call(token,'/jobs',{...darkroom,asset_ids:[],request_key:'zero-upload-0001'});assert.equal(replay.status,200,JSON.stringify(replay));assert.deepEqual(f.rows('jobs'),before);assert.equal(f.counts.post,0);assert.deepEqual(f.state.load(owner).intents,[]);
});
test('protective custody cleanup remains possible after source revocation without admitting another send',async t=>{
 const f=await setup(t),token=await f.issue(),u=await f.upload(token),resource=f.resource(token);revokeEngineeringScope(f.sourceScope);
 await resource.cleanup();assert.equal(f.counts.delete,1);assert.equal(f.rows('staging_upload_custody')[0].state,'deleted');assert.equal(f.counts.post,1);
});


test('interrupted read-only status resumes after restart without another provider POST',async t=>{
 const f=await setup(t),token=await f.issue(),u=await f.upload(token),owner=f.owner(token);
 const saved=f.state.load(owner);saved.intents[0].verifying=true;f.state.save(owner,saved);
 f.restart();const result=await f.call(token,`/uploads/${u.id}/status`);
 assert.equal(result.status,200,JSON.stringify(result));assert.equal(f.counts.post,1);
});

for(const flag of ['sourcePending','cropPending','removed'])test(`restart does not release verifying while ${flag}`,async t=>{
 const f=await setup(t),token=await f.issue(),u=await f.upload(token),owner=f.owner(token);
 const saved=f.state.load(owner);saved.intents[0].verifying=true;saved.intents[0][flag]=true;f.state.save(owner,saved);
 f.restart();f.resource(token);assert.equal(f.state.load(owner).intents[0].verifying,true);assert.equal(f.counts.post,1);
});

test('persistent maintenance skips terminal asset history after a real restart',async t=>{
 const f=await setup(t),token=await f.issue(),u=await f.upload(token),owner=f.owner(token);
 f.store.uploadLedger.invalidate(f.store.uploadLedger.read(u.id),'failed');
 const op=f.store.lifecycle.startRecovery();f.store.lifecycle.finish(op);
 f.restart();await f.resource(token).maintain();
 assert.equal(f.state.load(owner).intents[0].asset,u.body.asset_id);
 assert.equal(f.rows('upload_intents')[0].state,'failed');assert.equal(f.counts.post,1);
 assert.equal(f.custody.pending()[0].asset,u.body.asset_id);
});
