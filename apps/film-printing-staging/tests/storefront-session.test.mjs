import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {createServer} from 'node:http';
import {createStorefrontSessions,STOREFRONT_ORIGIN,PROXY_PREFIX} from '../backend/storefront-session.mjs';
import {createStorefrontSessionIngress} from '../backend/storefront-session-http.mjs';
const secret='s'.repeat(64),origin={headers:{origin:STOREFRONT_ORIGIN}};
let time=1800000000000;
function query(challenge,customer=''){
  const q=new URLSearchParams({shop:new URL(STOREFRONT_ORIGIN).hostname,path_prefix:PROXY_PREFIX,logged_in_customer_id:customer,timestamp:String(Math.floor(time/1000)),challenge});
  const message=[...q].map(([k,v])=>`${k}=${v}`).sort().join('');q.set('signature',createHmac('sha256',secret).update(message).digest('hex'));return q.toString();
}
function issue(s,customer=''){const c=s.challenge(origin),p=s.bootstrap(query(c.challenge,customer));return {c,p,result:s.exchange(origin,{...c,ticket:p.ticket})};}
function req(token){return {headers:{origin:STOREFRONT_ORIGIN,authorization:`Bearer ${token}`}};}
test('signed guest/customer context never claims an owner or verified cart',()=>{
 const s=createStorefrontSessions({secret,now:()=>time});for(const customer of ['', '123']){const {result}=issue(s,customer);const context=s.authenticate(req(result.token));assert.equal(context.customer_id,customer?'gid://shopify/Customer/123':null);assert.equal(context.cart_verified,false);assert.equal(context.checkout_ready,false);assert.equal(context.owner,undefined);}
});
test('response-only ticket + independent verifier are both required; signed-query replay denied',()=>{
 const s=createStorefrontSessions({secret,now:()=>time}),a=s.challenge(origin),b=s.challenge(origin),p=s.bootstrap(query(a.challenge,'123'));
 assert.throws(()=>s.exchange(origin,{challenge:a.challenge,verifier:a.verifier,ticket:'x'.repeat(43)}));
 assert.throws(()=>s.exchange(origin,{challenge:a.challenge,verifier:b.verifier,ticket:p.ticket}));
 assert.throws(()=>s.exchange(origin,{challenge:b.challenge,verifier:b.verifier,ticket:p.ticket}));
 assert.throws(()=>s.bootstrap(query(a.challenge,'123')));
 const result=s.exchange(origin,{...a,ticket:p.ticket});assert.equal(s.authenticate(req(result.token)).customer_id,'gid://shopify/Customer/123');assert.throws(()=>s.exchange(origin,{...a,ticket:p.ticket}));
});
test('foreign origins, forged customers, duplicate nonce and unknown sessions reject',()=>{
 const s=createStorefrontSessions({secret,now:()=>time}),c=s.challenge(origin);
 assert.throws(()=>s.challenge({headers:{origin:'https://evil.test'}}));assert.throws(()=>s.bootstrap(query(c.challenge).replace('logged_in_customer_id=','logged_in_customer_id=123')));
 assert.throws(()=>s.bootstrap(query(c.challenge)+'&challenge='+c.challenge));assert.throws(()=>s.authenticate(req('z'.repeat(43))));
 const {result}=issue(s);assert.throws(()=>s.authenticate({headers:{origin:'https://evil.test',authorization:`Bearer ${result.token}`}}));
});
test('expiry, explicit revoke and process restart discard context sessions',()=>{
 let clock=time;const s=createStorefrontSessions({secret,now:()=>clock}),{result}=issue(s);s.revoke(req(result.token));assert.throws(()=>s.authenticate(req(result.token)));
 const fresh=issue(s).result;clock+=60000;assert.throws(()=>s.authenticate(req(fresh.token)));
 clock=time;const restart=issue(s).result;s.close();assert.throws(()=>s.authenticate(req(restart.token)));
 assert.throws(()=>createStorefrontSessions({secret,now:()=>clock}).authenticate(req(restart.token)));
});
test('capacity limits cannot silently evict or revive sessions',()=>{
 const s=createStorefrontSessions({secret,now:()=>time,maxEntries:1}),c=s.challenge(origin);assert.throws(()=>s.challenge(origin));const p=s.bootstrap(query(c.challenge));s.exchange(origin,{...c,ticket:p.ticket});
 const next=s.challenge(origin),ticket=s.bootstrap(query(next.challenge)).ticket;assert.throws(()=>s.exchange(origin,{...next,ticket}));
});
test('actual HTTP bounds, CORS, proxy replay and context isolation',async()=>{
 const ingress=createStorefrontSessionIngress({secret,now:()=>time});const server=createServer(async(req,res)=>{if(!await ingress.handle(req,res)){res.writeHead(404);res.end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 const post=(path,data={},extra={})=>fetch(base+path,{method:'POST',headers:{origin:STOREFRONT_ORIGIN,'content-type':'application/json',...extra},body:JSON.stringify(data)});
 try {
  assert.equal((await post('/session/challenge',{}, {origin:'https://evil.test'})).status,403);
  const c=await (await post('/session/challenge')).json();const p=await fetch(base+'/proxy/bootstrap?'+query(c.challenge,'123'));
  assert.equal(p.status,200);assert.equal(p.headers.get('access-control-allow-origin'),null);assert.equal(p.headers.get('cache-control'),'no-store');const {ticket}=await p.json();
  assert.equal((await fetch(base+'/proxy/bootstrap?'+query(c.challenge,'123'))).status,403);
  const response=await post('/session/exchange',{challenge:c.challenge,verifier:c.verifier,ticket});assert.equal(response.headers.get('access-control-allow-origin'),STOREFRONT_ORIGIN);const {token}=await response.json();
  assert.equal((await post('/session/context',{}, {authorization:`Bearer ${token}`})).status,200);
  assert.equal((await post('/session/context',{owner:'forged'},{authorization:`Bearer ${token}`})).status,403);
  assert.equal((await post('/session/challenge',{x:'a'.repeat(2000)})).status,403);
  assert.equal((await post('/jobs',{}, {authorization:`Bearer ${token}`})).status,404);
  assert.equal((await post('/session/revoke',{}, {authorization:`Bearer ${token}`})).status,200);
  assert.equal((await post('/session/context',{}, {authorization:`Bearer ${token}`})).status,403);
 } finally {ingress.close();await new Promise(r=>server.close(r));}
});
test('uninstalled browser helper revokes prior and superseded context tokens',async()=>{
 const saved=globalThis.location;globalThis.location={origin:STOREFRONT_ORIGIN};
 try {
  const {createStorefrontContext}=await import('../theme/storefront-session.js');const calls=[];let serial=0;const held=[];
  const fake=async(url,init)=>{calls.push({url,init});if(url.endsWith('/session/challenge'))return {ok:true,json:async()=>({challenge:'c'+(++serial),verifier:'v'})};
   if(url.startsWith('/apps/'))return {ok:true,json:async()=>({ticket:'t'})};
   if(url.endsWith('/session/exchange')){const n=held.length+1;return new Promise(resolve=>held.push(()=>resolve({ok:true,json:async()=>({token:'t'+n,expires_in:60,cart_verified:false,checkout_ready:false,context:{customer_id:null}})})));}
   return {ok:true,json:async()=>({revoked:true})};};
  const helper=createStorefrontContext({backendOrigin:'https://staging.example.test',fetchImpl:fake});
  const a=helper.bootstrap();await new Promise(r=>setImmediate(r));const b=helper.bootstrap();await new Promise(r=>setImmediate(r));
  held[0]();await assert.rejects(a,/SESSION_SUPERSEDED/);held[1]();await b;
  await helper.revoke();await assert.rejects(helper.context(),/SESSION_EXPIRED/);
  assert.deepEqual(calls.filter(c=>c.url.endsWith('/session/revoke')).map(c=>c.init.headers.Authorization),['Bearer t1','Bearer t2']);
  assert.ok(calls.filter(c=>c.url.startsWith('https:')).every(c=>c.init.credentials==='omit'));
  assert.ok(calls.filter(c=>c.url.startsWith('/apps/')).every(c=>c.init.credentials==='same-origin'));
 } finally {if(saved===undefined)delete globalThis.location;else globalThis.location=saved;}
});
test('expired browser context renews on the first attempt; live revocation failures still reject',async()=>{
 const saved=globalThis.location;globalThis.location={origin:STOREFRONT_ORIGIN};
 try {
  const {createStorefrontContext}=await import('../theme/storefront-session.js');let clock=time,serial=0;const calls=[];
  const fake=async(url)=>{calls.push(url);
   if(url.endsWith('/session/revoke'))return {ok:false,status:403};
   if(url.endsWith('/session/challenge'))return {ok:true,json:async()=>({challenge:'c'+(++serial),verifier:'v'})};
   if(url.startsWith('/apps/'))return {ok:true,json:async()=>({ticket:'t'})};
   if(url.endsWith('/session/exchange'))return {ok:true,json:async()=>({token:'t'+serial,expires_in:60,cart_verified:false,checkout_ready:false,context:{customer_id:null}})};
   throw Error('UNEXPECTED_REQUEST');
  };
  const helper=createStorefrontContext({backendOrigin:'https://staging.example.test',fetchImpl:fake,now:()=>clock});
  await helper.bootstrap();clock+=60000;
  await assert.rejects(helper.context(),/SESSION_EXPIRED/);
  assert.deepEqual(await helper.bootstrap(),{customer_id:null});
  assert.equal(serial,2);assert.equal(calls.filter(url=>url.endsWith('/session/revoke')).length,0);
  await assert.rejects(helper.bootstrap(),/SESSION_UNAVAILABLE/);
  assert.equal(serial,2);assert.equal(calls.filter(url=>url.endsWith('/session/revoke')).length,1);
  await assert.rejects(helper.context(),/SESSION_EXPIRED/);
 } finally {if(saved===undefined)delete globalThis.location;else globalThis.location=saved;}
});
