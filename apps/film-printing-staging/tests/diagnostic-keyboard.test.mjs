import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {registerCheckoutDiagnostic} from '../theme/checkout-diagnostic.js';
import {moduleGraph} from './diagnostic-module-fixture.mjs';
import {verifyDiagnosticControl,CONTROL_QUERY} from '../backend/diagnostic-control.mjs';
import {canonical} from '../configuration/config.mjs';
import {rawHash} from '../configuration/engineering.mjs';
import {STORE,APP} from '../configuration/schema.mjs';
import {SHOP,INSTALLATION} from '../backend/config.mjs';
const locator=globalThis.BFLPrintCartLocator;
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};

// Generated event objects exercise handler guards only. isTrusted=true here is
// NOT evidence that Chrome/its extension delivers a real trusted keyboard event.
function setup(t,register=registerCheckoutDiagnostic){
 const names=['location','Shopify','document','BFLPrintCartLocator','addEventListener','removeEventListener','setTimeout','clearTimeout'];
 const old=Object.fromEntries(names.map(k=>[k,globalThis[k]])),dateNow=Date.now;
 const f={clock:100000,reads:0,updates:0,requests:[],lines:[],listeners:new Map(),page:new Map(),timers:new Map(),nodes:[],tools:[],readWait:null,fetchWait:null,failPath:null,serial:0};
 f.cap='gid://shopify/Cart/generated-keyboard-B?key=generated-private-capability';
 const secret='generated-private-signature',marker='b'.repeat(64),token='bflr1_'+'t'.repeat(43);
 const control={run_id:'f06p-integrated-v1',product_id:'gid://shopify/Product/9990001',variant_id:'gid://shopify/ProductVariant/9990002',title:'F06P engineering control — f06p-integrated-v1',currency:'USD',price:'1.00',quantity:1,requires_shipping:false,tracked:false};
 f.controlContractSha256=createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(control).filter(([key])=>!['product_id','variant_id'].includes(key)).sort(([a],[b])=>a.localeCompare(b))))).digest('hex');
 f.controlReady=true;f.controlPin=null;f.controlReads=0;f.controlReadbackChange=()=>{};f.browserControlChange=()=>{};
 f.provisionControl=()=>{f.controlReady=true;f.controlPin={product_id:control.product_id,variant_id:control.variant_id,publication_id:'gid://shopify/Publication/9990003',sha256:rawHash(canonical(control))};};
 f.verifiedControl=()=>verifyDiagnosticControl(async(query,variables)=>{
  f.controlReads++;assert.equal(query,CONTROL_QUERY);assert.deepEqual(variables,{id:f.controlPin.product_id,publication:f.controlPin.publication_id});
  const data={shop:{id:SHOP,myshopifyDomain:STORE,currencyCode:'USD'},currentAppInstallation:{id:INSTALLATION,app:{id:APP}},product:f.controlReady?{id:control.product_id,title:control.title,status:'ACTIVE',productType:'F06P engineering control',tags:['f06p-engineering'],hasOnlyDefaultVariant:true,publishedOnPublication:true,variants:{nodes:[{id:control.variant_id,price:'1.00',inventoryItem:{tracked:false,requiresShipping:false}}],pageInfo:{hasNextPage:false}}}:null};
  f.controlReadbackChange(data);return data;
 },f.controlPin);
 f.provisionControl();
 Date.now=()=>f.clock;
 globalThis.setTimeout=(fn,ms)=>{const id=++f.serial;f.timers.set(id,{fn,ms});return id;};
 globalThis.clearTimeout=id=>f.timers.delete(id);
 globalThis.addEventListener=(kind,fn)=>f.page.set(kind,fn);
 globalThis.removeEventListener=(kind,fn)=>{if(f.page.get(kind)===fn)f.page.delete(kind);};
 globalThis.location={origin:'https://bellows-film-printing-staging.myshopify.com',hostname:'bellows-film-printing-staging.myshopify.com'};
 const cart=()=>({cart:{id:f.cap,totalQuantity:f.lines.reduce((n,l)=>n+l.quantity,0),lines:{nodes:structuredClone(f.lines)},cost:{totalAmount:{amount:(f.lines.reduce((n,l)=>n+l.quantity,0)*1.2).toFixed(2),currencyCode:'USD'}}},userErrors:[],warnings:[]});
 globalThis.Shopify={theme:{id:189196533871,role:'unpublished'},actions:{
  getCart:async()=>{f.reads++;if(f.readWait)await f.readWait.promise;return cart();},
  updateCart:async({cartId,lines})=>{assert.equal(cartId,f.cap);f.updates++;for(const line of lines){if(line.id){const existing=f.lines.find(l=>l.id===line.id);if(line.quantity===0)f.lines=f.lines.filter(l=>l.id!==line.id);else if(existing)existing.quantity=line.quantity;}else f.lines.push({id:'generated-line-'+f.updates,quantity:line.quantity,attributes:line.attributes});}if(f.loseUpdate)throw Error(secret);return cart();},
 }};
 globalThis.BFLPrintCartLocator=locator;
 globalThis.document={
  head:{append:node=>{node.isConnected=true;f.nodes.push(node);}},
  getElementById:id=>f.nodes.find(n=>n.id===id&&n.isConnected),
  createElement:tag=>({tagName:tag.toUpperCase(),isConnected:false,textContent:'',remove(){this.isConnected=false;}}),
  addEventListener:(kind,fn)=>f.listeners.set(kind,fn),
  removeEventListener:(kind,fn)=>{if(f.listeners.get(kind)===fn)f.listeners.delete(kind);},
 };
 f.fetch=async(url,options)=>{
  const path=new URL(url,'https://bellows-film-printing-staging.myshopify.com').pathname;f.requests.push(path);
  if(f.failPath===path)throw Error(secret+' '+token+' '+f.cap);
  if(f.fetchWait?.path===path)await f.fetchWait.promise;
  const input=options.body?JSON.parse(options.body):{};
  let body={cart_verified:false,checkout_ready:false};
  if(path==='/resource-proof/challenge')body={challenge:'c'.repeat(43),verifier:'v'.repeat(43),purpose:'bfl:resource-fresh-proof:v1',audience:location.origin+'/bfl-application-resources',action:input.action,expires_in:30};
  else if(path==='/apps/bfl-staging/resource-proof')body={ticket:'k'.repeat(43)};
  else if(path==='/resource-proof/exchange')body={proof:'p'.repeat(43),expires_in:30};
  else if(path==='/resource-sessions/issue')body={...body,token,resource_only:true,expires_in:300,generation:1};
  else if(path==='/resource-sessions/revoke')body={revoked:true};
  else if(path==='/diagnostic/checkout/control'){
   const value=await f.verifiedControl();f.browserControlChange(value);body={...body,control:value};
  }
  else if(path==='/diagnostic/checkout/inspect')body={...body,binding_value:f.installed?marker:null,test_marker:marker};
  else if(path==='/diagnostic/checkout/copy_item'||path==='/diagnostic/checkout/resources')body={...body,item:{id:'67852705202287',quantity:4,properties:{_bfl_job:'generated-private-job',_bfl_signature:secret}}};
  else if(path==='/diagnostic/checkout/bind')body={...body,owned:true,state:secret};
  else if(path==='/diagnostic/checkout/install'){f.installed=true;body={...body,installed:true,state:secret};}
  else if(path==='/diagnostic/checkout/publish'||path==='/diagnostic/checkout/observe')body={...body,state:secret};
  else if(path==='/api/2026-07/graphql.json'){
   assert.equal(options.headers.Authorization,undefined);assert.equal(options.credentials,'same-origin');
   return new Response(JSON.stringify({errors:[{extensions:{code:'ACCESS_DENIED'},message:secret}]}),{status:403});
  }else throw Error('unexpected generated path');
  return new Response(JSON.stringify(body));
 };
 f.args={until:160000,cleanupUntil:790000,runId:'f06p-integrated-v1',role:'B',input:'keyboard',controlContractSha256:f.controlContractSha256,options:{fetchImpl:f.fetch}};
 f.start=async overrides=>{const r=await register({...f.args,...overrides});f.controller=r;return r;};
 f.receipt=()=>{const node=f.nodes.find(n=>n.isConnected);return node?JSON.parse(node.textContent):null;};
 f.press=(code,extra={})=>{let prevented=false;f.listeners.get('keydown')?.({isTrusted:true,repeat:false,isComposing:false,defaultPrevented:false,ctrlKey:true,altKey:true,shiftKey:true,metaKey:false,code,composedPath:()=>[{tagName:'BODY'}],preventDefault(){prevented=true;},...extra});return prevented;};
 f.settle=async()=>{await tick();for(let i=0;i<100&&f.receipt()?.status==='pending';i++)await delay(1);return f.receipt();};
 f.act=async code=>{f.press(code);return f.settle();};
 f.webmcp=()=>{document.modelContext={registerTool:async(tool,{signal})=>{f.tools.push({tool,signal});}};};
 f.noLeaks=()=>{for(const node of f.nodes){for(const value of [f.cap,f.cap.split('?')[0],f.cap.split('?key=')[1],secret,marker,token,'generated-private-job','c'.repeat(43),'v'.repeat(43),'p'.repeat(43),'k'.repeat(43)])assert.equal(node.textContent.includes(value),false);}};
 t.after(async()=>{await f.controller?.close().catch(()=>{});for(const k of names){if(old[k]===undefined)delete globalThis[k];else globalThis[k]=old[k];}Date.now=dateNow;});
 return f;
}

