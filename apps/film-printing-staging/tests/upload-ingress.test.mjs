import test from 'node:test';
import assert from 'node:assert/strict';
import {request,createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createUploadIngress} from '../uploads/http.mjs';
import {MAX_IMAGE_BYTES} from '../uploads/uploadcare.mjs';
import {STORE} from '../configuration/schema.mjs';
import {rig,bytes,asset,deletion} from '../../../fixtures/film-printing/f05c/rig.mjs';
const fixture=async(t,options)=>{const f=await rig(options);t.after(()=>f.close());return f;};
const intent=async f=>(await f.call('/uploads/intents',{request_key:'request-0001'})).body;
const rawRequest=(f,path,headers={},body,finish=true)=>new Promise((resolve,reject)=>{
 const req=request(f.url+path,{method:'POST',headers:{...f.headers(),...headers}},res=>{
  let text='';res.on('data',b=>text+=b);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text)}));
 });req.on('error',reject);req.flushHeaders();if(body)req.write(body);if(finish)req.end();
});
function browser(f,patch={}){
 const ctx=vm.createContext({URL,Blob,AbortController,setTimeout,clearTimeout,crypto:globalThis.crypto});
 for(const name of ['completed-uploads','upload-transport','film-printing-job'])vm.runInContext(readFileSync(new URL(`../theme/${name}.js`,import.meta.url),'utf8'),ctx);
 const fetchImpl=(url,options)=>fetch(url,{...options,headers:{...f.headers(),'content-type':options.headers['Content-Type']}});
 const transport=ctx.BFLUploadTransport.create({enabled:true,baseURL:f.url,origin:f.url,store:STORE,lifecycle:ctx.BFLUploadLifecycle.create({now:f.now}),fetchImpl,...patch});
 return {ctx,transport,fetchImpl};
}

