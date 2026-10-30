/* No widget or UI installation. F05 may attach this to BFLCompletedUploads after
 * its authenticated relay transport is proven. Receipts are display state only;
 * jobs revalidate all asset IDs on the server regardless of this snapshot. */
(function(root){
  function create({now=Date.now}={}) {
    const entries=new Map(),blocked=new Set();
    const terminal=s=>s==='removed'||s==='failed';
    return {
      // Call before any asynchronous selection/upload/removal operation. Keep
      // blocked after transport uncertainty until a status receipt is obtained.
      pending(key){blocked.add(key);},
      discardUnstarted(key){blocked.delete(key);},
      apply(receipt,key=receipt?.intent_id) {
        if(!receipt||receipt.schema!==1||typeof receipt.intent_id!=='string'||
          !Number.isSafeInteger(receipt.version)||receipt.version<1||
          !['issued','sending','pending','complete','failed','removed'].includes(receipt.state)||
          !Number.isSafeInteger(receipt.expires_at)||receipt.checkout_ready!==false||
          (receipt.state==='complete'?!/^[a-f0-9-]{36}$/.test(receipt.asset_id):receipt.asset_id!==null))throw Error('Invalid upload receipt');
        const prior=entries.get(receipt.intent_id);
        if(prior&&receipt.version<prior.version)return;
        if(prior&&receipt.version===prior.version){if(JSON.stringify(prior)!==JSON.stringify(receipt))throw Error('Conflicting upload receipt');blocked.delete(key);return;}
        if(prior&&terminal(prior.state)&&receipt.state!==prior.state&&!(prior.state==='failed'&&receipt.state==='removed'))throw Error('Retired upload');
        entries.set(receipt.intent_id,{...receipt});blocked.delete(key);
      },
      snapshot(){
        const rows=[...entries.values()].filter(e=>e.state!=='removed');
        return {pending:blocked.size+rows.filter(e=>!terminal(e.state)&&(e.state!=='complete'||e.expires_at<=now())).length,
          failed:rows.filter(e=>e.state==='failed').length,
          displayCompletedCount:rows.filter(e=>e.state==='complete').length,
          completedAssetIds:rows.filter(e=>e.state==='complete'&&e.expires_at>now()).map(e=>e.asset_id)};
      },
      // A failed entry can leave the form only after server removal or an
      // explicit form reset; reset is allowed only after F05 completes its flow.
      reset(){entries.clear();blocked.clear();},
    };
  }
  root.BFLUploadLifecycle={create};
  if(typeof module!=='undefined'&&module.exports)module.exports={create};
})(typeof window!=='undefined'?window:globalThis);