test('keyboard is explicit for either role; invalid target/run/window/pin/input denies before registration or work',async t=>{
 const f=setup(t);
 for(const change of [{input:undefined},{input:'other'},{role:'C'},{runId:'other'},{until:0},{until:1300001,cleanupUntil:1930001},{cleanupUntil:790001},{controlContractSha256:'bad'},{preflightOnly:'true'}])await assert.rejects(f.start(change));
 location.origin='https://other.test';await assert.rejects(f.start());location.origin='https://bellows-film-printing-staging.myshopify.com';
 Shopify.theme.id=1;await assert.rejects(f.start());Shopify.theme.id=189196533871;Shopify.theme.role='main';await assert.rejects(f.start());
 assert.equal(f.nodes.length,0);assert.equal(f.requests.length,0);assert.equal(f.reads,0);assert.equal(f.timers.size,0);
});

test('default WebMCP remains available; B role denied A actions in schema and dispatcher',async t=>{
 const f=setup(t);f.webmcp();await f.start({input:undefined});const {tool}=f.tools[0];
 for(const action of ['install','publish','resources','observe','quantity_changed','quantity_restored','remove_job','readd_job','duplicate_add','duplicate_remove','hostile_overwrite','hostile_delete']){
  assert.equal(tool.inputSchema.properties.action.enum.includes(action),false);await assert.rejects(tool.execute({action}));
 }
 assert.equal(f.nodes.length,0);assert.equal(f.requests.length,0);assert.equal(f.reads,0);
 assert.equal(JSON.parse(await tool.execute({action:'preflight'})).empty,true);
 await tool.execute({action:'close'});assert.equal(f.tools[0].signal.aborted,true);assert.equal(f.timers.size,0);assert.equal(f.page.size,0);
 await assert.rejects(f.start({input:undefined}));
});

test('preflight-only keys ignore untrusted/repeat/composing/editable/wrong modifiers and reject mutation keys',async t=>{
 const f=setup(t);await f.start({preflightOnly:true});assert.equal(f.receipt().status,'ready');assert.equal(f.nodes[0].tagName,'SCRIPT');assert.equal(f.nodes[0].type,'application/json');
 for(const extra of [{isTrusted:false},{repeat:true},{isComposing:true},{defaultPrevented:true},{ctrlKey:false},{altKey:false},{shiftKey:false},{metaKey:true},{composedPath:()=>[{tagName:'INPUT'}]},{composedPath:()=>[{tagName:'TEXTAREA'}]},{composedPath:()=>[{tagName:'SELECT'}]},{composedPath:()=>[{isContentEditable:true}]}])for(const code of ['KeyP','KeyU','KeyE'])assert.equal(f.press(code,extra),false);
 assert.equal(f.press('KeyQ'),false);assert.equal(f.receipt().sequence,0);assert.equal(f.reads,0);
 for(const code of ['KeyI','KeyB','KeyU','KeyD','KeyS','KeyJ','KeyH','KeyK'])assert.equal((await f.act(code)).status,'rejected');
 assert.equal((await f.act('KeyP')).result.empty,true);assert.equal((await f.act('KeyR')).result.controller_memory_retained,true);assert.equal(f.reads,4);
 assert.equal((await f.act('KeyP')).status,'rejected');assert.equal(f.reads,4);assert.equal(f.requests.length,0);assert.equal(f.updates,0);f.noLeaks();
});

