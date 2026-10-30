import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {setImmediate as tick} from 'node:timers/promises';
import {registerCheckoutDiagnostic} from '../theme/checkout-diagnostic.js';
import {moduleGraph} from './diagnostic-module-fixture.mjs';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const proposal=readFileSync(new URL('../../../fixtures/film-printing/f06p-final-execution-packet/bootstrap.proposal.liquid',import.meta.url),'utf8');
const body=proposal.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
const asset="{{ 'checkout-diagnostic.js' | asset_url | json }}";
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const moduleUrl=new URL('../theme/checkout-diagnostic.js',import.meta.url).href;
const pinnedHelperHash=proposal.match(/Helper SHA256: ([a-f0-9]{64})/)[1];
const bootstrapModuleUrl=new URL(moduleUrl);bootstrapModuleUrl.searchParams.set('bfl_sha256',pinnedHelperHash);
const secret='generated-private-registration-error';
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};

// Execute the actual proposal body. Only Liquid's asset URL and the reviewed
// disabled enable/deadline constants are rendered, just as a later pinned install
// would do. Dynamic import loads the actual helper and its real dependencies.
function setup(t){
 const names=['document','location','Shopify','fetch','addEventListener','removeEventListener','setTimeout','clearTimeout'];
 const original=Object.fromEntries(names.map(k=>[k,globalThis[k]])),now=Date.now;
 const f={clock:100000,nodes:[],page:new Map(),keys:new Map(),timers:new Map(),tools:[],calls:0,native:0,network:0,serial:0};
 const add=(map,kind,fn)=>{if(!map.has(kind))map.set(kind,new Set());map.get(kind).add(fn);};
 const remove=(map,kind,fn)=>map.get(kind)?.delete(fn);
 Date.now=()=>f.clock;
 globalThis.setTimeout=(fn,ms)=>{const id=++f.serial;f.timers.set(id,{fn,ms});return id;};
 globalThis.clearTimeout=id=>f.timers.delete(id);
 globalThis.addEventListener=(kind,fn)=>add(f.page,kind,fn);
 globalThis.removeEventListener=(kind,fn)=>remove(f.page,kind,fn);
 globalThis.location={origin:'https://bellows-film-printing-staging.myshopify.com',search:'?bfl_f06p_run=f06p-integrated-v1&bfl_f06p_role=A'};
 globalThis.Shopify={theme:{id:189196533871,role:'unpublished'},actions:{getCart(){f.native++;throw Error(secret);},updateCart(){f.native++;throw Error(secret);}}};
 globalThis.fetch=async()=>{f.network++;throw Error(secret);};
 globalThis.document={head:{append:n=>{n.isConnected=true;f.nodes.push(n);}},getElementById:id=>f.nodes.find(n=>n.isConnected&&n.id===id),
  createElement:tag=>({tagName:tag.toUpperCase(),textContent:'',isConnected:false,remove(){this.isConnected=false;}}),
  addEventListener:(kind,fn)=>add(f.keys,kind,fn),removeEventListener:(kind,fn)=>remove(f.keys,kind,fn),
  modelContext:{registerTool:async(tool,{signal})=>{f.calls++;f.tools.push({tool,signal});if(f.registration)await f.registration.promise;}},
 };
 f.status=()=>{const n=document.getElementById('bfl-f06p-registration');return n?JSON.parse(n.textContent):null;};
 f.receipt=()=>{const n=document.getElementById('bfl-f06p-role-b-result');return n?JSON.parse(n.textContent):null;};
 f.run=({enabled=true,until=160000,url=moduleUrl,roleAKeyboard=false,preflightOnly=false}={})=>{
  let source=body.replace(asset,JSON.stringify(url));
  if(enabled)source=source.replace('const ENABLED = false, UNTIL = 0,',`const ENABLED = true, UNTIL = ${until},`);
  if(roleAKeyboard)source=source.replace('ROLE_A_KEYBOARD = false','ROLE_A_KEYBOARD = true');
  if(preflightOnly)source=source.replace('PREFLIGHT_ONLY = false','PREFLIGHT_ONLY = true');
  return new AsyncFunction(source)();
 };
 f.hide=()=>{for(const fn of [...(f.page.get('pagehide')||[])])fn();};
 f.deadline=()=>{f.clock=790000;for(const [id,{fn}] of [...f.timers]){f.timers.delete(id);fn();}};
 f.noWork=()=>{assert.equal(f.native,0);assert.equal(f.network,0);};
 f.noLeaks=()=>{for(const n of f.nodes){assert.equal(n.textContent.includes(secret),false);assert.equal(n.textContent.includes(location.search),false);}};
 t.after(async()=>{f.hide();await tick();for(const k of names){if(original[k]===undefined)delete globalThis[k];else globalThis[k]=original[k];}Date.now=now;});
 return f;
}

