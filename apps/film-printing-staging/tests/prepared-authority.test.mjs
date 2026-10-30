import test from 'node:test';
import assert from 'node:assert/strict';
import {scenario} from '../../../fixtures/film-printing/f06p-candidate/synthetic.mjs';
import {inspectCart,decodeAuthority} from '../checkout/authority.js';
import {serializeAuthority} from '../checkout/projector.mjs';
import {leaseEnvelope,leaseDeadline} from '../checkout/lease.mjs';
import {quantitySignature,immutableSignature} from '../checkout/quantity-signature.js';
import {cartTransformRun,cartValidationsGenerateRun} from '../checkout/functions.js';

async function fixture(t,count=2){
  const s=await scenario({count});t.after(()=>s.store.close());
  const authority=structuredClone(s.prepared.authority);authority.schema=3;
  authority.lease={token:'a'.repeat(64),deadline:'2026-10-21T12:04:00',expires_at:1792584240000};
  for(const grant of authority.grants)for(const line of grant.lines)delete line.quantity;
  const input=structuredClone(s.input);delete input.shop.authority;
  input.shop.localTime={beforeDeadline:true};input.leaseOwner={lease:{value:leaseEnvelope(serializeAuthority(authority))}};
  for(const line of input.cart.lines)line.signature.value=quantitySignature(line.signature.value,line.quantity);
  return {input,authority};
}
test('V3 eligibility prices actual quantities and unique subsets without republishing',async t=>{
  const {input,authority}=await fixture(t);assert.ok(decodeAuthority(serializeAuthority(authority)));
  assert.equal(inspectCart(input).lines.length,2);
  input.cart.lines.pop();input.cart.deliverableLines.pop();
  const line=input.cart.lines[0],raw=authority.grants[0].lines[0].claims.signature;
  line.quantity=2;line.signature.value=quantitySignature(raw,2);line.cost.subtotalAmount.amount='2.40';
  assert.equal(inspectCart(input).valid,true);assert.equal(inspectCart(input).lines[0].physical_count,6);
  assert.equal(cartTransformRun(input).operations[0].lineUpdate.price.adjustment.fixedPricePerUnit.amount,'1.20');
  assert.deepEqual(cartValidationsGenerateRun(input),{operations:[]});
  input.cart.lines=[];input.cart.deliverableLines=[];assert.equal(inspectCart(input).valid,true);
});
test('V3 rejects merged duplicate, split duplicate, altered claims and expiry',async t=>{
  const {input}=await fixture(t,1);
  const changes=[i=>i.cart.lines[0].quantity*=2,i=>i.cart.lines.push({...structuredClone(i.cart.lines[0]),id:'gid://shopify/CartLine/duplicate'}),
    i=>i.cart.lines[0].signature.value=i.cart.lines[0].signature.value.replace(/:4$/,':04'),
    i=>i.cart.lines[0].files.value='1',i=>i.cart.binding.value='b'.repeat(64),i=>i.shop.localTime.beforeDeadline=false,
    i=>i.leaseOwner.lease.value=i.leaseOwner.lease.value.replace('12:04:00','12:05:00'),i=>delete i.leaseOwner.lease,
    i=>i.cart.lines[0].quantity=10001];
  for(const change of changes){const i=structuredClone(input);change(i);assert.equal(inspectCart(i).valid,false);assert.deepEqual(cartTransformRun(i),{operations:[]});}
});
test('V3 cannot be authorized by a legacy Shop-only input or an unrelated buyer',async t=>{
  const {input,authority}=await fixture(t,1);
  const i=structuredClone(input);delete i.leaseOwner;i.shop.authority={value:serializeAuthority(authority)};i.shop.localTime.date=authority.valid_on;
  assert.equal(inspectCart(i).valid,false);
  input.cart.buyerIdentity={isAuthenticated:true,customer:{id:'gid://shopify/Customer/123'}};assert.equal(inspectCart(input).valid,false);
});
test('V3 retains actual aggregate value bound',async t=>{
  const {input,authority}=await fixture(t);for(const [index,line] of input.cart.lines.entries()){
    line.quantity=1000;line.signature.value=quantitySignature(authority.grants[0].lines[index].claims.signature,1000);
  }
  assert.equal(inspectCart(input).valid,false);
});
test('quantity envelope normalizes only canonical matching actual quantities',()=>{
  const raw='c'.repeat(64);assert.equal(immutableSignature(raw,3),raw);assert.equal(immutableSignature(quantitySignature(raw,3),3),raw);
  for(const value of [`v3:${raw}:03`,`v3:${raw}:4`,`v3:${raw}:3x`])assert.equal(immutableSignature(value,3),null);
});
test('deadline floors original expiry, respects shop midnight and rejects DST transition',()=>{
  const now=Date.parse('2026-10-21T15:00:00.750Z'),end=now+240000;
  assert.equal(leaseDeadline(end,now,'America/New_York').expires_at,Math.floor(end/1000)*1000);
  const midnight=Date.parse('2026-10-22T03:59:00Z');assert.equal(leaseDeadline(midnight+240000,midnight,'America/New_York').expires_at,Date.parse('2026-10-22T04:00:00Z'));
  const dst=Date.parse('2026-11-01T05:59:00Z');assert.throws(()=>leaseDeadline(dst+240000,dst,'America/New_York'),/TIMEZONE_TRANSITION/);
});
