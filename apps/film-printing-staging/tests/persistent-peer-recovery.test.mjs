import test from 'node:test';
import assert from 'node:assert/strict';
import {persistentRig} from '../../../fixtures/film-printing/persistent-client-staging-20261030/rig.mjs';
import {resolveDirectBuyerIp} from '../backend/buyer-ip.mjs';
const act=(f,role,name,cart=f.ids[role],input={})=>f.clients[role].session.checkout(name,async()=>cart,input);
const plain=value=>JSON.parse(JSON.stringify(value));
const darkroom={service:'Darkroom Prints',size:'8” × 10”',paper:'RC Matte',lab:'Chicago',options:{Process:'Color',Borders:'Borderless (Edge-to-edge)',Turnaround:'Standard (4-5 days)','Scanning Options':'Yes',Negatives:'Mail In'},asset_ids:[],copies:1,message:'Peer crash regression'};
async function missingPeer(t){
 let bindReads=0;
 const f=await persistentRig(t,{resolveBuyerIp(request){
  const ip=resolveDirectBuyerIp(request);
  if(request.url==='/checkout/bind'&&++bindReads===2)throw Error('interrupted after durable capability completion before rememberPeer');
  return ip;
 }});
 let writes=0;f.hook=async(stage,{query}={})=>{if(stage==='storefront'&&query.startsWith('mutation'))writes++;};
 await f.clients.A.session.issue();await assert.rejects(act(f,'A','bind'));
 assert.equal(f.rows().staging_capability_attempts[0].state,'capability_only');assert.equal(f.rows().staging_cart_peers.length,0);assert.equal(writes,1);
 return {f,writes:()=>writes};
}

test('fresh authenticated current repairs the exact missing peer after capability commit and restart',async t=>{
 const {f,writes}=await missingPeer(t),owners=plain(f.rows().resource_sessions),attempt=plain(f.rows().staging_capability_attempts);
 await f.restart();await act(f,'A','install');assert.equal(f.rows().staging_cart_peers.length,0);const native=writes(),admin=f.counts.admin_mutations;
 await act(f,'A','current');assert.equal(f.rows().staging_cart_peers.length,1);assert.equal(f.rows().staging_cart_peers[0].owner,owners[0].owner);assert.equal(f.rows().staging_cart_peers[0].buyer_ip,'127.0.0.1');
 assert.equal(writes(),native);assert.equal(f.counts.admin_mutations,admin);assert.deepEqual(plain(f.rows().resource_sessions),owners);assert.deepEqual(plain(f.rows().staging_capability_attempts),attempt);
 // Publication validates staging.wireFor(owner), which requires this peer.
 const job=await f.clients.A.session.request('/jobs',{...darkroom,request_key:'missing-peer-after-restart'});
 const prepared=await act(f,'A','eligible',f.ids.A,{reference:job.reference,generation:1});assert.equal(prepared.prepared,true);assert.equal(writes(),native);
});

test('different cart and wrong marker cannot repair a peer; valid current preserves another owner',async t=>{
 const {f,writes}=await missingPeer(t);await f.restart();await act(f,'A','install');
 await f.clients.B.session.issue();await act(f,'B','bind');await act(f,'B','install');const other=plain(f.rows().staging_cart_peers),native=writes();assert.equal(other.length,1);
 await assert.rejects(act(f,'A','current',f.ids.B));assert.deepEqual(plain(f.rows().staging_cart_peers),other);
 const cart=f.carts.get(f.ids.A),marker=cart.marker;cart.marker='a'.repeat(64);await assert.rejects(act(f,'A','current'));assert.deepEqual(plain(f.rows().staging_cart_peers),other);cart.marker=marker;
 await act(f,'A','current');assert.equal(f.rows().staging_cart_peers.length,2);assert.deepEqual(plain(f.rows().staging_cart_peers.find(row=>row.owner===other[0].owner)),other[0]);assert.equal(writes(),native);
});
