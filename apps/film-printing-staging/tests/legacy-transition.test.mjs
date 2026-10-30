import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {classifyLegacyCart as classify,prepareLegacyTransition as prepare,LIMITS} from '../transition/legacy-cart.mjs';
import {fixture,reseal,line} from '../../../fixtures/film-printing/f07a/synthetic.mjs';
const held = x => { const p=classify(x); assert.equal(p.state,'hold'); assert.deepEqual(p.remove_keys,[]); assert.equal(p.executable,false);return p; };

test('T01/T02 exact reviewed legacy group includes every partial-package line and quantity',()=>{
 const x=fixture(), before=structuredClone(x), p=classify(x);
 assert.equal(p.state,'review-only');assert.deepEqual(p.remove_keys,['main:key','small:key','partial:key']);
 assert.deepEqual(p.preserve_keys,['send:key','return:key','other:key','current:key']);assert.deepEqual(x,before);
 const preview=prepare(x).inspectFresh(x);assert.equal(preview.state,'transport-disabled');
 assert.deepEqual(preview.proposed_changes,p.remove_keys.map(id=>({id,quantity:0})));
 assert.equal(preview.executable,false);assert.equal(preview.checkout_ready,false);
});
test('T03 no independent lineage, orphan, missing companion, empty association all hold',()=>{
 for(const edit of [x=>delete x.evidence,x=>x.evidence.groups=[],x=>x.snapshot.items.splice(1,1),x=>x.evidence.groups[0].companions=[]]){
  const x=fixture();edit(x);if(x.evidence)reseal(x);held(x);
 }
});
test('T04 shared, absent, malformed timestamps and duplicate keys/properties hold',()=>{
 for(const edit of [x=>x.snapshot.items[3].properties._timestamp='1792600000000',x=>delete x.snapshot.items[0].properties._timestamp,
 x=>x.snapshot.items[0].properties._timestamp='yesterday',x=>delete x.snapshot.items[1].properties._parent_timestamp,
 x=>x.snapshot.items[1].key='main:key',x=>x.snapshot.items[0].properties=[{name:'_timestamp',value:'a'},{name:'_timestamp',value:'b'}]]){
 const x=fixture();edit(x);held(reseal(x));}
});
test('T04 same-variant distinct jobs and complete distinct groups are not deduplicated',()=>{
 const x=fixture();x.snapshot.items.push(line('second:key',101,1001,{_timestamp:'1792600000001'}),
 line('second-small:key',102,1002,{_role:'shipping_size',_parent_timestamp:'1792600000001'},2));
 x.evidence.groups.push({main:'second:key',companions:['second-small:key'],complete:true,proof_ref:'synthetic-second'});
 assert.equal(classify(reseal(x)).remove_keys.length,5);
 x.evidence.groups[1].companions.push('small:key');held(reseal(x));
});
test('T05/T06 every current claim is preserved; missing/expired/consumed proof holds',()=>{
 for(const state of ['expired','retired','consumed','replayed','pending','browser-verified']){
 const x=fixture();x.evidence.current[0].state=state;held(reseal(x));}
 const x=fixture();x.evidence.current=[];held(reseal(x));
 x.snapshot.items[0].properties._bfl_job='forged-current';held(reseal(x));
});
test('T05 current signed claim on legacy exact variant is retained, never converted',()=>{
 const x=fixture();x.snapshot.items=x.snapshot.items.filter(l=>!['small:key','partial:key'].includes(l.key));
 x.snapshot.items[0].properties._bfl_job='synthetic-current';x.evidence.groups=[];
 x.evidence.current.push({key:'main:key',state:'verified-active-immutable',proof_ref:'synthetic-resolution'});
 assert.equal(classify(reseal(x)).state,'no-change');
});
test('T07/T08 synthetic selective effect preserves Send Rolls, return dependency and all unrelated bytes',()=>{
 const x=fixture(), p=classify(x), after=structuredClone(x.snapshot);
 // Test-local no-network effect only; production module never dispatches these changes.
 after.items=after.items.filter(l=>!p.remove_keys.includes(l.key));
 assert.deepEqual(after.items,x.snapshot.items.slice(3));
 for(const field of ['attributes','note','currency','discounts','delivery'])assert.deepEqual(after[field],x.snapshot[field]);
 assert.equal(after.items[0].quantity,2);assert.equal(after.items[1].quantity,1);assert.equal(after.items[2].final_price,1700);
 const o=prepare(x).observeOutcome({snapshot:after,outcome:'acknowledged'});
 assert.equal(o.observation,'targets-absent');assert.equal(o.preserved_lines_equal,true);assert.equal(o.state,'hold');
});
test('T07 legacy negative-return flags or return role on targeted items veto the whole group',()=>{
 for(const index of [0,1])for(const props of [{_return_shipping_required:'true'},{'Negatives shipped back':'yes'},{_role:'return_shipping'}]){
 const x=fixture();Object.assign(x.snapshot.items[index].properties,props);held(reseal(x));}
});
test('T10 role/handle/timestamp/price/public URL never supplies product or lineage authority',()=>{
 for(const edit of [x=>x.evidence.groups=[],x=>x.identities.entries=[],x=>x.snapshot.items[0].product_id='999',
 x=>x.snapshot.items[0].variant_id='999',x=>x.snapshot.items[0].properties._role='shipping_size']){
 const x=fixture();x.snapshot.items[0].handle='film-printing';x.snapshot.items[0].properties.url='https://example.invalid/public.jpg';
 x.snapshot.items[0].properties.verified='true';edit(x);held(reseal(x));}
 for(const handle of ['film-service','print-shipping']){const x=fixture();x.snapshot.items[5].handle=handle;held(reseal(x));}
});
test('T10 exact unrelated identity with forged companion role is held, never removed',()=>{
 const x=fixture();x.snapshot.items[5].properties={_role:'shipping_size',_parent_timestamp:'1792600000000'};
 held(reseal(x));
 x.evidence.groups[0].companions.push('other:key');held(reseal(x));
});
test('identity maps reject conflicts, unsupported variants, production and invented staging mappings',()=>{
 for(const edit of [x=>x.identities.entries.push({...x.identities.entries[0],kind:'send-rolls'}),
 x=>x.identities.environment='production-reference',x=>x.snapshot.store='1jukgy-dc.myshopify.com',
 x=>{x.snapshot.store=x.identities.store='bellows-film-printing-staging.myshopify.com';x.identities.environment='isolated-staging';}]){
 const x=fixture();edit(x);held(reseal(x));}
});
test('T09 pending/unknown is default, including identical snapshots and all valid proofs',()=>{
 for(const pending of [undefined,true,'unknown',null])held({...fixture(),pending});
 const x=fixture();delete x.pending;held(x);
});
test('T09 fresh inspection rejects another tab quantity, price, key, attribute, owner or review change',()=>{
 const edits=[x=>x.snapshot.items[0].quantity++,x=>x.snapshot.items[0].key='rotated:key',x=>x.snapshot.items.shift(),
 x=>x.snapshot.items[5].price++,x=>x.snapshot.attributes.gift='changed',x=>x.snapshot.owner_binding='changed',
 x=>x.evidence.review_ref='new-review',x=>x.identities.review_ref='new-map'];
 for(const edit of edits){const x=fixture(), intent=prepare(x), fresh=structuredClone(x);edit(fresh);reseal(fresh);
 const r=intent.inspectFresh(fresh);assert.equal(r.state,'hold');assert.equal(r.proposed_changes,undefined);}
});
test('T09 local preview cannot prevent edit after equal read and never dispatches or replays',()=>{
 const x=fixture(), intent=prepare(x);assert.equal(intent.inspectFresh(x).state,'transport-disabled');
 x.snapshot.items[5].quantity=99;
 assert.deepEqual(intent.inspectFresh(x).reasons,['INTENT_ALREADY_INSPECTED']);
 const o=intent.observeOutcome({snapshot:x.snapshot,outcome:'unknown'});
 assert.equal(o.preserved_lines_equal,false);assert.equal(o.state,'hold');
});
test('T09 timeout, lost response, partial failure and rejected outcomes require observation and new review',()=>{
 for(const outcome of ['unknown','partial','rejected','acknowledged'])for(const count of [0,1,3]){
 const x=fixture(), intent=prepare(x), s=structuredClone(x.snapshot);s.items.splice(0,count);
 const o=intent.observeOutcome({snapshot:s,outcome});assert.equal(o.state,'hold');assert.equal(o.executable,false);
 assert.equal(o.observation,count===0?'targets-present':count===3?'targets-absent':'partial');
 assert.equal(intent.inspectFresh(x).state,'hold');}
 assert.deepEqual(prepare(fixture()).observeOutcome({}).reasons,['OUTCOME_UNOBSERVED']);
});
test('bounded snapshots, exact nonnumeric keys and unsupported structures fail closed',()=>{
 for(const edit of [x=>x.snapshot.items[0].key='1001',x=>x.snapshot.items[0].quantity=0,
 x=>x.snapshot.items[0].components=[],x=>x.snapshot.items[0].selling_plan='anything',
 x=>x.snapshot.note='x'.repeat(LIMITS.bytes),x=>x.snapshot.items=Array(LIMITS.lines+1).fill(x.snapshot.items[0])]){
 const x=fixture();edit(x);held(reseal(x));}
});
test('no network, release, lifecycle or authority writer exists in preparation; output is immutable',()=>{
 const x=fixture();let calls=0;x.transport=()=>{calls++;throw Error('must not call');};
 x.publish=x.transport;x.clear=x.transport;x.restore=x.transport;
 const intent=prepare(x);intent.inspectFresh(x);intent.observeOutcome({snapshot:x.snapshot});assert.equal(calls,0);
 assert.throws(()=>intent.plan.remove_keys.push('other:key'),TypeError);
 const source=readFileSync(new URL('../transition/legacy-cart.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(source,/\bfetch\s*\(|cart\/clear|createLifecycle\s*\(|\.publish\s*\(/);
});
test('outcome observation cannot reconcile another cart or changed context as the original',()=>{
 const x=fixture(), s=structuredClone(x.snapshot);s.cart_binding='foreign-cart';
 assert.deepEqual(prepare(x).observeOutcome({snapshot:s}).reasons,['OUTCOME_UNOBSERVED']);
 s.cart_binding=x.snapshot.cart_binding;s.attributes.gift='new value';
 const o=prepare(x).observeOutcome({snapshot:s});assert.equal(o.cart_context_equal,false);assert.equal(o.state,'hold');
});
test('no partial removal plan escapes the local removal bound',()=>{
 const x=fixture();for(let n=0;n<LIMITS.removals;n++){
 const key=`extra:${n}`;x.snapshot.items.push(line(key,102,1002,{_role:'shipping_size',_parent_timestamp:'1792600000000'}));
 x.evidence.groups[0].companions.push(key);}
 const p=held(reseal(x));assert.ok(p.reasons.includes('REMOVAL_BOUNDS'));
});
test('default, malformed, pending and stale-evidence cases produce no change intents',()=>{
 for(const x of [undefined,{}, {...fixture(),pending:true}, {...fixture(),evidence:{}}]){
 const i=prepare(x);assert.equal(i.plan.state,'hold');assert.equal(i.inspectFresh(fixture()).proposed_changes,undefined);}
 const x=fixture();x.snapshot.items[0].quantity++;held(x);
});
