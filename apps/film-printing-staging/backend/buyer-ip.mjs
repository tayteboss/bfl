import {isIP} from 'node:net';
import {need} from './config.mjs';
import {STOREFRONT_ORIGIN} from './storefront-session.mjs';

export const CADDY_PEER='172.18.0.3';
const routes=new Set(['/session/challenge','/session/exchange','/session/context','/session/revoke','/owned-cart/bind','/owned-cart/status']);
const diagnosticRoutes=new Set(['bind','install','publish','observe','inspect','resources','copy_item','control','continue'].map(action=>'/diagnostic/checkout/'+action));
const customerRoutes=new Set(['bind','install','publish','current','resume','resume_uploads','eligible','cancel_preparation','continue','replace_session'].map(action=>'/checkout/'+action));
const header='x-bfl-direct-peer';
const normalize=ip=>typeof ip==='string'&&ip.startsWith('::ffff:')&&isIP(ip.slice(7))===4?ip.slice(7):ip;
// Only the dedicated Caddy bridge peer may supply this overwritten header.
// No forwarded chain, proxy signature, Origin or IP establishes ownership.
export function resolveDirectBuyerIp(request) {
  need(request?.method==='POST'&&(routes.has(request.url)||diagnosticRoutes.has(request.url)||customerRoutes.has(request.url))&&request.headers?.origin===STOREFRONT_ORIGIN,'BUYER_IP_DIRECT_REQUIRED');
  need(normalize(request.socket?.remoteAddress)===CADDY_PEER,'BUYER_IP_PEER_REJECTED');
  const raw=request.rawHeaders;
  need(Array.isArray(raw)&&raw.filter((v,i)=>i%2===0&&typeof v==='string'&&v.toLowerCase()===header).length===1,'BUYER_IP_HEADER_REJECTED');
  const ip=request.headers[header];
  need(typeof ip==='string'&&!ip.includes('%')&&isIP(ip)!==0,'BUYER_IP_HEADER_REJECTED');
  return normalize(ip);
}
