import {createAdminTransport} from './admin.mjs';
import {need} from './config.mjs';
import {preparedPolicy} from '../checkout/prepared-limits.mjs';
import {decodeAuthority,LAB_VARIANT_SCHEMA} from '../checkout/authority.js';

export function createStagingAdminTransport(config,{lifecycle,sourceScope,specificationOwner,credentialProvider,fetchImpl=fetch,permit=()=>false}){
 need(preparedPolicy(sourceScope).clientPolicy==='bfl-persistent-staging-client-v1'&&specificationOwner,'STAGING_ADMIN_POLICY');
 let armed=null;
 const custody={isArmedFor:value=>permit()&&armed?.value===value,consume(value){
  need(permit()&&armed&&armed.value===value,'STAGING_PUBLICATION_UNARMED');
  const operation=lifecycle.state().operation;
  need(operation?.kind==='publish'&&operation.epoch===armed.epoch,'STAGING_PUBLICATION_UNARMED');
  armed.guard(operation);armed=null;
 }};
 const api=createAdminTransport(config,{eligibility:true,specificationOwner,credentialProvider,publicationCustody:custody,fetchImpl});
 return {api,cleared(context){
  const state=lifecycle.state();need(permit()&&!state.pending&&!state.operation&&decodeAuthority(context?.field?.value)?.grants.length===0,'STAGING_RECOVERY_REQUIRED');
  need(!armed||state.epoch>armed.epoch,'STAGING_RECOVERY_REQUIRED');armed=null;
 },arm(prepared,guard){
  need(permit()&&typeof guard==='function'&&!armed,'STAGING_PUBLICATION_UNARMED');
  const authority=decodeAuthority(prepared?.value),state=lifecycle.state();
  need(authority?.schema===LAB_VARIANT_SCHEMA&&!state.pending&&!state.operation&&prepared.ticket?.epoch===state.epoch,'STAGING_PUBLICATION_UNARMED');
  armed={value:prepared.value,epoch:state.epoch,guard};
 }};
}
