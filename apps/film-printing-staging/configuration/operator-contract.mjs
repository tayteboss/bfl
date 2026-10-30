// Private operator contract. No provisioning, draft editing or runtime imports.
import {createHash} from 'node:crypto';
import {STORE,APP,CLIENT,definitions,groupTypes} from './schema.mjs';
import {canonical,makeRelease,verifyRelease,freeze} from './config.mjs';
import {readDrafts} from './shopify.mjs';
import {SHOP,INSTALLATION,need} from '../backend/config.mjs';
import {parseStrictJson} from '../pricing/prepare.mjs';

export const TARGET=Object.freeze({store:STORE,shop:SHOP,app:APP,client:CLIENT,installation:INSTALLATION});
export const API_VERSION='2026-10';
export const IDENTITY_QUERY='query F06DOperatorIdentity { shop { id myshopifyDomain } currentAppInstallation { id app { id apiKey } accessScopes { handle } } }';
export const DRAFT_QUERY='query Drafts($type: String!) { metaobjects(type: $type, first: 250) { nodes { id handle type updatedAt fields { key value } } pageInfo { hasNextPage } } }';
export const ARCHIVE_QUERY='query Archive($key: String!) { shop { myshopifyDomain } currentAppInstallation { id app { id } metafield(namespace: "bfl_printing", key: $key) { type value compareDigest } } }';
export const ARCHIVE_READBACK='query F06DArchive($key:String!) { shop { myshopifyDomain } currentAppInstallation { id app { id } metafield(namespace:"bfl_printing",key:$key) { type value compareDigest } } }';
export const COMMIT=`mutation F06DCommitAuthority($fields:[MetafieldsSetInput!]!) {
      metafieldsSet(metafields:$fields) { metafields { key compareDigest } userErrors { code } }
    }`;
export const sha256=value=>createHash('sha256').update(value).digest('hex');
export const equal=(a,b)=>canonical(a)===canonical(b);
export const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&equal(Object.keys(v).sort(),[...keys].sort());
const text=v=>typeof v==='string'&&v.trim().length>0&&v.length<=5000;
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const stamp=v=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(v)&&Number.isFinite(Date.parse(v));
export const descriptor=f=>f===null?null:{type:f.type,sha256:sha256(f.value),compare_digest:f.compareDigest};
export const describe=(c,archive)=>({active:descriptor(c.active),catalog:descriptor(c.catalogField),authority:descriptor(c.field),fence:descriptor(c.fence),archive:descriptor(archive)});

