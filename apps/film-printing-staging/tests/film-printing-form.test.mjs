import test from 'node:test';
import assert from 'node:assert/strict';
import {createFilmPrintingForm} from '../theme/film-printing-form.js';

const asset='11111111-2222-4333-8444-555555555555';
const selection=()=>({service:'Photo Prints',size:'4 × 6',paper:null,lab:'Miami',copies:2,asset_ids:[asset],options:{},message:''});
function rig(overrides={}){
  let input=selection(),items=[],sequence=[],preparations=0,adds=0;
  const job=()=>({checkout_ready:false,reference:{id:'job-1'},unit_price_cents:40,file_count:1,
    item:{id:'67852705202287',quantity:2,properties:{_bfl_job:'job-1','Uploaded File 1':'https://public.invalid/private-file'}}});
  const protocol={read:()=>input,id:()=> 'request-1',prepare:async()=>{preparations++;sequence.push('job');return job();},
    cart:async()=>({items}),add:async item=>{adds++;sequence.push('add');items=[{...item,id:'line-1',variant_id:item.id}];},
    publish:async()=>{sequence.push('publish');return {published:true};},
    recalculate:async value=>{assert.equal(value.quantity*value.unit_price_cents,80);sequence.push('recalculate');return {recalculated:true,cart:{items}};},...overrides};
  const controller=globalThis.BFLPrintJob.createController(protocol);
  return {controller,protocol,job,sequence,edit:value=>{input={...input,...value};},setItems:value=>{items=value;},
    get items(){return items;},get preparations(){return preparations;},get adds(){return adds;}};
}

test('pending immutable job adds once, strips public file URLs, then publishes and recalculates',async()=>{
  const r=rig(),a=r.controller.submit(),b=r.controller.submit();assert.equal(a,b);
  assert.equal((await a).accepted,true);assert.deepEqual(r.sequence,['job','add','publish','recalculate']);
  assert.equal(r.preparations,1);assert.equal(r.adds,1);
  assert.equal(r.items[0].properties['Uploaded File 1'],undefined);
  await r.controller.submit();assert.equal(r.adds,1);
});

test('lost add reconciles exact native line and never replays missing, changed or duplicate lines',async()=>{
  let sends=0;const r=rig({add:async()=>{sends++;throw Error('lost');}});
  await assert.rejects(r.controller.submit());assert.equal(r.controller.reset(),false);
  assert.equal(r.controller.canRetry(),false);
  await assert.rejects(r.controller.submit());assert.equal(sends,1);
  const line={id:'native-line',variant_id:'67852705202287',quantity:2,properties:{_bfl_job:'job-1'}};
  r.setItems([{...line,quantity:3}]);await assert.rejects(r.controller.submit());
  r.setItems([line,line]);await assert.rejects(r.controller.submit());
  r.edit({copies:3});await assert.rejects(r.controller.submit());r.edit({copies:2});
  r.setItems([line]);assert.equal((await r.controller.submit()).accepted,true);assert.equal(sends,1);
});

test('lost publication needs authenticated observation; failed recalculation cannot report success or replay',async()=>{
  let publications=0,reads=0,recalculations=0;
  const r=rig({publish:async()=>{publications++;throw Error('lost');},
    publicationStatus:async()=>{reads++;return {published:true};},
    recalculate:async()=>{recalculations++;throw Error('lost native update');}});
  await assert.rejects(r.controller.submit());await assert.rejects(r.controller.submit());await assert.rejects(r.controller.submit());
  assert.equal(publications,1);assert.equal(reads,1);assert.equal(recalculations,1);assert.equal(r.controller.reset(),false);
});

test('changed selection during prepare, missing publication adapter and pre-add readiness cannot add',async()=>{
  const r=rig({prepare:async()=>{r.edit({copies:3});return r.job();}});
  await assert.rejects(r.controller.submit());assert.equal(r.adds,0);
  const absent=rig({publish:undefined});await assert.rejects(absent.controller.submit());assert.equal(absent.preparations,0);
  const old=rig({prepare:async()=>({...old.job(),checkout_ready:true})});await assert.rejects(old.controller.submit());assert.equal(old.adds,0);
  const duringRead=rig({cart:async()=>{duringRead.edit({copies:7});return {items:[]};}});
  await assert.rejects(duringRead.controller.submit());assert.equal(duringRead.adds,0);
});

