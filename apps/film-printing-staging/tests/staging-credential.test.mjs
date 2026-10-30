import test from 'node:test';
import assert from 'node:assert/strict';
import {createStagingCredentialProvider,STAGING_CREDENTIAL_IDENTITY} from '../backend/staging-credential.mjs';
import {createAdminTransport,CATALOG_DELETE} from '../backend/admin.mjs';
import {createStorefrontReader} from '../checkout/storefront.mjs';
import {createCartCapabilityTransport} from '../checkout/cart-capability.mjs';
import {STORE,APP,CLIENT} from '../configuration/schema.mjs';
import {SHOP,INSTALLATION} from '../backend/config.mjs';
import {mockAdmin} from '../../../fixtures/film-printing/f06d/mock-admin.mjs';

const config={store:STORE,app:APP,clientId:CLIENT,installation:INSTALLATION,appSecret:'synthetic-app-secret-'.repeat(3),mode:'reconcile-only'};
const token=n=>'synthetic-token-'+String(n).padStart(32,'0');
const identity=()=>({shop:{id:SHOP,myshopifyDomain:STORE},currentAppInstallation:{id:INSTALLATION,app:{id:APP,apiKey:CLIENT}}});
const response=(body,{status=200,version='2026-10',type='application/json'}={})=>new Response(JSON.stringify(body),{status,headers:{'content-type':type,'x-shopify-api-version':version}});
function fixture({ttl=86400,auth,identify,fetcher,options={}}={}) {
 let time=1793336000000,serial=0;const calls=[];
 const fetchImpl=async(url,request)=>{
  calls.push({url,request});assert.equal(request.redirect,'error');assert.ok(request.signal instanceof AbortSignal);
  if(fetcher)return fetcher(url,request,calls.length);
  if(url.endsWith('/admin/oauth/access_token')){
   const fields=new URLSearchParams(request.body);
   assert.deepEqual([...fields.keys()].sort(),['client_id','client_secret','grant_type']);
   assert.equal(fields.get('grant_type'),'client_credentials');assert.equal(fields.get('client_id'),CLIENT);assert.equal(fields.get('client_secret'),config.appSecret);
   return auth?auth(++serial):response({access_token:token(++serial),expires_in:ttl});
  }
  assert.equal(url,`https://${STORE}/admin/api/2026-10/graphql.json`);
  assert.deepEqual(JSON.parse(request.body),{query:STAGING_CREDENTIAL_IDENTITY});
  assert.equal(request.headers['X-Shopify-Access-Token'],token(serial));
  return identify?identify():response({data:identity()});
 };
 const provider=createStagingCredentialProvider(config,{fetchImpl,now:()=>time,...options});
 return {provider,calls,setTime:t=>{time=t;},advance:ms=>{time+=ms;},now:()=>time};
}
test('existing-grant token is exact-target verified, cached, then replaced before original expiry',async()=>{
 const f=fixture(),start=f.now();assert.equal(await f.provider.read(),token(1));assert.equal(f.calls.length,2);
 f.advance(86400000-300001);assert.equal(await f.provider.read(),token(1));assert.equal(f.calls.length,2);
 f.advance(1);assert.equal(await f.provider.read(),token(2));assert.equal(f.calls.length,4);
 f.setTime(start+86400001);assert.equal(await f.provider.read(),token(2));assert.equal(f.calls.length,4);
});
test('concurrent initial and early-refresh readers share one acquisition and identity check',async()=>{
 let release;const wait=new Promise(r=>{release=r;});let authCalls=0;
 const f=fixture({auth:async serial=>{authCalls++;if(serial===1)await wait;return response({access_token:token(serial),expires_in:86400});}});
 const reads=Array.from({length:20},()=>f.provider.read());assert.equal(authCalls,1);release();
 assert.deepEqual(await Promise.all(reads),Array(20).fill(token(1)));assert.equal(f.calls.length,2);
 f.advance(86100000);assert.deepEqual(await Promise.all(Array.from({length:20},()=>f.provider.read())),Array(20).fill(token(2)));assert.equal(f.calls.length,4);
});
for(const field of ['store','app','clientId','installation'])test(`wrong configured ${field} rejects before network`,()=>{
 let calls=0;assert.throws(()=>createStagingCredentialProvider({...config,[field]:'wrong'},{fetchImpl:async()=>{calls++;}}),/WRONG_TARGET/);assert.equal(calls,0);
});
for(const [name,change] of [
 ['shop id',d=>{d.shop.id='gid://shopify/Shop/1';}],['shop domain',d=>{d.shop.myshopifyDomain='other.myshopify.com';}],
 ['installation',d=>{d.currentAppInstallation.id='gid://shopify/AppInstallation/1';}],['app id',d=>{d.currentAppInstallation.app.id='gid://shopify/App/1';}],
 ['client',d=>{d.currentAppInstallation.app.apiKey='other';}],
])test(`new token with wrong ${name} is never cached or returned`,async()=>{
 const f=fixture({identify:()=>{const d=identity();change(d);return response({data:d});}});
 await assert.rejects(f.provider.read(),/STAGING_CREDENTIAL_IDENTITY/);assert.equal(f.calls.length,2);
 await assert.rejects(f.provider.read(),/STAGING_CREDENTIAL_IDENTITY/);assert.equal(f.calls.length,4);
});
for(const [name,body] of [['missing token',{expires_in:86400}],['token control',{access_token:'bad\n',expires_in:86400}],
 ['zero TTL',{access_token:token(1),expires_in:0}],['too long TTL',{access_token:token(1),expires_in:86401}],['fraction TTL',{access_token:token(1),expires_in:1.1}],['string TTL',{access_token:token(1),expires_in:'86400'}]])
 test(`invalid token response ${name} stops before identity`,async()=>{const f=fixture({auth:()=>response(body)});await assert.rejects(f.provider.read(),/STAGING_CREDENTIAL_RESPONSE/);assert.equal(f.calls.length,1);});
