import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,chmodSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {reserveDiagnosticJournal,startDiagnosticOperator,RUN_ID} from '../backend/diagnostic-operator.mjs';
import {retireDiagnostic} from '../backend/diagnostic-retire.mjs';
import {rig} from '../../../fixtures/film-printing/f06p-composition/rig.mjs';

test('private operator proposal and default mode reject before any credential, DB or transport access',async()=>{
 let calls=0;
 for(const options of [{},{enabled:true,plan:{phase:'proposal'}},{enabled:true,plan:{phase:'reviewed-integrated',run_id:RUN_ID,source_eligibility:'engineering-only'}}])
  await assert.rejects(startDiagnosticOperator({...options,fetchImpl:()=>{calls++;throw Error('network');}}),/OPERATOR_DISABLED/);
 assert.equal(calls,0);
});

test('durable run latch is exclusive and retained; private permissions enforced',t=>{
 const dir=mkdtempSync(join(tmpdir(),'bfl-diagnostic-latch-'));chmodSync(dir,0o700);t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const journal=reserveDiagnosticJournal(dir,'a'.repeat(64));journal.append({event:'test'});journal.close();
 assert.throws(()=>reserveDiagnosticJournal(dir,'b'.repeat(64)),/EEXIST/);
 const rows=readFileSync(join(dir,RUN_ID+'.spent.jsonl'),'utf8').trim().split('\n').map(JSON.parse);assert.equal(rows[0].plan_sha256,'a'.repeat(64));assert.equal(rows.length,2);
 chmodSync(dir,0o755);assert.throws(()=>reserveDiagnosticJournal(dir,'a'.repeat(64)),/PRIVATE_DIAGNOSTIC_DIRECTORY/);
});

test('stopped-writer recovery retires only journaled new principals and clears pending unknown via normal CAS writer',async t=>{
 const f=rig(t),token=f.issue(),ticket=f.store.resourceSessions.authenticate(f.request(token));
 await f.bind(token);await f.install(token);
 const history=[{event:'reserved',run_id:RUN_ID,plan_sha256:'a'.repeat(64)},{event:'issued_owner',owner:ticket.owner},{event:'installed_marker',marker:f.rows('cart_checkout_bindings')[0].marker}];
 await assert.rejects(retireDiagnostic({store:f.store,admin:f.admin,history,planHash:'a'.repeat(64)}),/DIAGNOSTIC_RECOVERY_REVIEW/);
 f.store.lifecycle.event('generated-crash-event',{generated:true},()=>{});f.store.lifecycle.startRecovery();
 const result=await retireDiagnostic({store:f.store,admin:f.admin,history,planHash:'a'.repeat(64),enabled:true});
 assert.equal(result.authority_cleared,true);assert.equal(result.provider_cleanup_confirmed,false);assert.equal(result.cart_cleanup_confirmed,false);
 assert.equal(f.store.lifecycle.retired('owner',ticket.owner),true);assert.equal(f.store.lifecycle.state().pending,0);assert.equal(f.store.lifecycle.state().operation,null);
 assert.equal(f.rows('cart_checkout_bindings')[0].state,'retired');
 assert.equal(JSON.parse(f.m.data.shop.authority.value).grants.length,0);
});
