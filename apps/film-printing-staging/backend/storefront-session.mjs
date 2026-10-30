import {randomBytes,createHash} from 'node:crypto';
import {createProxyContextVerifier} from '../checkout/proxy-context.mjs';
import {STORE} from '../configuration/schema.mjs';
import {need} from './config.mjs';
const digest=value=>createHash('sha256').update(value).digest('hex');
const opaque=()=>randomBytes(32).toString('base64url');
const valid=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{43}$/.test(value);
export const STOREFRONT_ORIGIN=`https://${STORE}`;
export const PROXY_PREFIX='/apps/bfl-staging';
// Context only. This is NEVER an owner/cart verifier or a job/upload credential.
// Restart revokes all context sessions. No durable authority is created here.
export function createStorefrontSessions({secret,now=Date.now,maxEntries=256}={}) {
  need(Number.isInteger(maxEntries)&&maxEntries>0&&maxEntries<=256,'SESSION_CONFIG');
  const verify=createProxyContextVerifier({secret,pathPrefix:PROXY_PREFIX,now});
  const challenges=new Map(),sessions=new Map();
  const sweep=()=>{for(const map of [challenges,sessions])for(const [k,v] of map)if(v.expires<=now())map.delete(k);};
  const origin=req=>need(req?.headers?.origin===STOREFRONT_ORIGIN,'SESSION_ORIGIN');
  const take=(map,key)=>{const row=map.get(key);need(row&&row.expires>now(),'SESSION_REJECTED');return row;};
  return Object.freeze({
    challenge(req){origin(req);sweep();need(challenges.size<maxEntries,'SESSION_CAPACITY');
      const challenge=opaque(),verifier=opaque();
      challenges.set(digest(challenge),{verifier:digest(verifier),expires:now()+60000,ticket:null,context:null});
      return {challenge,verifier,expires_in:60,checkout_ready:false};
    },
    bootstrap(rawQuery){sweep();const context=verify(rawQuery),query=new URLSearchParams(rawQuery);
      need(query.getAll('challenge').length===1&&valid(query.get('challenge')),'SESSION_REJECTED');
      const row=take(challenges,digest(query.get('challenge')));need(!row.ticket,'SESSION_REPLAY');
      // The response-only ticket prevents a cross-site navigation with an
      // attacker-chosen challenge from authenticating the attacker's session.
      // No CORS on this route. Signed query replay cannot retrieve the ticket.
      const ticket=opaque();row.ticket=digest(ticket);row.context=context;
      return {ticket,expires_in:Math.max(0,Math.floor((row.expires-now())/1000)),checkout_ready:false};
    },
    exchange(req,input){origin(req);sweep();need(valid(input?.challenge)&&valid(input?.verifier)&&valid(input?.ticket),'SESSION_REJECTED');
      const key=digest(input.challenge),row=take(challenges,key);
      need(row.ticket===digest(input.ticket)&&row.verifier===digest(input.verifier)&&row.context,'SESSION_REJECTED');
      need(sessions.size<maxEntries,'SESSION_CAPACITY');challenges.delete(key);
      const token=opaque();sessions.set(digest(token),{context:row.context,expires:now()+60000});
      return {token,expires_in:60,context:row.context,cart_verified:false,checkout_ready:false};
    },
    authenticate(req){origin(req);sweep();const auth=req.headers.authorization;
      need(typeof auth==='string'&&/^Bearer [A-Za-z0-9_-]{43}$/.test(auth),'SESSION_REJECTED');
      const row=take(sessions,digest(auth.slice(7)));
      return {...row.context,cart_verified:false,checkout_ready:false};
    },
    revoke(req){this.authenticate(req);sessions.delete(digest(req.headers.authorization.slice(7)));return {revoked:true,cart_verified:false,checkout_ready:false};},
    close(){challenges.clear();sessions.clear();},
  });
}