test('only accepted submission can reset for a second distinct immutable job',async()=>{
  let n=0;const r=rig({id:()=>`request-${++n}`,prepare:async input=>({...r.job(),reference:{id:input.request_key},
    item:{...r.job().item,properties:{_bfl_job:input.request_key}}})});
  assert.equal(r.controller.reset(),false);await r.controller.submit();assert.equal(r.controller.reset(),true);
  await r.controller.submit();assert.equal(n,2);assert.equal(r.adds,2);
});

class Form extends EventTarget{
  dataset={filmPrintingForm:''};copies=3;
  querySelector(selector){
    const values={'[name="quantity"]':String(this.copies),'[name="service"]:checked':'Photo Prints',
      '[name="location"]:checked':'Miami','[name="properties[Message]"]':'Keep centered'};
    return selector in values?{value:values[selector]}:null;
  }
  querySelectorAll(selector){return selector.includes('data-group="Sizes"')
    ?[{value:'4 × 6',disabled:false,closest:()=>({style:{display:''}})}]:[];}
}

test('form uses one private session for actual File upload and job, completed assets × copies, and accepted reset',async t=>{
  const oldLocation=globalThis.location;globalThis.location={origin:'https://bellows-film-printing-staging.myshopify.com'};
  t.after(()=>{globalThis.location=oldLocation;});
  const token='bflr1_'+'a'.repeat(43),opaque='b'.repeat(43),calls=[];let intentCount=0,items=[],jobCount=0,successes=0;
  const intents=new Map(),receipt=(id,state,version)=>({schema:1,intent_id:id,version,state,expires_at:Date.now()+60000,
    asset_id:state==='complete'?asset:null,checkout_ready:false});
  const fetchImpl=async(url,options)=>{
    const path=url.startsWith('/')?url.split('?')[0]:new URL(url).pathname;
    calls.push({path,authorization:options.headers?.Authorization});
    let result;
    if(path==='/resource-proof/challenge')result={challenge:opaque,verifier:opaque,purpose:'bfl:resource-fresh-proof:v1',
      audience:globalThis.location.origin+'/bfl-application-resources',action:'issue',expires_in:30};
    else if(path==='/apps/bfl-staging/resource-proof')result={ticket:opaque};
    else if(path==='/resource-proof/exchange')result={proof:opaque,expires_in:30};
    else if(path==='/resource-sessions/issue')result={token,expires_in:300,generation:1,resource_only:true,cart_verified:false,checkout_ready:false};
    else if(path==='/uploads/intents'){
      const id=`00000000-0000-4000-8000-${String(++intentCount).padStart(12,'0')}`;result=receipt(id,'issued',1);intents.set(id,result);
    }else if(path.endsWith('/bytes')){
      assert.ok(options.body instanceof File);assert.equal(options.credentials,'omit');
      const id=path.split('/')[2];result=receipt(id,'complete',2);intents.set(id,result);
    }else if(path.endsWith('/status')){const id=path.split('/')[2];result=receipt(id,'complete',intents.get(id).version+1);intents.set(id,result);}
    else if(path.endsWith('/remove')){const id=path.split('/')[2];result=receipt(id,'removed',3);intents.set(id,result);}
    else if(path==='/jobs'){
      const input=JSON.parse(options.body);assert.deepEqual(input.asset_ids,[asset]);assert.equal(input.copies,3);assert.equal(input.message,'Keep centered');
      const id=`job-${++jobCount}`;result={checkout_ready:false,reference:{id},unit_price_cents:40,file_count:1,
        item:{id:'67852705202287',quantity:3,properties:{_bfl_job:id}}};
    }else throw Error('Unexpected path '+path);
    return Response.json(result);
  };
  const form=new Form();let updates=0;form.addEventListener('bfl:uploads-changed',()=>updates++);
  const flow=createFilmPrintingForm(form,{sessionOptions:{fetchImpl},success:()=>successes++,checkoutForSession:session=>{
    assert.equal(typeof session.request,'function');assert.equal(session.token,undefined);
    return {cart:async()=>({items}),add:async item=>{items.push({...item,id:`line-${jobCount}`,variant_id:item.id});},
      publish:async()=>({published:true}),recalculate:async value=>{
        assert.equal(value.quantity*value.file_count,3);assert.equal(value.quantity*value.unit_price_cents,120);
        return {recalculated:true,cart:{items}};
      }};
  }});
  assert.equal(flow.reset(),false);assert.throws(()=>flow.select([new File(['x'],'a.png',{type:'image/png'})]));
  await flow.issue();assert.throws(()=>flow.select(['https://provider.invalid/file']));
  const selected=flow.select([new File(['x'],'a.png',{type:'image/png'})]);
  assert.ok(flow.snapshot().pending);assert.equal(await flow.submit(),null);
  await selected[0].completion;assert.equal(flow.snapshot().pending,0);assert.deepEqual(flow.snapshot().completedAssetIds,[asset]);
  const a=flow.submit(),b=flow.submit();assert.equal(a,b);assert.equal((await a).accepted,true);assert.equal(successes,1);
  assert.equal(flow.reset(),true);assert.deepEqual(flow.snapshot().completedAssetIds,[]);assert.ok(updates>=3);
  assert.equal(calls.filter(c=>c.path==='/resource-sessions/issue').length,1);
  for(const call of calls.filter(c=>c.path.startsWith('/uploads/')||c.path==='/jobs'))assert.equal(call.authorization,'Bearer '+token);
  assert.equal(calls.some(c=>c.path.endsWith('/remove')),false); // immutable job file remains owned
  assert.equal(items.length,1);
});

