import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {resolveDirectBuyerIp,CADDY_PEER} from '../backend/buyer-ip.mjs';
import {createStorefrontSessionIngress} from '../backend/storefront-session-http.mjs';
import {STOREFRONT_ORIGIN} from '../backend/storefront-session.mjs';
import {createStorefrontReader} from '../checkout/storefront.mjs';
import {SHOP} from '../backend/config.mjs';

const request=()=>({method:'POST',url:'/session/challenge',socket:{remoteAddress:CADDY_PEER},
 headers:{origin:STOREFRONT_ORIGIN,'x-bfl-direct-peer':'198.51.100.7'},rawHeaders:['X-BFL-Direct-Peer','198.51.100.7']});
test('synthetic trusted direct peer accepts IPv4/IPv6 and ignores arbitrary forwarding chains',()=>{
 for(const ip of ['198.51.100.7','2001:db8::7','::ffff:198.51.100.7']) {
  const req=request();req.socket.remoteAddress='::ffff:'+CADDY_PEER;req.headers['x-bfl-direct-peer']=ip;
  Object.assign(req.headers,{'x-forwarded-for':'203.0.113.9','forwarded':'for=203.0.113.9','x-real-ip':'203.0.113.9','shopify-storefront-buyer-ip':'203.0.113.9'});
  assert.equal(resolveDirectBuyerIp(req),ip.startsWith('::ffff:')?ip.slice(7):ip);
 }
});
test('synthetic forged peer, duplicate, missing, malformed and ambiguous addresses reject',()=>{
 for(const peer of ['172.18.0.1','172.18.0.4','127.0.0.1',undefined]){const req=request();req.socket.remoteAddress=peer;assert.throws(()=>resolveDirectBuyerIp(req),/BUYER_IP_PEER_REJECTED/);}
 for(const ip of [undefined,['198.51.100.7'],'198.51.100.7, 203.0.113.9','198.51.100.7:443',' 198.51.100.7','fe80::1%eth0','not-an-ip']){const req=request();req.headers['x-bfl-direct-peer']=ip;assert.throws(()=>resolveDirectBuyerIp(req),/BUYER_IP_HEADER_REJECTED/);}
 for(const raw of [undefined,[],['X-BFL-Direct-Peer','198.51.100.7','x-bfl-direct-peer','203.0.113.9']]){const req=request();req.rawHeaders=raw;assert.throws(()=>resolveDirectBuyerIp(req),/BUYER_IP_HEADER_REJECTED/);}
});
test('proxy paths, queries, other methods/origins and private routes never provide buyer IP',()=>{
 for(const url of ['/proxy/bootstrap','/proxy/bootstrap?signature=synthetic','/session/challenge?signature=synthetic','/jobs','/uploads']){const req=request();req.url=url;assert.throws(()=>resolveDirectBuyerIp(req),/BUYER_IP_DIRECT_REQUIRED/);}
 for(const method of ['GET','OPTIONS']){const req=request();req.method=method;assert.throws(()=>resolveDirectBuyerIp(req),/BUYER_IP_DIRECT_REQUIRED/);}
 const req=request();req.headers.origin='https://evil.test';assert.throws(()=>resolveDirectBuyerIp(req),/BUYER_IP_DIRECT_REQUIRED/);
});
test('synthetic private reader composition forwards only the resolved IP with the exact Shopify header',async()=>{
 let calls=0;const read=createStorefrontReader({store:new URL(STOREFRONT_ORIGIN).hostname,shopId:SHOP,privateToken:'synthetic-private-token-'.repeat(2),enabled:true},{fetchImpl:async(url,options)=>{
  calls++;assert.equal(options.headers['Shopify-Storefront-Buyer-IP'],'198.51.100.7');assert.equal(options.headers['X-Forwarded-For'],undefined);
  return {status:503};
 }});
 await assert.rejects(read({cart_id:'gid://shopify/Cart/synthetic?key=synthetic',buyerIp:resolveDirectBuyerIp(request())}),/STOREFRONT_UNAVAILABLE/);
 assert.equal(calls,1);
});
test('actual loopback HTTP cannot spoof the Caddy peer; proxy bootstrap bypasses IP capture only',async()=>{
 let resolved=0;const ingress=createStorefrontSessionIngress({secret:'s'.repeat(64),resolveBuyerIp:req=>{resolved++;return resolveDirectBuyerIp(req);}});
 const server=createServer(async(req,res)=>{if(!await ingress.handle(req,res)){res.writeHead(404);res.end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 try {
  const rejected=await fetch(base+'/session/challenge',{method:'POST',headers:{origin:STOREFRONT_ORIGIN,'content-type':'application/json','x-bfl-direct-peer':'198.51.100.7','x-forwarded-for':CADDY_PEER},body:'{}'});
  assert.equal(rejected.status,403);assert.equal((await rejected.json()).code,'BUYER_IP_PEER_REJECTED');assert.equal(resolved,1);
  const proxy=await fetch(base+'/proxy/bootstrap?signature=synthetic');assert.equal(proxy.status,403);assert.equal(resolved,1);
 } finally {ingress.close();await new Promise(r=>server.close(r));}
});

test('F06N owned-cart direct routes require the exact trusted peer and overwritten single IP header',()=>{
 for(const path of ['/owned-cart/bind','/owned-cart/status']){
  const req=request();req.url=path;req.headers['x-forwarded-for']='203.0.113.100';
  assert.equal(resolveDirectBuyerIp(req),'198.51.100.7');
  req.socket.remoteAddress='127.0.0.1';assert.throws(()=>resolveDirectBuyerIp(req),/PEER_REJECTED/);
  req.socket.remoteAddress=CADDY_PEER;req.url+='?proof=synthetic';assert.throws(()=>resolveDirectBuyerIp(req),/DIRECT_REQUIRED/);
 }
});

test('finite F06P direct routes preserve peer, origin, method and single-header enforcement',()=>{
 for(const action of ['bind','install','publish','observe','inspect','resources','copy_item','control','continue']){
  const req=request();req.url='/diagnostic/checkout/'+action;assert.equal(resolveDirectBuyerIp(req),'198.51.100.7');
  for(const change of [r=>r.url+='?x=1',r=>r.method='GET',r=>r.socket.remoteAddress='127.0.0.1',r=>r.headers.origin='https://evil.test',r=>r.rawHeaders.push('x-bfl-direct-peer','1.1.1.1')]){
   const altered=structuredClone(req);change(altered);assert.throws(()=>resolveDirectBuyerIp(altered));
  }
 }
});
