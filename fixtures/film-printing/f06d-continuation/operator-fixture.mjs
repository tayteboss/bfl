// SYNTHETIC LOCAL TEST ONLY. No credentials or network discovery.
import {mockAdmin,hash,now} from '../f06d/mock-admin.mjs';
import {CLIENT,definitions,groupTypes} from '../../../apps/film-printing-staging/configuration/schema.mjs';
import {IDENTITY_QUERY,DRAFT_QUERY,ARCHIVE_QUERY,ARCHIVE_READBACK,COMMIT} from '../../../apps/film-printing-staging/configuration/operator-contract.mjs';
import {CONTEXT_QUERY} from '../../../apps/film-printing-staging/checkout/shopify.mjs';
export {now,hash};
export const field=(value,type='json')=>({value,type,compareDigest:hash(value)});
export function syntheticAdmin() {
  const m=mockAdmin();m.data.currentAppInstallation.app.apiKey=CLIENT;
  m.data.currentAppInstallation.accessScopes=[{handle:'read_metaobjects'}];
  // Candidate differs from active only by a synthetic label.
  m.drafts.packages[0].label+=' operator candidate';
  m.calls=[];m.readHook=null;
  m.fetch=async(url,opts)=>{
    if(url!=='https://bellows-film-printing-staging.myshopify.com/admin/api/2026-10/graphql.json')throw Error('unexpected endpoint');
    const {query,variables}=JSON.parse(opts.body);m.calls.push(query);
    if(![IDENTITY_QUERY,DRAFT_QUERY,ARCHIVE_QUERY,ARCHIVE_READBACK,COMMIT,CONTEXT_QUERY].includes(query))throw Error('unexpected operation');
    const data=await m.api(query,variables);
    if(query===DRAFT_QUERY) {
      const offset=Object.values(groupTypes).indexOf(variables.type)*1000;
      for(const [i,n] of data.metaobjects.nodes.entries()) {
        n.id=`gid://shopify/Metaobject/${offset+i+1}`;n.updatedAt='2026-10-21T11:30:00Z';
        n.fields=definitions.find(d=>d.type===variables.type).fieldDefinitions.map(f=>n.fields.find(v=>v.key===f.key)??{key:f.key,value:null});
      }
    }
    if(m.readHook&&query!==COMMIT)await m.readHook(query,data,variables);
    return new Response(JSON.stringify({data}),{headers:{'content-type':'application/json','x-shopify-api-version':'2026-10'}});
  };
  return m;
}
export function approve(snapshot,time=now()) {
  return {...snapshot,status:'approved_staging_configuration_cutover',approval:{approved_at:time.toISOString(),expires_at:new Date(time.getTime()+3600000).toISOString(),
    release_version:snapshot.candidate.version,release_sha256:snapshot.candidate.sha256,
    evidence:[{reference:'SYNTHETIC fixture only; never authorizes actual physical rules',sha256:hash('synthetic evidence')}],
    unavailable_gate_evidence:'SYNTHETIC stopped checkout fixture',writers_stopped_evidence:'SYNTHETIC single-writer fixture'}};
}