test('Send Rolls cannot register the owned Film Printing flow; DOM endpoint flags make no requests',async()=>{
  const form=new Form();form.dataset={printJobFlow:'enabled',printJobEndpoint:'/apps/bfl'};
  assert.throws(()=>createFilmPrintingForm(form,{checkoutForSession:()=>{throw Error('must not run');}}));
  const mounted=globalThis.BFLPrintJob.mount(form,{uploadAdapter:{snapshot:()=>({completedAssetIds:[asset]})}});
  assert.equal(globalThis.BFLPrintJob.forForm(form),undefined);assert.equal(await mounted.submit(),null);
});

test('owned transport counts multiple completed files, blocks failures/removal and never repeats uncertain bytes',async()=>{
  let n=0,sends=0,lost=true;const receipts=new Map();
  const complete=id=>({...receipts.get(id),version:2,state:'complete',asset_id:id});
  const client={intent:async()=>{
    const id=`00000000-0000-4000-8000-${String(++n).padStart(12,'0')}`;
    const receipt={schema:1,intent_id:id,version:1,state:'issued',asset_id:null,expires_at:Date.now()+60000,checkout_ready:false};
    receipts.set(id,receipt);return receipt;
  },bytes:async id=>{sends++;if(lost){lost=false;throw Error('uncertain send');}return complete(id);},
    status:async id=>complete(id),remove:async id=>({...receipts.get(id),version:3,state:'removed'})};
  const transport=globalThis.BFLUploadTransport.create({enabled:true,client}),file=new File(['x'],'a.png',{type:'image/png'});
  const first=transport.select('one',file);await assert.rejects(first);
  assert.equal(transport.select('one',file),first);assert.equal(sends,1);assert.ok(transport.snapshot().pending);
  await transport.refresh('one');await transport.select('two',file);
  assert.equal(transport.snapshot().completedAssetIds.length,2);assert.equal(sends,2);
  const removing=transport.remove('one');assert.ok(transport.snapshot().pending);await removing;
  assert.equal(transport.snapshot().completedAssetIds.length,1);
  await assert.rejects(transport.select('invalid',new File(['x'],'bad.txt',{type:'text/plain'})));
  assert.ok(transport.snapshot().pending);assert.equal(sends,2);
  await transport.remove('invalid');assert.equal(transport.snapshot().pending,0);
  transport.dispose();
});


