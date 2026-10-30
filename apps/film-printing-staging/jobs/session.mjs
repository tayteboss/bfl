import {createHmac,timingSafeEqual,randomUUID} from 'node:crypto';
// For a same-origin host that preserves HttpOnly cookies. Shopify app proxies strip
// cookies: they need a separate verified bootstrap/transport, not this adapter.
// issue() is server-internal; never expose an unauthenticated owner/session issuer.
export function createSessionAuth({secret,origin,now=()=>Date.now()}) {
  if(typeof secret!=='string'||secret.length<32||!/^https?:\/\//.test(origin))throw Error('Session configuration required');
  const mac=value=>createHmac('sha256',secret).update(value).digest('base64url');
  return {
    issue(owner) {
      if(typeof owner!=='string'||!owner||owner.length>200)throw Error('Verified owner required');
      const value=Buffer.from(JSON.stringify({owner,expires:now()+3600000,nonce:randomUUID()})).toString('base64url');
      return `bfl_session=${value}.${mac(value)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600${origin.startsWith('https:')?'; Secure':''}`;
    },
    authenticate(req) {
      if(req.headers.origin!==origin)return null;
      const tokens=(req.headers.cookie??'').split(';').map(v=>v.trim()).filter(v=>v.startsWith('bfl_session='));
      if(tokens.length!==1)return null;
      const [value,signature,...rest]=tokens[0].slice(12).split('.');
      if(rest.length||!value||!signature||signature.length!==43)return null;
      if(!timingSafeEqual(Buffer.from(mac(value)),Buffer.from(signature)))return null;
      try{const session=JSON.parse(Buffer.from(value,'base64url').toString());return session.expires>now()&&typeof session.owner==='string'?session.owner:null;}catch{return null;}
    },
  };
}
