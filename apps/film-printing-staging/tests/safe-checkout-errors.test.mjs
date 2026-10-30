import test from 'node:test';
import assert from 'node:assert/strict';
import {safeCode,RuntimeError} from '../backend/config.mjs';
import {ShippingError} from '../shipping/packing.mjs';

test('sanitized checkout journal retains only the approved internal failure enum',()=>{
 for(const code of ['INVALID_PRIOR_AUTHORITY','AUTHORITY_WRITE_REJECTED','AUTHORITY_READBACK_CHANGED','FUNCTION_OWNER_CHANGED','FUNCTION_LEASE_UNPROTECTED']){
  const error=new ShippingError(code);error.message='private upstream body and URL';assert.equal(safeCode(error),code);
 }
 assert.equal(safeCode(new RuntimeError('ADMIN_UNAVAILABLE')),'ADMIN_UNAVAILABLE');
 for(const error of [Error('private body'),new ShippingError('secret-token-value'),{code:'INVALID_PRIOR_AUTHORITY'},Object.assign(Error('private body'),{code:'UPSTREAM_URL_WITH_TOKEN'})])assert.equal(safeCode(error),'UNAVAILABLE');
});
