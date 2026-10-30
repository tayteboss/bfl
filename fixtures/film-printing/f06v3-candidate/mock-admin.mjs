import {mockAdmin,hash} from '../f06d/mock-admin.mjs';
import {APP} from '../../../apps/film-printing-staging/configuration/schema.mjs';
import {leaseOwners,LEASE_KEY,leaseEnvelope,readFunctionOwners} from '../../../apps/film-printing-staging/checkout/lease.mjs';
export function mockLeaseAdmin({specificationOwner=null,...options}={}) {
 const LEASE_OWNERS=leaseOwners(specificationOwner);
 const m=mockAdmin(options),baseApi=m.api,expanded='app--'+APP.split('/').at(-1)+'--bfl-checkout';
 const connection=nodes=>({nodes,pageInfo:{hasNextPage:false,hasPreviousPage:false}});
 for(const o of LEASE_OWNERS) {
  const row={id:o.id,lease:null};
  if(o.alias==='leasePricing')Object.assign(row,{functionId:o.functionId,blockOnFailure:true});
  if(o.alias==='leaseValidation')Object.assign(row,{shopifyFunction:{id:o.functionId},enabled:true,blockOnFailure:true});
  if(o.alias==='leaseLab')Object.assign(row,{function:{id:o.functionId},deliveryMethodTypes:['SHIPPING','PICK_UP']});
  if(o.alias==='leaseDelivery')Object.assign(row,{shopifyFunction:{id:o.functionId},enabled:true});
  if(o.alias==='leaseLab')m.data[o.alias]=[row];else if(m.data[o.alias])m.data[o.alias].nodes.push(row);else m.data[o.alias]=connection([row]);
 }
 m.data.leaseFunctions=connection(LEASE_OWNERS.map(o=>({id:o.functionId,handle:o.handle,apiVersion:'2026-07',app:{id:APP}})));
 const ownerRow=id=>{const o=LEASE_OWNERS.find(o=>o.id===id);if(!o)throw Error('Mock owner scope violation');const rows=o.alias==='leaseLab'?m.data[o.alias]:m.data[o.alias].nodes;const row=rows.find(r=>r.id===id);if(!row)throw Error('Mock owner identity violation');return row;};
 const aliases={active_config:'active',price_catalog:'catalog',authority_fence:'fence'};
 const current=f=>f.key===LEASE_KEY?ownerRow(f.ownerId).lease:f.key==='authority'?m.data.shop.authority:aliases[f.key]?m.data.currentAppInstallation[aliases[f.key]]:m.archives.get(f.key);
 m.api=async(query,variables={})=>{
  if(!/^\s*mutation\s/.test(query))return baseApi(query,variables);
  if(!/^mutation F06DCommitAuthority\(/.test(query.trim()))throw Error('Mock mutation scope violation');
  const fields=structuredClone(variables.fields);m.writes.push(fields);if(m.beforeWrite)await m.beforeWrite(fields);
  if(!Array.isArray(fields)||fields.length<3+LEASE_OWNERS.length||fields.length>5+LEASE_OWNERS.length)throw Error('Mock complete CAS transaction required');
  const owners=fields.filter(f=>f.key===LEASE_KEY),base=fields.filter(f=>f.key!==LEASE_KEY),authority=base.find(f=>f.key==='authority');
  if(owners.length!==LEASE_OWNERS.length||new Set(fields.map(f=>f.ownerId+'\0'+f.namespace+'\0'+f.key)).size!==fields.length||!['authority','active_config','authority_fence'].every(k=>base.some(f=>f.key===k)))throw Error('Mock complete CAS transaction required');
  if(m.data.currentAppInstallation.catalog&&!base.some(f=>f.key==='price_catalog'))throw Error('Mock catalog guard required');
  readFunctionOwners(m.data,{specificationOwner});
  for(const f of fields) {
   if(!Object.hasOwn(f,'compareDigest')||typeof f.value!=='string')throw Error('Mock CAS violation');
   if(f.key===LEASE_KEY) {ownerRow(f.ownerId);if(f.namespace!=='$app:bfl-checkout'||f.type!=='json'||f.value!==leaseEnvelope(authority.value))throw Error('Mock lease mirror violation');}
   else {const owner=f.key==='authority'?m.data.shop.id:m.data.currentAppInstallation.id,ns=f.key==='authority'?'$app:bfl-checkout':'bfl_printing',type=f.key==='authority_fence'?'single_line_text_field':'json';if(f.ownerId!==owner||f.namespace!==ns||f.type!==type||!(f.key==='authority'||Object.hasOwn(aliases,f.key)||/^release_[a-f0-9]{24}$/.test(f.key)))throw Error('Mock source scope violation');}
  }
  if(m.reject||fields.some(f=>f.compareDigest!==(current(f)?.compareDigest??null)))return {metafieldsSet:{userErrors:[{code:'STALE_OBJECT'}]}};
  // Validate all source and owner digests before changing any field.
  for(const f of fields) {const next={...current(f),value:f.value,type:f.type,compareDigest:hash(f.value)};if(f.key===LEASE_KEY)ownerRow(f.ownerId).lease={...next,namespace:expanded,key:LEASE_KEY};else if(f.key==='authority')m.data.shop.authority=next;else if(aliases[f.key])m.data.currentAppInstallation[aliases[f.key]]=next;else m.archives.set(f.key,next);}
  if(m.afterWrite)await m.afterWrite(fields);
  return {metafieldsSet:{userErrors:[],metafields:fields.map(f=>({key:f.key,compareDigest:hash(f.value)}))}};
 };
 return m;
}
