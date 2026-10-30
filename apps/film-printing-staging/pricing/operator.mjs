import {canonical} from '../configuration/config.mjs';
import {need} from '../backend/config.mjs';
import {openDatabase} from '../backend/storage.mjs';
import {createAuthorityAdmin} from '../checkout/shopify.mjs';
import {publishPriceCatalog} from '../jobs/catalog.mjs';
import {verifyPreparedCatalog,prepareCatalog,sha256} from './prepare.mjs';
import {createPricingTransport,TARGET,TARGET_QUERY,describe} from './operator-admin.mjs';

const equal=(a,b)=>canonical(a)===canonical(b);
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&equal(Object.keys(v).sort(),[...keys].sort());
const text=v=>typeof v==='string'&&v.trim().length>0&&v.length<=5000;
const stamp=v=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(v)&&Number.isFinite(Date.parse(v));
const bytes=b=>({price_version:b.version,catalog_sha256:sha256(b.value),form_sha256:sha256(b.formValue),source_version:b.diagnostics.source_version});
function validateReview(review,config,input,bundle,now,{recovery=false}={}) {
  need(exact(review,['schema','status','target','database_id','bundle','inspected_at','current','current_values','approved_at','expires_at','source_refresh','unavailable_gate_evidence']),'OPERATOR_REVIEW_INVALID');
  need(review.schema===1&&equal(review.target,TARGET)&&review.database_id===config.databaseId&&equal(review.bundle,bytes(bundle)),'OPERATOR_REVIEW_INVALID');
  need(exact(review.current,['form','active','catalog','authority','fence'])&&exact(review.current_values,['form','catalog']),'OPERATOR_REVIEW_INVALID');
  for(const [key,f] of Object.entries(review.current)) {
    need(f===null?['form','catalog'].includes(key):exact(f,['type','sha256','compare_digest'])&&f.type===(key==='fence'?'single_line_text_field':'json')&&/^[a-f0-9]{64}$/.test(f.sha256)&&text(f.compare_digest),'OPERATOR_REVIEW_INVALID');
  }
  for(const key of ['form','catalog'])need(review.current[key]===null?review.current_values[key]===null:
    typeof review.current_values[key]==='string'&&sha256(review.current_values[key])===review.current[key].sha256,'OPERATOR_REVIEW_INVALID');
  // Recovery only revokes. An old/unapproved inspection can identify observed
  // source bytes, but cannot authorize a source write.
  if(recovery)return;
  need(review.status==='approved_staging_form_catalog_import'&&stamp(review.inspected_at)&&stamp(review.approved_at)&&stamp(review.expires_at)&&text(review.unavailable_gate_evidence),'OPERATOR_APPROVAL_REQUIRED');
  const approved=Date.parse(review.approved_at),expires=Date.parse(review.expires_at),inspected=Date.parse(review.inspected_at),time=now().getTime();
  need(inspected<=approved&&approved<=time&&expires>approved&&time<=expires&&expires-inspected<=86400000,'OPERATOR_REVIEW_EXPIRED');
  need(exact(review.source_refresh,['capture','evidence'])&&text(review.source_refresh.evidence),'SOURCE_REFRESH_REQUIRED');
  const refreshed=prepareCatalog({...input,capture:review.source_refresh.capture});
  const captured=Date.parse(review.source_refresh.capture.captured_at);
  need(captured<=approved&&time-captured<=86400000&&equal(refreshed.catalog.rows,bundle.catalog.rows)&&refreshed.diagnostics.source_version===bundle.diagnostics.source_version,'SOURCE_REFRESH_CHANGED_OR_EXPIRED');
}

// The caller is a trusted, stopped-runtime operator, never a public request.
export async function runPricingOperator({action,mode='disabled',config,input,prepared,review,allWritersStopped=false,now=()=>new Date(),fetchImpl,transportOptions={}}) {
  need(['inspect','apply','recover'].includes(action)&&mode===action,'OPERATOR_DISABLED');
  need(config.mode==='disabled','RUNTIME_WRITES_MUST_BE_DISABLED');
  need(allWritersStopped===true,'STOP_ALL_WRITERS_FIRST');
  const bundle=verifyPreparedCatalog(input,prepared);
  if(action!=='inspect')validateReview(review,config,input,bundle,now,{recovery:action==='recover'});
  const db=openDatabase(config,{now:()=>now().getTime()});
  try {
    const api=createPricingTransport(config,{...transportOptions,mode:action,bundle,review,now,fetchImpl});
    const admin=createAuthorityAdmin(api,{writesEnabled:action==='recover',lifecycle:db.store.lifecycle,now});
    if(action==='apply') {
      const state=db.store.lifecycle.state();need(!state.operation&&!state.pending,'OPERATOR_RECOVERY_REQUIRED');
      const current=await admin.read({allowMissingCatalog:true}),target=await api(TARGET_QUERY);
      need(equal(describe(current,target),review.current),'OPERATOR_REVIEW_STALE');
      await publishPriceCatalog(api,bundle.value,{writesEnabled:true,lifecycle:db.store.lifecycle,now});
      db.store.cartRefresh.recovered();
      return {status:'imported_empty_authority',...bytes(bundle),checkout_ready:false};
    }
    if(action==='recover') {
      // Always a fresh guarded grant clearing/fence rotation, never retry import.
      await admin.reconcile();db.store.cartRefresh.recovered();
      let state='unobserved';
      try {
        const current=await admin.read({allowMissingCatalog:true}),target=await api(TARGET_QUERY);
        const form=target.product.form?.value??null,catalog=current.catalogField?.value??null;
        state=form===bundle.formValue&&catalog===bundle.value?'both_proposed':
          form===review.current_values.form&&catalog===review.current_values.catalog?'both_prior':'mixed_or_changed';
      } catch { /* Revocation succeeded; inability to inspect never means import. */ }
      return {status:'revoked_review_required',source_state:state,checkout_ready:false};
    }
    const current=await admin.read({allowMissingCatalog:true}),target=await api(TARGET_QUERY),state=db.store.lifecycle.state();
    // No grants/customer identifiers or credentials in the private review file.
    return {schema:1,status:state.operation||state.pending?'recovery_required_do_not_apply':'unreviewed_do_not_apply',target:TARGET,database_id:config.databaseId,bundle:bytes(bundle),inspected_at:now().toISOString(),
      current:describe(current,target),current_values:{form:target.product.form?.value??null,catalog:current.catalogField?.value??null},
      approved_at:null,expires_at:null,source_refresh:null,unavailable_gate_evidence:null};
  } finally {db.close();}
}
