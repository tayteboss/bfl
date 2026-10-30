// TEST-ONLY Node --import shim. Replaces fetch entirely; no external network.
// Used to kill the real operator CLI after a synthetic remote atomic commit.
import {readFileSync,writeFileSync} from 'node:fs';
import {syntheticAdmin} from './operator-fixture.mjs';
const path=process.env.BFL_SYNTHETIC_REMOTE_FILE;
if(!path || !process.env.BFL_SYNTHETIC_OFFLINE_TEST)throw Error('OFFLINE_TEST_REQUIRED');
const mock=syntheticAdmin(JSON.parse(readFileSync(path,'utf8')));
mock.afterWrite=async()=>{
  writeFileSync(path,JSON.stringify(mock.data),{mode:0o600});
  if(process.env.BFL_SYNTHETIC_KILL_AFTER_COMMIT==='yes') {
    process.send?.({status:'synthetic_commit_applied'});
    await new Promise(()=>{setInterval(()=>{},1000);});
  }
};
globalThis.fetch=mock.fetch;
