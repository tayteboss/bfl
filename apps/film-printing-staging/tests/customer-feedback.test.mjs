import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createOwnedWidget} from '../theme/owned-widget.js';
import {createCustomerCheckout} from '../theme/customer-checkout.js';

test('Add to Bag opens immediately while submission is pending, then renders only accepted results',async()=>{
  const source=readFileSync(new URL('../../../assets/film-service.js',import.meta.url),'utf8');
  const block=source.slice(source.indexOf('    const ownedFlow = printJobFlow();'),source.indexOf('    // Use the variant ID from the hidden input'));
  for(const accepted of [true,false]){
    let resolve;const pending=new Promise(r=>{resolve=r;}),events=[];
    const drawer={classList:{contains:()=>false},setPending:(...args)=>events.push(['pending',...args]),open:()=>events.push(['open']),renderContents:()=>events.push(['render'])};
    const context=vm.createContext({printJobFlow:()=>({canRetry:()=>true,refresh:()=>pending.then(()=>{}),submit:()=>pending,reset:()=>true}),cartDrawer:drawer,setErrorMessage:()=>{},clearFormAndScrollTop:()=>{},
      validateOpenFields:()=>({errors:[]}),getCustomSizeValidation:()=>({active:false}),total:2.4,
      document:{activeElement:{},getElementById:()=>null},window:{Shopify:{routes:{root:'/'}},location:{}},
      fetch:async()=>({ok:true,json:async()=>({'cart-drawer':'verified section'})})});
    const run=vm.runInContext(`(async()=>{${block}})`,context),work=run();
    assert.deepEqual(events,[['pending',true],['open']]);
    resolve(accepted?{accepted:true,cart:{items:[{quantity:3}]}}:null);await work;
    assert.equal(events.some(e=>e[0]==='render'),accepted);
    assert.equal(events.at(-1)[0],'pending');assert.equal(events.at(-1)[1],false);
    if(!accepted)assert.equal(events.at(-1)[2].failed,false);
  }
});

test('failed Add to Bag reopens the error, but only retries before any cart write',async()=>{
  const source=readFileSync(new URL('../../../assets/film-service.js',import.meta.url),'utf8');
  const block=source.slice(source.indexOf('    const ownedFlow = printJobFlow();'),source.indexOf('    // Use the variant ID from the hidden input'));
  for(const retryable of [false,true]){
    let opened=0,submitted=0;
    const context=vm.createContext({printJobFlow:()=>({canRetry:()=>retryable,refresh:async()=>{},submit:async()=>{submitted++;return null;}}),
      cartDrawer:{classList:{contains:()=>true},open:()=>opened++,setPending(){}},setErrorMessage(){},document:{activeElement:{}},
      validateOpenFields:()=>({errors:[]}),getCustomSizeValidation:()=>({active:false}),total:2.4});
    await vm.runInContext(`(async()=>{${block}})()`,context);
    assert.equal(opened,1);assert.equal(submitted,retryable?1:0);
  }
});

test('accepted owned Add resets print options, copies, summary and submitted images',async()=>{
  const source=readFileSync(new URL('../../../assets/film-service.js',import.meta.url),'utf8');
  const block=source.slice(source.indexOf('    const ownedFlow = printJobFlow();'),source.indexOf('    // Use the variant ID from the hidden input'));
  for(const prepared of [true,false]){
    const form={location:'Miami',service:'Photo Prints',size:'4x6',copies:3,summaryVisible:true,images:2};
    let rendered=0;
    const context=vm.createContext({printJobFlow:()=>({canRetry:()=>true,refresh:async()=>{},submit:async()=>({accepted:true,cart:{items:[{quantity:3}]},...(prepared?{render:{sections:{}}}:{})}),reset:()=>{form.images=0;return true;}}),
      cartDrawer:{classList:{contains:()=>false},setPending(){},open(){},renderContents(){rendered++;}},setErrorMessage(){},
      clearFormAndScrollTop(){Object.assign(form,{location:null,service:null,size:null,copies:1,summaryVisible:false});},
      validateOpenFields:()=>({errors:[]}),getCustomSizeValidation:()=>({active:false}),total:2.4,
      document:{activeElement:{},getElementById:()=>null,querySelector:()=>({refreshOwnedCart:async()=>{rendered++;}})},
      window:{Shopify:{routes:{root:'/'}},location:{}},fetch:async()=>({ok:true,json:async()=>({'cart-drawer':'verified section'})})});
    await vm.runInContext(`(async()=>{${block}})()`,context);
    assert.equal(rendered,1);
    assert.deepEqual(form,{location:null,service:null,size:null,copies:1,summaryVisible:false,images:0});
  }
});