test('actual bootstrap explicitly selects A, pending until real registration completes, and freezes selection',async t=>{
 const f=setup(t);f.registration=deferred();const work=f.run();await tick();
 assert.equal(f.calls,1);assert.equal(f.status().status,'pending');assert.equal(f.receipt(),null);assert.equal(f.keys.size,0);
 location.search='?bfl_f06p_run=f06p-integrated-v1&bfl_f06p_role=B';
 f.registration.resolve();await work;
 assert.deepEqual(f.status(),{run:'f06p-integrated-v1',role:'A',input:'webmcp',status:'ready',reason:null,implementation:{diagnostic:'f06p-diagnostic-v4',native:'f06p-native-preflight-v3'},cart_verified:false,checkout_ready:false});
 await f.run();assert.equal(f.calls,1);assert.equal(f.receipt(),null);f.noWork();
 await f.tools[0].tool.execute({action:'close'});assert.equal(f.status().status,'closed');assert.equal(f.tools[0].signal.aborted,true);
 await f.run();assert.equal(f.calls,1);f.noWork();
});

test('actual B bootstrap ignores present but unusable WebMCP and installs only the existing keyboard controller',async t=>{
 const f=setup(t);location.search='?bfl_f06p_run=f06p-integrated-v1&bfl_f06p_role=B';
 document.modelContext.registerTool=()=>{f.calls++;throw Error(secret);};await f.run();
 assert.equal(f.calls,0);assert.equal(f.status().role,'B');assert.equal(f.status().input,'keyboard');assert.equal(f.status().status,'ready');
 assert.deepEqual(f.receipt(),{run:'f06p-integrated-v1',role:'B',input:'keyboard',implementation:{diagnostic:'f06p-diagnostic-v4',native:'f06p-native-preflight-v3'},sequence:0,action:null,status:'ready',cart_verified:false,checkout_ready:false});
 assert.equal(f.keys.get('keydown').size,1);await f.run();assert.equal(f.keys.get('keydown').size,1);f.noWork();
 const key=[...f.keys.get('keydown')][0];
 for(const code of ['KeyC','KeyX','KeyV'])key({isTrusted:true,repeat:false,isComposing:false,defaultPrevented:false,ctrlKey:true,altKey:true,shiftKey:true,metaKey:false,code,composedPath:()=>[{tagName:'BODY'}],preventDefault(){assert.fail('unmapped shortcut consumed');}});
 await tick();assert.equal(f.status().status,'ready');assert.equal(f.receipt().sequence,0);f.noWork();
 key({isTrusted:true,repeat:false,isComposing:false,defaultPrevented:false,ctrlKey:true,altKey:true,shiftKey:true,metaKey:false,code:'KeyE',composedPath:()=>[{tagName:'BODY'}],preventDefault(){}});
 await tick();assert.equal(f.status().status,'closed');assert.equal(f.receipt().action,'close');assert.equal(f.receipt().status,'complete');
 assert.equal(f.keys.get('keydown').size,0);await f.run();assert.equal(f.calls,0);assert.equal(f.keys.get('keydown').size,0);f.noWork();f.noLeaks();
});

