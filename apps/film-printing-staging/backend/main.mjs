import {readConfig,need,safeCode} from './config.mjs';
import {initializeDatabase,releaseAbandonedLock,migrateUploads,migrateCartRefresh,migrateOrders,migrateOrderInbox,migrateResourceSessions,migrateUploadCustody,migrateCartCapability,migrateOwnedCart} from './storage.mjs';
import {createOwnedCartRuntime} from './owned-cart.mjs';
import {createRuntime} from './server.mjs';
import {createUploadOnlyRuntime} from './upload-only.mjs';
import {createSessionOnlyRuntime} from './session-only.mjs';
process.umask(0o077);
let runtime;
try {
  const config=readConfig(),command=process.argv[2]??'serve';
  if(command==='init')console.log(JSON.stringify({database_id:initializeDatabase(config),checkout_ready:false}));
  else if(command==='migrate-uploads')console.log(JSON.stringify(migrateUploads(config)));
  else if(command==='migrate-cart-refresh')console.log(JSON.stringify(migrateCartRefresh(config)));
  else if(command==='migrate-orders')console.log(JSON.stringify(migrateOrders(config)));
  else if(command==='migrate-order-inbox')console.log(JSON.stringify(migrateOrderInbox(config)));
  else if(command==='migrate-resource-sessions')console.log(JSON.stringify(migrateResourceSessions(config)));
  else if(command==='migrate-upload-custody')console.log(JSON.stringify(migrateUploadCustody(config)));
  else if(command==='migrate-cart-capability')console.log(JSON.stringify(migrateCartCapability(config)));
  else if(command==='migrate-owned-cart')console.log(JSON.stringify(migrateOwnedCart(config)));
  else if(command==='release-lock') {
    releaseAbandonedLock(config,process.argv[3],process.argv[4]==='--all-writers-stopped');
    console.log(JSON.stringify({lock_released:true,database_unchanged:true}));
  } else {
    need(command==='serve','UNKNOWN_COMMAND');
    need(config.databaseId,'DATABASE_ID_REQUIRED');
    runtime=config.resourceSessions==='owned-cart'?createOwnedCartRuntime(config):config.resourceSessions==='upload-only'?createUploadOnlyRuntime(config):['session-only','session-only-closed'].includes(config.resourceSessions)?createSessionOnlyRuntime(config):
      createRuntime(config,{log:entry=>console.log(JSON.stringify(entry))});
    let stopping=false;
    const stop=async()=>{
      if(stopping)return;stopping=true;
      // A hung adapter must never lead to an unlocked DB with work still alive.
      // Hard exit retains the lock and pending operation for manual recovery.
      const hard=setTimeout(()=>process.exit(1),25000);hard.unref();
      await runtime.close();clearTimeout(hard);
    };
    process.on('SIGTERM',()=>void stop());process.on('SIGINT',()=>void stop());
    await runtime.start();
    console.log(JSON.stringify({event:'listening',port:config.port,checkout_ready:false}));
  }
} catch(error) {
  console.error(JSON.stringify({code:safeCode(error),checkout_ready:false}));
  if(runtime)await runtime.close();process.exitCode=1;
}
