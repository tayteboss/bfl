import {createHmac,timingSafeEqual} from 'node:crypto';
import {STORE,CLIENT} from '../configuration/schema.mjs';
// Shopify App Bridge ID/session JWT: staff authentication ONLY, never a cart owner.
// HMAC covers the original base64url header.payload bytes, not reserialized JSON.
export function verifyAdminSession(authorization,secret,now=Date.now()) {
  if(!secret||typeof authorization!=='string'||authorization.length>8192||!authorization.startsWith('Bearer '))return null;
  try {
    const parts=authorization.slice(7).split('.');
    if(parts.length!==3||!parts.every(v=>/^[A-Za-z0-9_-]+$/.test(v)))return null;
    const [h,p,s]=parts;
    const signature=Buffer.from(s,'base64url');
    if(signature.length!==32||signature.toString('base64url')!==s)return null;
    const expected=createHmac('sha256',secret).update(`${h}.${p}`,'ascii').digest();
    if(!timingSafeEqual(expected,signature))return null;
    const header=JSON.parse(Buffer.from(h,'base64url')),claims=JSON.parse(Buffer.from(p,'base64url'));
    if(header.alg!=='HS256'||header.crit||header.b64===false)return null;
    const time=Math.floor(now/1000);
    if(claims.aud!==CLIENT||claims.dest!==`https://${STORE}`||claims.iss!==`https://${STORE}/admin`||
      ![claims.exp,claims.nbf,claims.iat].every(Number.isSafeInteger)||claims.exp<=time||claims.nbf>time||claims.iat>time||
      claims.exp-claims.iat>60||claims.exp<=claims.iat||claims.nbf>claims.exp||typeof claims.sub!=='string'||!/^\d+$/.test(claims.sub))return null;
    return {staff:claims.sub,store:STORE};
  } catch {return null;}
}