test('missing, invalid and duplicate selectors fail closed without importing or registering',async t=>{
 for(const search of ['', '?bfl_f06p_role=A','?bfl_f06p_run=f06p-integrated-v1','?bfl_f06p_run=other&bfl_f06p_role=A',
  '?bfl_f06p_run=f06p-integrated-v1&bfl_f06p_role=C','?bfl_f06p_run=f06p-integrated-v1&bfl_f06p_role=A&bfl_f06p_role=A',
  '?bfl_f06p_run=f06p-integrated-v1&bfl_f06p_role=A&bfl_f06p_role=B','?bfl_f06p_run=f06p-integrated-v1&bfl_f06p_run=f06p-integrated-v1&bfl_f06p_role=A']){
  await t.test(search||'missing',async t=>{const f=setup(t);location.search=search;await f.run({url:'data:text/javascript,throw new Error("must not import")'});
   assert.deepEqual(f.status(),{run:'f06p-integrated-v1',role:null,input:null,status:'failed',reason:'invalid_selection',implementation:null,cart_verified:false,checkout_ready:false});
   location.search='?bfl_f06p_run=f06p-integrated-v1&bfl_f06p_role=A';await f.run();assert.equal(f.status().reason,'invalid_selection');assert.equal(f.calls,0);f.noWork();f.noLeaks();
  });
 }
});

test('role markers cannot enable disabled, foreign, published, expired or overlong bootstrap',async t=>{
 for(const mode of ['disabled','origin','draft','published','expired','long'])await t.test(mode,async t=>{
  const f=setup(t);location.search+='&ENABLED=true&UNTIL=9999999999999&controlContractSha256=wrong';
  if(mode==='origin')location.origin='https://other.test';if(mode==='draft')Shopify.theme.id=1;if(mode==='published')Shopify.theme.role='main';
  await f.run({enabled:mode!=='disabled',until:mode==='expired'?100000:mode==='long'?1300001:160000});
  assert.equal(f.status(),null);assert.equal(f.calls,0);assert.equal(f.timers.size,0);f.noWork();
 });
});

test('module load/init and actual registration rejection expose only fixed failure reasons and cannot retry',async t=>{
 for(const mode of ['load','init','register','missing-api'])await t.test(mode,async t=>{
  const f=setup(t);let url=moduleUrl;
  if(mode==='load')url=new URL('./nonexistent-diagnostic-module.mjs',import.meta.url).href;
  if(mode==='init')url='data:text/javascript,throw new Error('+JSON.stringify(secret)+')';
  if(mode==='register')document.modelContext.registerTool=async(tool,{signal})=>{f.calls++;f.tools.push({tool,signal});throw Error(secret);};
  if(mode==='missing-api')delete document.modelContext;
  await f.run({url});assert.equal(f.status().status,'failed');assert.equal(f.status().reason,['load','init'].includes(mode)?'module_unavailable':'registration_failed');
  assert.equal(f.receipt(),null);assert.equal(f.keys.size,0);const calls=f.calls;await f.run();assert.equal(f.calls,calls);f.noWork();f.noLeaks();
  if(mode==='register')assert.equal(f.tools[0].signal.aborted,true);
  f.deadline();await tick();assert.equal(f.status().status,'closed');await f.run();assert.equal(f.calls,calls);
 });
});