test('one handler executes the generated B sequence through native locator/proof transport without DOM secrets',async t=>{
 const f=setup(t);await f.start();
 const ignored=async()=>{const receipt=f.receipt(),counts=[f.reads,f.updates,f.requests.length];
  for(const code of ['KeyC','KeyX','KeyV'])assert.equal(f.press(code),false);
  await tick();assert.deepEqual(f.receipt(),receipt);assert.deepEqual([f.reads,f.updates,f.requests.length],counts);assert.equal(f.listeners.size,1);
 };
 await ignored();
 for(const code of ['KeyP','KeyI','KeyB','KeyU','KeyD','KeyR','KeyS','KeyS','KeyH','KeyJ','KeyK']){
  const r=await f.act(code);assert.equal(r.status,'complete',code);assert.equal(r.cart_verified,false);assert.equal(r.result.checkout_ready,false);f.noLeaks();
  await ignored();
 }
 assert.equal(f.updates,4);assert.equal(f.reads,21);assert.equal(f.lines.length,0);assert.equal(f.requests.filter(p=>p==='/api/2026-07/graphql.json').length,1);
 const before=f.requests.length;assert.equal((await f.act('KeyI')).status,'rejected');assert.equal((await f.act('KeyJ')).status,'rejected');assert.equal(f.requests.length,before);
 const receipt=await f.act('KeyE');assert.equal(receipt.result.local_cleared,true);assert.equal(receipt.result.remote_confirmed,true);assert.equal(f.listeners.size,0);assert.equal(f.page.size,0);
 assert.equal(f.requests.filter(p=>p==='/resource-sessions/revoke').length,1);assert.equal(f.requests.length,34);assert.equal(f.timers.size,1);f.noLeaks();
 await f.controller.close();assert.equal(f.receipt(),null);assert.equal(f.timers.size,0);await assert.rejects(f.start());
});

test('busy keys never queue or overwrite pending result; close cancels pending issuance and discards late credential',async t=>{
 const f=setup(t),wait=deferred();f.fetchWait={path:'/resource-sessions/issue',...wait};await f.start();
 f.press('KeyI');await tick();assert.equal(f.receipt().status,'pending');const seq=f.receipt().sequence,count=f.requests.length;
 for(const code of ['KeyI','KeyB','KeyP'])f.press(code);assert.equal(f.receipt().sequence,seq);assert.equal(f.requests.length,count);
 const closed=await f.act('KeyE');assert.equal(closed.result.closed,true);assert.equal(closed.result.remote_confirmed,false);assert.equal(f.listeners.size,0);
 wait.resolve();await tick();assert.deepEqual(f.receipt(),closed);assert.equal(f.requests.filter(p=>p==='/resource-sessions/revoke').length,1);f.noLeaks();
});

test('uncertain action is never retried; only cleanup/close remain, and a lost native update is not claimed clean',async t=>{
 const f=setup(t);await f.start();await f.act('KeyI');await f.act('KeyB');f.loseUpdate=true;
 assert.equal((await f.act('KeyU')).status,'unknown');assert.equal(f.updates,1);assert.equal(f.lines.length,1);
 const before=f.requests.length;for(const code of ['KeyU','KeyB','KeyI','KeyP','KeyS','KeyJ'])assert.equal((await f.act(code)).status,'rejected');assert.equal(f.requests.length,before);assert.equal(f.updates,1);
 assert.equal((await f.act('KeyK')).status,'unknown');assert.equal((await f.act('KeyK')).status,'rejected');assert.equal(f.updates,1);assert.equal(f.lines.length,1);
 assert.equal((await f.act('KeyE')).result.remote_confirmed,true);f.noLeaks();
});

test('unknown proof response blocks new authority; failed revoke disposes local input without claiming remote success',async t=>{
 const f=setup(t);await f.start();await f.act('KeyI');f.failPath='/diagnostic/checkout/bind';assert.equal((await f.act('KeyB')).status,'unknown');
 const before=f.requests.length;assert.equal((await f.act('KeyB')).status,'rejected');assert.equal(f.requests.length,before);
 f.failPath='/resource-sessions/revoke';const r=await f.act('KeyE');assert.equal(r.status,'unknown');assert.equal(r.result,undefined);assert.equal(f.listeners.size,0);assert.equal(f.page.size,0);f.noLeaks();
 await assert.rejects(f.controller.close());assert.equal(f.timers.size,0);assert.equal(f.receipt(),null);
 assert.equal(f.requests.filter(p=>p==='/resource-sessions/revoke').length,1);
});

test('target changes and expiry deny input; only known-line cleanup/close survive admission expiry',async t=>{
 const f=setup(t);await f.start();await f.act('KeyI');await f.act('KeyB');await f.act('KeyJ');
 Shopify.theme.id=1;const before=f.reads;assert.equal((await f.act('KeyP')).status,'rejected');assert.equal(f.reads,before);Shopify.theme.id=189196533871;
 f.clock=f.args.until;assert.equal((await f.act('KeyP')).status,'rejected');assert.equal((await f.act('KeyU')).status,'rejected');assert.equal(f.reads,before);
 assert.equal((await f.act('KeyK')).status,'complete');assert.equal(f.lines.length,0);
 f.clock=f.args.cleanupUntil;assert.equal((await f.act('KeyE')).status,'rejected');const timer=[...f.timers.values()][0];await timer.fn();await tick();
 assert.equal(f.listeners.size,0);assert.equal(f.page.size,0);assert.equal(f.receipt(),null);assert.equal(f.timers.size,0);assert.equal(f.requests.filter(p=>p==='/resource-sessions/revoke').length,1);
});

test('close/pagehide while native read waits prevents the later mutation and removes DOM/listeners/timer',async t=>{
 const f=setup(t);await f.start();await f.act('KeyI');await f.act('KeyB');const wait=deferred();f.readWait=wait;f.press('KeyU');await tick();
 const pagehide=f.page.get('pagehide');pagehide();await tick();wait.resolve();await tick();assert.equal(f.updates,0);assert.equal(f.receipt(),null);assert.equal(f.listeners.size,0);assert.equal(f.page.size,0);assert.equal(f.timers.size,0);
});

test('deadline passing during native read prevents a late control mutation',async t=>{
 const f=setup(t);await f.start();await f.act('KeyI');await f.act('KeyB');const wait=deferred();f.readWait=wait;f.press('KeyU');await tick();
 f.clock=f.args.until;wait.resolve();assert.equal((await f.settle()).status,'unknown');assert.equal(f.updates,0);f.noLeaks();
});

