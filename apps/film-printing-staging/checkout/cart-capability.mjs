import {createCipheriv,createDecipheriv,createHash,randomBytes,randomUUID} from 'node:crypto';
import {isIP} from 'node:net';
import {CART_QUERY,cartHash,requireCartLocator,parseCurrentCart,printLine} from './storefront.mjs';
import {STORE} from './authority.js';
import {SHOP,need,RuntimeError} from '../backend/config.mjs';
import {fingerprint} from '../jobs/lifecycle.mjs';
import {bindOwnedObservation} from './owned-cart.mjs';
import {RESOURCE_PURPOSE} from '../backend/resource-session.mjs';

export const CAPABILITY_ACTION='cart-capability';
export const CAPABILITY_LIMIT=256;
export function installCartCapabilitySchema(db,{checkout=false}={}){
 const table=checkout?'checkout_capability_attempts':'cart_capability_attempts';
 db.exec(`CREATE TABLE ${table} (
  id TEXT PRIMARY KEY, owner_hash TEXT NOT NULL UNIQUE, cart_hash TEXT NOT NULL UNIQUE,
  locator_hash TEXT NOT NULL UNIQUE, proof_hash TEXT NOT NULL UNIQUE,
  session_generation INTEGER NOT NULL, epoch INTEGER NOT NULL, created INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('reading','sending','unknown','rejected','capability_only')),
  sealed_cart TEXT NOT NULL, snapshot_hash TEXT);`);
}
// Existing SQLite connection and synchronous lifecycle transaction only. Rows
// are permanent reservations, NOT authenticated buyer/cart ownership grants.
export function createCartCapabilityLedger(db,lifecycle,{checkout=false}={}){
 const table=checkout?'checkout_capability_attempts':'cart_capability_attempts';
 const row=id=>db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
 return Object.freeze({
  reserve({ticket,cart_id,proofId,created,sealed}){return lifecycle.transaction(()=>{
   const s=lifecycle.state();need(!s.pending&&!s.operation&&s.epoch===ticket.epoch,'CART_CAPABILITY_FENCED');
   need(!db.prepare(`SELECT 1 FROM ${table} WHERE state IN ('reading','sending','unknown')`).get(),'CART_CAPABILITY_UNKNOWN');
   need(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n<CAPABILITY_LIMIT,'CART_CAPABILITY_CAPACITY');
   const owner=cartHash(ticket.owner),cart=cartHash(cart_id),locator=cartHash(cart_id.split('?')[0]);
   // Base locator hash is an additional anti-rebind index only, never proof or
   // normalization of the exact full capability used on the wire and in custody.
   need(!db.prepare(`SELECT 1 FROM ${table} WHERE owner_hash=? OR cart_hash=? OR locator_hash=? OR proof_hash=?`).get(owner,cart,locator,cartHash(proofId)),'CART_CAPABILITY_REPLAY');
   need(!db.prepare('SELECT 1 FROM cart_job_bindings WHERE cart_hash=? OR owner_hash=?').get(cart,owner)&&!db.prepare('SELECT 1 FROM cart_refresh_requests WHERE cart_hash=? OR owner_hash=?').get(cart,owner),'CART_EXISTING_BINDING');
   if(checkout)need(!db.prepare('SELECT 1 FROM cart_capability_attempts WHERE owner_hash=? OR cart_hash=? OR locator_hash=? OR proof_hash=?').get(owner,cart,locator,cartHash(proofId)),'CART_CAPABILITY_REPLAY');
   const id=randomUUID();
   db.prepare(`INSERT INTO ${table} VALUES (?,?,?,?,?,?,?,?,?,?,NULL)`).run(id,owner,cart,locator,cartHash(proofId),ticket.generation,ticket.epoch,created,'reading',sealed);
   return id;
  });},
  sending(id,snapshot){return lifecycle.transaction(()=>{
   need(row(id)?.state==='reading','CART_CAPABILITY_REPLAY');
   db.prepare(`UPDATE ${table} SET state='sending',snapshot_hash=? WHERE id=?`).run(snapshot,id);
  });},
  finish(id,state){return lifecycle.transaction(()=>{
   const prior=row(id);need(prior&&['reading','sending'].includes(prior.state)&&['rejected','unknown','capability_only'].includes(state),'CART_CAPABILITY_REPLAY');
   db.prepare(`UPDATE ${table} SET state=? WHERE id=?`).run(state,id);
  });},
  status(id,ticket){
   const r=row(id),s=lifecycle.state();need(r&&r.owner_hash===cartHash(ticket.owner)&&r.session_generation===ticket.generation&&r.epoch===ticket.epoch&&s.epoch===ticket.epoch&&!s.pending&&!s.operation,'CART_CAPABILITY_FENCED');
   return {state:['reading','sending'].includes(r.state)?'unknown':r.state,customer_context:'unproven',cart_verified:false,checkout_ready:false};
  },
 });
}
const key=secret=>{need(typeof secret==='string'&&secret.length>=32,'CART_CUSTODY_KEY');return createHash('sha256').update('bfl:cart-capability-custody:v1\0'+secret).digest();};
export function sealCartCapability(id,secret){
 requireCartLocator(id);const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key(secret),iv);c.setAAD(Buffer.from(STORE));
 return Buffer.concat([iv,c.update(id,'utf8'),c.final(),c.getAuthTag()]).toString('base64');
}
// Explicit private operator custody inspection only; never exposed over HTTP.
export function openCartCapability(sealed,secret){
 try{const b=Buffer.from(sealed,'base64'),d=createDecipheriv('aes-256-gcm',key(secret),b.subarray(0,12));d.setAAD(Buffer.from(STORE));d.setAuthTag(b.subarray(-16));return requireCartLocator(Buffer.concat([d.update(b.subarray(12,-16)),d.final()]).toString('utf8'));}
 catch{throw new RuntimeError('CART_CUSTODY_REJECTED');}
}
export const CAPABILITY_QUERY=CART_QUERY.replace('cart(id: $id) {','cart(id: $id) { note attributes { key value }');
const fields=CAPABILITY_QUERY.slice(CAPABILITY_QUERY.indexOf('cart(id: $id) {')+'cart(id: $id) {'.length).replace(/}\s*}\s*$/,'');
export const CAPABILITY_MUTATION=`mutation($id:ID!){cartLinesUpdate(cartId:$id,lines:[]){cart {${fields}} userErrors{code field} warnings{code}}}`;
export const BINDING_NAMESPACE='app--436988772353--bfl-checkout';
export const BINDING_KEY='binding_v2';
export const BINDING_QUERY=CAPABILITY_QUERY.replace('cart(id: $id) {',`cart(id: $id) { binding:metafield(namespace:"${BINDING_NAMESPACE}",key:"${BINDING_KEY}"){namespace key type value}`);
export const BINDING_MUTATION='mutation($fields:[CartMetafieldsSetInput!]!){cartMetafieldsSet(metafields:$fields){userErrors{code field}}}';
export const BINDING_DELETE='mutation($input:CartMetafieldDeleteInput!){cartMetafieldDelete(input:$input){deletedId userErrors{code field}}}';
export const capabilitySnapshot=c=>{const {updatedAt,...rest}=c;return fingerprint(rest);};
export function createCartCapabilityTransport({store,shopId,privateToken,enabled=false},{fetchImpl=fetch,timeoutMs=5000,maxBytes=1048576,credentialProvider=null}={}){
 need(store===STORE&&shopId===SHOP,'CART_WRONG_SHOP');
 const call=async(query,{cart_id,buyerIp},variables={id:cart_id})=>{
  need(enabled===true,'CART_CAPABILITY_DISABLED');requireCartLocator(cart_id);
  need(isIP(buyerIp??''),'BUYER_IP_REQUIRED');
  const token=credentialProvider?await credentialProvider.read():privateToken;
  need(typeof token==='string'&&/^[\x21-\x7e]{32,2048}$/.test(token),'STOREFRONT_CREDENTIAL_REQUIRED');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
   const r=await fetchImpl(`https://${STORE}/api/2026-07/graphql.json`,{method:'POST',redirect:'error',signal:controller.signal,headers:{'Content-Type':'application/json','Accept':'application/json','Accept-Encoding':'identity','Shopify-Storefront-Private-Token':token,'Shopify-Storefront-Buyer-IP':buyerIp},body:JSON.stringify({query,variables})});
   need(r.status===200&&!r.redirected&&r.headers.get('x-shopify-api-version')==='2026-07'&&/^application\/json(?:;|$)/i.test(r.headers.get('content-type')??'')&&[null,'identity'].includes(r.headers.get('content-encoding')),'CART_CAPABILITY_TRANSPORT');
   let n=0;const chunks=[];for await(const c of r.body){n+=c.length;need(n<=maxBytes,'CART_CAPABILITY_TRANSPORT');chunks.push(c);}
   const j=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(Buffer.concat(chunks)));
   need(j&&(!Object.hasOwn(j,'errors')||Array.isArray(j.errors)&&j.errors.length===0)&&j.data,'CART_CAPABILITY_RESPONSE');return j;
  }catch(e){throw e instanceof RuntimeError?e:new RuntimeError('CART_CAPABILITY_TRANSPORT');}finally{clearTimeout(timer);controller.abort();}
 };
 const inspect=(j,id)=>{
  const parsed=parseCurrentCart(j,id),c=j.data.cart;
  need(typeof c.note==='string'&&Array.isArray(c.attributes),'CART_CAPABILITY_INCOMPLETE');
  const keys=new Set();for(const a of c.attributes){need(typeof a?.key==='string'&&typeof a.value==='string'&&!keys.has(a.key),'CART_CAPABILITY_INCOMPLETE');keys.add(a.key);}
  return {parsed,raw:c};
 };
 return Object.freeze({
  async deleteBinding(input){
   const j=await call(BINDING_DELETE,input,{input:{ownerId:input.cart_id,key:`$app:bfl-checkout.${BINDING_KEY}`}}),p=j.data.cartMetafieldDelete;
   need(Array.isArray(p?.userErrors)&&p.userErrors.length===0&&typeof p.deletedId==='string','BINDING_RESPONSE');
  },
  async readBinding(input){
   const result=inspect(await call(BINDING_QUERY,input),input.cart_id),m=result.raw.binding;
   need(m===null||m?.namespace===BINDING_NAMESPACE&&m.key===BINDING_KEY&&m.type==='single_line_text_field'&&/^[a-f0-9]{64}$/.test(m.value),'BINDING_RESPONSE');
   return {...result,marker:m?.value??null};
  },
  async writeBinding(input,marker){
   need(typeof marker==='string'&&/^[a-f0-9]{64}$/.test(marker),'BINDING_RESPONSE');
   const j=await call(BINDING_MUTATION,input,{fields:[{ownerId:input.cart_id,key:`$app:bfl-checkout.${BINDING_KEY}`,type:'single_line_text_field',value:marker}]});
   need(Array.isArray(j.data.cartMetafieldsSet?.userErrors)&&j.data.cartMetafieldsSet.userErrors.length===0,'BINDING_RESPONSE');
  },
  async read(input){return inspect(await call(CAPABILITY_QUERY,input),input.cart_id);},
  async check(input){
   const j=await call(CAPABILITY_MUTATION,input),p=j.data.cartLinesUpdate;
   need(Array.isArray(p?.userErrors)&&Array.isArray(p?.warnings),'CART_CAPABILITY_RESPONSE');
   // Even an exact cart-shaped payload is never success alongside an error.
   if(p.userErrors.length&&p.warnings.length===0&&p.userErrors.every(e=>e.code==='INVALID'&&Array.isArray(e.field)&&e.field.length===1&&e.field[0]==='cartId'))return {rejected:true};
   need(p.userErrors.length===0&&p.warnings.length===0,'CART_CAPABILITY_REJECTED');
   return inspect({data:{shop:{id:SHOP},cart:p.cart}},input.cart_id);
  },
 });
}
// F06M exercised the exact full selection on a native ordinary nonempty cart.
// A private-token read plus accepted full-key mutation supports the returned
// account-association observation under Shopify's Cart ID contract. It does not
// authenticate a unique guest or turn a permanent capability-only reservation
// into ownership. Only the separate schema9 new-owner composition may bind
// its own newly issued principal during this same successful observation.
export function createCartCapabilityAdapter({store,proofs,transport,custodySecret,resolveBuyerIp,now=Date.now,owned,permit=()=>true}){
 const sessions=store.resourceSessions,ledger=store.cartCapability;
 need(sessions&&ledger&&proofs&&typeof resolveBuyerIp==='function','CART_CAPABILITY_COMPOSITION');key(custodySecret);
 const inspect=async({request,proof,cart_id},bind=false)=>{
  need(permit(),'CART_WINDOW_CLOSED');requireCartLocator(cart_id);const ticket=sessions.authenticate(request);
  need(sessions.assert(ticket).purpose===RESOURCE_PURPOSE,'CART_CAPABILITY_PURPOSE');
  const e=proofs.observeFreshContext({request,proof,action:CAPABILITY_ACTION,ticket});
  sessions.assertCartContext(ticket,e);
  const id=store.lifecycle.transaction(()=>{
   const id=ledger.reserve({ticket,cart_id,proofId:e.id,created:now(),sealed:sealCartCapability(cart_id,custodySecret)});
   if(bind){need(owned,'CART_OWNER_COMPOSITION');owned.reserve(ticket,id);}return id;
  });
  let sent=false,finished=false;
  const guard=()=>{need(permit(),'CART_WINDOW_CLOSED');sessions.assert(ticket);need(e.observedAt<=now()&&now()<e.observedAt+30000,'CART_CAPABILITY_STALE');};
  try{
   const buyerIp=await resolveBuyerIp(request);guard();const input={cart_id,buyerIp};
   const before=await transport.read(input);guard();
   need(before.parsed.customer_id===null,'CART_CUSTOMER_PROOF_UNAVAILABLE');
   need(before.parsed.lines.every(line=>!printLine(line)),'CART_PRINTING_PROOF_UNAVAILABLE');
   ledger.sending(id,capabilitySnapshot(before.raw));sent=true;
   const changed=await transport.check(input);guard();
   const after=await transport.read(input);guard();
   need(capabilitySnapshot(before.raw)===capabilitySnapshot(after.raw),'CART_CAPABILITY_CHANGED');
   if(changed.rejected){ledger.finish(id,'rejected');finished=true;throw new RuntimeError('CART_CAPABILITY_REJECTED');}
   need(capabilitySnapshot(before.raw)===capabilitySnapshot(changed.raw),'CART_CAPABILITY_CHANGED');
   if(bind){
    // Compute strict binding from this invocation's authenticated principal and
    // successful private/full-key observation; recheck after binder awaits.
    const bound=await bindOwnedObservation({cart:after.parsed,ticket,e,binding:id,now});guard();
    const binding=store.lifecycle.transaction(()=>{sessions.assertCartContext(ticket,e);const b=owned.complete(ticket,id);ledger.finish(id,'capability_only');return b;});
    finished=true;
    return {binding_id:binding,owned:true,owner_kind:'application',generation:ticket.generation,
     observed_customer_account:bound.customer_id===null?'absent':'unsupported',cart_verified:false,checkout_ready:false};
   }
   ledger.finish(id,'capability_only');
   return {attempt_id:id,capability:'verified',buyer_association:'no_customer_account',
    buyer_association_basis:'private_token_and_accepted_full_key',
    customer_context:'unproven',cart_verified:false,checkout_ready:false};
  }catch(e){if(!finished)ledger.finish(id,sent?'unknown':'rejected');throw e instanceof RuntimeError?e:new RuntimeError('CART_CAPABILITY_UNAVAILABLE');}
 };
 return Object.freeze({inspect,bind:input=>inspect(input,true),status(request,id){const t=sessions.authenticate(request);sessions.assert(t);return ledger.status(id,t);},
  async verifyOwnership(){throw new RuntimeError('CART_BUYER_PROOF_UNAVAILABLE');},
 });
}
