import {createResourceSession} from './resource-session.js';
// Explicit nonvisual consumer. No automatic activation, persistence, global
// session/capability, form binding, completion claims or client-nominated UUID.
export function createOwnedUploads(options,session=createResourceSession(options)){
  const intents=new Set();
  const own=id=>{if(!intents.has(id))throw Error('UPLOAD_INTENT_UNAVAILABLE');return `/uploads/${id}`;};
  return Object.freeze({issue:session.issue,renew:session.renew,
    restore(receipts){
      if(intents.size||!Array.isArray(receipts)||!receipts.length||receipts.some(r=>r.state!=='complete'||typeof r.intent_id!=='string'))throw Error('UPLOAD_UNAVAILABLE');
      for(const r of receipts)intents.add(r.intent_id);
    },
    async revoke(){intents.clear();return session.revoke();},
    async intent(requestKey){const r=await session.request('/uploads/intents',{request_key:requestKey});
      if(typeof r.intent_id!=='string'||r.checkout_ready!==false)throw Error('UPLOAD_UNAVAILABLE');
      intents.add(r.intent_id);return r;},
    async bytes(id,file){
      if(!(file instanceof Blob)||!['image/png','image/jpeg','image/tiff'].includes(file.type)||file.size<1||file.size>20*1024*1024)throw Error('UPLOAD_IMAGE_INVALID');
      return session.request(own(id)+'/bytes',file,{mime:file.type});
    },
    crop:(id,crop)=>session.request(own(id)+'/crop',crop),
    status:id=>session.request(own(id)+'/status',{}),
    source:(id,url)=>session.request(own(id)+'/source',{url}),
    remove:id=>session.request(own(id)+'/remove',{}),
    // Signed CDN URL is a short-lived provider capability in the response, not
    // the application bearer. Caller must not persist/log it or put it in links.
    preview:id=>session.request(own(id)+'/preview',{}),
    original:id=>session.request(own(id)+'/original',{}),
  });
}
