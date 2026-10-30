import {need} from '../backend/config.mjs';
import {openDatabase} from '../backend/storage.mjs';
import {createAuthorityAdmin} from '../checkout/shopify.mjs';
import {publishDrafts} from './shopify.mjs';
import {verifyRelease} from './config.mjs';
import {parseStrictJson} from '../pricing/prepare.mjs';
import {createConfigurationTransport} from './operator-admin.mjs';
import {TARGET,API_VERSION,ARCHIVE_QUERY,ARCHIVE_READBACK,equal,describe,snapshotDrafts,validateReview} from './operator-contract.mjs';

export async function runConfigurationOperator({action,mode='disabled',config,expectedVersion,review,allWritersStopped=false,now=()=>new Date(),fetchImpl,transportOptions={}}) {
  need(['inspect','apply','recover'].includes(action)&&mode===action,'OPERATOR_DISABLED');
  need(config.mode==='disabled','RUNTIME_WRITES_MUST_BE_DISABLED');need(allWritersStopped===true,'STOP_ALL_WRITERS_FIRST');
  if(action!=='inspect')review=await validateReview(review,config,expectedVersion,now,{recovery:action==='recover'});
  else need(expectedVersion===undefined&&!review,'OPERATOR_USAGE');
  const db=openDatabase(config,{now:()=>now().getTime()});
  try {
    const api=createConfigurationTransport(config,{...transportOptions,mode:action,review,now,fetchImpl});
    const admin=createAuthorityAdmin(api,{writesEnabled:action==='recover',lifecycle:db.store.lifecycle,now});
    if(action==='apply') {
      const state=db.store.lifecycle.state();need(!state.operation&&!state.pending,'OPERATOR_RECOVERY_REQUIRED');
      const c=await admin.read(),a=(await api(ARCHIVE_QUERY,{key:review.candidate.archive_key})).currentAppInstallation.metafield;
      need(equal(describe(c,a),review.current)&&c.shopDate===review.shop_date,'OPERATOR_REVIEW_STALE');
      const result=await publishDrafts(api,{writesEnabled:true,lifecycle:db.store.lifecycle,now});
      db.store.cartRefresh.recovered();
      return {status:'published_configuration_empty_authority',version:result.release.version,sha256:result.release.sha256,archive_key:review.candidate.archive_key,checkout_ready:false};
    }
    if(action==='recover') {
      await admin.reconcile();db.store.cartRefresh.recovered();
      let active='unobserved',archive='unobserved';
      try {
        const c=await admin.read({allowMissingCatalog:true});
        active=c.active.value===review.candidate.value?'proposed':c.active.value===review.current_values.active?'prior':'changed';
        const a=(await api(ARCHIVE_READBACK,{key:review.candidate.archive_key})).currentAppInstallation.metafield;
        archive=a===null?'absent':a.value===(review.current_values.archive??review.candidate.value)?'expected_bytes':'changed';
      } catch { /* Recovery never proves a source import from an unobserved read. */ }
      return {status:'revoked_review_required',active_state:active,archive_state:archive,checkout_ready:false};
    }
    const c=await admin.read();
    need(c.field&&c.fence?.type==='single_line_text_field'&&c.fence.compareDigest&&/^[a-f0-9-]{36}$/.test(c.fence.value),'OPERATOR_PROVISIONING_REQUIRED');
    const first=await snapshotDrafts(api),second=await snapshotDrafts(api);
    need(equal(first,second),'OPERATOR_DRAFT_CHANGED');
    const key=second.candidate.archive_key;
    const a=(await api(ARCHIVE_QUERY,{key})).currentAppInstallation.metafield;
    if(a)need(equal(verifyRelease(parseStrictJson(a.value)),parseStrictJson(second.candidate.value)),'ARCHIVE_CONFLICT');
    const after=await admin.read(),again=(await api(ARCHIVE_QUERY,{key})).currentAppInstallation.metafield;
    need(equal(describe(c,a),describe(after,again))&&c.shopDate===after.shopDate,'OPERATOR_SOURCE_CHANGED');
    const state=db.store.lifecycle.state();
    const result={schema:1,status:state.operation||state.pending?'recovery_required_do_not_apply':'unreviewed_do_not_apply',target:TARGET,database_id:config.databaseId,api_version:API_VERSION,
      inspected_at:now().toISOString(),shop_date:c.shopDate,...second,current:describe(c,a),current_values:{active:c.active.value,archive:a?.value??null},approval:null};
    // Leave room for reviewed evidence while keeping the private input bounded.
    need(Buffer.byteLength(JSON.stringify(result,null,2))<=200000,'OPERATOR_REVIEW_TOO_LARGE');
    return result;
  } finally {db.close();}
}