test('pagehide and hard deadline invalidate pending registration and deny late readiness or a second controller',async t=>{
 for(const mode of ['pagehide','deadline'])await t.test(mode,async t=>{
  const f=setup(t);f.registration=deferred();const work=f.run();await tick();assert.equal(f.calls,1);assert.equal(f.status().status,'pending');
  if(mode==='pagehide')f.hide();else f.deadline();assert.equal(f.status().status,'closed');assert.equal(f.tools[0].signal.aborted,true);
  f.registration.resolve();await work;assert.equal(f.status().status,'closed');await f.run();assert.equal(f.calls,1);
  // Query parameters identify an ESM instance; check the controller actually loaded by the bootstrap.
  const loaded=await import(bootstrapModuleUrl.href);
  await assert.rejects(loaded.registerCheckoutDiagnostic({until:160000,cleanupUntil:790000,runId:'f06p-integrated-v1',preflightOnly:true}));f.noWork();f.noLeaks();
 });
});

test('registration resolving after admission expiry fails without ready, and ready B invalidates on pagehide/deadline',async t=>{
 await t.test('late A',async t=>{const f=setup(t);f.registration=deferred();const work=f.run();await tick();f.clock=160000;f.registration.resolve();await work;
  assert.equal(f.status().status,'failed');assert.equal(f.status().reason,'registration_failed');assert.equal(f.tools[0].signal.aborted,true);f.noWork();});
 for(const mode of ['pagehide','deadline'])await t.test(mode,async t=>{const f=setup(t);location.search='?bfl_f06p_run=f06p-integrated-v1&bfl_f06p_role=B';await f.run();
  if(mode==='pagehide')f.hide();else f.deadline();await tick();assert.equal(f.status().status,'closed');assert.equal(f.receipt(),null);assert.equal(f.keys.get('keydown').size,0);await f.run();assert.equal(f.keys.get('keydown').size,0);f.noWork();});
});

test('cancellation of an in-flight native action invalidates readiness and cannot be revived by its late result',async t=>{
 const f=setup(t);await f.run();const read=deferred(),signal=new AbortController();
 Shopify.actions.getCart=async()=>{f.native++;return read.promise;};
 const work=f.tools[0].tool.execute({action:'preflight'},{signal:signal.signal});
 const rejection=assert.rejects(work,/DIAGNOSTIC_UNAVAILABLE/);await tick();assert.equal(f.native,1);
 signal.abort();assert.equal(f.status().status,'closed');assert.equal(f.tools[0].signal.aborted,true);
 read.resolve({cart:{id:'gid://shopify/Cart/generated-bootstrap?key=generated-private-key',totalQuantity:0,lines:{nodes:[]}},userErrors:[],warnings:[]});
 await rejection;assert.equal(f.status().status,'closed');await f.run();assert.equal(f.calls,1);assert.equal(f.network,0);f.noLeaks();
});

test('valid role markers cannot override fixed run, transport, deadline, contract or action schema',async t=>{
 const f=setup(t);location.search+='&runId=other&input=keyboard&until=9999999999999&cleanupUntil=9999999999999&controlContractSha256=bad&action=issue';
 await f.run();assert.equal(f.status().run,'f06p-integrated-v1');assert.equal(f.status().input,'webmcp');assert.equal(f.status().status,'ready');
 assert.equal(f.receipt(),null);assert.ok([...f.timers.values()].every(t=>t.ms===690000));
 assert.deepEqual(Object.keys(f.tools[0].tool.inputSchema.properties),['action']);assert.equal(f.tools[0].tool.inputSchema.additionalProperties,false);f.noWork();
});