test('pending and failed drawer states disable checkout and repeated edits; accepted completion releases them',()=>{
  const definitions=new Map(),nodes={};
  const classes=new Set(),classList={toggle:(name,on)=>on?classes.add(name):classes.delete(name),contains:name=>classes.has(name)};
  nodes['#CartDrawer-LineItemStatus']={setAttribute(){}};nodes['.cart-items-list']={inert:false};nodes['#CartDrawer-Checkout']={disabled:false};nodes['#CartDrawer-CartErrors']={textContent:''};
  const context=vm.createContext({HTMLElement:class{},CartItems:class{},customElements:{define:(name,value)=>definitions.set(name,value)},console});
  vm.runInContext(readFileSync(new URL('../../../assets/cart-drawer.js',import.meta.url),'utf8'),context);
  const drawer=Object.create(definitions.get('cart-drawer').prototype);Object.assign(drawer,{classList,setAttribute(){},querySelector:key=>nodes[key]});
  drawer.setPending(true);assert.equal(nodes['#CartDrawer-Checkout'].disabled,true);assert.equal(nodes['.cart-items-list'].inert,true);
  drawer.setPending(false,{failed:true});assert.equal(nodes['#CartDrawer-Checkout'].disabled,true);assert.ok(classes.has('update-failed'));
  drawer.setPending(false);assert.equal(nodes['#CartDrawer-Checkout'].disabled,false);assert.equal(nodes['.cart-items-list'].inert,false);assert.equal(classes.size,0);
});

test('closing the drawer during immediate validation cancels its scheduled opening',()=>{
  const definitions=new Map(),timers=new Map(),classes=new Set(),transitions=[];let serial=0,trapped=0;
  const context=vm.createContext({HTMLElement:class{},CartItems:class{},customElements:{define:(name,value)=>definitions.set(name,value)},
    setTimeout:fn=>{timers.set(++serial,fn);return serial;},clearTimeout:id=>timers.delete(id),
    document:{body:{classList:{add(){},remove(){}}},getElementById:()=>({})},trapFocus:()=>trapped++,console});
  vm.runInContext(readFileSync(new URL('../../../assets/cart-drawer.js',import.meta.url),'utf8'),context);
  const drawer=Object.create(definitions.get('cart-drawer').prototype);
  Object.assign(drawer,{classList:{add:(...names)=>names.forEach(n=>classes.add(n)),remove:name=>classes.delete(name),contains:name=>classes.has(name)},querySelector:()=>null,addEventListener:(_name,fn)=>transitions.push(fn)});
  drawer.open();drawer.close();for(const fn of timers.values())fn();assert.equal(classes.has('active'),false);
  drawer.open();drawer.open();assert.equal(timers.size,1);for(const fn of timers.values())fn();assert.equal(classes.has('active'),true);
  drawer.close();for(const fn of transitions)fn();assert.equal(trapped,0);
});

test('typing copies updates totals before blur and zero uploaded files totals zero',()=>{
  const source=readFileSync(new URL('../../../assets/film-service.js',import.meta.url),'utf8'),listeners=new Map();let totals=0;
  const input=source.slice(source.indexOf("  form.addEventListener('input'"),source.indexOf("  form.addEventListener('focusout'"));
  vm.runInNewContext(input,{form:{addEventListener:(name,fn)=>listeners.set(name,fn)},calculateTotal:()=>totals++,getCustomSizeValidation(){}});
  listeners.get('input')({target:{matches:selector=>selector==='input[name="quantity"]'}});assert.equal(totals,1);
  const summary=source.slice(source.indexOf('    // --- Totals area (consider quantity)'),source.indexOf('  // --- Total calc ---'));
  for(const files of [0,1,2]){
    const rows=[];
    vm.runInNewContext(`(()=>{${summary.trimEnd().slice(0,-2)}})()`,{getQuantity:()=>3,getUploadedFilesCount:()=>files,usesPhysicalNegatives:()=>false,total:0.4,getSizeShippingHandle:()=>null,
      osList:'main',bottomOsList:'bottom',formatMoney:value=>value.toFixed(2),createRow:(list,label,value)=>rows.push({list,label,value})});
    assert.deepEqual(rows.filter(r=>r.label==='Total').map(r=>r.value),Array(2).fill((files*3*0.4).toFixed(2)));
  }
});