test('same-document controller cannot reset after close; changed exact capability fails private recheck',async t=>{
 const f=setup(t);await f.start({preflightOnly:true});await assert.rejects(f.start({preflightOnly:true}));await f.act('KeyP');f.cap='gid://shopify/Cart/changed?key=changed-generated-private';
 const failed=await f.act('KeyR');assert.equal(failed.status,'unknown');assert.equal(failed.preflight.stage,'continuity');assert.equal(f.reads,4);assert.equal(f.updates,0);assert.equal(f.requests.length,0);f.noLeaks();
 await f.act('KeyE');await assert.rejects(f.start({preflightOnly:true}));
});

test('A shares the guarded dispatcher and retains finite install/publish plus repeatable observation',async t=>{
 const f=setup(t);f.webmcp();await f.start({role:'A',input:'webmcp'});const {tool}=f.tools[0];
 await assert.rejects(tool.execute({action:'hostile_copy'}));assert.equal(f.requests.length,0);
 const results=[];for(const action of ['issue','bind','install','publish','observe','observe'])results.push(JSON.parse(await tool.execute({action})));
 assert.equal(results[2].installed,true);assert.equal(JSON.stringify(results).includes('generated-private'),false);
 const before=f.requests.length;for(const action of ['issue','bind','install','publish'])await assert.rejects(tool.execute({action}));assert.equal(f.requests.length,before);
 // A real registry can synchronously abort an in-flight execute on unregister.
 const execution=new AbortController();f.tools[0].signal.addEventListener('abort',()=>execution.abort());
 await tool.execute({action:'close'},{signal:execution.signal});assert.equal(execution.signal.aborted,true);
 assert.equal(f.requests.filter(p=>p==='/resource-sessions/revoke').length,1);assert.equal(f.timers.size,0);
});

test('WebMCP caller cancellation while a read waits disposes registration without late success',async t=>{
 const f=setup(t);f.webmcp();await f.start({role:'A',input:'webmcp',preflightOnly:true});const execution=new AbortController(),wait=deferred();f.readWait=wait;
 const pending=f.tools[0].tool.execute({action:'preflight'},{signal:execution.signal});execution.abort();wait.resolve();await assert.rejects(pending,error=>{assert.equal(error.message,'DIAGNOSTIC_UNAVAILABLE');assert.equal(error.preflight.stage,'native_summary');assert.equal(error.preflight.reason,'cancelled');return true;});assert.equal(f.reads,1);
 assert.equal(f.tools[0].signal.aborted,true);assert.equal(f.page.size,0);assert.equal(f.timers.size,0);assert.equal(f.requests.length,0);assert.equal(f.updates,0);
});