test('rendered bootstrap rejects old or mixed revisions before registration and native/network work',async t=>{
 const native=readFileSync(new URL('../theme/checkout-native-cases.js',import.meta.url),'utf8');
 const diagnostic=readFileSync(new URL('../theme/checkout-diagnostic.js',import.meta.url),'utf8');
 const oldNative=readFileSync(new URL('../../../fixtures/film-printing/f06p-module-consistency/before/checkout-native-cases.js',import.meta.url),'utf8');
 const oldDiagnostic=readFileSync(new URL('../../../fixtures/film-printing/f06p-module-consistency/before/checkout-diagnostic.js',import.meta.url),'utf8');
 for(const [name,changes,reason] of [
  ['native revision mismatch',{nativeSource:native.replace("'f06p-native-preflight-v3'","'injected-secret-revision'")},'implementation_mismatch'],
  ['diagnostic revision mismatch',{diagnosticSource:diagnostic.replace("'f06p-diagnostic-v4'","'injected-secret-revision'")},'implementation_mismatch'],
  ['old native missing revision',{nativeSource:oldNative},'module_unavailable'],
  ['old root missing revision',{diagnosticSource:oldDiagnostic},'implementation_mismatch'],
  ['v3 root before A input',{diagnosticSource:readFileSync(new URL('../../../fixtures/film-printing/f06p-role-a-keyboard/before/checkout-diagnostic.js',import.meta.url),'utf8')},'implementation_mismatch'],
 ])await t.test(name,async t=>{
  const graph=await moduleGraph(t,changes),f=setup(t);await f.run({url:graph.url});
  assert.equal(f.status().status,'failed');assert.equal(f.status().reason,reason);assert.equal(f.status().implementation,null);
  assert.equal(f.calls,0);assert.equal(f.receipt(),null);f.noWork();f.noLeaks();assert.equal(JSON.stringify(f.status()).includes('injected-secret-revision'),false);
  await f.run();assert.equal(f.status().status,'failed');assert.equal(f.calls,0);f.noWork();
 });
});

test('versioned dependency resolves current native despite an already cached unversioned old module',async t=>{
 const graph=await moduleGraph(t),f=setup(t);
 const oldNative=readFileSync(new URL('../../../fixtures/film-printing/f06p-module-consistency/before/checkout-native-cases.js',import.meta.url),'utf8');
 const currentNative=readFileSync(new URL('../theme/checkout-native-cases.js',import.meta.url),'utf8');
 const file=join(graph.dir,'checkout-native-cases.js');await writeFile(file,oldNative);
 const old=await import(pathToFileURL(file).href);assert.equal(old.NATIVE_REVISION,undefined);
 await writeFile(file,currentNative);assert.equal((await import(pathToFileURL(file).href)).NATIVE_REVISION,undefined);
 // The real root's fixed hash query must select a distinct module instance.
 await f.run({url:graph.url});assert.equal(f.status().status,'ready');
 assert.deepEqual(f.status().implementation,{diagnostic:'f06p-diagnostic-v4',native:'f06p-native-preflight-v3'});
 location.hostname='bellows-film-printing-staging.myshopify.com';
 Shopify.actions.getCart=async()=>{f.native++;return {cart:{id:'gid://shopify/Cart/generated-module-test?key=generated-private-key',totalQuantity:0,lines:{nodes:[]}}};};
 const result=JSON.parse(await f.tools[0].tool.execute({action:'preflight'}));assert.equal(result.empty,true);assert.equal(result.exact_capability_retained,true);assert.equal(result.cart_verified,false);assert.equal(result.checkout_ready,false);assert.equal(f.native,2);assert.equal(f.network,0);
 await assert.rejects(f.tools[0].tool.execute({action:'preflight'}));assert.equal(f.native,2);
 assert.equal(JSON.parse(await f.tools[0].tool.execute({action:'close'})).local_cleared,true);assert.equal(f.status().status,'closed');f.noLeaks();
});

test('direct registration independently denies a mixed native revision before native or API work',async t=>{
 const native=readFileSync(new URL('../theme/checkout-native-cases.js',import.meta.url),'utf8');
 const graph=await moduleGraph(t,{nativeSource:native.replace("'f06p-native-preflight-v3'","'old-native'")}),module=await import(graph.url),f=setup(t);
 await assert.rejects(module.registerCheckoutDiagnostic({until:160000,cleanupUntil:790000,runId:'f06p-integrated-v1',preflightOnly:true}),/DIAGNOSTIC_UNAVAILABLE/);
 assert.equal(f.calls,0);assert.equal(f.nodes.length,0);f.noWork();
});

