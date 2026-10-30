// Offline, one-shot authority recovery. No listener, migration, admission or source writer.
import {pathToFileURL} from 'node:url';
import {lstatSync,openSync,fsyncSync,closeSync,writeFileSync} from 'node:fs';
import {dirname,resolve,join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {readConfig,need,safeCode} from './config.mjs';
import {openDatabase} from './storage.mjs';
import {createAdminTransport} from './admin.mjs';
import {createAuthorityAdmin,CONTEXT_QUERY} from '../checkout/shopify.mjs';

export async function reconcileOnce(config,{expectedEpoch,expectedPending,allWritersStopped=false,fetchImpl=fetch}={}) {
  need(allWritersStopped===true,'STOP_ALL_WRITERS_FIRST');
  need(config.mode==='reconcile-only'&&config.adminToken&&config.resourceSessions==='disabled'&&
    config.storefrontSessions==='disabled'&&!config.cartToken&&!config.uploadcare,'RECONCILE_ONLY_REQUIRED');
  need(Number.isSafeInteger(expectedEpoch)&&expectedEpoch>=7&&expectedPending===2,'EXPECTED_HISTORY_REQUIRED');
  // Reuse CURRENT schema/identity/key/trigger/lock checks. No session method is
  // called; historical resource-purpose retirement rules remain unchanged.
  const storage=openDatabase(config,{resourceSessions:true,sessionOnly:true,currentClosed:true});
  try {
    const db=new DatabaseSync(join(config.dataDir,'jobs.sqlite'),{readOnly:true});
    try {need(JSON.parse(db.prepare('SELECT value FROM runtime_identity WHERE singleton=1').get().value).schema===9,'DATABASE_MIGRATION_REQUIRED');} finally {db.close();}
    const lifecycle=storage.store.lifecycle,before=lifecycle.state();
    need(before.epoch===expectedEpoch&&before.pending===expectedPending,'HISTORY_CHANGED');
    let requests=0,mutations=0;
    const transport=createAdminTransport(config,{fetchImpl:async(...args)=>{
      need(++requests<=9,'REQUEST_LIMIT');return fetchImpl(...args);
    }});
    const api=async(query,variables={})=>{
      need(query===CONTEXT_QUERY||query.startsWith('mutation F06DCommitAuthority('),'ADMIN_OPERATION_REJECTED');
      if(query!==CONTEXT_QUERY)need(++mutations===1,'MUTATION_LIMIT');
      return transport(query,variables);
    };
    const admin=createAuthorityAdmin(api,{writesEnabled:true,lifecycle});
    const current=await admin.read({allowMissingCatalog:true});
    need(current.field,'AUTHORITY_DEFINITION_REQUIRED');
    need(current.fence?.type==='single_line_text_field'&&current.fence.compareDigest&&
      /^[a-f0-9-]{36}$/.test(current.fence.value),'AUTHORITY_FENCE_REQUIRED');
    // Missing prerequisites retain the prior pending/unknown state. An explicit
    // later recovery reads actual remote state; it never replays an old write.
    const result=await admin.reconcile();
    const after=lifecycle.state();
    need(after.epoch===expectedEpoch+1&&after.pending===0&&!after.operation,'RECOVERY_UNACKNOWLEDGED');
    return {...result,cart_verified:false,epoch:after.epoch,pending:0,requests,mutations};
  } finally {storage.close();}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  process.umask(0o077);
  try {
    const [epoch,pending,out,...extra]=process.argv.slice(2);
    need(process.env.BFL_AUTHORITY_OPERATOR==='reconcile-once'&&!extra.length&&/^\d+$/.test(epoch??'')&&pending==='2'&&out,'OPERATOR_DISABLED');
    need(process.env.BFL_ALL_WRITERS_STOPPED==='yes','STOP_ALL_WRITERS_FIRST');
    const config=readConfig(),output=resolve(out),parent=dirname(output),s=lstatSync(parent);
    need(s.isDirectory()&&!s.isSymbolicLink()&&(s.mode&0o077)===0,'PRIVATE_RECEIPT_DIRECTORY_REQUIRED');
    const fd=openSync(output,'wx',0o600);
    try {
      fsyncSync(fd);const dir=openSync(parent,'r');try{fsyncSync(dir);}finally{closeSync(dir);}
      const result=await reconcileOnce(config,{expectedEpoch:Number(epoch),expectedPending:2,allWritersStopped:true});
      writeFileSync(fd,JSON.stringify(result)+'\n');fsyncSync(fd);
      console.log(JSON.stringify({status:'reconciled',cart_verified:false,checkout_ready:false}));
    } finally {closeSync(fd);}
  } catch(error) {console.error(JSON.stringify({code:safeCode(error),cart_verified:false,checkout_ready:false}));process.exitCode=1;}
}