test('identity GraphQL errors, wrong API version and invalid JSON fail closed',async()=>{
 for(const make of [()=>response({data:identity(),errors:[{message:'secret upstream text'}]}),()=>response({data:identity()},{version:'2026-07'}),()=>new Response('not-json',{headers:{'content-type':'application/json'}})]){
  const f=fixture({identify:make});await assert.rejects(f.provider.read(),e=>/^STAGING_CREDENTIAL_/.test(e.code)&&!e.message.includes('secret upstream'));assert.equal(f.calls.length,2);
 }
});
test('network, HTTP rejection, redirect, content type and oversized responses never retry or expose upstream text',async()=>{
 const cases=[async()=>{throw Error(config.appSecret);},async()=>response({error:config.appSecret},{status:401}),async()=>response({error:config.appSecret},{status:503}),
  async()=>({ok:true,redirected:true,status:200}),async()=>response({access_token:token(1),expires_in:86400},{type:'text/html'}),
  async()=>response({access_token:token(1),expires_in:86400,padding:'x'.repeat(70000)})];
 for(const fetcher of cases){const f=fixture({fetcher});await assert.rejects(f.provider.read(),e=>/^STAGING_CREDENTIAL_/.test(e.code)&&!e.message.includes(config.appSecret));assert.equal(f.calls.length,1);}
});
test('request timeout aborts without retry',async()=>{
 const f=fixture({options:{timeoutMs:5},fetcher:async(url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('private request timed out')),{once:true}))});
 await assert.rejects(f.provider.read(),/STAGING_CREDENTIAL_UNAVAILABLE/);assert.equal(f.calls.length,1);
});
test('token lifetime begins before exchange and an expired identity result is not cached',async()=>{
 let f;f=fixture({ttl:1,identify:()=>{f.advance(1000);return response({data:identity()});}});
 await assert.rejects(f.provider.read(),/STAGING_CREDENTIAL_EXPIRED/);assert.equal(f.calls.length,2);
});
test('failed early refresh never returns the rejected candidate or an expired cached token',async()=>{
 const f=fixture({auth:serial=>serial===1?response({access_token:token(serial),expires_in:86400}):response({error:'denied'},{status:401})});
 assert.equal(await f.provider.read(),token(1));f.advance(86100000);await assert.rejects(f.provider.read(),/STAGING_CREDENTIAL_REJECTED/);
 f.advance(300001);await assert.rejects(f.provider.read(),/STAGING_CREDENTIAL_REJECTED/);assert.equal(f.calls.length,4);
});
test('closing during verification prevents credential delivery; closed provider never reacquires',async()=>{
 let finish;const f=fixture({identify:()=>new Promise(r=>{finish=r;})});const read=f.provider.read();
 while(!finish)await new Promise(r=>setImmediate(r));f.provider.close();finish(response({data:identity()}));
 await assert.rejects(read,/STAGING_CREDENTIAL_EXPIRED/);await assert.rejects(f.provider.read(),/STAGING_CREDENTIAL_CLOSED/);assert.equal(f.calls.length,2);
});
const cartId='gid://shopify/Cart/synthetic-credential-cart?key=synthetic-key';
const emptyCart=()=>({id:cartId,updatedAt:'2026-10-30T00:00:00Z',buyerIdentity:{customer:null,purchasingCompany:null},totalQuantity:0,
 lines:{nodes:[],pageInfo:{hasNextPage:false,hasPreviousPage:false}},note:'',attributes:[],binding:null});