test('expired completion refreshes by status, while uncertain bytes remain blocking and never replay',async()=>{
  let clock=1000,n=0,sends=0,statuses=0,allowStatus=true;
  const entries=new Map(),receipt=(id,state,version)=>({schema:1,intent_id:id,state,version,
    asset_id:state==='complete'?id:null,expires_at:clock+100,checkout_ready:false});
  const client={intent:async()=>{const id=`00000000-0000-4000-8000-${String(++n).padStart(12,'0')}`;
    const r=receipt(id,'issued',1);entries.set(id,r);return r;},
    bytes:async id=>{sends++;if(sends===2)throw Error('lost');const r=receipt(id,'complete',2);entries.set(id,r);return r;},
    status:async id=>{statuses++;if(!allowStatus)throw Error('expired session');const r=receipt(id,'complete',entries.get(id).version+1);entries.set(id,r);return r;},
    remove:async id=>receipt(id,'removed',3)};
  const transport=globalThis.BFLUploadTransport.create({enabled:true,client,lifecycle:globalThis.BFLUploadLifecycle.create({now:()=>clock})});
  const file=new File(['x'],'a.png',{type:'image/png'});
  await transport.select('complete',file);clock+=101;assert.equal(transport.snapshot().completedAssetIds.length,0);assert.equal(transport.snapshot().displayCompletedCount,1);
  await transport.refreshCompleted();assert.equal(transport.snapshot().completedAssetIds.length,1);assert.equal(statuses,1);assert.equal(sends,1);
  allowStatus=false;await assert.rejects(transport.refreshCompleted());assert.ok(transport.snapshot().pending);assert.equal(sends,1);
  allowStatus=true;await transport.refreshCompleted();
  await assert.rejects(transport.select('uncertain',file));await assert.rejects(transport.refreshCompleted());
  assert.ok(transport.snapshot().pending);assert.equal(statuses,3);assert.equal(sends,2);
  allowStatus=false;await assert.rejects(transport.refreshCompleted());assert.ok(transport.snapshot().pending);assert.equal(sends,2);
});


test('page validation can refresh the mounted flow before reading an expired selection',async()=>{
  const form=new Form();let refreshed=false,refreshes=0;
  const protocol={prepare:async()=>{throw Error('not submitted');},cart:async()=>{},add:async()=>{},publish:async()=>{},recalculate:async()=>{}};
  const flow=globalThis.BFLPrintJob.mount(form,{protocol,uploadAdapter:{
    snapshot:()=>({pending:refreshed?0:1,failed:0,completedAssetIds:refreshed?[asset]:[],displayCompletedCount:1}),
    refresh:async()=>{refreshes++;refreshed=true;}}});
  assert.equal(flow.snapshot().pending,1);await globalThis.BFLPrintJob.forForm(form).refresh();
  assert.equal(refreshes,1);assert.equal(flow.snapshot().pending,0);assert.deepEqual(flow.snapshot().completedAssetIds,[asset]);
});


test('submission diagnostics contain fixed stages only, including an uncertain add',async()=>{
  const events=[];const r=rig({observe:e=>events.push(e),add:async()=>{throw Error('private-cart-token');}});
  await assert.rejects(r.controller.submit());
  assert.deepEqual(events.at(-1),{stage:'add',state:'failed'});
  assert.equal(JSON.stringify(events).includes('private-cart-token'),false);
  assert.ok(events.every(e=>Object.keys(e).sort().join() === 'stage,state'||
    e.stage==='selection'&&e.state==='read'&&Object.keys(e).sort().join()==='copies,files,stage,state'));
});

test('a rejected pre-cart preparation allows correcting copies without repeating a cart write',async()=>{
  const r=rig({prepare:async input=>{if(input.copies!==2)throw Error('selection rejected');return r.job();}});
  r.edit({copies:1});await assert.rejects(r.controller.submit());
  assert.equal(r.controller.canRetry(),true);assert.equal(r.adds,0);
  r.edit({copies:2});assert.equal((await r.controller.submit()).accepted,true);
  assert.equal(r.adds,1);assert.equal(r.controller.canRetry(),false);
});

