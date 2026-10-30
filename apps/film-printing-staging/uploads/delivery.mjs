import {createHmac} from 'node:crypto';
import {need} from '../backend/config.mjs';
import {uuid} from './ledger.mjs';

// Trusted operator composition, never browser input. These assertions must be
// backed by actual project settings and unsigned-original probes. They do not
// discover settings, prove ownership, or continuously detect provider drift.
export function deliveryPolicy(config) {
  const d=config?.delivery;
  need(d&&d.publicAccessDisabled===true&&d.legacyAccessDisabled===true&&
    d.projectKey===config.publicKey&&Number.isSafeInteger(config.projectId)&&config.projectId>0,'UPLOAD_PRIVATE_DELIVERY_REQUIRED');
  let u;try {u=new URL(d.origin);}catch {need(false,'UPLOAD_DELIVERY_ORIGIN_INVALID');}
  need(u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&u.pathname==='/'&&!u.search&&!u.hash&&
    u.origin===d.origin&&u.hostname.includes('.')&&u.origin!==config.cdnOrigin&&
    !['ucarecdn.com','www.ucarecdn.com'].includes(u.hostname),'UPLOAD_DELIVERY_ORIGIN_INVALID');
  return Object.freeze({...d});
}

// Fixed original/preview paths or a validated exact crop. No wildcards, client expiry,
// arbitrary transformation, or original-filename input. Secret is hex-decoded
// per Uploadcare's signed-delivery contract, distinct from the REST API key.
export function signDelivery(config,asset,variant,now,checkedUntil,crop=null) {
  const d=deliveryPolicy(config);
  need(uuid(asset)&&['original','preview','crop'].includes(variant),'UPLOAD_DELIVERY_INVALID');
  need(typeof d.signingSecret==='string'&&/^[a-f0-9]{64}$/.test(d.signingSecret)&&
    d.signingSecret!==config.secret,'UPLOAD_DELIVERY_SECRET_REQUIRED');
  need(Number.isSafeInteger(now)&&Number.isSafeInteger(checkedUntil),'UPLOAD_DELIVERY_INVALID');
  const expires=Math.min(Math.floor(now/1000)+30,Math.floor(checkedUntil/1000));
  need(expires>Math.floor(now/1000),'UPLOAD_REVALIDATION_REQUIRED');
  const path=`/${asset}/`+(variant==='crop'?cropModifiers(crop):variant==='preview'?'-/resize/640x/':'');
  const body=`exp=${expires}~acl=${path}`;
  const token=body+'~hmac='+createHmac('sha256',Buffer.from(d.signingSecret,'hex')).update(body).digest('hex');
  return {url:`${d.origin}${path}?token=${token}`,expires_at:expires*1000,checkout_ready:false};
}

// Pixel rectangles only: no client URL, arbitrary modifier, resizing or expiry.
export function cropModifiers(crop) {
  need(crop&&Object.keys(crop).sort().join() === 'height,left,top,width' &&
    Object.values(crop).every(n=>Number.isSafeInteger(n)&&n>=0&&n<=100000)&&
    crop.width>0&&crop.height>0&&crop.width*crop.height<=40000000,'UPLOAD_CROP_INVALID');
  return `-/crop/${crop.width}x${crop.height}/${crop.left},${crop.top}/-/format/png/`;
}
