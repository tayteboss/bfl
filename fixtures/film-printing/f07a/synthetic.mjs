// GENERATED LOCAL ONLY. None of these identities names a Shopify store/product.
import {fingerprint} from '../../../apps/film-printing-staging/jobs/lifecycle.mjs';
export const line = (key, product, variant, properties = {}, quantity = 1) => ({
  key, product_id:String(product), variant_id:String(variant), quantity, properties,
  price:1900, final_price:1700, discounts:[{amount:200}], selling_plan:false,
});
export function fixture() {
  const snapshot = {store:'f07a-synthetic.invalid', cart_binding:'synthetic-cart-binding',
    attributes:{gift:'keep'}, note:'synthetic', currency:'USD', discounts:[{title:'fixture'}],
    delivery:{selection:'pickup',group:'synthetic-group'}, items:[
      line('main:key',101,1001,{_timestamp:'1792600000000',_custom_price_cents:'1','Files Uploaded':'7'}),
      line('small:key',102,1002,{_role:'shipping_size',_parent_timestamp:'1792600000000',_package:'Small'},3),
      line('partial:key',102,1003,{_role:'shipping_size',_parent_timestamp:'1792600000000',_package:'Partial'},1),
      line('send:key',103,1004,{_return_shipping_required:'true',_timestamp:'1792600000000'},2),
      line('return:key',104,1005,{_role:'return_shipping',_parent_timestamp:'1792600000000'}),
      line('other:key',105,1006,{engraving:'keep'},4),
      line('current:key',106,1007,{_bfl_job:'synthetic-job',_bfl_revision:'1',_bfl_signature:'synthetic-only'}),
    ]};
  // Send Rolls timestamp is deliberately the same. Remove it for the positive case;
  // the collision case asserts a hold even with a proposed independent review.
  delete snapshot.items[3].properties._timestamp;
  const identities = {store:snapshot.store,environment:'synthetic',review_ref:'synthetic-map-only',entries:[
    {product_id:'101',variant_id:'1001',kind:'legacy-print'},
    {product_id:'102',variant_id:'1002',kind:'print-companion'},
    {product_id:'102',variant_id:'1003',kind:'print-companion'},
    {product_id:'103',variant_id:'1004',kind:'send-rolls'},
    {product_id:'104',variant_id:'1005',kind:'return-shipping'},
    {product_id:'106',variant_id:'1007',kind:'current-print'},
  ]};
  const evidence = {review_ref:'synthetic-lineage-only',groups:[{main:'main:key',companions:['small:key','partial:key'],complete:true,proof_ref:'synthetic-complete-association'}],
    current:[{key:'current:key',state:'verified-active-immutable',proof_ref:'synthetic-existing-authority-resolution'}]};
  return reseal({snapshot,identities,evidence,pending:false});
}
// TEST ONLY: models new independent evidence after synthetic edits, never authenticates.
export function reseal(x) {
  x.evidence.snapshot_hash=fingerprint(x.snapshot); x.evidence.identity_hash=fingerprint(x.identities);return x;
}