test('submission refresh covers a second completed receipt that has not expired yet',async t=>{
  let clock=1000,n=0;const originalNow=Date.now;Date.now=()=>clock;t.after(()=>{Date.now=originalNow;});
  const entries=new Map(),seen=[];
  const receipt=(id,state,version)=>({schema:1,intent_id:id,state,version,asset_id:state==='complete'?id:null,expires_at:clock+60000,checkout_ready:false});
  const client={intent:async()=>{const id=`00000000-0000-4000-8000-${String(++n).padStart(12,'0')}`;return receipt(id,'issued',1);},
    bytes:async id=>{const r=receipt(id,'complete',2);entries.set(id,r);return r;},
    status:async id=>{seen.push(id);const r=receipt(id,'complete',3);entries.set(id,r);return r;},remove:async id=>receipt(id,'removed',4)};
  const transport=globalThis.BFLUploadTransport.create({enabled:true,client});
  const file=new File(['x'],'test.png',{type:'image/png'});
  await transport.select('one',file);clock+=40000;await transport.select('two',file);clock+=21000;
  assert.equal(transport.snapshot().pending,1);
  await transport.refreshCompleted();assert.equal(seen.length,2);
  clock+=20000;assert.equal(transport.snapshot().pending,0);assert.equal(transport.snapshot().completedAssetIds.length,2);
});

test('page validation and immediate submit share one refresh, but a later submit refreshes again',async t=>{
  const original=Date.now;let time=10000;Date.now=()=>time;t.after(()=>{Date.now=original;});
  for(const delay of [0,1500]){
    let refreshes=0;const form=new Form();
    const flow=globalThis.BFLPrintJob.mount(form,{protocol:{prepare:async()=>{throw Error('pre-write rejection');},cart:async()=>{},add:async()=>{},publish:async()=>{},recalculate:async()=>{}},
      uploadAdapter:{snapshot:()=>({pending:0,failed:0,completedAssetIds:[asset]}),refresh:async()=>{refreshes++;}}});
    await flow.refresh();time+=delay;await flow.submit();
    assert.equal(refreshes,delay?2:1);assert.equal(flow.canRetry(),true);
  }
});

test('partial refresh keeps a long batch usable without accepting or replaying a failed file',async()=>{
  let clock=1000,n=0,sends=0,statuses=0;
  const entries=new Map(),expiry=new Map();
  const receipt=(id,state)=>{const value={schema:1,intent_id:id,state,version:(entries.get(id)?.version??0)+1,
    asset_id:state==='complete'?id:null,expires_at:state==='complete'?Math.min(clock+60000,expiry.get(id)):expiry.get(id),checkout_ready:false};entries.set(id,value);return value;};
  const client={intent:async()=>{const id=`00000000-0000-4000-8000-${String(++n).padStart(12,'0')}`;expiry.set(id,clock+600000);return receipt(id,'issued');},
    bytes:async id=>{sends++;if(sends===1)throw Error('individual failure');return receipt(id,'complete');},
    status:async id=>{statuses++;return receipt(id,'complete');},remove:async id=>receipt(id,'removed')};
  const transport=globalThis.BFLUploadTransport.create({enabled:true,client,concurrency:4,lifecycle:globalThis.BFLUploadLifecycle.create({now:()=>clock})});
  const file=new File(['x'],'test.png',{type:'image/png'});
  await assert.rejects(transport.select('failed',file));
  for(let i=0;i<100;i++){clock+=2000;await transport.select('ok-'+i,file);await transport.refreshSuccessful();}
  assert.equal(transport.snapshot().completedAssetIds.length,100);assert.ok(transport.snapshot().pending);
  await assert.rejects(transport.refreshCompleted());assert.equal(sends,101);assert.ok(statuses>0);
  const before=new Map(expiry);clock+=61000;await transport.remove('failed');await transport.refreshSuccessful();
  assert.equal(transport.snapshot().pending,0);assert.equal(transport.snapshot().completedAssetIds.length,100);
  assert.deepEqual(expiry,before);assert.equal(sends,101);
  const idle=statuses;await Promise.resolve();await Promise.resolve();assert.equal(statuses,idle);
});

