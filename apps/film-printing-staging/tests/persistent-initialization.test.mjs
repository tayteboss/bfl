import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,chmodSync,mkdtempSync,rmSync,existsSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {configuration} from '../../../fixtures/film-printing/f06p-composition/rig.mjs';
import {mockLeaseAdmin} from '../../../fixtures/film-printing/f06v3-candidate/mock-admin.mjs';
import {migrateCheckoutComposition,migratePreparedCart} from '../backend/storage.mjs';
import {initializePersistentStaging,readStagingMaterial} from '../backend/staging-main.mjs';
import {createPersistentStagingRuntime} from '../backend/staging-runtime.mjs';
import {preparePersistentStagingSources} from '../configuration/engineering.mjs';
import {CUSTOMER_VARIANTS_TARGET_QUERY,PERSISTENT_CUSTOMER_TARGET_QUERY,PERSISTENT_CUSTOMER_PUBLICATION} from '../backend/diagnostic-control.mjs';
import {VARIANTS_BY_LAB,decodeAuthority} from '../checkout/authority.js';
import {decodeCatalog} from '../checkout/shopify.mjs';
import {leaseEnvelope} from '../checkout/lease.mjs';
import {STORE,CLIENT} from '../configuration/schema.mjs';
const digest=b=>createHash('sha256').update(b).digest('hex');
const read=name=>JSON.parse(readFileSync(new URL('../../../fixtures/film-printing/full-product-lab-routing-20261030/'+name,import.meta.url)));
const files=JSON.parse(readFileSync(new URL('../../../fixtures/film-printing/f06p-integration/fixture-files.json',import.meta.url))).map(f=>({...f,bytes:readFileSync(new URL('../../../fixtures/film-printing/f06p-integration/'+f.path,import.meta.url))}));
function setup(t){
 const config={...configuration(t),mode:'disabled',adminToken:null,resourceSessions:'disabled',storefrontSessions:'disabled',host:'0.0.0.0',port:0,origin:'https://film-printing-staging.bellowsfilmlab.com',buyerIpMode:'caddy-direct'};migrateCheckoutComposition(config);migratePreparedCart(config);
 const clock={time:Date.parse('2026-10-30T05:00:00Z')};
 const specification_owner={id:'gid://shopify/Validation/999',functionId:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'};
 const m=mockLeaseAdmin({specificationOwner:specification_owner});m.data.currentAppInstallation.app.apiKey=CLIENT;m.data.currentAppInstallation.catalog=null;m.data.shop.storefrontAccessTokens={nodes:[],pageInfo:{hasNextPage:false,hasPreviousPage:false}};
 const manifest={kind:'bfl-persistent-staging-v1',specification_owner,engineering:preparePersistentStagingSources({config:read('engineering-config-proposal.json'),catalog:read('engineering-catalog-proposal.json'),issuedAt:clock.time})};
 let published=false,exchange=0,lose=false;const calls=[];
 const fetchImpl=async(url,options)=>{
  if(url===`https://${STORE}/admin/oauth/access_token`){exchange++;return new Response(JSON.stringify({access_token:'generated-existing-grant-token'.repeat(3),expires_in:86400}),{headers:{'content-type':'application/json'}});}
  assert.equal(url,`https://${STORE}/admin/api/2026-10/graphql.json`);const {query,variables}=JSON.parse(options.body);calls.push(query);let data;
  if(query===CUSTOMER_VARIANTS_TARGET_QUERY||query===PERSISTENT_CUSTOMER_TARGET_QUERY)data={...structuredClone(m.data),shop:{...structuredClone(m.data.shop),currencyCode:'USD'},publications:{nodes:[{id:PERSISTENT_CUSTOMER_PUBLICATION,name:'Online Store'}],pageInfo:{hasNextPage:false}},product:{id:'gid://shopify/Product/15620086005871',title:'F00 Film Printing Test',status:'ACTIVE',handle:'f00-film-printing-test',publishedOnPublication:published,onlineStoreUrl:null,hasOnlyDefaultVariant:false,variants:{nodes:Object.entries(VARIANTS_BY_LAB).map(([lab,id])=>({id,selectedOptions:[{name:'Lab',value:lab[0].toUpperCase()+lab.slice(1)}],price:'1.00',inventoryItem:{tracked:false,requiresShipping:true}})),pageInfo:{hasNextPage:false}}}};
  else{data=await m.api(query,variables);if(query.startsWith('mutation')&&m.data.currentAppInstallation.catalog){m.data.currentAppInstallation.catalog.id??='gid://shopify/Metafield/9991001';if(lose)throw Error('lost source response');}}
  return new Response(JSON.stringify({data}),{headers:{'content-type':'application/json','x-shopify-api-version':'2026-10'}});
 };
 const journalPath=join(config.dataDir,'persistent-source-initialization.jsonl');
 const rows=()=>{const db=new DatabaseSync(join(config.dataDir,'jobs.sqlite'),{readOnly:true});try{return Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(({name})=>[name,db.prepare(`SELECT * FROM ${name}`).all()]));}finally{db.close();}};
 const uploadConfig={store:STORE,app:config.app,publicKey:'synthetic-public-key',projectId:699888,cdnOrigin:'https://synthetic.ucarecd.net',secret:'synthetic-upload-secret'.repeat(3),delivery:{projectKey:'synthetic-public-key',origin:'https://synthetic.s.ucarecd.net',publicAccessDisabled:true,legacyAccessDisabled:true,signingSecret:'a'.repeat(64)}};
 return {config,clock,m,manifest,fetchImpl,journalPath,rows,uploadConfig,calls,get exchanges(){return exchange;},set published(v){published=v;},set lose(v){lose=v;}};
}
test('actual persistent initializer applies source once and clean runtime reopen never reapplies it',async t=>{
 const f=setup(t),before=f.rows(),params={config:f.config,manifest:f.manifest,journalPath:f.journalPath,fetchImpl:f.fetchImpl,now:()=>f.clock.time};
 await initializePersistentStaging(params);const initialized=f.rows();
 assert.equal(f.m.writes.length,1);assert.equal(f.exchanges,1);assert.equal(f.m.data.currentAppInstallation.active.value,f.manifest.engineering.releaseValue);assert.equal(f.m.data.currentAppInstallation.catalog.value,f.manifest.engineering.catalogValue);
 const authority=decodeAuthority(f.m.data.shop.authority.value);assert.equal(authority.price_version,decodeCatalog(f.manifest.engineering.catalogValue).version);assert.equal(authority.grants.length,0);
 assert.equal(f.m.data.leaseValidation.nodes[1].lease.value,leaseEnvelope(f.m.data.shop.authority.value));assert.equal(f.m.writes[0].filter(row=>row.key==='lease_v3').length,5);
 for(const table of ['jobs','upload_intents','resource_sessions','checkout_capability_attempts'])assert.deepEqual(initialized[table],before[table]);assert.equal(existsSync(join(f.config.dataDir,'runtime.lock')),false);
 assert.equal(readFileSync(f.journalPath,'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(e=>e.event==='persistent_source_initialized').length,1);
 await assert.rejects(initializePersistentStaging(params),{code:'EEXIST'});assert.equal(f.m.writes.length,1);assert.equal(f.exchanges,1);
 f.published=true;const options={config:f.config,manifest:f.manifest,files,uploadConfig:f.uploadConfig,fetchImpl:f.fetchImpl,now:()=>f.clock.time};
 const first=await createPersistentStagingRuntime(options);await first.close();f.clock.time+=86400000*3;const second=await createPersistentStagingRuntime(options);await second.close();
 assert.equal(f.m.writes.length,1);assert.equal(f.rows().authority_state[0].operation,null);assert.deepEqual(f.rows().resource_sessions,initialized.resource_sessions);
});
test('lost initializer source response remains spent, retains unknown authority and never retries mutation',async t=>{
 const f=setup(t);f.lose=true;const params={config:f.config,manifest:f.manifest,journalPath:f.journalPath,fetchImpl:f.fetchImpl,now:()=>f.clock.time};
 await assert.rejects(initializePersistentStaging(params));assert.equal(f.m.writes.length,1);assert.ok(f.rows().authority_state[0].operation);assert.equal(existsSync(join(f.config.dataDir,'runtime.lock')),false);
 f.lose=false;await assert.rejects(initializePersistentStaging(params),{code:'EEXIST'});assert.equal(f.m.writes.length,1);assert.equal(f.exchanges,1);
});
function material(t){
 const dir=mkdtempSync(join(tmpdir(),'bfl-material-review-'));chmodSync(dir,0o700);t.after(()=>rmSync(dir,{recursive:true,force:true}));const write=(name,data)=>writeFileSync(join(dir,name),data,{mode:0o600});
 for(const file of files)write(file.path,file.bytes);const inventory=Buffer.from(JSON.stringify({generated:'synthetic-inventory'}));write('shippo-inventory.json',inventory);write('carrier-path','/carrier/rates/'+'a'.repeat(64));
 const env={BFL_UPLOADCARE_API_FILE:join(dir,'upload-api'),BFL_UPLOADCARE_DELIVERY_FILE:join(dir,'upload-delivery'),BFL_SHIPPO_TEST_FILE:join(dir,'shippo-token')};write('upload-api','synthetic-uploadcare-secret'.repeat(3));write('upload-delivery','b'.repeat(64));write('shippo-token','shippo_test_'+'c'.repeat(64));
 const manifest={kind:'bfl-persistent-staging-v1',files:files.map(({bytes,...f})=>f),shipping:{inventory_sha256:digest(inventory)}};const raw=Buffer.from(JSON.stringify(manifest));write('service.json',raw);return {dir,env,path:join(dir,'service.json'),hash:digest(raw),read:()=>readStagingMaterial(join(dir,'service.json'),digest(raw),env)};
}
test('private staging material accepts exact manifest, fixtures, inventory and existing credential files',t=>{const f=material(t),value=f.read();assert.equal(value.files.length,3);assert.deepEqual(value.files[0].bytes,files[0].bytes);assert.equal(value.shipping.callbackPath,'/carrier/rates/'+'a'.repeat(64));assert.equal(value.uploadConfig.publicKey,'3c958e674d1b0653284b');});
for(const name of ['service.json','fixture-1.png','shippo-inventory.json','upload-api','upload-delivery','shippo-token','carrier-path'])test(`private material rejects public-readable ${name}`,t=>{const f=material(t);chmodSync(join(f.dir,name),0o644);assert.throws(f.read,/STAGING_PRIVATE_FILE/);});
test('private material rejects changed hashes and symlinked fixture before serving',t=>{const f=material(t);assert.throws(()=>readStagingMaterial(f.path,'0'.repeat(64),f.env),/STAGING_MANIFEST_CHANGED/);writeFileSync(join(f.dir,'fixture-1.png'),'changed');assert.throws(f.read,/STAGING_FIXTURE_CHANGED/);rmSync(join(f.dir,'fixture-1.png'));symlinkSync(join(f.dir,'fixture-2.png'),join(f.dir,'fixture-1.png'));assert.throws(f.read,/STAGING_PRIVATE_FILE/);});