test('current-cart and capability transports read the current credential for every request',async()=>{
 let serial=0;const seen=[],credentialProvider={read:async()=>token(++serial)};
 const fetchImpl=async(url,o)=>{seen.push(o.headers['Shopify-Storefront-Private-Token']);const q=JSON.parse(o.body).query;
  return response(q.startsWith('mutation')?{data:{cartLinesUpdate:{cart:emptyCart(),userErrors:[],warnings:[]}}}:{data:{shop:{id:SHOP},cart:emptyCart()}},{version:'2026-07'});};
 const options={credentialProvider,fetchImpl},input={cart_id:cartId,buyerIp:'192.0.2.1'};
 const read=createStorefrontReader({store:STORE,shopId:SHOP,enabled:true},options),cap=createCartCapabilityTransport({store:STORE,shopId:SHOP,enabled:true},options);
 await read(input);await cap.read(input);await cap.check(input);assert.deepEqual(seen,[token(1),token(2),token(3)]);
});
test('Admin transport obtains dynamic credentials and never retries an auth-rejected or lost mutation',async()=>{
 for(const lost of [false,true]){
  const m=mockAdmin();m.data.currentAppInstallation.app.apiKey=CLIENT;let reads=0,writes=0;const seen=[];
  const api=createAdminTransport(config,{credentialProvider:{read:async()=>token(++reads)},sourceCustody:{isArmed:()=>false,deleteCatalog(){}},fetchImpl:async(url,o)=>{
   seen.push(o.headers['X-Shopify-Access-Token']);const {query,variables}=JSON.parse(o.body);
   if(query===CATALOG_DELETE){writes++;if(lost)throw Error('private lost-response details');return response({}, {status:401});}
   return response({data:await m.api(query,variables)});
  }});
  await assert.rejects(api(CATALOG_DELETE,{metafields:[]}),lost?/ADMIN_UNAVAILABLE/:/ADMIN_ACCESS_DENIED/);
  assert.equal(writes,1);assert.equal(reads,2);assert.deepEqual(seen,[token(1),token(2)]);
 }
});
test('capability mutation auth failure is sent once without refreshing/replaying',async()=>{
 let reads=0,writes=0;const cap=createCartCapabilityTransport({store:STORE,shopId:SHOP,enabled:true},{credentialProvider:{read:async()=>{reads++;return token(1);}},fetchImpl:async()=>{writes++;return response({}, {status:401,version:'2026-07'});}});
 await assert.rejects(cap.check({cart_id:cartId,buyerIp:'192.0.2.1'}),/CART_CAPABILITY_TRANSPORT/);assert.equal(reads,1);assert.equal(writes,1);
});
test('invalid dynamic credential or invalid caller request makes zero Shopify requests',async()=>{
 let calls=0;const options={credentialProvider:{read:async()=>''},fetchImpl:async()=>{calls++;}};
 await assert.rejects(createStorefrontReader({store:STORE,shopId:SHOP,enabled:true},options)({cart_id:cartId,buyerIp:'192.0.2.1'}),/STOREFRONT_CREDENTIAL_REQUIRED/);
 await assert.rejects(createCartCapabilityTransport({store:STORE,shopId:SHOP,enabled:true},options).read({cart_id:cartId,buyerIp:'bad'}),/BUYER_IP_REQUIRED/);
 assert.equal(calls,0);
});