test('stale status reads are coalesced and prioritized without undoing removal or preview failure',async()=>{
  let clock=1000,n=0;const statuses=[],gates=[],events=[],entries=new Map();
  const receipt=(id,state)=>{const value={schema:1,intent_id:id,state,version:(entries.get(id)?.version??0)+1,
    asset_id:state==='complete'?id:null,expires_at:clock+100,checkout_ready:false};entries.set(id,value);return value;};
  const client={intent:async()=>{const id=`00000000-0000-4000-8000-${String(++n).padStart(12,'0')}`;return receipt(id,'issued');},
    bytes:async id=>{events.push('bytes');if(n>1)await new Promise(r=>gates.push(r));return receipt(id,'complete');},
    status:async id=>{events.push('status');await new Promise(r=>statuses.push(r));return receipt(id,'complete');},remove:async id=>receipt(id,'removed')};
  const transport=globalThis.BFLUploadTransport.create({enabled:true,client,concurrency:4,lifecycle:globalThis.BFLUploadLifecycle.create({now:()=>clock})});
  const file=new File(['x'],'test.png',{type:'image/png'}),tick=()=>new Promise(r=>setImmediate(r));
  await transport.select('ready',file);clock+=101;
  const pending=Array.from({length:5},(_,i)=>transport.select('wait-'+i,file));await tick();assert.equal(gates.length,4);
  const first=transport.refreshSuccessful(),second=transport.refreshSuccessful();gates.shift()();await tick();
  assert.equal(events.at(-1),'status');assert.equal(events.filter(x=>x==='status').length,1);
  transport.failPreview('ready');statuses.shift()();await Promise.all([first,second]);assert.ok(transport.snapshot().pending);
  await tick();while(gates.length)gates.shift()();await Promise.all(pending);
  await transport.remove('ready');assert.equal(transport.snapshot().pending,0);
  clock+=101;const refresh=transport.refreshSuccessful();await tick();
  const removal=transport.remove('wait-0');statuses.shift()();
  // Four distinct status calls can occupy the pool; release each without
  // allowing any late response to restore the removed selection.
  for(let i=0;i<8;i++){await tick();while(statuses.length)statuses.shift()();}
  await Promise.all([refresh,removal]);assert.equal(transport.snapshot().displayCompletedCount,4);
});

test('settled batch refresh covers proofs that would age out while earlier status reads finish',async()=>{
  let clock=1000,n=0,sends=0;const entries=new Map(),deadlines=new Map(),seen=[];
  const receipt=(id,state)=>{const value={schema:1,intent_id:id,state,version:(entries.get(id)?.version??0)+1,
    asset_id:state==='complete'?id:null,expires_at:Math.min(clock+100,deadlines.get(id)),checkout_ready:false};entries.set(id,value);return value;};
  const client={intent:async()=>{const id=`00000000-0000-4000-8000-${String(++n).padStart(12,'0')}`;deadlines.set(id,clock+600);return receipt(id,'issued');},
    bytes:async id=>{sends++;return receipt(id,'complete');},status:async id=>{seen.push(id);clock+=80;return receipt(id,'complete');},remove:async id=>receipt(id,'removed')};
  const transport=globalThis.BFLUploadTransport.create({enabled:true,client,concurrency:1,lifecycle:globalThis.BFLUploadLifecycle.create({now:()=>clock})});
  const file=new File(['x'],'test.png',{type:'image/png'});
  await transport.select('first',file);clock+=50;await transport.select('last',file);clock=1101;
  const original=new Map(deadlines);assert.equal(transport.snapshot().pending,1);
  await transport.refreshSuccessful({settled:true});
  assert.equal(seen.length,2);assert.equal(transport.snapshot().pending,0);assert.equal(transport.snapshot().completedAssetIds.length,2);
  assert.equal(sends,2);assert.deepEqual(deadlines,original);
  const idle=seen.length;await new Promise(setImmediate);assert.equal(seen.length,idle);
});