test('a rejected preparation preserves inputs and releases cart controls; uncertain Add stays locked',async()=>{
  const source=readFileSync(new URL('../../../assets/film-service.js',import.meta.url),'utf8');
  const block=source.slice(source.indexOf('    const ownedFlow = printJobFlow();'),source.indexOf('    // Use the variant ID from the hidden input'));
  for(const retryable of [true,false]){
    let pending,closed=0,resets=0;
    const context=vm.createContext({printJobFlow:()=>({canRetry:()=>retryable,refresh:async()=>{},submit:async()=>null,reset(){resets++;}}),
      cartDrawer:{classList:{contains:()=>false},setPending:(_busy,options)=>{pending=options;},open(){},close(){closed++;}},setErrorMessage(){},clearFormAndScrollTop(){resets++;},
      validateOpenFields:()=>({errors:[]}),getCustomSizeValidation:()=>({active:false}),total:2.4,document:{activeElement:{}}});
    await vm.runInContext(`(async()=>{${block}})()`,context);
    assert.equal(pending.failed,!retryable);assert.equal(closed,retryable?1:0);assert.equal(resets,0);
  }
});

test('failed or unconfirmed Add preserves every input and submitted selection',async()=>{
  const source=readFileSync(new URL('../../../assets/film-service.js',import.meta.url),'utf8');
  const block=source.slice(source.indexOf('    const ownedFlow = printJobFlow();'),source.indexOf('    // Use the variant ID from the hidden input'));
  for(const outcome of ['failed','render-failed']){
    let resets=0;
    const context=vm.createContext({printJobFlow:()=>({canRetry:()=>false,refresh:async()=>{},submit:async()=>outcome==='failed'?null:{accepted:true,cart:{items:[]},render:{}},reset(){resets++;return true;}}),
      cartDrawer:{classList:{contains:()=>false},setPending(){},open(){}},setErrorMessage(){},clearFormAndScrollTop(){resets++;},
      validateOpenFields:()=>({errors:[]}),getCustomSizeValidation:()=>({active:false}),total:2.4,
      document:{activeElement:{},querySelector:()=>({refreshOwnedCart:async()=>{throw Error('sections unavailable');}})}});
    await vm.runInContext(`(async()=>{${block}})()`,context);assert.equal(resets,0);
  }
});

test('authenticated current-cart read keeps before/after continuity without an identical intervening native read',async()=>{
  let reads=0,id='gid://shopify/Cart/current?key=private';
  const actions={getCart:async()=>{reads++;return {cart:{id,lines:[],totalQuantity:0}};},updateCart:async()=>assert.fail('read must not mutate')};
  let change=false;
  const session={checkout:async(action,locate)=>{const located=await locate();assert.equal(located,id);if(action==='current'&&change)id='gid://shopify/Cart/other?key=private';return {items:[]};}};
  const flow=createCustomerCheckout(session,{actions});await flow.initialize();reads=0;
  await flow.cart();assert.equal(reads,2);
  change=true;await assert.rejects(flow.cart());
});

