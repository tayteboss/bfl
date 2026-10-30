// TEST ONLY --import shim: redirects the fixed staging request to an explicit
// loopback synthetic HTTP server. Runtime/operator has no such override.
const target=new URL(process.env.BFL_SYNTHETIC_HTTP??'invalid');
if(process.env.BFL_SYNTHETIC_OFFLINE_TEST!=='yes'||target.hostname!=='127.0.0.1'||target.protocol!=='http:'||target.pathname!=='/'||target.username||target.password||target.search)throw Error('OFFLINE_TEST_REQUIRED');
const original=globalThis.fetch;
globalThis.fetch=async(url,opts)=>{
  if(url!=='https://bellows-film-printing-staging.myshopify.com/admin/api/2026-10/graphql.json')throw Error('UNEXPECTED_ENDPOINT');
  const response=await original(target,opts);
  if(JSON.parse(opts.body).query.startsWith('mutation')&&process.env.BFL_SYNTHETIC_KILL_AFTER_COMMIT==='yes') {
    process.send?.({status:'synthetic_commit_applied'});
    await new Promise(()=>{setInterval(()=>{},1000);});
  }
  return response;
};
