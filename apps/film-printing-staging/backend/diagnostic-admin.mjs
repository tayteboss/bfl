import {createAdminTransport} from './admin.mjs';
import {decodeAuthority,isEligibilitySchema,isFullProductSchema} from '../checkout/authority.js';
import {need} from './config.mjs';
import {preparedPolicy} from '../checkout/prepared-limits.mjs';

// The normal transport stays revocation-only. This private closure can consume
// a bounded number of normal projector values during their durable publications.
// It cannot edit sources, accept a caller query, or retry an uncertain send.
export function createDiagnosticAdminTransport(config,{lifecycle,publicationLimit=1,replaceSettled=false,eligibility=false,specificationOwner=null,enabled=false,permit=()=>false,fetchImpl=fetch,record=()=>{}}={}){
 need([1,2,4].includes(publicationLimit),'DIAGNOSTIC_PUBLICATION_LIMIT');
 let activeLimit=publicationLimit,clientScope=null;
 let armed=null,spent=0,lastEpoch=-1;const tickets=new Set(),counts={requests:0,mutations:0};
 const gate=()=>{need(enabled===true&&permit(),'DIAGNOSTIC_CLOSED');if(clientScope)need(preparedPolicy(clientScope).clientPolicy,'DIAGNOSTIC_CLOSED');};
 const publicationCustody={consume(value){
  gate();const op=lifecycle.state().operation;
  need(armed&&spent<activeLimit&&op?.kind==='publish'&&op.epoch===armed.epoch&&value===armed.value,'DIAGNOSTIC_PUBLICATION_SPENT');
  armed.guard(op);spent++;lastEpoch=armed.epoch;armed=null;record({event:'publication_send_reserved'});
 }};
 const api=createAdminTransport(config,{publicationCustody,eligibility,specificationOwner,fetchImpl:async(url,options)=>{
  need(enabled===true,'DIAGNOSTIC_CLOSED');
  const {query}=JSON.parse(options.body),mutation=/^\s*mutation/.test(query);
  // Includes identity/context checks performed inside the normal boundary.
  need(counts.requests<(32+32*activeLimit)&&(!mutation||counts.mutations<(4+4*activeLimit)),'DIAGNOSTIC_ADMIN_LIMIT');
  counts.requests++;if(mutation)counts.mutations++;record({event:'admin_attempt',kind:mutation?'mutation':'query',count:counts.requests});
  return fetchImpl(url,options);
 }});
 return Object.freeze({api,
  activateFullProduct(sourceScope){
   const policy=preparedPolicy(sourceScope);
   need(enabled===true&&policy.clientPolicy&&!clientScope&&!armed&&spent===0,'DIAGNOSTIC_CLIENT_POLICY');
   clientScope=sourceScope;activeLimit=policy.publications;
  },
  arm(prepared,guard){
   gate();const a=decodeAuthority(prepared?.value),s=lifecycle.state();
   need(!armed&&spent<activeLimit&&(s.epoch>lastEpoch||replaceSettled&&s.epoch===lastEpoch)&&!s.pending&&!s.operation&&prepared?.ticket?.epoch===s.epoch&&typeof prepared.ticket.id==='string'&&!tickets.has(prepared.ticket.id)&&(eligibility?isEligibilitySchema(a?.schema):a?.schema===2)&&(!isFullProductSchema(a?.schema)||specificationOwner!==null)&&a.grants.length===1&&typeof guard==='function','DIAGNOSTIC_PREPARATION_REQUIRED');
   tickets.add(prepared.ticket.id); // One-use preparation, even when the epoch stays settled.
   armed={value:prepared.value,epoch:prepared.ticket.epoch,guard};
  },
  status:()=>({...counts,publication_spent:spent>=activeLimit}),
 });
}