test('F05 ingress default stays absent; exact trusted staging identity required',async t=>{
 const f=await fixture(t,{enabled:false});assert.equal((await f.call('/uploads/intents',{request_key:'request-0001'})).status,404);
 assert.throws(()=>createUploadIngress({config:{...f.config,store:'1jukgy-dc.myshopify.com'}}),/WRONG_TARGET/);
 for(const path of ['/uploads/intents?owner=owner-a','/uploads/intents/','/uploads/uuid/status'])assert.equal((await f.call(path)).status,404);
 assert.equal(f.p.calls.length,0);
});
test('F05 ingress rejects missing session/origin and owner mismatch before waiting for body',async t=>{
 const f=await fixture(t,{resolveOwner:async()=>null});
 for(const headers of [{cookie:''},{origin:'https://foreign.invalid'},{}]){
  const result=await rawRequest(f,'/uploads/intents',{'content-length':'1000',...headers},null,false);
  assert.equal(result.status,403);
 }
 assert.equal(f.p.calls.length,0);
});
test('F05 ingress actual HTTP byte relay, status, owner isolation and local removal',async t=>{
 const f=await fixture(t),i=await intent(f);assert.equal(i.state,'issued');
 let r=await f.call(`/uploads/${i.intent_id}/bytes`,bytes,{'content-type':'image/jpeg'});
 assert.equal(r.status,200);assert.equal(r.body.state,'complete');assert.equal(r.body.asset_id,asset);assert.equal(r.body.checkout_ready,false);
 const form=f.p.calls.find(x=>x.url.endsWith('/base/')).options.body;
 assert.deepEqual(Buffer.from(await form.get('file').arrayBuffer()),bytes);
 r=await f.call(`/uploads/${i.intent_id}/status`,{},f.headers('owner-b'));assert.equal(r.status,422);
 assert.equal((await f.call(`/uploads/${i.intent_id}/status`)).body.state,'complete');
 assert.equal((await f.call(`/uploads/${i.intent_id}/remove`)).body.state,'removed');
 assert.equal((await f.call(`/uploads/${i.intent_id}/bytes`,bytes,{'content-type':'image/jpeg'})).body.state,'removed');
 assert.equal(f.p.calls.filter(x=>x.url.endsWith('/base/')).length,1);
 assert.equal(f.runtime.status().checkout_ready,false);
});
test('F05 ingress rejects forged owner/UUID/verified, unknown keys and oversized/encoded/types before provider',async t=>{
 const f=await fixture(t),i=await intent(f);
 for(const body of [{request_key:'request-0002',owner:'owner-a'},{request_key:'request-0002',verified:true},{request_key:'request-0002',asset_id:asset},[],null])assert.equal((await f.call('/uploads/intents',body)).status,422);
 assert.equal((await f.call(`/uploads/${i.intent_id}/status`,{intent_id:i.intent_id})).status,422);
 for(const headers of [{'content-type':'image/svg+xml'},{'content-encoding':'gzip','content-type':'image/jpeg'},{'content-type':'image/jpeg','content-length':String(MAX_IMAGE_BYTES+1)}])assert.ok([413,415].includes((await rawRequest(f,`/uploads/${i.intent_id}/bytes`,headers,null,false)).status));
 assert.equal((await rawRequest(f,'/uploads/intents',{'Expect':'100-continue'},null,false)).status,417);
 assert.equal(f.p.calls.length,0);
});
test('F05 ingress chunked overflow closes before adapter and one occupied intake returns busy',async t=>{
 const f=await fixture(t),i=await intent(f);
 const slow=request(f.url+`/uploads/${i.intent_id}/bytes`,{method:'POST',headers:{...f.headers(),'content-type':'image/jpeg','transfer-encoding':'chunked'}});
 slow.on('error',()=>{});slow.flushHeaders();slow.write(bytes.subarray(0,1));
 // Same socket acknowledgement is not available; retry only read-only probe of
 // busy state while the first request owns intake, without provider activity.
 let result;for(let n=0;n<30;n++){result=await f.call(`/uploads/${i.intent_id}/status`);if(result.status===429)break;}
 assert.equal(result.status,429);slow.destroy();
 await new Promise(resolve=>setTimeout(resolve,20));
 let overflow;try{overflow=await rawRequest(f,`/uploads/${i.intent_id}/bytes`,{'content-type':'image/jpeg','transfer-encoding':'chunked'},Buffer.alloc(MAX_IMAGE_BYTES+1));}catch(e){assert.ok(['ECONNRESET','EPIPE'].includes(e.code));}
 if(overflow)assert.equal(overflow.status,413);assert.equal(f.p.calls.length,0);
});
test('F05 signed deletion verifies exact whitespace bytes; duplicates persist and tampering rejects',async t=>{
 const f=await fixture(t),i=await intent(f);
 await f.call(`/uploads/${i.intent_id}/bytes`,bytes,{'content-type':'image/jpeg'});
 const event=deletion();
 assert.equal((await f.call('/hooks/uploadcare',Buffer.from(event.raw.toString().trim()),{'x-uc-signature':event.signature})).status,422);
 const r=await f.call('/hooks/uploadcare',event.raw,{'x-uc-signature':event.signature});assert.equal(r.status,200);
 assert.equal((await f.call('/hooks/uploadcare',event.raw,{'x-uc-signature':event.signature})).status,200);
 assert.equal((await f.call(`/uploads/${i.intent_id}/status`)).body.state,'removed');
 assert.equal((await f.call('/hooks/uploadcare',event.raw,{'x-uc-signature':'v1='+'0'.repeat(64)})).status,422);
 assert.equal((await f.call('/hooks/uploadcare',event.raw)).status,401);
});
test('F05 intake time limit releases occupancy; late owner resolution cannot start reading/uploading',async t=>{
 const f=await fixture(t);let resolveOwner,calls=0;
 const handler=createUploadIngress({config:f.config,enabled:true,bodyTimeoutMs:20,authenticate:()=>new Promise(r=>resolveOwner=r),upload:()=>calls++,receiveUploadDeletion:()=>calls++});
 const server=createServer((req,res)=>void handler(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 await assert.rejects(rawRequest({...f,url:`http://127.0.0.1:${server.address().port}`},'/uploads/intents',{},Buffer.from('{"request_key":"request-0001"}')),/socket hang up/);
 resolveOwner('owner-a');await new Promise(r=>setTimeout(r,10));assert.equal(calls,0);
});
test('F05 browser transport default and cross-origin/app-proxy/production targets reject without requests',async t=>{
 const f=await fixture(t),{ctx}=browser(f);
 assert.throws(()=>ctx.BFLUploadTransport.create());
 for(const baseURL of ['https://other.invalid','https://staging.invalid/apps/bfl','https://user:pass@staging.invalid'])assert.throws(()=>ctx.BFLUploadTransport.create({enabled:true,baseURL,origin:'https://staging.invalid',store:STORE}));
 assert.throws(()=>ctx.BFLUploadTransport.create({enabled:true,baseURL:f.url,origin:f.url,store:'1jukgy-dc.myshopify.com'}));assert.equal(f.p.calls.length,0);
});
test('F05 browser to actual HTTP pending/completed/expired/removal receipts; no cart readiness',async t=>{
 const f=await fixture(t),{transport}=browser(f);f.p.ready=false;
 const flight=transport.select('local-one',new Blob([bytes],{type:'image/jpeg'}));assert.ok(transport.snapshot().pending);
 assert.equal((await flight).state,'pending');assert.ok(transport.snapshot().pending);f.p.ready=true;
 await transport.refresh('local-one');assert.deepEqual([...transport.snapshot().completedAssetIds],[asset]);
 f.advance(60001);assert.ok(transport.snapshot().pending);await transport.refresh('local-one');assert.equal(transport.snapshot().failed,0);assert.equal(transport.snapshot().pending,0);
 f.advance(540000);await transport.refresh('local-one');assert.equal(transport.snapshot().failed,1);
 await transport.remove('local-one');assert.equal(transport.snapshot().failed,0);assert.equal(transport.snapshot().pending,0);transport.dispose();
});
test('F05 browser lost response does not resend bytes; status recovers only server-bound completion',async t=>{
 const f=await fixture(t);let lose=true;const base=browser(f),transport=browser(f,{fetchImpl:async(u,o)=>{const r=await base.fetchImpl(u,o);if(u.endsWith('/bytes')&&lose){lose=false;throw Error('lost');}return r;}}).transport;
 const file=new Blob([bytes],{type:'image/jpeg'});
 await assert.rejects(transport.select('one',file));assert.ok(transport.snapshot().pending);
 await assert.rejects(transport.select('one',file));
 await transport.refresh('one');assert.deepEqual([...transport.snapshot().completedAssetIds],[asset]);
 assert.equal(f.p.calls.filter(x=>x.url.endsWith('/base/')).length,1);transport.dispose();base.transport.dispose();
});
test('F05 browser remove during in-flight completion stays blocking until terminal removal',async t=>{
 const f=await fixture(t),{transport}=browser(f);let finish,started;
 const start=new Promise(r=>started=r);f.p.beforeUpload=()=>{started();return new Promise(r=>finish=r);};
 const flight=transport.select('one',new Blob([bytes],{type:'image/jpeg'}));await start;
 const removed=transport.remove('one');assert.ok(transport.snapshot().pending);finish();await flight;assert.ok(transport.snapshot().pending);
 await removed;assert.equal(transport.snapshot().pending,0);assert.equal(transport.snapshot().completedAssetIds.length,0);transport.dispose();
});
test('F05 browser missing intent response reuses request key; unknown byte outcome fails terminally',async t=>{
 const f=await fixture(t);let lose=true;const base=browser(f),transport=browser(f,{fetchImpl:async(u,o)=>{const r=await base.fetchImpl(u,o);if(u.endsWith('/intents')&&lose){lose=false;throw Error('lost');}return r;}}).transport;
 await assert.rejects(transport.select('one',new Blob([bytes],{type:'image/jpeg'})));
 assert.ok(transport.snapshot().pending);await transport.remove('one');assert.equal(transport.snapshot().pending,0);assert.equal(f.p.calls.length,0);
 const second=browser(f).transport;f.p.fail=true;
 await assert.rejects(second.select('two',new Blob([bytes],{type:'image/jpeg'})));await second.refresh('two');assert.equal(second.snapshot().failed,1);
 transport.dispose();second.dispose();base.transport.dispose();
});
test('F05 browser rejects malformed/foreign receipts and disposal prevents late completion',async t=>{
 const f=await fixture(t),base=browser(f);let release;
 const transport=browser(f,{fetchImpl:async(u,o)=>{const r=await base.fetchImpl(u,o);if(u.endsWith('/bytes'))await new Promise(resolve=>release=resolve);return r;}}).transport;
 const flight=transport.select('one',new Blob([bytes],{type:'image/jpeg'}));
 while(!release)await new Promise(r=>setTimeout(r,5));transport.dispose();release();await assert.rejects(flight);assert.throws(()=>transport.snapshot());
 const bad=browser(f,{fetchImpl:async()=>new Response(JSON.stringify({intent_id:'foreign',checkout_ready:false}))}).transport;
 await assert.rejects(bad.select('one',new Blob([bytes],{type:'image/jpeg'})));assert.ok(bad.snapshot().pending);bad.dispose();base.transport.dispose();
});
test('F05 preparation cannot convert a receipt into pre-add checkout authority',async t=>{
 const f=await fixture(t),base=browser(f);let requested,adds=0;
 const transport=browser(f,{fetchImpl:async(u,o)=>{if(u.endsWith('/jobs')){requested=JSON.parse(o.body);return new Response(JSON.stringify({checkout_ready:false,reference:{id:'diagnostic'}}));}return base.fetchImpl(u,o);}}).transport;
 await transport.select('one',new Blob([bytes],{type:'image/jpeg'}));
 const result=await transport.prepare({asset_ids:['forged'],copies:4});assert.equal(result.checkout_ready,false);assert.deepEqual(requested.asset_ids,[asset]);
 const controller=base.ctx.BFLPrintJob.createController({read:()=>({copies:4}),prepare:()=>result,cart:()=>{adds++;},add:()=>{adds++;}});
 await assert.rejects(controller.submit());assert.equal(adds,0);transport.dispose();base.transport.dispose();
});

test('F05 owner is rechecked after intake and rejection cannot reach provider',async t=>{
 let n=0;const f=await fixture(t,{resolveOwner:async()=>++n===1?'owner-a':'owner-b'});
 const r=await f.call('/uploads/intents',{request_key:'request-0001'});assert.equal(r.status,403);assert.equal(f.p.calls.length,0);
});
test('F05 webhook has its own strict signature/body bounds independent of browser cookies',async t=>{
 const f=await fixture(t),e=deletion();
 assert.equal((await f.call('/hooks/uploadcare',e.raw,{cookie:'',origin:'','x-uc-signature':e.signature})).status,200);
 assert.equal((await rawRequest(f,'/hooks/uploadcare',{'x-uc-signature':[e.signature,e.signature]},e.raw)).status,401);
 assert.equal((await rawRequest(f,'/hooks/uploadcare',{'x-uc-signature':e.signature,'content-length':'65537'},null,false)).status,413);
 assert.equal((await rawRequest(f,'/uploads/intents',{'content-length':'1025'},null,false)).status,413);
 assert.equal(f.p.calls.length,0);
});
test('F05 graceful shutdown drains an admitted relay before releasing the private database',async t=>{
 const f=await fixture(t),i=await intent(f);let finish,started;
 const start=new Promise(r=>started=r);f.p.beforeUpload=()=>{started();return new Promise(r=>finish=r);};
 const sending=f.call(`/uploads/${i.intent_id}/bytes`,bytes,{'content-type':'image/jpeg'});await start;
 let closed=false;const closing=f.runtime.close().then(()=>closed=true);await new Promise(r=>setTimeout(r,10));assert.equal(closed,false);
 finish();assert.equal((await sending).body.state,'complete');await closing;assert.equal(closed,true);
});

test('F05 mounted form cannot enable obsolete pre-add protocol through DOM flags',async()=>{
 let calls=0,error=null;const ctx=vm.createContext({crypto:globalThis.crypto,fetch:()=>calls++});
 vm.runInContext(readFileSync(new URL('../theme/film-printing-job.js',import.meta.url),'utf8'),ctx);
 const form={dataset:{printJobFlow:'enabled',printJobEndpoint:'/apps/bfl'},querySelector:s=>s==='[name="quantity"]'?{value:'1'}:null,querySelectorAll:()=>[]};
 const mounted=ctx.BFLPrintJob.mount(form,{uploadAdapter:{snapshot:()=>({pending:0,failed:0,completedAssetIds:[asset]})},setError:e=>error=e});
 await mounted.submit();assert.equal(calls,0);assert.equal(error,'The selection could not be confirmed. Please contact us before trying again.');
});

test('F05 rejected local file stays blocking alongside prior completion until explicit removal',async t=>{
 const f=await fixture(t),{transport}=browser(f);
 await transport.select('valid',new Blob([bytes],{type:'image/jpeg'}));
 for(const [key,file] of [['url','https://foreign.invalid/file.jpg'],['empty',new Blob([],{type:'image/jpeg'})],['svg',new Blob(['<svg/>'],{type:'image/svg+xml'})]]){
  await assert.rejects(transport.select(key,file));assert.ok(transport.snapshot().pending);
  await transport.remove(key);assert.equal(transport.snapshot().pending,0);assert.deepEqual([...transport.snapshot().completedAssetIds],[asset]);
 }
 assert.equal(f.p.calls.filter(x=>x.url.endsWith('/base/')).length,1);transport.dispose();
});

test('bounded parallel queue removes an unstarted selection without later blocking surviving uploads',async()=>{
 const ctx=vm.createContext({Blob,crypto:globalThis.crypto});
 for(const name of ['completed-uploads','upload-transport'])vm.runInContext(readFileSync(new URL(`../theme/${name}.js`,import.meta.url),'utf8'),ctx);
 let issued=0,sent=0,active=0,peak=0;const rows=new Map(),releases=[];
 const receipt=(id,state,version=1)=>({schema:1,intent_id:id,version,state,asset_id:state==='complete'?id:null,expires_at:Date.now()+60000,checkout_ready:false});
 const client={intent:async()=>{const id=`00000000-0000-4000-8000-${String(++issued).padStart(12,'0')}`;rows.set(id,'issued');return receipt(id,'issued');},
 bytes:async id=>{sent++;active++;peak=Math.max(peak,active);await new Promise(r=>releases.push(r));active--;rows.set(id,'complete');return receipt(id,'complete',2);},
 status:async id=>receipt(id,rows.get(id),2),remove:async id=>{rows.set(id,'removed');return receipt(id,'removed',3);}};
 const transport=ctx.BFLUploadTransport.create({enabled:true,client,concurrency:4});
 const flights=Array.from({length:6},(_,i)=>transport.select(`file-${i}`,new Blob(['image'],{type:'image/jpeg'})));
 while(releases.length<4)await new Promise(setImmediate);
 const removal=transport.remove('file-4');for(const release of releases.splice(0))release();await removal;
 while(releases.length<1)await new Promise(setImmediate);releases.shift()();await Promise.all(flights);
 transport.failPreview('file-4');assert.equal(issued,5);assert.equal(sent,5);assert.equal(peak,4);assert.equal(transport.snapshot().pending,0);assert.equal(transport.snapshot().failed,0);
 assert.equal(transport.snapshot().completedAssetIds.length,5);transport.dispose();
});