test('all local and remote previews settle before one full refresh; duplicate and removed callbacks stay idle',async t=>{
  const oldLocation=globalThis.location;globalThis.location={origin:'https://bellows-film-printing-staging.myshopify.com'};
  t.after(()=>{globalThis.location=oldLocation;});
  const opaque='b'.repeat(43),entries=new Map(),deadline=Date.now()+60000;let n=0,statuses=0,bytes=0,sources=0;
  const receipt=(id,state)=>{const value={schema:1,intent_id:id,state,version:(entries.get(id)?.version??0)+1,
    asset_id:state==='complete'?id:null,expires_at:deadline,checkout_ready:false};entries.set(id,value);return value;};
  const fetchImpl=async(url,options)=>{
    const path=url.startsWith('/')?url.split('?')[0]:new URL(url).pathname;let result;
    if(path==='/resource-proof/challenge')result={challenge:opaque,verifier:opaque,purpose:'bfl:resource-fresh-proof:v1',
      audience:globalThis.location.origin+'/bfl-application-resources',action:'issue',expires_in:30};
    else if(path==='/apps/bfl-staging/resource-proof')result={ticket:opaque};
    else if(path==='/resource-proof/exchange')result={proof:opaque,expires_in:30};
    else if(path==='/resource-sessions/issue')result={token:'bflr1_'+'a'.repeat(43),expires_in:300,generation:1,resource_only:true,cart_verified:false,checkout_ready:false};
    else if(path==='/uploads/intents')result=receipt(`00000000-0000-4000-8000-${String(++n).padStart(12,'0')}`,'issued');
    else if(path.endsWith('/source')){sources++;if(sources===4)return Response.json({code:'UPLOAD_IMAGE_INVALID'},{status:422});result=receipt(path.split('/')[2],'complete');}
    else if(path.endsWith('/bytes')){bytes++;result=receipt(path.split('/')[2],'complete');}
    else if(path.endsWith('/status')){statuses++;result=receipt(path.split('/')[2],'complete');}
    else if(path.endsWith('/remove'))result=receipt(path.split('/')[2],'removed');
    else throw Error('Unexpected path '+path);
    return Response.json(result);
  };
  const flow=createFilmPrintingForm(new Form(),{sessionOptions:{fetchImpl},checkoutForSession:()=>({cart:async()=>({items:[]}),add:async()=>{},publish:async()=>{},recalculate:async()=>{}})});
  const flush=async()=>{for(let i=0;i<8;i++)await new Promise(setImmediate);};
  await flow.issue();
  const remote=Array.from({length:3},(_,i)=>flow.selectSource('https://fixture.invalid/'+i));
  const [local]=flow.select([new File(['x'],'local.png',{type:'image/png'})]);
  await Promise.all([...remote,local].map(row=>row.completion));
  for(const row of remote){flow.selectionReady(row.key);await flush();assert.equal(statuses,0);}
  flow.selectionReady(local.key);await flush();assert.equal(statuses,4);assert.equal(flow.snapshot().pending,0);
  for(const row of [...remote,local])flow.selectionReady(row.key);
  await flush();assert.equal(statuses,4);
  const rejected=flow.selectSource('https://fixture.invalid/rejected');await assert.rejects(rejected.completion);
  flow.selectionFailed(rejected.key);await flush();assert.equal(statuses,4);assert.ok(flow.snapshot().pending);
  await flow.remove(rejected.key);await flush();assert.equal(statuses,8);assert.equal(flow.snapshot().pending,0);
  flow.selectionReady(rejected.key);await flush();assert.equal(statuses,8);
  await flow.remove(remote[0].key);await flush();assert.equal(statuses,11);
  flow.selectionReady(remote[0].key);await flush();assert.equal(statuses,11);
  assert.equal(bytes,1);assert.equal(sources,4);assert.ok([...entries.values()].every(row=>row.expires_at===deadline));
});