test('A keyboard requires explicit reviewed source configuration, with its own fixed inert receipt',async t=>{
 const f=setup(t);delete document.modelContext;location.search+='&ROLE_A_KEYBOARD=true&input=keyboard';
 await f.run({roleAKeyboard:true,preflightOnly:true});assert.equal(f.status().status,'ready');assert.equal(f.status().input,'keyboard');assert.equal(f.calls,0);
 const receipt=JSON.parse(document.getElementById('bfl-f06p-role-a-result').textContent);assert.equal(receipt.role,'A');assert.equal(receipt.input,'keyboard');assert.equal(receipt.implementation.diagnostic,'f06p-diagnostic-v4');assert.equal(f.receipt(),null);
 const key=[...f.keys.get('keydown')][0];key({isTrusted:true,repeat:false,isComposing:false,defaultPrevented:false,ctrlKey:true,altKey:true,shiftKey:true,metaKey:false,code:'KeyI',composedPath:()=>[{tagName:'BODY'}],preventDefault(){}});await tick();
 assert.equal(JSON.parse(document.getElementById('bfl-f06p-role-a-result').textContent).status,'rejected');f.noWork();
 f.hide();await tick();assert.equal(f.status().status,'closed');assert.equal(document.getElementById('bfl-f06p-role-a-result'),undefined);await f.run({roleAKeyboard:true});assert.equal(f.keys.get('keydown').size,0);
});

test('unreviewed A keyboard URL flags cannot override the default WebMCP transport',async t=>{
 const f=setup(t);location.search+='&ROLE_A_KEYBOARD=true&input=keyboard&PREFLIGHT_ONLY=false';await f.run();
 assert.equal(f.status().input,'webmcp');assert.equal(f.calls,1);assert.equal(document.getElementById('bfl-f06p-role-a-result'),undefined);assert.equal(f.keys.size,0);f.noWork();
});

test('historical bootstrap keeps its recorded pins, stays disabled/default WebMCP and selects N/G only explicitly',async t=>{
 const {createHash}=await import('node:crypto');
 const pins=JSON.parse(readFileSync(new URL('../../../fixtures/film-printing/f06p-final-execution-packet/pins.json',import.meta.url)));
 const hash=pins['apps/film-printing-staging/theme/checkout-diagnostic.js'];
 assert.equal(createHash('sha256').update(proposal).digest('hex'),pins['fixtures/film-printing/f06p-final-execution-packet/bootstrap.proposal.liquid']);
 assert.ok(proposal.includes('Helper SHA256: '+hash));assert.ok(proposal.includes("moduleUrl.searchParams.set('bfl_sha256', '"+hash+"')"));
 assert.ok(proposal.includes('ENABLED = false, UNTIL = 0'));assert.ok(proposal.includes('ROLE_A_KEYBOARD = false'));
 const f=setup(t);await f.run({enabled:false});assert.equal(f.status(),null);f.noWork();
 await f.run({roleAKeyboard:true,preflightOnly:true});assert.equal(f.status().input,'keyboard');assert.equal(f.status().status,'ready');
 const node=document.getElementById('bfl-f06p-role-a-result'),key=[...f.keys.get('keydown')][0];
 const press=code=>{let consumed=false;key({isTrusted:true,repeat:false,isComposing:false,defaultPrevented:false,ctrlKey:true,altKey:true,shiftKey:true,metaKey:false,code,composedPath:()=>[{tagName:'BODY'}],preventDefault(){consumed=true;}});return consumed;};
 for(const code of ['KeyC','KeyX','KeyV'])assert.equal(press(code),false);
 for(const [code,action] of [['KeyN','remove_job'],['KeyG','publish']]){
  assert.equal(press(code),true);await tick();assert.equal(JSON.parse(node.textContent).action,action);assert.equal(JSON.parse(node.textContent).status,'rejected');
 }
 f.noWork();f.noLeaks();
});
