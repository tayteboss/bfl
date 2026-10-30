import test from 'node:test';
import assert from 'node:assert/strict';
import {createResourceSession} from '../theme/resource-session.js';
const origin='https://bellows-film-printing-staging.myshopify.com';
globalThis.location={origin};
const secret='private diagnostic sentinel';
async function reject(fetchImpl){const steps=[],s=createResourceSession({fetchImpl,observe:x=>steps.push(x)});await assert.rejects(s.issue(),/RESOURCE_UNAVAILABLE/);assert(!JSON.stringify(steps).includes(secret));return steps.filter(x=>x.stage!=='timing');}
test('challenge transport and JSON failures emit only fixed categories',async()=>{
 const network=new TypeError(secret);assert.deepEqual(await reject(async()=>{throw network;}),[{stage:'session-proof-request',state:'failed',phase:'transport',error:'TypeError'}]);
 assert.deepEqual(await reject(async()=>({ok:true,json:async()=>{throw new SyntaxError(secret);}})),[{stage:'session-proof-request',state:'failed',phase:'json',error:'SyntaxError'}]);
 const arbitrary=Error(secret);arbitrary.name=secret;assert.equal((await reject(async()=>{throw arbitrary;}))[0].error,'UNAVAILABLE');
});
test('challenge rejection reports status and known code without response fields',async()=>{
 for(const [code,expected] of [['RESOURCE_CAPACITY','RESOURCE_CAPACITY'],[secret,'UNAVAILABLE']]){
  assert.deepEqual(await reject(async()=>({ok:false,status:403,json:async()=>({code,challenge:secret,verifier:secret})})),[{stage:'session-proof-request',state:'rejected',status:403,code:expected}]);
 }
});
test('invalid challenge shape emits booleans and does not continue to proxy',async()=>{
 let calls=0;const result=await reject(async()=>{calls++;return {ok:true,json:async()=>({challenge:secret,verifier:'a'.repeat(43),purpose:'bfl:resource-fresh-proof:v1',audience:origin+'/bfl-application-resources',action:'issue',expires_in:30})};});
 assert.equal(calls,1);assert.deepEqual(result,[{stage:'session-proof-shape',state:'rejected',challenge_valid:false,verifier_valid:true,purpose_matches:true,audience_matches:true,action_matches:true,expiry_matches:true}]);
 const nullable=await reject(async()=>({ok:true,json:async()=>null}));assert.equal(nullable[0].state,'rejected');assert(Object.entries(nullable[0]).filter(([k])=>!['stage','state'].includes(k)).every(([,v])=>v===false));
});
