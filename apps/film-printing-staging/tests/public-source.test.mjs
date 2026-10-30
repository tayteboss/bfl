import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createPublicSource,publicAddress,sourceURL} from '../uploads/public-source.mjs';
import {MAX_IMAGE_BYTES} from '../uploads/uploadcare.mjs';
const png=readFileSync(new URL('../../../fixtures/film-printing/f06p-integration/fixture-1.png',import.meta.url));
function rig({answers=[{address:'93.184.216.34',family:4}],status=200,headers={'content-type':'image/png'},chunks=[png],resolve,timeoutMs=100}={}){
  const calls=[];let destroyed=false;
  const importSource=createPublicSource({timeoutMs,resolve:resolve??(async()=>answers),requestImpl:(url,options,callback)=>{
    calls.push({url,options});const req=new EventEmitter();req.destroy=()=>{destroyed=true;};
    req.end=()=>{const res=Readable.from(chunks);res.statusCode=status;res.headers=headers;callback(res);};return req;
  }});
  return {importSource,calls,get destroyed(){return destroyed;}};
}
test('reject unsafe URLs and IP spellings before resolution/transport',()=>{
  for(const url of ['http://public.org/a','https://127.1/a','https://2130706433/a','https://0x7f000001/a','https://[::1]/a','https://user:password@public.org/a','https://public.org:444/a','https://public.org/a#fragment','https://localhost/a','https://a.local/a','https://a.internal/a','https://a.test/a','https://public.org\\@localhost/a',' https://public.org/a'])assert.throws(()=>sourceURL(url),/SOURCE_URL_INVALID/,url);
});
test('private/reserved and mixed DNS answers never open a connection',async()=>{
  for(const address of ['0.1.2.3','10.0.0.1','100.100.100.200','127.0.0.1','169.254.169.254','172.31.1.1','192.168.1.1','192.0.0.8','192.0.2.1','192.88.99.1','198.19.1.1','198.51.100.1','203.0.113.1','224.0.0.1','255.255.255.255','::','::1','::ffff:127.0.0.1','64:ff9b::a00:1','fc00::1','fe80::1','ff02::1','2001::1','2001:db8::1','2002:7f00:1::','3fff::1']){
    assert.equal(publicAddress(address),false,address);
    const f=rig({answers:[{address:'93.184.216.34',family:4},{address,family:address.includes(':')?6:4}]});
    await assert.rejects(f.importSource('https://images.public.org/a'),/SOURCE_ADDRESS_REJECTED/);assert.equal(f.calls.length,0);
  }
});
test('connect only to the validated DNS answer with hostname TLS, no cookie/auth headers or pooled sockets',async()=>{
  const f=rig(),result=await f.importSource('https://images.public.org/not-a-fixture.png?token=private');
  assert.equal(result.source.sha256,createHash('sha256').update(png).digest('hex'));assert.deepEqual(result.bytes,png);
  assert.equal(result.source.origin,'https://images.public.org');assert.equal(JSON.stringify(result.source).includes('private'),false);
  const options=f.calls[0].options;assert.equal(options.servername,'images.public.org');assert.equal(options.agent,false);
  assert.deepEqual(Object.keys(options.headers).sort(),['Accept','Accept-Encoding']);
  options.lookup('images.public.org',{},(error,address,family)=>{assert.equal(error,null);assert.equal(address,'93.184.216.34');assert.equal(family,4);});
  options.lookup('images.public.org',{all:true},(error,answers)=>assert.deepEqual(answers,[{address:'93.184.216.34',family:4}]));
  assert.equal(publicAddress('2606:4700::1111'),true);
});
test('reject every redirect including metadata target without following it',async()=>{
  for(const status of [301,302,303,307,308]){
    const f=rig({status,headers:{location:'https://169.254.169.254/latest/meta-data'}});
    await assert.rejects(f.importSource('https://images.public.org/a'),/SOURCE_RESPONSE_REJECTED/);assert.equal(f.calls.length,1);assert.equal(f.destroyed,true);
  }
});
test('reject oversized declared/streamed, encoded, empty, truncated and nonimage responses',async()=>{
  for(const options of [
    {headers:{'content-type':'image/png','content-length':String(MAX_IMAGE_BYTES+1)}},
    {chunks:[Buffer.alloc(MAX_IMAGE_BYTES),Buffer.alloc(1)]},
    {headers:{'content-type':'image/png','content-encoding':'gzip'}},
    {headers:{'content-type':'text/html'}},{chunks:[]},{chunks:[Buffer.from('<html>no image</html>')]},
    {headers:{'content-type':'image/jpeg'}},{headers:{'content-type':'image/png','content-length':'1000'}}]){
    const f=rig(options);await assert.rejects(f.importSource('https://images.public.org/a'),/SOURCE_(BODY_LIMIT|IMAGE_INVALID)/);assert.equal(f.destroyed,true);
  }
});
test('DNS deadline expires without starting a late request',async()=>{
  let finish;const held=setTimeout(()=>{},100);const f=rig({timeoutMs:5,resolve:()=>new Promise(r=>{finish=r;})});
  await assert.rejects(f.importSource('https://images.public.org/a'),/SOURCE_TIMEOUT/);
  finish([{address:'127.0.0.1',family:4}]);await new Promise(r=>setImmediate(r));assert.equal(f.calls.length,0);clearTimeout(held);
});
