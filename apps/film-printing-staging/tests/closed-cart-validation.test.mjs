import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {cartValidationsGenerateRun as validate} from '../extensions/f02-print-validation/src/cart_validations_generate_run.js';
const fixture=name=>JSON.parse(readFileSync(new URL(`../extensions/f02-print-validation/tests/fixtures/${name}-job.json`,import.meta.url))).payload;
test('closed staging permits cart interaction while preserving every checkout rejection',()=>{
 const invalid=fixture('invalid'),valid=fixture('valid');
 for(const step of ['CHECKOUT_INTERACTION','CHECKOUT_COMPLETION',undefined,null,'unknown']){
  assert.deepEqual(validate({...invalid.input,buyerJourney:{step}}),invalid.output);
  assert.deepEqual(validate({...valid.input,buyerJourney:{step}}),valid.output);
 }
 assert.deepEqual(validate({...invalid.input,buyerJourney:{step:'CART_INTERACTION'}}),{operations:[]});
 assert.deepEqual(validate({...valid.input,buyerJourney:{step:'CART_INTERACTION'}}),{operations:[]});
 assert.deepEqual(validate(invalid.input),invalid.output);
});
