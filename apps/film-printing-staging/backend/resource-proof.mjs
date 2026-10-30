import {randomBytes,createHash} from 'node:crypto';
import {createProxyContextVerifier} from '../checkout/proxy-context.mjs';
import {PROXY_PREFIX,STOREFRONT_ORIGIN} from './storefront-session.mjs';
import {RESOURCE_AUDIENCE,RESOURCE_BOUNDS,RESOURCE_PURPOSE} from './resource-session.mjs';
import {need} from './config.mjs';

export const PROOF_PURPOSE='bfl:resource-fresh-proof:v1';
export const PROOF_BOUNDS=Object.freeze({entries:256,ttlMs:30000,challengesPerMinute:32});
const opaque=()=>randomBytes(32).toString('base64url');
const valid=s=>typeof s==='string'&&/^[A-Za-z0-9_-]{43}$/.test(s);
const hash=(kind,s)=>createHash('sha256').update(`${PROOF_PURPOSE}\0${kind}\0${s}`).digest('hex');
// Only ephemeral verifier/ticket/proof hashes and signed context live here.
// Durable admission and consumption receipts remain in resource_evidence.
// Restart discards every pending exchange; it never reconstructs ownership.
export function createResourceProof({secret,sessions,now=Date.now,cartCapability=false}) {
  const verify=createProxyContextVerifier({secret,pathPrefix:PROXY_PREFIX,now});
  const challenges=new Map(),proofs=new Map();let closed=false;
  const clock=()=>{const t=now();need(!closed&&Number.isSafeInteger(t)&&t>=0,'PROOF_UNAVAILABLE');return t;};
  const sweep=()=>{const t=clock();for(const map of [challenges,proofs])for(const [k,row] of map)if(row.expires<=t)map.delete(k);};
  const direct=req=>{
    need(req?.headers?.origin===STOREFRONT_ORIGIN&&req.headers.cookie===undefined,'PROOF_ORIGIN');
    for(const name of ['origin','authorization'])if(req.rawHeaders)need(req.rawHeaders.filter((_,i)=>i%2===0&&req.rawHeaders[i].toLowerCase()===name).length<=1,'PROOF_REJECTED');
  };
  const auth=(req,action)=>{
    direct(req);need((['issue','renew'].includes(action)||cartCapability&&action==='cart-capability'),'PROOF_ACTION');
    if(action==='issue'){need(req.headers.authorization===undefined,'PROOF_REJECTED');return null;}
    const ticket=sessions.authenticate(req),row=sessions.assert(ticket);
    if(action==='cart-capability')need(row.purpose===RESOURCE_PURPOSE,'PROOF_ACTION');return ticket;
  };
  const check=(row,ticket,action)=>{
    need(row&&row.expires>clock()&&row.created<=clock()&&row.action===action&&row.purpose===PROOF_PURPOSE&&row.audience===RESOURCE_AUDIENCE,'PROOF_REJECTED');
    sessions.assertProofEpoch(row.epoch);
    if(row.ticketBinding){
      sessions.assert(row.ticketBinding);
      need(ticket&&['owner','verifier','generation','epoch'].every(k=>ticket[k]===row.ticketBinding[k]),'PROOF_BINDING');
    }else need(!ticket,'PROOF_BINDING');
  };
  return Object.freeze({
    challenge(req,{action}){
      sweep();const ticketBinding=auth(req,action);
      need(challenges.size+proofs.size<PROOF_BOUNDS.entries,'PROOF_CAPACITY');
      const challenge=opaque(),verifier=opaque(),created=clock();
      const epoch=sessions.reserveProofChallenge(challenge);
      challenges.set(hash('challenge',challenge),{created,expires:created+PROOF_BOUNDS.ttlMs,epoch,action,ticketBinding,
        purpose:PROOF_PURPOSE,audience:RESOURCE_AUDIENCE,verifier:hash('verifier',verifier)});
      return {challenge,verifier,purpose:PROOF_PURPOSE,audience:RESOURCE_AUDIENCE,action,expires_in:30,checkout_ready:false};
    },
    bootstrap(rawQuery){
      sweep();const context=verify(rawQuery),q=new URLSearchParams(rawQuery);
      for(const key of ['challenge','purpose','audience','action'])need(q.getAll(key).length===1,'PROOF_REJECTED');
      need(valid(q.get('challenge'))&&q.get('purpose')===PROOF_PURPOSE&&q.get('audience')===RESOURCE_AUDIENCE,'PROOF_REJECTED');
      const row=challenges.get(hash('challenge',q.get('challenge')));
      check(row,row?.ticketBinding,q.get('action'));need(!row.responseTicket,'PROOF_REPLAY');
      // Reuse exact-shop HMAC verification, then tighten its five-minute window.
      // Second-resolution timestamps cannot establish ordering inside a second.
      const observed=context.signed_at*1000,t=clock();
      need(observed>=Math.floor(row.created/1000)*1000&&observed>t-RESOURCE_BOUNDS.freshMs,'PROOF_STALE');
      const ticket=opaque();row.responseTicket=hash('ticket',ticket);row.customerId=context.customer_id;row.observedAt=observed;
      row.expires=Math.min(row.expires,observed+RESOURCE_BOUNDS.freshMs);
      return {ticket,checkout_ready:false};
    },
    exchange(req,{challenge,verifier,ticket,action}){
      sweep();const binding=auth(req,action);
      need([challenge,verifier,ticket].every(valid),'PROOF_REJECTED');
      const key=hash('challenge',challenge),row=challenges.get(key);check(row,binding,action);
      need(row.responseTicket===hash('ticket',ticket)&&row.verifier===hash('verifier',verifier),'PROOF_REJECTED');
      const proof=opaque();challenges.delete(key);proofs.set(hash('proof',proof),row);
      return {proof,expires_in:Math.max(0,Math.floor((row.expires-clock())/1000)),checkout_ready:false};
    },
    observeFreshContext({request,proof,action,ticket}){
      sweep();const binding=auth(request,action);need(valid(proof),'PROOF_REJECTED');
      const key=hash('proof',proof),row=proofs.get(key);check(row,binding,action);
      need((!binding&&!ticket)||(binding&&ticket&&['owner','verifier','generation','epoch'].every(k=>binding[k]===ticket[k])),'PROOF_BINDING');
      // Burn before issuance: even downstream failure cannot re-use this proof.
      proofs.delete(key);
      return {id:proof,observedAt:row.observedAt,customerId:row.customerId,epoch:row.epoch};
    },
    close(){closed=true;challenges.clear();proofs.clear();},
  });
}
