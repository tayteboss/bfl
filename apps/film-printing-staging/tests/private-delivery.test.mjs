import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {signDelivery} from '../uploads/delivery.mjs';

const config={publicKey:'synthetic-key',projectId:1,cdnOrigin:'https://test.ucarecd.net',secret:'synthetic-api-secret',
 delivery:{projectKey:'synthetic-key',origin:'https://test.s.ucarecd.net',publicAccessDisabled:true,legacyAccessDisabled:true,signingSecret:'a'.repeat(64)}};
const asset='11111111-2222-4333-8444-555555555555';
test('F05C signer rejects broad paths, invalid keys and expired freshness, clamps expiry',()=>{
 const now=1792620000123;
 const s=signDelivery(config,asset,'original',now,now+10100);
 assert.equal(s.expires_at,Math.floor((now+10100)/1000)*1000);
 assert.throws(()=>signDelivery(config,asset,'original',now,now),/REVALIDATION/);
 for(const id of ['*',asset+'/-/resize/1x/','../'+asset])assert.throws(()=>signDelivery(config,id,'original',now,now+60000));
 for(const secret of ['a'.repeat(63),'z'.repeat(64),config.secret])assert.throws(()=>signDelivery({...config,delivery:{...config.delivery,signingSecret:secret}},asset,'preview',now,now+60000),/SECRET/);
});

test('F05C native selection uses actual local Files, stable keys and local previews without UI or requests',async()=>{
 const calls=[],revoked=[];let n=0;
 const root={File,URL:{createObjectURL:file=>{calls.push(['preview',file]);return 'blob:local-'+n;},revokeObjectURL:url=>revoked.push(url)},crypto:{randomUUID:()=>`file-${++n}`}};
 vm.runInNewContext(readFileSync(new URL('../theme/native-files.js',import.meta.url),'utf8'),root);
 assert.deepEqual(calls,[]);
 const transport={select:(key,file)=>{calls.push(['select',key,file]);return Promise.resolve({state:'complete'});},remove:key=>{calls.push(['remove',key]);return Promise.resolve({state:'removed'});},dispose:()=>calls.push(['dispose'])};
 const handoff=root.BFLNativeFiles.create({transport});
 const png=new File(['tiny'],'fixture.png',{type:'image/png'}),tiff=new File(['tiny'],'fixture.tif',{type:'image/tiff'});
 const selected=handoff.select([png,tiff]);assert.equal(selected[0].preview_url,'blob:local-1');assert.equal(selected[1].preview_url,null);
 assert.equal(handoff.select([png])[0],selected[0]);assert.equal(calls.filter(x=>x[0]==='select').length,2);
 assert.throws(()=>handoff.select(['https://public.invalid/'+asset]),/Local files/);
 assert.throws(()=>handoff.select([new Blob(['x'],{type:'image/png'})]),/Local files/);
 await handoff.remove(selected[0].key);assert.deepEqual(revoked,['blob:local-1']);
 handoff.dispose();assert.equal(calls.at(-1)[0],'dispose');assert.throws(()=>handoff.select([png]),/unavailable/);
});
test('F05C invalid native selection still enters blocking transport; failed removal does not forget history',async()=>{
 let selected=0,removed=0;const root={File,URL:{createObjectURL:()=>{throw Error('no preview expected');},revokeObjectURL:()=>{}},crypto:{randomUUID:()=> 'invalid-key'}};
 vm.runInNewContext(readFileSync(new URL('../theme/native-files.js',import.meta.url),'utf8'),root);
 const h=root.BFLNativeFiles.create({transport:{select:()=>{selected++;return Promise.reject(Error('blocked'));},remove:()=>{removed++;return Promise.reject(Error('uncertain'));},dispose:()=>{}}});
 const file=new File(['x'],'not-image.txt',{type:'text/plain'}),s=h.select([file])[0];
 assert.equal(s.preview_url,null);await assert.rejects(s.completion,/blocked/);assert.equal(selected,1);
 await assert.rejects(h.remove(s.key),/uncertain/);assert.equal(h.select([file])[0],s);assert.equal(removed,1);h.dispose();
});
