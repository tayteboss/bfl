import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHmac} from 'node:crypto';
import {createRuntime} from '../backend/server.mjs';
import {initializeDatabase} from '../backend/storage.mjs';
import {STORE,APP,CLIENT} from '../configuration/schema.mjs';
import {INSTALLATION} from '../backend/config.mjs';
import {STOREFRONT_ORIGIN} from '../backend/storefront-session.mjs';

// Offline protocol boundary regression. Shopify signatures are SYNTHETIC here;
// no positive owner resolver, remote request, cart or production DB is supplied.
for(const customer of ['', '123'])test(`context-only ${customer?'customer':'anonymous'} bearer cannot enter cookie owner routes`,async()=>{
  const dir=mkdtempSync(join(tmpdir(),'bfl-owner-boundary-'));chmodSync(dir,0o700);
  const config={store:STORE,app:APP,clientId:CLIENT,installation:INSTALLATION,dataDir:dir,
    origin:'https://film-printing-staging.bellowsfilmlab.com',host:'127.0.0.1',port:0,mode:'disabled',
    storefrontSessions:'context-only',jobSecret:'offline-job-secret-'.repeat(3),
    sessionSecret:'offline-session-secret-'.repeat(3),appSecret:'offline-app-secret-'.repeat(3)};
  config.databaseId=initializeDatabase(config);
  let ownerResolverCalls=0;
  const runtime=createRuntime(config,{api:async()=>{throw Error('OFFLINE_NO_ADMIN');},
    adapters:{resolveOwner:async()=>{ownerResolverCalls++;throw Error('NO_POSITIVE_OWNER_FIXTURE');}}});
  try {
    await runtime.start();const base=`http://127.0.0.1:${runtime.server.address().port}`;
    const post=(path,input,headers={})=>fetch(base+path,{method:'POST',headers:{origin:STOREFRONT_ORIGIN,'content-type':'application/json',...headers},body:JSON.stringify(input)});
    const challenge=await (await post('/session/challenge',{})).json();
    const q=new URLSearchParams({shop:STORE,path_prefix:'/apps/bfl-staging',logged_in_customer_id:customer,
      timestamp:String(Math.floor(Date.now()/1000)),challenge:challenge.challenge});
    q.set('signature',createHmac('sha256',config.appSecret).update([...q].map(([k,v])=>`${k}=${v}`).sort().join('')).digest('hex'));
    const bootstrap=await fetch(base+'/proxy/bootstrap?'+q);assert.equal(bootstrap.status,200);
    const {ticket}=await bootstrap.json();
    const exchange=await post('/session/exchange',{challenge:challenge.challenge,verifier:challenge.verifier,ticket});
    assert.equal(exchange.status,200);const {token}=await exchange.json();
    const authorization=`Bearer ${token}`;
    const context=await post('/session/context',{}, {authorization});assert.equal(context.status,200);
    const body=await context.json();assert.equal(body.customer_id,customer?'gid://shopify/Customer/123':null);
    assert.equal(body.cart_verified,false);assert.equal(body.checkout_ready,false);assert.equal(body.owner,undefined);
    const syntheticCookie=runtime.session.issue('offline-owner').split(';')[0];
    for(const headers of [
      {origin:STOREFRONT_ORIGIN,authorization},
      {origin:config.origin,authorization},
      {origin:config.origin,authorization,cookie:`bfl_session=${token}`},
      {origin:STOREFRONT_ORIGIN,authorization,cookie:syntheticCookie},
    ]){
      for(const path of ['/jobs','/quote']){
        const denied=await post(path,{owner:'offline-owner',customer_id:body.customer_id,complete:true},headers);
        assert.equal(denied.status,401);assert.equal((await denied.json()).code,'UNAUTHENTICATED');
      }
      await assert.rejects(runtime.refreshAuthority({headers},{owner:'offline-owner',cart_id:'untrusted',request_key:'untrusted'}),/OWNER_REJECTED/);
    }
    assert.equal(ownerResolverCalls,0);
    assert.equal((await post('/session/revoke',{}, {authorization})).status,200);
  }finally{await runtime.close();rmSync(dir,{recursive:true,force:true});}
});
