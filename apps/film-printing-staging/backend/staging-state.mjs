import {isIP} from 'node:net';
import {need} from './config.mjs';
import {preparedPolicyReceipt,CLIENT_POLICY_ADMISSION} from '../checkout/prepared-limits.mjs';
import {cartHash} from '../checkout/storefront.mjs';
import {openCartCapability} from '../checkout/cart-capability.mjs';

export function installStagingServiceSchema(db,sourceScope){
 db.exec(`CREATE TABLE staging_service(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL,source_receipt TEXT NOT NULL);
 CREATE TABLE staging_cart_peers(owner TEXT PRIMARY KEY,buyer_ip TEXT NOT NULL,observed INTEGER NOT NULL);`);
 db.prepare('INSERT INTO staging_service VALUES (1,1,?)').run(preparedPolicyReceipt(sourceScope));
}
// Private service custody only. No route returns a peer address or decrypts a
// capability for a caller. The exact original owner and source are mandatory.
export function createStagingServiceState({db,store,sourceScope,sessionSecret,now=Date.now}){
 const receipt=preparedPolicyReceipt(sourceScope),saved=db.prepare('SELECT * FROM staging_service WHERE singleton=1').get();
 need(saved?.version===1&&saved.source_receipt===receipt,'STAGING_SERVICE_STATE');
 const member=owner=>need(db.prepare('SELECT 1 FROM resource_admissions WHERE owner=? AND kind=? AND request_hash=?').get(owner,CLIENT_POLICY_ADMISSION,receipt),'STAGING_SERVICE_OWNER');
 return Object.freeze({
  rememberPeer(ticket,ip){store.resourceSessions.assert(ticket);store.checkoutOwner.bound(ticket);member(ticket.owner);need(typeof ip==='string'&&isIP(ip)&&!ip.includes('%'),'BUYER_IP_REQUIRED');
   db.prepare('INSERT INTO staging_cart_peers VALUES (?,?,?) ON CONFLICT(owner) DO UPDATE SET buyer_ip=excluded.buyer_ip,observed=excluded.observed').run(ticket.owner,ip,now());
  },
  wireFor(owner){member(owner);const ticket=store.resourceSessions.ticketForOwner(owner),bound=store.checkoutOwner.bound(ticket),peer=db.prepare('SELECT * FROM staging_cart_peers WHERE owner=?').get(owner);
   need(peer&&isIP(peer.buyer_ip),'STAGING_CART_PEER_UNAVAILABLE');const cart_id=openCartCapability(bound.sealed_cart,sessionSecret);
   need(cartHash(cart_id)===bound.cart_hash,'STAGING_CART_CHANGED');return {ticket,bound,wire:{cart_id,buyerIp:peer.buyer_ip}};
  },
  ownerForJob(id){const row=db.prepare('SELECT owner FROM jobs WHERE id=?').get(id);need(row,'JOB_UNAVAILABLE');member(row.owner);return row.owner;},
  owners(){return db.prepare('SELECT s.owner,s.expires,s.deadline,s.revoked FROM resource_sessions s JOIN resource_admissions a ON a.owner=s.owner WHERE a.kind=? AND a.request_hash=?').all(CLIENT_POLICY_ADMISSION,receipt);},
  resourceOwners(){return db.prepare('SELECT owner FROM staging_resource_state WHERE source_receipt=?').all(receipt).map(row=>row.owner);},
  refreshableAssets(){return db.prepare(`SELECT i.owner,i.id,i.asset FROM upload_intents i JOIN resource_sessions s ON s.owner=i.owner
   JOIN resource_admissions a ON a.owner=s.owner WHERE a.kind=? AND a.request_hash=? AND s.revoked IS NULL AND s.expires>? AND s.deadline>?
   AND i.state IN ('pending','complete') AND i.asset IS NOT NULL AND i.expires>? AND i.checked_until<=?`).all(CLIENT_POLICY_ADMISSION,receipt,now(),now(),now(),now());},
  invalidations(events){
   const owners=new Set(),jobs=new Set();
   for(const event of events){
    if(event.id.startsWith('resource:revoke:')){const owner=event.id.slice('resource:revoke:'.length);member(owner);need(store.lifecycle.retired('owner',owner),'STAGING_INVALIDATION_UNPROVEN');owners.add(owner);continue;}
    if(event.id.startsWith('uc:terminal:')){const row=store.uploadLedger.read(event.id.slice('uc:terminal:'.length));member(row?.owner);need(row?.asset&&['failed','removed'].includes(row.state),'STAGING_INVALIDATION_UNPROVEN');
     for(const job of db.prepare("SELECT DISTINCT jobs.id FROM jobs,json_each(jobs.body,'$.completed_asset_ids') a WHERE jobs.owner=? AND a.value=?").all(row.owner,row.asset))jobs.add(job.id);continue;
    }
    if(event.id.startsWith('prepared-cancel:')){const row=db.prepare('SELECT * FROM cart_prepared_jobs WHERE operation_id=?').get(event.id.slice('prepared-cancel:'.length));need(row?.state==='cancelled','STAGING_INVALIDATION_UNPROVEN');const owner=this.ownerForJob(row.job_id);member(owner);jobs.add(row.job_id);continue;}
    need(false,'STAGING_INVALIDATION_UNPROVEN');
   }
   return {excludeOwners:[...owners],excludeJobs:[...jobs]};
  },
 });
}
