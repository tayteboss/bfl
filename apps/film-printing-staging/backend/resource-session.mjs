import {randomBytes,createHash} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import {need} from './config.mjs';
import {STOREFRONT_ORIGIN} from './storefront-session.mjs';
import {preparedPolicy,preparedPolicyReceipt,preparedOwnerPolicy,CLIENT_POLICY_ADMISSION} from '../checkout/prepared-limits.mjs';
import {assertEngineeringScope} from '../configuration/engineering.mjs';

export const RESOURCE_PURPOSE='bfl:application-resources:v1';
export const UPLOAD_ONLY_PURPOSE='bfl:application-uploads-only:v1';
export const SESSION_ONLY_PURPOSE='bfl:application-session-only:v1';
export const RESOURCE_AUDIENCE=`${STOREFRONT_ORIGIN}/bfl-application-resources`;
export const RESOURCE_BOUNDS=Object.freeze({ttlMs:300000,absoluteMs:3600000,freshMs:30000,
  sessions:256,evidence:4096,issuesPerMinute:16,generations:24,jobs:16,uploads:1000});
export const CUSTOMER_SESSION_TTL_MS=600000;
export const resourceTables=['resource_sessions','resource_evidence','resource_admissions'];
const digest=(domain,value)=>createHash('sha256').update(`${RESOURCE_PURPOSE}\0${domain}\0${value}`).digest('hex');
const opaque=()=>randomBytes(32).toString('base64url');
export function installResourceSchema(db) {
  db.exec(`CREATE TABLE resource_sessions (
    owner TEXT PRIMARY KEY, verifier TEXT NOT NULL UNIQUE, purpose TEXT NOT NULL, audience TEXT NOT NULL,
    generation INTEGER NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL, deadline INTEGER NOT NULL,
    revoked INTEGER, observation TEXT NOT NULL);
    CREATE TABLE resource_evidence (verifier TEXT PRIMARY KEY, observed INTEGER NOT NULL, used INTEGER NOT NULL, action TEXT NOT NULL);
    CREATE TABLE resource_admissions (owner TEXT NOT NULL, kind TEXT NOT NULL, request_hash TEXT NOT NULL,
      PRIMARY KEY(owner,kind,request_hash));`);
}
// Only installed by explicit offline migration. Tokens are random, opaque and
// domain-separated; no raw customer ID, cart or recoverable credential is persisted.
export function createResourceSessions(db,lifecycle,now=Date.now,{sessionOnly=false,uploadOnly=false,retireUploadOwner,cartOwner=false,checkoutOwner=false,persistentSourceScope=null}={}) {
  const tx=lifecycle.transaction, B=RESOURCE_BOUNDS;
  need(!(sessionOnly&&uploadOnly),'RESOURCE_COMPOSITION_INVALID');
  need(!checkoutOwner||!sessionOnly&&!uploadOnly&&!cartOwner,'RESOURCE_COMPOSITION_INVALID');
  const persistent=persistentSourceScope!==null;
  need(!persistent||checkoutOwner&&preparedPolicy(persistentSourceScope).clientPolicy==='bfl-persistent-staging-client-v1','RESOURCE_COMPOSITION_INVALID');
  const purpose=sessionOnly?SESSION_ONLY_PURPOSE:uploadOnly?UPLOAD_ONLY_PURPOSE:RESOURCE_PURPOSE;
  const clock=()=>{const t=now();need(Number.isSafeInteger(t)&&t>=0,'RESOURCE_CLOCK');return t;};
  const available=()=>{const state=lifecycle.state();need(!state.operation&&!state.pending,'RESOURCE_FENCED');return state;};
  const rowFor=verifier=>db.prepare('SELECT * FROM resource_sessions WHERE verifier=?').get(verifier);
  const valid=row=>{
    const t=clock();need(row&&row.purpose===purpose&&row.audience===RESOURCE_AUDIENCE&&
      row.revoked===null&&row.expires>t&&row.deadline>t&&row.created<=t&&
      !lifecycle.retired('owner',row.owner),'RESOURCE_REJECTED');
    if(cartOwner)need(db.prepare('SELECT 1 FROM cart_owner_admissions WHERE owner=?').get(row.owner),'CART_NEW_OWNER_REQUIRED');
    if(checkoutOwner)need(db.prepare('SELECT 1 FROM checkout_owner_admissions WHERE owner=?').get(row.owner),'CART_NEW_OWNER_REQUIRED');
    return row;
  };
  const evidence=(e,action)=>{
    const t=clock();need(e&&typeof e.id==='string'&&/^[A-Za-z0-9_-]{32,128}$/.test(e.id)&&
      Number.isSafeInteger(e.observedAt)&&e.observedAt<=t&&e.observedAt>t-B.freshMs&&
      (e.customerId===null||typeof e.customerId==='string'&&/^gid:\/\/shopify\/Customer\/[1-9][0-9]*$/.test(e.customerId)),'RESOURCE_EVIDENCE');
    // Concrete proof consumption precedes an HTTP await. Recheck its lifecycle
    // epoch inside this same issuance/rotation transaction before committing.
    if(e.epoch!==undefined)need(Number.isSafeInteger(e.epoch)&&available().epoch===e.epoch,'RESOURCE_FENCED');
    need((persistent?db.prepare('SELECT count(*) AS n FROM resource_evidence WHERE used>?').get(t-60000):db.prepare('SELECT count(*) AS n FROM resource_evidence').get()).n<B.evidence,'RESOURCE_CAPACITY');
    const key=digest('evidence',e.id);need(!db.prepare('SELECT 1 FROM resource_evidence WHERE verifier=?').get(key),'RESOURCE_REPLAY');
    db.prepare('INSERT INTO resource_evidence VALUES (?,?,?,?)').run(key,e.observedAt,t,action);
    return digest('customer-observation',e.customerId??'absent');
  };
  const credential=()=>`bflr1_${opaque()}`;
  const response=(token,row)=>({token,expires_in:Math.floor((row.expires-clock())/1000),generation:row.generation,
    resource_only:true,cart_verified:false,checkout_ready:false});
  const retire=row=>{
    db.prepare('UPDATE resource_sessions SET revoked=?,generation=generation+1 WHERE owner=?').run(clock(),row.owner);
    if(sessionOnly){
      // This purpose can never admit resources and cannot authenticate in the
      // resource runtime. Retain a local tombstone and advance the same durable
      // fence without inventing a remote reconciliation obligation or success.
      // Existing pending events/unknown operations are deliberately untouched.
      need(row.purpose===SESSION_ONLY_PURPOSE,'RESOURCE_REJECTED');
      lifecycle.retire('owner',row.owner);
      db.prepare('UPDATE authority_state SET epoch=epoch+1 WHERE singleton=1').run();
    }else if(uploadOnly){
      need(row.purpose===UPLOAD_ONLY_PURPOSE&&typeof retireUploadOwner==='function','RESOURCE_REJECTED');
      retireUploadOwner(row.owner);
    }else lifecycle.event(`resource:revoke:${row.owner}`,{kind:'owner',owner:row.owner},()=>lifecycle.retire('owner',row.owner));
  };
  const service={
    // Durable admission receipts share the evidence ceiling. Transient secrets
    // never enter SQLite; restart destroys outstanding exchanges, not receipts.
    reserveProofChallenge(id){return tx(()=>{
      const state=available(),t=clock();
      need(typeof id==='string'&&/^[A-Za-z0-9_-]{43}$/.test(id),'RESOURCE_EVIDENCE');
      need((persistent?db.prepare('SELECT count(*) AS n FROM resource_evidence WHERE used>?').get(t-60000):db.prepare('SELECT count(*) AS n FROM resource_evidence').get()).n<B.evidence,'RESOURCE_CAPACITY');
      need(db.prepare("SELECT count(*) AS n FROM resource_evidence WHERE action='proof-challenge' AND used>?").get(t-60000).n<32,'RESOURCE_RATE');
      db.prepare('INSERT INTO resource_evidence VALUES (?,?,?,?)').run(digest('proof-challenge',id),t,t,'proof-challenge');
      return state.epoch;
    });},
    assertProofEpoch(epoch){need(available().epoch===epoch,'RESOURCE_FENCED');},
    issue(e,{ttlMs=B.ttlMs,sourceScope}={}){return tx(()=>{
      // Trusted composition selects the initial policy. Issued rows and renewal
      // retain their original semantics; no HTTP body can nominate a duration.
      const policy=preparedPolicy(sourceScope);
      need(ttlMs===B.ttlMs||checkoutOwner&&(ttlMs===CUSTOMER_SESSION_TTL_MS||policy.clientPolicy&&ttlMs===policy.ownerMs),'RESOURCE_SESSION_POLICY');
      const full=checkoutOwner&&policy.clientPolicy&&ttlMs===policy.ownerMs;
      available();const t=clock();
      need((persistent?db.prepare('SELECT count(*) AS n FROM resource_sessions WHERE revoked IS NULL AND expires>? AND deadline>?').get(t,t):db.prepare('SELECT count(*) AS n FROM resource_sessions').get()).n<B.sessions,'RESOURCE_CAPACITY');
      need(db.prepare("SELECT count(*) AS n FROM resource_evidence WHERE action='issue' AND used>?").get(t-60000).n<B.issuesPerMinute,'RESOURCE_RATE');
      if(cartOwner){
        need(e?.customerId===null,'CART_CUSTOMER_PROOF_UNAVAILABLE');
        need(db.prepare('SELECT count(*) AS n FROM cart_owner_admissions').get().n<2,'CART_OWNER_CAPACITY');
      }
      if(checkoutOwner)need(e?.customerId===null,'CART_CUSTOMER_PROOF_UNAVAILABLE');
      const observation=evidence(e,'issue'),owner=`resource_${opaque()}`,token=credential();
      const persistentPolicy=full&&policy.clientPolicy==='bfl-persistent-staging-client-v1';
      const absolute=persistentPolicy?policy.ownerMs:B.absoluteMs;
      const row={owner,generation:1,expires:full&&!persistentPolicy?Math.min(t+ttlMs,assertEngineeringScope(sourceScope).contract.expires_at):t+ttlMs};
      need(row.expires>t&&row.expires<=t+absolute,'RESOURCE_SESSION_POLICY');
      db.prepare('INSERT INTO resource_sessions VALUES (?,?,?,?,?,?,?,?,NULL,?)').run(owner,digest('credential',token),
        purpose,RESOURCE_AUDIENCE,1,t,row.expires,t+absolute,observation);
      if(cartOwner)db.prepare('INSERT INTO cart_owner_admissions VALUES (?,?,NULL,NULL)').run(owner,t);
      if(checkoutOwner)db.prepare('INSERT INTO checkout_owner_admissions VALUES (?,?,NULL,NULL)').run(owner,t);
      if(full)db.prepare('INSERT INTO resource_admissions VALUES (?,?,?)').run(owner,CLIENT_POLICY_ADMISSION,preparedPolicyReceipt(sourceScope));
      return {...response(token,row),...(full?{client_policy:policy.clientPolicy}:{}),...(persistentPolicy?{expires_at:row.expires}:{})};
    });},
    retireExpiredCartOwners(){return tx(()=>{
      if(!cartOwner&&!checkoutOwner)return;
      const membership=checkoutOwner?'checkout_owner_admissions':'cart_owner_admissions';
      const time=clock();
      for(const row of db.prepare(`SELECT s.* FROM resource_sessions s JOIN ${membership} c ON c.owner=s.owner WHERE s.revoked IS NULL`).all())
        if(row.expires<=time||row.deadline<=time||lifecycle.retired('owner',row.owner))retire(row);
    });},
    authenticate(req){
      need(req?.headers?.origin===STOREFRONT_ORIGIN&&req.headers.cookie===undefined,'RESOURCE_ORIGIN');
      for(const name of ['origin','authorization'])if(req.rawHeaders)need(req.rawHeaders.filter((_,i)=>i%2===0&&req.rawHeaders[i].toLowerCase()===name).length===1,'RESOURCE_REJECTED');
      const auth=req.headers.authorization;need(typeof auth==='string'&&/^Bearer bflr1_[A-Za-z0-9_-]{43}$/.test(auth),'RESOURCE_REJECTED');
      const row=valid(rowFor(digest('credential',auth.slice(7))));
      return Object.freeze({owner:row.owner,verifier:row.verifier,generation:row.generation,epoch:lifecycle.state().epoch});
    },
    // Private service maintenance can validate its retained owners without
    // storing raw browser credentials. This is never an HTTP authentication path.
    ticketForOwner(owner){
      need(persistent,'RESOURCE_COMPOSITION_INVALID');
      const row=valid(db.prepare('SELECT * FROM resource_sessions WHERE owner=?').get(owner));
      need(preparedOwnerPolicy(db,row.owner,persistentSourceScope).clientPolicy==='bfl-persistent-staging-client-v1','RESOURCE_REJECTED');
      return Object.freeze({owner:row.owner,verifier:row.verifier,generation:row.generation,epoch:available().epoch});
    },
    authenticateTerminal(req){
      need(persistent&&req?.headers?.origin===STOREFRONT_ORIGIN&&req.headers.cookie===undefined,'RESOURCE_ORIGIN');
      for(const name of ['origin','authorization'])if(req.rawHeaders)need(req.rawHeaders.filter((_,i)=>i%2===0&&req.rawHeaders[i].toLowerCase()===name).length===1,'RESOURCE_REJECTED');
      const auth=req.headers.authorization;need(typeof auth==='string'&&/^Bearer bflr1_[A-Za-z0-9_-]{43}$/.test(auth),'RESOURCE_REJECTED');
      const row=rowFor(digest('credential',auth.slice(7))),t=clock();
      need(row&&row.purpose===RESOURCE_PURPOSE&&row.audience===RESOURCE_AUDIENCE&&row.created<=t&&row.expires<=t&&row.deadline<=t&&
        preparedOwnerPolicy(db,row.owner,persistentSourceScope).clientPolicy==='bfl-persistent-staging-client-v1','RESOURCE_REJECTED');
      return Object.freeze({...row,epoch:available().epoch});
    },
    assert(ticket){
      const row=valid(rowFor(ticket?.verifier));
      need(row.owner===ticket.owner&&row.generation===ticket.generation&&available().epoch===ticket.epoch,'RESOURCE_FENCED');return row;
    },
    clientPolicy(ticket,sourceScope){const row=service.assert(ticket);return preparedOwnerPolicy(db,row.owner,sourceScope).clientPolicy;},
    assertCartContext(ticket,e){
      const row=service.assert(ticket),t=clock();
      need(row.purpose===RESOURCE_PURPOSE,'CART_CAPABILITY_PURPOSE');
      need(e?.customerId===null&&e.epoch===ticket.epoch&&Number.isSafeInteger(e.observedAt)&&e.observedAt<=t&&e.observedAt>t-B.freshMs&&row.observation===digest('customer-observation','absent'),'CART_CUSTOMER_PROOF_UNAVAILABLE');
    },
    renew(ticket,e){return tx(()=>{
      const row=service.assert(ticket);
      need(!db.prepare('SELECT 1 FROM resource_admissions WHERE owner=? AND kind=?').get(row.owner,CLIENT_POLICY_ADMISSION),'RESOURCE_SESSION_POLICY');
      const observation=evidence(e,'renew');
      if(observation!==row.observation){retire(row);return {rejected:true,code:'RESOURCE_CONTEXT_CHANGED',checkout_ready:false};}
      need(row.generation<B.generations,'RESOURCE_RENEWAL_LIMIT');
      const token=credential(),expires=Math.min(clock()+B.ttlMs,row.deadline),generation=row.generation+1;
      db.prepare('UPDATE resource_sessions SET verifier=?,generation=?,expires=? WHERE owner=? AND generation=?').run(
        digest('credential',token),generation,expires,row.owner,row.generation);
      return response(token,{expires,generation});
    });},
    revoke(ticket){return tx(()=>{
      // Logout remains possible while unrelated lifecycle work is pending.
      const row=valid(rowFor(ticket?.verifier));need(row.owner===ticket.owner&&row.generation===ticket.generation,'RESOURCE_FENCED');
      retire(row);return {revoked:true,checkout_ready:false};
    });},
    admit(ticket,kind,key,{sourceScope}={}){return tx(()=>{
      need(!sessionOnly,'SESSION_ONLY');
      need(!uploadOnly||kind==='uploads','UPLOAD_ONLY');
      service.assert(ticket);
      need(!cartOwner&&! (db.prepare("SELECT 1 FROM sqlite_master WHERE name='cart_owner_admissions'").get()&&db.prepare('SELECT 1 FROM cart_owner_admissions WHERE owner=?').get(ticket.owner)),'CART_OWNER_RESOURCE_CLOSED');
      need(['jobs','uploads'].includes(kind)&&typeof key==='string'&&/^[A-Za-z0-9_-]{8,100}$/.test(key),'RESOURCE_INPUT');
      const h=digest('request',key);
      if(db.prepare('SELECT 1 FROM resource_admissions WHERE owner=? AND kind=? AND request_hash=?').get(ticket.owner,kind,h))return;
      const maximum=kind==='jobs'?preparedOwnerPolicy(db,ticket.owner,sourceScope).resourceJobs:B[kind];
      need(db.prepare('SELECT count(*) AS n FROM resource_admissions WHERE owner=? AND kind=?').get(ticket.owner,kind).n<maximum,'RESOURCE_ADMISSION_LIMIT');
      db.prepare('INSERT INTO resource_admissions VALUES (?,?,?)').run(ticket.owner,kind,h);
    });},
  };
  return Object.freeze(service);
}

// Trusted process composition only. Check fences immediately before every
// synchronous resource store/ledger primitive, including commits after awaits.
// The final check also suppresses stale async responses. No remote CAS is claimed.
export function createResourceScope(store,sessions) {
  const scope=new AsyncLocalStorage();
  const check=()=>{const ticket=scope.getStore();if(ticket)sessions.assert(ticket);};
  const wrap=object=>new Proxy(object,{get(target,key){
    const value=target[key];return typeof value==='function'?(...args)=>{check();return value.apply(target,args);}:value;
  }});
  const guarded=wrap({...store,uploadLedger:wrap(store.uploadLedger),orders:wrap(store.orders)});
  return {store:guarded,
    // A synchronous terminal removal deliberately advances the lifecycle epoch.
    // Its owned read and mutation execute in one turn; no async resource grant is
    // returned. Do not apply the stale async-response check to its own event.
    remove(ticket,work){sessions.assert(ticket);return scope.run(ticket,work);},
    async run(ticket,work){sessions.assert(ticket);return scope.run(ticket,async()=>{
    const result=await work();sessions.assert(ticket);return result;
  });}};
}
