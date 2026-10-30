import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import vm from 'node:vm';
const template=await readFile(new URL('../theme/persistent-bootstrap.liquid',import.meta.url),'utf8');
const generator=new URL('../theme/build-persistent-layout.py',import.meta.url).pathname;
const entry='bfl-customer-persistent-cart-0123456789abcdef.js';
const marker="    {% if shop.permanent_domain == 'bellows-film-printing-staging.myshopify.com' and product.id == 15620086005871 %}\n";
const prefix='<html>\n<body>\n<!-- supplied header, form, cart, footer -->\n    {% render \'gw-custom\' %}\n';
const suffix='\n\n\n</body>\n</html>\n';
const historical=marker+"f02-checkout-probe.js\nbfl-storefront-session.js\nbfl-cart-preflight-123.js\nconst until=123;\nexpectedCartHash:'historic';\nbfl-customer-status\n{% endif %}";
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {resolve,reject,promise};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('prospective generator preserves all non-BFL bytes and removes finite experiment tail',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'bfl-layout-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const baseline=path.join(dir,'baseline.liquid'),output=path.join(dir,'theme.liquid');await writeFile(baseline,prefix+historical+suffix);
 const run=spawnSync('python3',[generator,baseline,entry,output],{encoding:'utf8'});assert.equal(run.status,0,run.stderr);
 const result=await readFile(output,'utf8');assert.ok(result.startsWith(prefix));assert.ok(result.endsWith(suffix));assert.equal(result,prefix+template.trimEnd().replace('__BFL_PERSISTENT_ENTRY__',entry)+suffix);
 for(const old of ['const until=','expectedCartHash','bfl-cart-preflight-','f02-checkout-probe','bfl-storefront-session','bfl-customer-status','bfl-combined-source',"role==='unpublished'"])assert.ok(!result.includes(old),old);
 assert.equal(await readFile(baseline,'utf8'),prefix+historical+suffix);
 assert.match(result,/theme.id == 189196533871/);assert.match(result,/product.id == 15620086005871 and template.suffix == 'film-printing-customer'/);
 assert.equal(spawnSync('python3',[generator,baseline,entry,baseline]).status,1);assert.equal(await readFile(baseline,'utf8'),prefix+historical+suffix);
 assert.equal(spawnSync('python3',[generator,baseline,'unhashed.js',output]).status,1);
});
function boot({hasForm=true,rejectReady=false}={}){
 const controls=[{disabled:false},{disabled:true},{disabled:false}],errors=[{textContent:'',style:{display:'none'}}],form=Object.assign(new EventTarget(),{querySelectorAll(selector){return selector.includes('button')?controls:errors;}});
 const doc=Object.assign(new EventTarget(),{readyState:'loading',querySelector(selector){assert.equal(selector,'[data-film-printing-form]');return hasForm?form:null;},querySelectorAll(){return errors;}});
 const gate=deferred(),calls=[];
 let source=template.match(/<script>\s*([\s\S]*?)\s*<\/script>/)[1];
 source=source.replace(/\{% if bfl_persistent_product %\}([\s\S]*?)\{% else %\}null\{% endif %\}/,hasForm?'$1':'null').replace(/import\(\{\{[\s\S]*?\}\}\)/,'loadEntry()');
 const loadEntry=async()=>({mountPersistentCustomer:async options=>{calls.push(options);return {ready:gate.promise};}});
 vm.runInNewContext(source,{document:doc,window:{BFLOwnedWidget:{pinned:true},BFLPrintJob:{customerError:()=> 'Safe error'}},loadEntry,queueMicrotask,Error});
 return {doc,form,controls,errors,gate,calls};
}
test('bootstrap waits for DOMContentLoaded then keeps controls locked until real flow readiness',async()=>{
 const w=boot();assert.deepEqual(w.controls.map(b=>b.disabled),[true,true,true]);assert.equal(w.calls.length,0);
 const event=new Event('submit',{cancelable:true});w.form.dispatchEvent(event);assert.equal(event.defaultPrevented,true);
 w.doc.dispatchEvent(new Event('DOMContentLoaded'));await tick();assert.equal(w.calls.length,1);assert.equal(w.calls[0].form,w.form);assert.equal(w.calls[0].widget.pinned,true);assert.equal(w.calls[0].publicKey,'3c958e674d1b0653284b');assert.deepEqual(w.controls.map(b=>b.disabled),[true,true,true]);
 w.gate.resolve({client_policy:'bfl-persistent-staging-client-v1'});await tick();assert.deepEqual(w.controls.map(b=>b.disabled),[false,true,false]);
 const readyEvent=new Event('submit',{cancelable:true});w.form.dispatchEvent(readyEvent);assert.equal(readyEvent.defaultPrevented,false);assert.equal(w.errors[0].textContent,'');
 w.doc.dispatchEvent(new Event('DOMContentLoaded'));await tick();assert.equal(w.calls.length,1);
});
test('bootstrap failure uses existing error nodes and never enables invalid form',async()=>{
 const w=boot();w.doc.dispatchEvent(new Event('DOMContentLoaded'));await tick();w.gate.reject(Error('unknown'));await tick();assert.deepEqual(w.controls.map(b=>b.disabled),[true,true,true]);assert.equal(w.errors[0].textContent,'Safe error');assert.equal(w.errors[0].style.display,'');
 const event=new Event('submit',{cancelable:true});w.form.dispatchEvent(event);assert.equal(event.defaultPrevented,true);
});
test('cart-only bootstrap explicitly passes no form and permits idle native-null result',async()=>{
 const w=boot({hasForm:false});w.doc.dispatchEvent(new Event('DOMContentLoaded'));await tick();assert.equal(w.calls.length,1);assert.equal(w.calls[0].form,null);w.gate.resolve(null);await tick();assert.equal(w.errors[0].textContent,'');
});
test('persistent upload module preserves approved local/link/Drive/Dropbox and no crop settings',async()=>{
 const owned=await readFile(new URL('../theme/owned-widget.js',import.meta.url),'utf8');assert.match(owned,/tabs:'file url gdrive dropbox'/);assert.match(owned,/crop:false/);assert.ok(!template.includes('createElement'));
});