test('selected previews use privately verified blobs and disappear on remove/reset without deleting submitted originals',async t=>{
  const wrap=p=>({_promise:p,then:(...args)=>p.then(...args)});
  const Deferred=()=>{let resolve,reject,state='pending';const promise=new Promise((r,j)=>{resolve=r;reject=j;});
    const api=wrap(promise),df={promise:()=>api,state:()=>state,notify(){},resolve(v){state='resolved';resolve(v);return df;},reject(e){state='rejected';reject(e);return df;}};return df;};
  let settings,removeListener,removed=0;const changes=[],revoked=[];
  const widget={version:'3.25.3',jQuery:{Deferred},plugin:fn=>fn({utils:{fixedPipe:(api,...args)=>wrap(api._promise.then(...args))}}),
    openDialog:(files,options)=>{settings=options;return {fileColl:{onRemove:{add:fn=>{removeListener=fn;}}}};}};
  const flow={select:files=>[{key:'a',completion:(async()=>({state:'complete',asset_id:'owned',file:{bytes:files[0].size,mime:files[0].type,sha256:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await files[0].arrayBuffer())),b=>b.toString(16).padStart(2,'0')).join('')}}))()}],selectSource(){},original:async()=>({url:'https://private.test/original'}),remove:async()=>{removed++;},crop(){}};
  const previous=globalThis.createImageBitmap;globalThis.createImageBitmap=async()=>({width:2,height:2,close(){}});t.after(()=>{globalThis.createImageBitmap=previous;});
  const uploader=createOwnedWidget(widget,flow,{publicKey:'12345678901234567890',onSelections:rows=>changes.push(rows),
    fetchImpl:async()=>({ok:true,redirected:false,blob:async()=>new Blob(['verified'],{type:'image/png'})}),urls:{createObjectURL:()=> 'blob:local-preview',revokeObjectURL:url=>revoked.push(url)}});
  uploader.open();const file=settings.bflOwnedFileFactory('object',new File(['file'],'test.png',{type:'image/png'}));await Promise.resolve(file);
  assert.deepEqual(changes.at(-1),[{key:'a',url:'blob:local-preview',name:'test.png'}]);
  await uploader.remove('a');assert.deepEqual(changes.at(-1),[]);assert.equal(removed,1);
  removeListener(file);await new Promise(setImmediate);assert.equal(removed,1);
  const next=settings.bflOwnedFileFactory('object',new File(['next'],'next.png',{type:'image/png'}));await Promise.resolve(next);
  uploader.dispose();assert.deepEqual(changes.at(-1),[]);assert.equal(removed,1);assert.equal(revoked.length,2);
  const repeated=settings.bflOwnedFileFactory('object',new File(['file'],'test.png',{type:'image/png'}));await Promise.resolve(repeated);
  assert.equal(changes.at(-1).length,1);uploader.dispose();assert.equal(revoked.length,3);
});

test('rejected and cancelled widget files retain display info for group summaries without becoming ready',async()=>{
  const failures=[],ready=[],failed=[];let settings,rejectUpload;
  const wrap=p=>({_promise:p,then:(...args)=>p.then(...args)});
  const Deferred=()=>{let state='pending',resolve,reject;
    const promise=new Promise((a,b)=>{resolve=a;reject=b;});promise.catch(()=>{});
    const api=wrap(promise),df={promise:()=>api,state:()=>state,notify(){},
      resolve(value){if(state==='pending'){state='resolved';resolve(value);}return df;},
      reject(code,info){if(state==='pending'){state='rejected';failures.push({code,info});reject(code);}return df;}};return df;};
  const widget={version:'3.25.3',jQuery:{Deferred},plugin:fn=>fn({utils:{fixedPipe:(api,...args)=>wrap(api._promise.then(...args))}}),
    openDialog:(files,options)=>{settings=options;return {fileColl:{onRemove:{add(){}}}};}};
  let key=0;
  const flow={select:()=>[{key:String(++key),completion:new Promise((_,reject)=>{rejectUpload=reject;})}],selectSource(){throw Error('unsupported');},original(){},remove:async()=>{},crop(){},
    selectionReady:key=>ready.push(key),selectionFailed:key=>failed.push(key)};
  const uploader=createOwnedWidget(widget,flow,{publicKey:'12345678901234567890'});uploader.open();
  settings.bflOwnedFileFactory('object',new File(['bad'],'bad.jpg',{type:'image/jpeg'}));
  rejectUpload(Error('invalid'));await new Promise(setImmediate);
  assert.deepEqual(failed,['1']);assert.deepEqual(ready,[]);
  const cancelled=settings.bflOwnedFileFactory('object',new File(['cancel'],'cancel.jpg',{type:'image/jpeg'}));
  cancelled.cancel();await new Promise(setImmediate);
  settings.bflOwnedFileFactory('url','https://invalid.test/image.jpg');
  assert.deepEqual(failures.map(x=>x.code),['upload','user','upload']);
  assert.deepEqual(failures.map(x=>x.info.size),[3,6,0]);
  // FileGroup consumes this info even for rejected members, then rejects the
  // group. Missing metadata must not throw inside the last valid resolution.
  assert.equal(failures.reduce((size,{info})=>size+info.size,0),9);
  for(const {info} of failures){assert.equal(info.uuid,null);assert.equal(info.originalUrl,null);assert.equal(info.cdnUrl,null);assert.equal(info.isImage,false);assert.equal(info.isStored,false);}
  assert.deepEqual(ready,[]);uploader.dispose();
});