test('adapter adds only inert JSON: no persistence, general input, evaluator network, visible controls or startup action',()=>{
 const source=readFileSync(new URL('../theme/checkout-diagnostic.js',import.meta.url),'utf8');
 for(const forbidden of ['localStorage','sessionStorage','document.cookie','console.','innerHTML','eval(','new Function(','navigator.clipboard','location.search','location.hash','createElement(\'button\'','createElement(\'input\''])assert.equal(source.includes(forbidden),false,forbidden);
 assert.deepEqual([...source.matchAll(/createElement\('([^']+)'\)/g)].map(m=>m[1]),['script']);
});

test('one full controller discovers an empty native cart before any control exists, then uses later exact backend verification and cleans up',async t=>{
 const f=setup(t);f.controlReady=false;f.controlPin=null;await f.start();const controller=f.controller,node=f.nodes[0],deadline=f.args.until;
 const initial=await f.act('KeyP');assert.equal(initial.status,'complete');assert.equal(initial.result.controller_memory_retained,false);assert.match(initial.result.cart_comparison_sha256,/^[a-f0-9]{64}$/);
 assert.equal(f.controlPin,null);assert.equal(f.controlReads,0);assert.equal(f.requests.length,0);assert.equal(f.updates,0);
 // Generated setup stands in for the later reviewed nine-operation control
 // lifecycle. No browser pin update, register call, reload or deadline reset.
 f.provisionControl();for(const code of ['KeyI','KeyB','KeyU'])assert.equal((await f.act(code)).status,'complete');
 assert.equal(f.lines.length,1);assert.equal(f.lines[0].quantity,1);assert.equal(f.controlReads,1);
 assert.equal((await f.act('KeyD')).status,'complete');const recheck=await f.act('KeyR');assert.equal(recheck.result.cart_comparison_sha256,initial.result.cart_comparison_sha256);assert.equal(recheck.result.controller_memory_retained,true);
 // In the joint run this is B's already-budgeted opposite-cart inspection,
 // after A's first hostile control. It proves fresh proof use after native edits.
 assert.equal((await f.act('KeyS')).status,'complete');
 for(const code of ['KeyK','KeyE'])assert.equal((await f.act(code)).status,'complete');
 assert.equal(f.controller,controller);assert.equal(f.nodes[0],node);assert.equal(f.nodes.length,1);assert.equal(f.args.until,deadline);assert.equal(f.lines.length,0);
 assert.equal(f.reads,13);assert.equal(f.updates,3);assert.equal(f.requests.length,17);assert.equal(f.requests.filter(p=>p==='/resource-sessions/issue').length,1);assert.equal(f.requests.filter(p=>p==='/resource-sessions/revoke').length,1);f.noLeaks();
});

test('unchanged backend exact pin rejects substituted fresh identities, content and a contract-only hash before native mutation',async t=>{
 for(const [name,change,pinChange] of [
  ['product',d=>d.product.id='gid://shopify/Product/9998881'],
  ['variant',d=>d.product.variants.nodes[0].id='gid://shopify/ProductVariant/9998882'],
  ['title',d=>d.product.title='changed'],['price',d=>d.product.variants.nodes[0].price='2.00'],
  ['publication',d=>d.product.publishedOnPublication=false],
  ['contract hash',()=>{},f=>{f.controlPin.sha256=f.controlContractSha256;}],
  ['missing exact pin',()=>{},f=>{f.controlPin=null;}],
 ])await t.test(name,async t=>{
  const f=setup(t);f.controlReady=false;await f.start();assert.equal((await f.act('KeyP')).status,'complete');f.provisionControl();f.controlReadbackChange=change;pinChange?.(f);
  const expectedReads=name==='missing exact pin'?0:1;
  await f.act('KeyI');await f.act('KeyB');assert.equal((await f.act('KeyU')).status,'unknown');assert.equal(f.controlReads,expectedReads);assert.equal(f.updates,0);
  assert.equal((await f.act('KeyU')).status,'rejected');assert.equal(f.controlReads,expectedReads);assert.equal((await f.act('KeyK')).status,'complete');assert.equal((await f.act('KeyE')).status,'complete');f.noLeaks();
 });
});

test('browser contract check denies tampered or extra contract fields even with a generated valid identity',async t=>{
 for(const [name,change] of [['title',v=>v.title='changed'],['quantity',v=>v.quantity=2],['extra',v=>v.extra='generated-private-contract-field']])await t.test(name,async t=>{
  const f=setup(t);f.provisionControl();f.browserControlChange=change;await f.start();await f.act('KeyI');await f.act('KeyB');
  assert.equal((await f.act('KeyU')).status,'unknown');assert.equal(f.updates,0);assert.equal((await f.act('KeyU')).status,'rejected');f.noLeaks();
 });
});

test('preflight receipt distinguishes captured methods from later global availability without late binding',async t=>{
 for(const mode of ['missing at construction','removed at entry','same captured object initialized'])await t.test(mode,async t=>{
  const f=setup(t),actions=Shopify.actions;
  if(mode==='missing at construction')Shopify.actions=undefined;
  if(mode==='same captured object initialized')Shopify.actions={};
  const captured=Shopify.actions;await f.start({preflightOnly:true});
  if(mode==='removed at entry')delete actions.updateCart;
  else if(mode==='same captured object initialized')Object.assign(captured,actions);
  else Shopify.actions=actions;
  const receipt=await f.act('KeyP');
  if(mode==='same captured object initialized'){
   assert.equal(receipt.status,'complete');assert.equal(receipt.preflight,undefined);assert.equal(f.reads,2);
   assert.deepEqual(Object.keys(receipt.result).sort(),['cart_comparison_sha256','cart_verified','checkout_ready','controller_memory_retained','empty','exact_capability_retained','line_count','native_actions_present','phase'].sort());
  }else{
   assert.equal(receipt.status,'unknown');assert.equal(receipt.result,undefined);assert.equal(receipt.preflight.stage,'native_methods');assert.equal(receipt.preflight.reason,'unavailable');
   const present={observed:true,get_cart:true,update_cart:true},absent={observed:true,get_cart:false,update_cart:false};
   assert.deepEqual(receipt.preflight.construction_methods,mode==='missing at construction'?absent:present);
   assert.deepEqual(receipt.preflight.captured_methods,mode==='missing at construction'?absent:{observed:true,get_cart:true,update_cart:false});
   assert.deepEqual(receipt.preflight.current_methods,mode==='missing at construction'?present:{observed:true,get_cart:true,update_cart:false});
   assert.equal(f.reads,0);
  }
  const reads=f.reads;assert.equal((await f.act('KeyP')).status,'rejected');assert.equal(f.reads,reads);
  assert.equal((await f.act('KeyE')).result.local_cleared,true);assert.equal(f.updates,0);assert.equal(f.requests.length,0);f.noLeaks();
 });
});

test('actual preflight failure receipts expose fixed stages only, stay unknown/spent and allow close',async t=>{
 const injected='injected-secret-error-url?key=DO-NOT-EXPORT';
 const corrupt=()=>Object.assign(Error(injected),{preflight:{stage:injected,reason:injected,cart_id:injected},stack:injected});
 const cases=[
  ['native rejection','native_read',1,f=>{Shopify.actions.getCart=async()=>{f.reads++;throw corrupt();};}],
  ['thrown arbitrary record','native_read',1,f=>{Shopify.actions.getCart=async()=>{f.reads++;throw {message:injected,stage:injected,reason:injected};};}],
  ['malformed summary','native_summary',1,f=>{Shopify.actions.getCart=async()=>{f.reads++;return {cart:{id:f.cap,totalQuantity:1,lines:[],error:injected}};};}],
  ['locator unavailable','locator_unavailable',1,()=>{delete globalThis.BFLPrintCartLocator;}],
  ['locator rejection','locator_read',1,()=>{globalThis.BFLPrintCartLocator={locate:async()=>{throw corrupt();}};}],
  ['locator malformed result','locator_read',1,()=>{globalThis.BFLPrintCartLocator={locate:async()=>null};}],
  ['locator exact mismatch','continuity',1,()=>{globalThis.BFLPrintCartLocator={locate:async()=>({cart_id:injected})};}],
  ['unsupported exact capability','capability',2,f=>{f.cap+='&extra='+injected;}],
 ];
 for(const [name,stage,reads,change] of cases)await t.test(name,async t=>{
  const f=setup(t);change(f);await f.start({preflightOnly:true});
  const receipt=await f.act('KeyP');assert.equal(receipt.status,'unknown');assert.equal(receipt.result,undefined);assert.equal(receipt.preflight.stage,stage);assert.equal(receipt.preflight.reason,'unavailable');
  assert.equal(receipt.cart_verified,false);assert.equal(receipt.checkout_ready,false);assert.equal(f.reads,reads);
  assert.deepEqual(Object.keys(receipt.preflight).sort(),['stage','reason','construction_methods','captured_methods','current_methods'].sort());
  for(const flags of [receipt.preflight.construction_methods,receipt.preflight.captured_methods,receipt.preflight.current_methods])assert.deepEqual(flags,{observed:true,get_cart:true,update_cart:true});
  assert.equal(JSON.stringify(receipt).includes(injected),false);f.noLeaks();
  const rejected=await f.act('KeyP');assert.equal(rejected.status,'rejected');assert.deepEqual(rejected.preflight,{stage:'admission',reason:'rejected'});
  assert.equal((await f.act('KeyR')).status,'rejected');assert.equal(f.reads,reads);
  const closed=await f.act('KeyE');assert.equal(closed.status,'complete');assert.equal(closed.result.local_cleared,true);assert.equal(closed.result.remote_confirmed,false);assert.equal(closed.preflight,undefined);
  assert.equal(f.updates,0);assert.equal(f.requests.length,0);await assert.rejects(f.start());
 });
});

test('expiry after both native reads reports the final boundary without authorizing or repeating work',async t=>{
 const f=setup(t),getCart=Shopify.actions.getCart;
 Shopify.actions.getCart=async()=>{const result=await getCart();if(f.reads===2)f.clock=f.args.until;return result;};
 await f.start({preflightOnly:true});const receipt=await f.act('KeyP');
 assert.equal(receipt.status,'unknown');assert.equal(receipt.preflight.stage,'final_guard');assert.equal(receipt.preflight.reason,'expired');assert.equal(receipt.result,undefined);
 assert.equal(f.reads,2);assert.equal((await f.act('KeyP')).status,'rejected');assert.equal(f.reads,2);
 assert.equal((await f.act('KeyE')).result.local_cleared,true);assert.equal(f.updates,0);assert.equal(f.requests.length,0);f.noLeaks();
});

test('E close during pending preflight owns the receipt and a cancelled late failure cannot overwrite it',async t=>{
 const f=setup(t),wait=deferred();f.readWait=wait;await f.start({preflightOnly:true});f.press('KeyP');await tick();
 assert.equal(f.receipt().status,'pending');assert.equal(f.reads,1);f.press('KeyP');assert.equal(f.receipt().sequence,1);
 const closed=await f.act('KeyE');assert.equal(closed.sequence,2);assert.equal(closed.result.local_cleared,true);
 wait.resolve();await tick();await tick();assert.deepEqual(f.receipt(),closed);assert.equal(f.reads,1);assert.equal(f.updates,0);assert.equal(f.requests.length,0);f.noLeaks();
});

test('dispatcher failure after native success uses a fixed fallback and never leaks a thrown target getter',async t=>{
 const f=setup(t);f.webmcp();await f.start({role:'A',input:'webmcp',preflightOnly:true});
 const originalDigest=crypto.subtle.digest.bind(crypto.subtle),injected='secret-target-getter';
 t.mock.method(crypto.subtle,'digest',async(...args)=>{const result=await originalDigest(...args);Object.defineProperty(Shopify.theme,'id',{configurable:true,get(){throw Error(injected);}});return result;});
 await assert.rejects(f.tools[0].tool.execute({action:'preflight'}),error=>{
  assert.equal(error.message,'DIAGNOSTIC_UNAVAILABLE');assert.deepEqual(error.preflight,{stage:'dispatch',reason:'unavailable'});assert.equal(JSON.stringify(error).includes(injected),false);return true;
 });
 Object.defineProperty(Shopify.theme,'id',{configurable:true,value:189196533871});
 await assert.rejects(f.tools[0].tool.execute({action:'preflight_recheck'}));assert.equal(f.reads,2);
 assert.equal(JSON.parse(await f.tools[0].tool.execute({action:'close'})).local_cleared,true);assert.equal(f.updates,0);assert.equal(f.requests.length,0);
});

test('keyboard never exports a forged preflight field from an error outside the dispatcher catch',async t=>{
 const f=setup(t);await f.start({preflightOnly:true});const secret='injected-outside-catch-secret';
 Object.defineProperty(Shopify.theme,'id',{configurable:true,get(){throw Object.assign(Error(secret),{preflight:{stage:secret,reason:secret,cart_id:f.cap}});}});
 const receipt=await f.act('KeyP');assert.equal(receipt.status,'unknown');assert.deepEqual(receipt.preflight,{stage:'admission',reason:'unavailable'});assert.equal(JSON.stringify(receipt).includes(secret),false);f.noLeaks();
 Object.defineProperty(Shopify.theme,'id',{configurable:true,value:189196533871});
 assert.equal((await f.act('KeyE')).result.local_cleared,true);assert.equal(f.reads,0);assert.equal(f.updates,0);assert.equal(f.requests.length,0);
});


test('safe fallback survives missing, throwing and malformed native observers without exporting secrets',async t=>{
 const secret='injected-observer-secret';
 for(const [name,observer] of [
  ['missing','missing'],
  ['throws',`preflightFailure(){throw Error('${secret}');}`],
  ['observer getter',`get preflightFailure(){throw Error('${secret}');}`],
  ['bad enum',`preflightFailure(){return {stage:'${secret}',reason:'unavailable'};}`],
  ['record getter',`preflightFailure(){return {get stage(){throw Error('${secret}');}};}`],
  ['flag getter',`preflightFailure(){return {stage:'native_read',reason:'unavailable',construction_methods:{observed:true,get get_cart(){throw Error('${secret}');},update_cart:true}};}`],
  ['extra fields',`preflightFailure(){return {stage:'native_read',reason:'unavailable',cart_id:'${secret}'};}`],
 ])await t.test(name,async t=>{
  const graph=await moduleGraph(t,{observer}),module=await import(graph.url),f=setup(t,module.registerCheckoutDiagnostic);
  Shopify.actions.getCart=async()=>{f.reads++;throw Object.assign(Error(secret),{preflight:{stage:secret}});};
  await f.start({preflightOnly:true});const receipt=await f.act('KeyP');assert.equal(receipt.status,'unknown');
  assert.deepEqual(receipt.preflight,{stage:'observer',reason:'unavailable'});assert.equal(JSON.stringify(receipt).includes(secret),false);f.noLeaks();
  assert.equal(f.reads,1);assert.equal((await f.act('KeyP')).status,'rejected');assert.equal((await f.act('KeyR')).status,'rejected');assert.equal(f.reads,1);
  assert.equal((await f.act('KeyE')).result.local_cleared,true);assert.equal(f.updates,0);assert.equal(f.requests.length,0);
 });
});

test('early preflight denials and thrown guards have fixed detail without consuming an unstarted action',async t=>{
 for(const mode of ['target denied','target throws','expired'])await t.test(mode,async t=>{
  const f=setup(t);await f.start({preflightOnly:true});
  if(mode==='target denied')Shopify.theme.id=1;
  if(mode==='target throws')Object.defineProperty(Shopify.theme,'id',{configurable:true,get(){throw Object.assign(Error('secret-early-guard'),{preflight:{stage:'secret-early-guard'}});}});
  if(mode==='expired')f.clock=f.args.until;
  const receipt=await f.act('KeyP');assert.equal(receipt.status,mode==='target throws'?'unknown':'rejected');
  assert.deepEqual(receipt.preflight,{stage:'admission',reason:mode==='target throws'?'unavailable':'rejected'});
  assert.equal(JSON.stringify(receipt).includes('secret-early-guard'),false);assert.equal(f.reads,0);assert.equal(f.updates,0);assert.equal(f.requests.length,0);
  Object.defineProperty(Shopify.theme,'id',{configurable:true,value:189196533871});
  if(mode!=='expired'){assert.equal((await f.act('KeyP')).status,'complete');assert.equal(f.reads,2);}
  assert.equal((await f.act('KeyE')).result.local_cleared,true);f.noLeaks();
 });
});

test('preflight setup and finally exceptions cannot bypass sanitization or reset spent actions',async t=>{
 for(const mode of ['setup','finally'])await t.test(mode,async t=>{
  const f=setup(t);f.webmcp();await f.start({role:'A',input:'webmcp',preflightOnly:true});const {tool}=f.tools[0];
  const secret='injected-signal-secret',signal={aborted:false,addEventListener(){if(mode==='setup')throw Error(secret);},removeEventListener(){if(mode==='finally')throw Object.assign(Error(secret),{preflight:{stage:secret}});}};
  await assert.rejects(tool.execute({action:'preflight'},{signal}),error=>{assert.equal(error.message,'DIAGNOSTIC_UNAVAILABLE');assert.deepEqual(error.preflight,{stage:'dispatch',reason:'unavailable'});assert.equal(JSON.stringify(error).includes(secret),false);return true;});
  const reads=f.reads;assert.equal(reads,mode==='setup'?0:2);await assert.rejects(tool.execute({action:'preflight'}));assert.equal(f.reads,reads);
  assert.equal(JSON.parse(await tool.execute({action:'close'})).local_cleared,true);assert.equal(f.updates,0);assert.equal(f.requests.length,0);
 });
});

const roleASequence=[['KeyP','preflight'],['KeyI','issue'],['KeyB','bind'],['KeyU','control_add'],['KeyD','control_remove'],['KeyR','preflight_recheck'],['KeyM','install'],['KeyS','inspect'],['KeyW','hostile_overwrite'],['KeyL','hostile_delete'],['KeyF','resources'],['KeyJ','add_job'],['KeyG','publish'],['KeyO','observe'],['KeyO','observe'],['KeyQ','quantity_changed'],['KeyT','quantity_restored'],['KeyN','remove_job'],['KeyY','readd_job'],['KeyA','duplicate_add'],['KeyZ','duplicate_remove'],['KeyK','cleanup'],['KeyE','close']];
test('explicit A keyboard runs its bounded original sequence through the real dispatcher and never B hostile-copy',async t=>{
 const f=setup(t);await f.start({role:'A'});
 assert.equal(f.nodes[0].id,'bfl-f06p-role-a-result');assert.equal(f.tools.length,0);
 assert.deepEqual(f.receipt(),{run:'f06p-integrated-v1',role:'A',input:'keyboard',implementation:{diagnostic:'f06p-diagnostic-v4',native:'f06p-native-preflight-v3'},sequence:0,action:null,status:'ready',cart_verified:false,checkout_ready:false});
 assert.equal(f.press('KeyV'),false);assert.equal(f.press('constructor'),false);assert.equal(f.requests.length,0);
 for(const [code,action] of roleASequence){const receipt=await f.act(code);assert.equal(receipt.action,action);assert.equal(receipt.status,'complete',action);assert.equal(receipt.role,'A');f.noLeaks();}
 assert.equal(f.lines.length,0);assert.equal(f.updates,10);assert.equal(f.requests.filter(x=>x==='/api/2026-07/graphql.json').length,2);
 assert.equal(f.listeners.size,0);await assert.rejects(f.start({role:'A'}));await assert.rejects(f.start({role:'B'}));
});

test('A recalculate verifies the unchanged job quantity and exact price within the existing mutation budget',async t=>{
 const f=setup(t);await f.start({role:'A'});
 for(const [code,action] of [['KeyP','preflight'],['KeyI','issue'],['KeyB','bind'],['KeyF','resources'],['KeyJ','add_job'],['KeyG','publish']]){
  const receipt=await f.act(code);assert.equal(receipt.action,action);assert.equal(receipt.status,'complete');
 }
 const receipt=await f.act('KeyH');assert.equal(receipt.action,'recalculate');assert.equal(receipt.status,'complete');
 assert.equal(receipt.result.recalculated,true);assert.equal(receipt.result.total_quantity,4);assert.equal(receipt.result.total_amount,'4.80');assert.equal(receipt.result.currency,'USD');
 assert.equal(f.updates,2);assert.equal((await f.act('KeyH')).status,'rejected');assert.equal(f.updates,2);
 assert.equal((await f.act('KeyK')).status,'complete');assert.equal((await f.act('KeyE')).status,'complete');assert.equal(f.lines.length,0);f.noLeaks();
});

test('A mapping is unique and equals its existing WebMCP allowlist; B cannot invoke A-only keys',async t=>{
 const f=setup(t);f.webmcp();await f.start({role:'A',input:undefined});const allowed=f.tools[0].tool.inputSchema.properties.action.enum;
 const mapping=[...roleASequence,['KeyH','recalculate']].filter(([code],i,all)=>all.findIndex(x=>x[0]===code)===i);
 assert.equal(mapping.length,23);assert.equal(new Set(mapping.map(x=>x[1])).size,23);assert.deepEqual([...allowed].sort(),mapping.map(x=>x[1]).sort());
 await assert.rejects(f.tools[0].tool.execute({action:'hostile_copy'}));assert.equal(f.requests.length,0);
});

for(const role of ['A','B']){
 test(`${role} keyboard rejects every untrusted input variant before consuming a sequence`,async t=>{
  const f=setup(t);await f.start({role,preflightOnly:true});
  for(const extra of [{isTrusted:false},{repeat:true},{isComposing:true},{defaultPrevented:true},{ctrlKey:false},{altKey:false},{shiftKey:false},{metaKey:true},...['INPUT','TEXTAREA','SELECT'].map(tagName=>({composedPath:()=>[{tagName}]})),{composedPath:()=>[{tagName:'SPAN',isContentEditable:true}]}])for(const key of ['KeyP','KeyI','KeyE'])assert.equal(f.press(key,extra),false);
  assert.equal(f.receipt().sequence,0);assert.equal(f.reads,0);assert.equal(f.requests.length,0);
  const keys=role==='A'?roleASequence.map(x=>x[0]):['KeyI','KeyB','KeyU','KeyD','KeyS','KeyJ','KeyH','KeyK'];
  for(const key of new Set(keys.filter(x=>!['KeyP','KeyR','KeyE'].includes(x))))assert.equal((await f.act(key)).status,'rejected');
  assert.equal(f.reads,0);assert.equal(f.requests.length,0);assert.equal((await f.act('KeyP')).status,'complete');f.noLeaks();
 });
 test(`${role} busy input cannot queue and close owns the terminal receipt over a late native result`,async t=>{
  const f=setup(t),wait=deferred();f.readWait=wait;await f.start({role,preflightOnly:true});f.press('KeyP');await tick();const pending=f.receipt();
  for(const key of ['KeyP','KeyI','KeyB'])f.press(key);assert.deepEqual(f.receipt(),pending);assert.equal(f.reads,1);
  const close=await f.act('KeyE');assert.equal(close.status,'complete');wait.resolve();await tick();await tick();assert.deepEqual(f.receipt(),close);assert.equal(f.reads,1);assert.equal(f.requests.length,0);await assert.rejects(f.start({role}));f.noLeaks();
 });
 test(`${role} expiry and unknown failure keep actions spent without leaking transport data`,async t=>{
  const f=setup(t);await f.start({role});await f.act('KeyI');f.failPath='/diagnostic/checkout/bind';assert.equal((await f.act('KeyB')).status,'unknown');const count=f.requests.length;
  for(const key of ['KeyB','KeyI','KeyP','KeyS'])assert.equal((await f.act(key)).status,'rejected');assert.equal(f.requests.length,count);
  f.clock=f.args.until;assert.equal((await f.act('KeyU')).status,'rejected');f.failPath=null;assert.equal((await f.act('KeyE')).result.remote_confirmed,true);f.noLeaks();
 });
}

test('A-only keyboard keys are inert for B without replacing its receipt or executing work',async t=>{
 const f=setup(t);await f.start();const before=f.receipt();for(const code of ['KeyM','KeyG','KeyO','KeyF','KeyQ','KeyT','KeyN','KeyY','KeyA','KeyZ','KeyW','KeyL'])assert.equal(f.press(code),false);
 assert.deepEqual(f.receipt(),before);assert.equal(f.reads,0);assert.equal(f.requests.length,0);
});

test('A close during pending issuance discards the late credential and never revives a ready receipt',async t=>{
 const f=setup(t),wait=deferred();f.fetchWait={path:'/resource-sessions/issue',...wait};await f.start({role:'A'});f.press('KeyI');await tick();assert.equal(f.receipt().status,'pending');
 const close=await f.act('KeyE');assert.equal(close.result.remote_confirmed,false);wait.resolve();await tick();await tick();assert.deepEqual(f.receipt(),close);assert.equal(f.requests.filter(x=>x==='/resource-sessions/revoke').length,1);assert.equal(f.listeners.size,0);f.noLeaks();
});

test('A clean expiry and target changes deny new actions; close still respects the separate cleanup deadline',async t=>{
 const f=setup(t);await f.start({role:'A'});Shopify.theme.role='main';assert.equal((await f.act('KeyI')).status,'rejected');assert.equal(f.requests.length,0);Shopify.theme.role='unpublished';
 f.clock=f.args.until;for(const key of ['KeyI','KeyM','KeyG','KeyF','KeyP'])assert.equal((await f.act(key)).status,'rejected');assert.equal(f.requests.length,0);assert.equal(f.reads,0);
 f.clock=f.args.cleanupUntil;assert.equal((await f.act('KeyE')).status,'rejected');await [...f.timers.values()][0].fn();await tick();assert.equal(f.receipt(),null);assert.equal(f.listeners.size,0);await assert.rejects(f.start({role:'A'}));
});

test('remapped A G publishes and N removes exactly once; C/X/V never dispatch',async t=>{
 const f=setup(t);await f.start({role:'A'});
 for(const key of ['KeyC','KeyX','KeyV'])assert.equal(f.press(key),false);
 assert.equal(f.receipt().sequence,0);assert.equal(f.requests.length,0);assert.equal(f.reads,0);
 for(const key of ['KeyP','KeyI','KeyB','KeyM','KeyF','KeyJ'])assert.equal((await f.act(key)).status,'complete');
 const published=await f.act('KeyG');assert.equal(published.action,'publish');assert.equal(published.status,'complete');
 const removed=await f.act('KeyN');assert.equal(removed.action,'remove_job');assert.equal(removed.status,'complete');assert.equal(f.lines.length,0);
 const counts=[f.requests.length,f.reads,f.updates],receipt=f.receipt();
 for(const key of ['KeyC','KeyX','KeyV'])assert.equal(f.press(key),false);
 assert.deepEqual(f.receipt(),receipt);
 assert.equal((await f.act('KeyG')).status,'rejected');assert.equal((await f.act('KeyN')).status,'rejected');
 assert.deepEqual([f.requests.length,f.reads,f.updates],counts);f.noLeaks();
});

test('remapped N/G retain trusted-input, preflight, target and expiry guards; B stays inert',async t=>{
 for(const mode of ['untrusted','preflight','target','expiry','B'])await t.test(mode,async t=>{
  const f=setup(t);await f.start({role:mode==='B'?'B':'A',preflightOnly:mode==='preflight'});
  if(mode==='untrusted'){
   for(const extra of [{isTrusted:false},{repeat:true},{isComposing:true},{defaultPrevented:true},{ctrlKey:false},{altKey:false},{shiftKey:false},{metaKey:true},{composedPath:()=>[{tagName:'INPUT'}]},{composedPath:()=>[{tagName:'SPAN',isContentEditable:true}]}])
    for(const key of ['KeyN','KeyG'])assert.equal(f.press(key,extra),false);
   assert.equal(f.receipt().sequence,0);
  }else if(mode==='B'){
   for(const key of ['KeyN','KeyG','KeyC','KeyX','KeyV'])assert.equal(f.press(key),false);
   assert.equal(f.receipt().sequence,0);
  }else{
   if(mode==='target')Shopify.theme.role='main';if(mode==='expiry')f.clock=f.args.until;
   for(const key of ['KeyN','KeyG'])assert.equal((await f.act(key)).status,'rejected');
  }
  assert.equal(f.requests.length,0);assert.equal(f.reads,0);assert.equal(f.updates,0);f.noLeaks();
 });
});

test('remapped pending G cannot queue N and close discards the late publication response',async t=>{
 const f=setup(t),wait=deferred();await f.start({role:'A'});await f.act('KeyI');
 f.fetchWait={path:'/diagnostic/checkout/publish',...wait};f.press('KeyG');await tick();
 assert.equal(f.receipt().status,'pending');const pending=f.receipt();
 f.press('KeyN');f.press('KeyG');assert.deepEqual(f.receipt(),pending);assert.equal(f.updates,0);
 const closed=await f.act('KeyE');assert.equal(closed.status,'complete');wait.resolve();await tick();await tick();
 assert.deepEqual(f.receipt(),closed);assert.equal(f.requests.filter(x=>x==='/diagnostic/checkout/publish').length,1);
 assert.equal(f.updates,0);assert.equal(f.listeners.size,0);f.noLeaks();
});