// Keep the returned field strings, including JSON whitespace and optional nulls.
// Sorting only removes transport order; no semantic normalization hides edits.
export function draftNodes(data,type) {
  const definition=definitions.find(d=>d.type===type),m=data?.metaobjects;
  need(definition&&exact(m,['nodes','pageInfo'])&&exact(m.pageInfo,['hasNextPage'])&&m.pageInfo.hasNextPage===false&&Array.isArray(m.nodes)&&m.nodes.length>0&&m.nodes.length<=250,'OPERATOR_DRAFT_INCOMPLETE');
  const ids=new Set(),handles=new Set();
  const nodes=m.nodes.map(node=>{
    need(exact(node,['id','handle','type','updatedAt','fields'])&&/^gid:\/\/shopify\/Metaobject\/[1-9]\d*$/.test(node.id)&&!ids.has(node.id)&&
      typeof node.handle==='string'&&/^[a-z0-9][a-z0-9_-]{0,80}$/.test(node.handle)&&!handles.has(node.handle)&&node.type===type&&stamp(node.updatedAt)&&Array.isArray(node.fields),'OPERATOR_DRAFT_INVALID');
    ids.add(node.id);handles.add(node.handle);
    need(equal(node.fields.map(f=>f?.key).sort(),definition.fieldDefinitions.map(f=>f.key).sort()),'OPERATOR_DRAFT_INCOMPLETE');
    for(const f of node.fields) {
      need(exact(f,['key','value'])&&(f.value===null||typeof f.value==='string'&&Buffer.byteLength(f.value)<=65536),'OPERATOR_DRAFT_INVALID');
      const spec=definition.fieldDefinitions.find(s=>s.key===f.key);
      if(f.value!==null&&f.value!==''&&(spec.type==='json'||spec.type==='boolean'||spec.type.startsWith('number_')))parseStrictJson(f.value);
    }
    return {...node,fields:[...node.fields].sort((a,b)=>a.key.localeCompare(b.key))};
  }).sort((a,b)=>a.id.localeCompare(b.id));
  return nodes;
}
export async function snapshotDrafts(api) {
  const records={};
  const parsed=await readDrafts(async(q,v)=>{
    need(q===DRAFT_QUERY,'ADMIN_OPERATION_REJECTED');
    const data=await api(q,v);records[v.type]=draftNodes(data,v.type);return data;
  });
  const ids=Object.values(records).flat().map(n=>n.id);
  need(new Set(ids).size===ids.length,'OPERATOR_DRAFT_INVALID');
  const release=makeRelease(parsed.config),value=canonical(release);
  return {drafts:{records,sha256:sha256(canonical(records))},candidate:{version:release.version,sha256:release.sha256,value_sha256:sha256(value),value,archive_key:`release_${release.sha256.slice(0,24)}`}};
}
export async function validateReview(review,config,version,now,{recovery=false}={}) {
  need(exact(review,['schema','status','target','database_id','api_version','inspected_at','shop_date','drafts','candidate','current','current_values','approval']),'OPERATOR_REVIEW_INVALID');
  need(review.schema===1&&equal(review.target,TARGET)&&review.database_id===config.databaseId&&review.api_version===API_VERSION&&stamp(review.inspected_at)&&/^\d{4}-\d\d-\d\d$/.test(review.shop_date),'OPERATOR_REVIEW_INVALID');
  need(exact(review.drafts,['records','sha256'])&&exact(review.drafts.records,Object.values(groupTypes)),'OPERATOR_REVIEW_INVALID');
  const snapshot=await snapshotDrafts(async(q,v)=>({metaobjects:{nodes:review.drafts.records[v.type],pageInfo:{hasNextPage:false}}}));
  need(equal(snapshot,{drafts:review.drafts,candidate:review.candidate})&&version===snapshot.candidate.version,'OPERATOR_CANDIDATE_CHANGED');
  need(exact(review.current,['active','catalog','authority','fence','archive'])&&exact(review.current_values,['active','archive']),'OPERATOR_REVIEW_INVALID');
  for(const [key,f] of Object.entries(review.current)) {
    need(f===null?key==='archive':exact(f,['type','sha256','compare_digest'])&&f.type===(key==='fence'?'single_line_text_field':'json')&&hash(f.sha256)&&text(f.compare_digest),'OPERATOR_REVIEW_INVALID');
  }
  for(const key of ['active','archive']) {
    const v=review.current_values[key];need(review.current[key]===null?v===null:typeof v==='string'&&sha256(v)===review.current[key].sha256,'OPERATOR_REVIEW_INVALID');
    if(v!==null){const release=verifyRelease(parseStrictJson(v));if(key==='archive')need(equal(release,parseStrictJson(review.candidate.value)),'ARCHIVE_CONFLICT');}
  }
  // An expired/unapproved inspection can guide revocation, never source replay.
  if(!recovery) {
    const a=review.approval;
    need(review.status==='approved_staging_configuration_cutover'&&exact(a,['approved_at','expires_at','release_version','release_sha256','evidence','unavailable_gate_evidence','writers_stopped_evidence'])&&
      stamp(a.approved_at)&&stamp(a.expires_at)&&a.release_version===version&&a.release_sha256===snapshot.candidate.sha256&&text(a.unavailable_gate_evidence)&&text(a.writers_stopped_evidence),'OPERATOR_APPROVAL_REQUIRED');
    need(Array.isArray(a.evidence)&&a.evidence.length>0&&a.evidence.length<=100&&a.evidence.every(e=>exact(e,['reference','sha256'])&&text(e.reference)&&hash(e.sha256)),'OPERATOR_EVIDENCE_REQUIRED');
    const inspected=Date.parse(review.inspected_at),approved=Date.parse(a.approved_at),expires=Date.parse(a.expires_at),time=now().getTime();
    need(inspected<=approved&&approved<=time&&expires>approved&&time<=expires&&expires-inspected<=86400000,'OPERATOR_REVIEW_EXPIRED');
  }
  return freeze(structuredClone(review));
}
