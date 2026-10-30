import {readFileSync,lstatSync,openSync,writeSync,fsyncSync,closeSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {readConfig,need,safeCode} from './config.mjs';
import {STORE,APP} from '../configuration/schema.mjs';
import {createPersistentStagingRuntime,openStagingStorage} from './staging-runtime.mjs';
import {createPersistentStagingScope} from '../configuration/engineering.mjs';
import {createEngineeringSourceOperator} from '../configuration/engineering-operator.mjs';
import {createStagingCredentialProvider} from './staging-credential.mjs';
import {createAdminTransport} from './admin.mjs';
import {INVENTORY_QUERY} from './diagnostic-operator.mjs';
import {verifyCustomerTarget} from './diagnostic-control.mjs';

const digest=value=>createHash('sha256').update(value).digest('hex');
function privateFile(path,max=1048576){
 need(typeof path==='string'&&path.startsWith('/'),'STAGING_PRIVATE_FILE');const stat=lstatSync(path);
 need(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&(stat.mode&0o077)===0&&stat.size>0&&stat.size<=max,'STAGING_PRIVATE_FILE');return readFileSync(path);
}
function secret(path,min=32,max=2048){const value=privateFile(path,4096).toString('utf8').replace(/\r?\n$/,'');need(value.length>=min&&value.length<=max&&/^[\x21-\x7e]+$/.test(value),'STAGING_PRIVATE_FILE');return value;}
export function readStagingMaterial(path,hash,env=process.env){
 const raw=privateFile(path);need(/^[a-f0-9]{64}$/.test(hash??'')&&digest(raw)===hash,'STAGING_MANIFEST_CHANGED');
 const manifest=JSON.parse(raw),directory=dirname(path);
 need(manifest?.kind==='bfl-persistent-staging-v1'&&Array.isArray(manifest.files)&&manifest.files.length===3&&manifest.shipping,'STAGING_MANIFEST_CHANGED');
 const files=manifest.files.map(file=>{need(/^fixture-[123]\.png$/.test(file.path),'STAGING_FIXTURE_CHANGED');const bytes=privateFile(join(directory,file.path),1048576);need(digest(bytes)===file.sha256,'STAGING_FIXTURE_CHANGED');return {...file,bytes};});
 const inventoryRaw=privateFile(join(directory,'shippo-inventory.json'));need(digest(inventoryRaw)===manifest.shipping.inventory_sha256,'STAGING_MANIFEST_CHANGED');
 return {manifest,files,uploadConfig:{store:STORE,app:APP,publicKey:'3c958e674d1b0653284b',projectId:699888,cdnOrigin:'https://2082t3ckh5.ucarecd.net',
  secret:secret(env.BFL_UPLOADCARE_API_FILE,20,256),delivery:{projectKey:'3c958e674d1b0653284b',origin:'https://2082t3ckh5.s.ucarecd.net',publicAccessDisabled:true,legacyAccessDisabled:true,signingSecret:secret(env.BFL_UPLOADCARE_DELIVERY_FILE)}},
  shipping:{callbackPath:secret(join(directory,'carrier-path'),79,79),token:secret(env.BFL_SHIPPO_TEST_FILE,20,256),inventory:JSON.parse(inventoryRaw)}};
}
// One explicit initial source cutover under the same writer lock. This command
// is never a startup retry; its exclusive journal and additive schema retain any
// uncertain initialization for exact readback/recovery by the operator.
export async function initializePersistentStaging({config,manifest,journalPath,fetchImpl=fetch,now=Date.now}){
 need(config.mode==='disabled'&&config.resourceSessions==='disabled'&&!config.adminToken,'STAGING_RUNTIME_TARGET');
 const fd=openSync(journalPath,'wx',0o600),record=event=>{writeSync(fd,JSON.stringify(event)+'\n');fsyncSync(fd);};
 const credentials=createStagingCredentialProvider(config,{fetchImpl,now});let storage;
 try{
  const api=createAdminTransport(config,{credentialProvider:credentials,fetchImpl}),identity=await api(INVENTORY_QUERY),tokens=identity.shop?.storefrontAccessTokens;
  need(tokens?.nodes?.length===0&&tokens.pageInfo?.hasNextPage===false&&tokens.pageInfo.hasPreviousPage===false,'STAGING_PUBLIC_WRITER_UNRESOLVED');
  const sourceScope=createPersistentStagingScope({...manifest.engineering,identity,now});
  await verifyCustomerTarget(api,{sourceScope});
  storage=openStagingStorage(config,{sourceScope,now,initialize:true});
  const sources=createEngineeringSourceOperator({config:{...config,mode:'reconcile-only'},storage,sourceScope,append:record,fetchImpl,now,eligibility:true,specificationOwner:manifest.specification_owner,credentialProvider:credentials});
  await sources.apply();record({event:'persistent_source_initialized',source_sha256:manifest.engineering.contract.release_sha256});
 }finally{storage?.close();credentials.close();closeSync(fd);}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 process.umask(0o077);let runtime;
 try{
  const [command,path,hash,...extra]=process.argv.slice(2);need(['serve','initialize'].includes(command)&&extra.length===0,'STAGING_COMMAND');
  const config=readConfig(),material=readStagingMaterial(path,hash);
  if(command==='initialize')await initializePersistentStaging({config,manifest:material.manifest,journalPath:join(config.dataDir,'persistent-source-initialization.jsonl')});
  else {
   runtime=await createPersistentStagingRuntime({config,...material,record:event=>console.log(JSON.stringify(event))});
   let stopping=false;const stop=async()=>{if(stopping)return;stopping=true;const hard=setTimeout(()=>process.exit(1),30000);hard.unref();try{await runtime.close();}finally{clearTimeout(hard);}};
   process.on('SIGINT',()=>{void stop();});process.on('SIGTERM',()=>{void stop();});await runtime.start();
  }
 }catch(error){
  const code=safeCode(error);console.error(JSON.stringify({code,checkout_ready:false}));if(runtime)await runtime.close().catch(()=>{});
  // Network failures can retry under the one-container supervisor. A durable
  // invariant failure must remain visible, without an automatic mutation loop.
  process.exitCode=/UNAVAILABLE|TIMEOUT|EXPIRED$/.test(code)?1:78;
 }
}
