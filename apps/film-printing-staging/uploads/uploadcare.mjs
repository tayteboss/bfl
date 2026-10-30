import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {STORE,APP} from '../configuration/schema.mjs';
import {need,RuntimeError} from '../backend/config.mjs';
import {uuid,terminal} from './ledger.mjs';
import {deliveryPolicy,signDelivery,cropModifiers} from './delivery.mjs';
const snapshot=c=>Object.freeze({...c,...(c?.delivery?{delivery:Object.freeze({...c.delivery})}:{})});
export const MAX_IMAGE_BYTES=20*1024*1024;
const hash=b=>createHash('sha256').update(b).digest('hex');
const mimeTypes=new Set(['image/jpeg','image/png','image/tiff']);
const timestamp=s=>typeof s==='string'&&Number.isFinite(Date.parse(s));
export function uploadBinding(c) {
  need(c?.store===STORE&&c.app===APP&&typeof c.publicKey==='string'&&/^[a-zA-Z0-9_-]{8,100}$/.test(c.publicKey),'UPLOAD_TARGET_INVALID');
  need(typeof c.cdnOrigin==='string'&&/^https:\/\/[a-z0-9][a-z0-9-]{0,62}\.ucarecd\.net$/.test(c.cdnOrigin),'UPLOAD_CDN_INVALID');
  need(c.publicKey!=='a6c28a58daf426c6c6ec','UPLOAD_TARGET_INVALID');
  const d=c.delivery?deliveryPolicy(c):null;
  return hash(JSON.stringify([c.store,c.app,'uploadcare',c.publicKey,c.cdnOrigin,...(d?[c.projectId,'private-v1',d.origin]:[])]));
}
// Documented Upload API JWT: HS256 over a raw SHA256-derived key. Kept on
// server; sub/jti are NOT provider-enforced ownership evidence.
export function uploadToken(secret,intent,now) {
  const enc=v=>Buffer.from(JSON.stringify(v)).toString('base64url');
  const body=enc({alg:'HS256',typ:'JWT'})+'.'+enc({iat:Math.floor(now/1000),exp:Math.floor(now/1000)+60,
    jti:intent,uc:{restrictions:{scope:['/base/'],limits:{operations:1}}}});
  return body+'.'+createHmac('sha256',createHash('sha256').update(secret).digest()).update(body).digest('base64url');
}
export function restHeaders(secret,publicKey,path,now,method='GET') {
  const date=new Date(now).toUTCString(),type='application/json';
  const sign=[method,createHash('md5').update('').digest('hex'),type,date,path].join('\n');
  return {'Accept':'application/vnd.uploadcare-v0.7+json','Content-Type':type,'Date':date,
    Authorization:`Uploadcare ${publicKey}:${createHmac('sha1',secret).update(sign).digest('hex')}`};
}
export function createUploadcareTransport(config,{enabled=false,fetchImpl=globalThis.fetch,now=Date.now}={}) {
  const c=snapshot(config);uploadBinding(c);
  if(enabled)deliveryPolicy(c);
  const request=async(url,options)=>{
    need(enabled===true,'UPLOAD_TRANSPORT_DISABLED');
    need(typeof c.secret==='string'&&c.secret.length>=20&&c.secret.length<=256,'UPLOAD_CREDENTIAL_REQUIRED');
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);timer.unref();
    try {
      const r=await fetchImpl(url,{...options,redirect:'error',signal:controller.signal});
      need(r.status===200&&!r.redirected&&(!r.url||r.url===url),'UPLOAD_PROVIDER_UNAVAILABLE');
      // REST actually responds with its pinned vendor media type. Upload API
      // uses ordinary JSON; never accept arbitrary vendor versions/types.
      const media=r.headers.get('content-type')??'';
      need(/^application\/json(?:;|$)/i.test(media)||(url.startsWith('https://api.uploadcare.com/')&&
        /^application\/vnd\.uploadcare-v0\.7\+json(?:;|$)/i.test(media)),'UPLOAD_PROVIDER_INVALID');
      need(!r.headers.get('content-encoding')||r.headers.get('content-encoding')==='identity','UPLOAD_PROVIDER_INVALID');
      need(Number(r.headers.get('content-length')??0)<=65536,'UPLOAD_RESPONSE_LIMIT');
      const chunks=[];let size=0;
      for await(const b of r.body){size+=b.length;need(size<=65536,'UPLOAD_RESPONSE_LIMIT');chunks.push(b);}
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch(error) {controller.abort();throw error instanceof RuntimeError?error:new RuntimeError('UPLOAD_PROVIDER_UNAVAILABLE');}
    finally {clearTimeout(timer);}
  };
  const get=path=>{need(enabled===true,'UPLOAD_TRANSPORT_DISABLED');need(typeof c.secret==='string'&&c.secret.length>=20,'UPLOAD_CREDENTIAL_REQUIRED');return request('https://api.uploadcare.com'+path,{method:'GET',headers:{...restHeaders(c.secret,c.publicKey,path,now()),'Accept-Encoding':'identity'}});};
  const identity=async()=>{const p=await get('/project/');need(p?.pub_key===c.publicKey,'UPLOAD_PROJECT_MISMATCH');};
  return {
    async upload(intent,bytes,mime,beforeSend=()=>{}) {
      await identity();
      const form=new FormData();form.set('UPLOADCARE_PUB_KEY',c.publicKey);form.set('UPLOADCARE_STORE','1');
      form.set('file',new Blob([bytes],{type:mime}),'image'+({'image/jpeg':'.jpg','image/png':'.png','image/tiff':'.tif'}[mime]));
      beforeSend();
      const r=await request('https://upload.uploadcare.com/base/',{method:'POST',headers:{Authorization:'Bearer '+uploadToken(c.secret,intent,now()),'Accept-Encoding':'identity'},body:form});
      need(r&&Object.keys(r).length===1&&uuid(r.file),'UPLOAD_PROVIDER_INVALID');return r.file;
    },
    async delete(asset,beforeSend=()=>{}) {
      need(uuid(asset),'UPLOAD_INVALID_ASSET');await identity();
      const path=`/files/${asset}/storage/`;beforeSend();
      const result=await request('https://api.uploadcare.com'+path,{method:'DELETE',headers:{...restHeaders(c.secret,c.publicKey,path,now(),'DELETE'),'Accept-Encoding':'identity'}});
      need(result?.uuid===asset&&result.url===`https://api.uploadcare.com/files/${asset}/`&&timestamp(result.datetime_removed),'UPLOAD_DELETE_UNCONFIRMED');
      return {deleted:true};
    },
    async info(asset) {need(uuid(asset),'UPLOAD_INVALID_ASSET');await identity();return get(`/files/${asset}/`);},
  };
}
export function uploadReceipt(row) {
  return {schema:1,intent_id:row.id,version:row.version,state:row.state,
    asset_id:row.state==='complete'?row.asset:null,expires_at:row.state==='complete'?row.checked_until:row.expires,checkout_ready:false};
}
export function createUploadcareAdapter({store,config,enabled=false,fetchImpl,now=Date.now,custody=null,beforeSend=()=>{},concurrency=1}) {
  // Snapshot protects project/secret/transport identity against caller mutation.
  const c=snapshot(config),binding=uploadBinding(c),ledger=store.uploadLedger;
  const transport=createUploadcareTransport(c,{enabled,fetchImpl,now});
  need(Number.isInteger(concurrency)&&concurrency>=1&&concurrency<=4,'UPLOAD_CONCURRENCY');
  let sending=0; // At most four existing bounded file bodies, never a batch body.
  const requireEnabled=()=>need(enabled===true,'UPLOAD_TRANSPORT_DISABLED');
  const probes=new Map();
  const probeOnce=async row=>{
    need(['pending','complete'].includes(row.state),'UPLOAD_NOT_COMPLETE');
    try {
      const f=await transport.info(row.asset);
      need(f?.uuid===row.asset&&f.url===`https://api.uploadcare.com/files/${row.asset}/`,'UPLOAD_PROVIDER_INVALID');
      if(f.datetime_removed!==null){need(timestamp(f.datetime_removed),'UPLOAD_PROVIDER_INVALID');ledger.invalidate(ledger.read(row.id),'removed');throw new RuntimeError('UPLOAD_REMOVED');}
      if(f.is_ready===false&&row.state==='pending')return ledger.read(row.id);
      need(f.size===row.size&&f.is_image===true&&f.mime_type===row.mime&&timestamp(f.datetime_uploaded)&&timestamp(f.datetime_stored),'UPLOAD_IMAGE_INVALID');
      need(f.is_ready===true,'UPLOAD_NOT_COMPLETE');
      let url;try{url=new URL(f.original_file_url);}catch{throw new RuntimeError('UPLOAD_CDN_INVALID');}
      need([c.cdnOrigin,c.delivery?.origin].includes(url.origin)&&!url.username&&!url.password&&!url.search&&!url.hash&&
        url.pathname.startsWith(`/${row.asset}/`)&&!url.pathname.slice(row.asset.length+2).includes('/'),'UPLOAD_CDN_INVALID');
      // Provider's URL field never controls a transport or a browser link.
      return ledger.complete(row.owner,row.id,binding,row.version,`${deliveryPolicy(c).origin}/${row.asset}/`);
    } catch(error) {
      // Any uncertain verification is unavailable. Terminal on known/ambiguous
      // failure; a fresh intent/file is required, never revive an old grant.
      if(custody)custody.failed(row.id);else ledger.invalidate(ledger.read(row.id),'failed');
      throw error instanceof RuntimeError?error:new RuntimeError('UPLOAD_PROVIDER_UNAVAILABLE');
    }
  };
  const probe=row=>{
    if(probes.has(row.id))return probes.get(row.id);
    // A queued row may have been refreshed by another request in the meantime.
    row=ledger.owned(row.owner,row.id,binding);need(row.expires>now(),'UPLOAD_EXPIRED');
    const p=probeOnce(row).finally(()=>probes.delete(row.id));probes.set(row.id,p);return p;
  };
  const ownedRows=(owner,ids)=>{
    requireEnabled();ledger.sweep();
    return ledger.forAssets(owner,ids,binding).map(row=>{
      row=ledger.owned(owner,row.id,binding);
      need(['pending','complete'].includes(row.state)&&row.expires>now(),'UPLOAD_NOT_COMPLETE');return row;
    });
  };
  const probeRows=async rows=>{
    let next=0;
    await Promise.all(Array.from({length:Math.min(concurrency,rows.length)},async()=>{
      while(next<rows.length)await probe(rows[next++]);
    }));
  };
  return {
    binding,transportEnabled:enabled===true,
    async cleanup(){
      need(custody,'UPLOAD_CUSTODY_UNAVAILABLE');
      for(const row of custody.pending()){
        if(row.binding!==binding)continue; // never delete through a changed project binding
        let started=false;
        try {await transport.delete(row.asset,()=>{custody.beginDelete(row.intent);started=true;});custody.finishDelete(row.intent,true);}
        catch {if(started)custody.finishDelete(row.intent,false);}
      }
      return custody.counts();
    },
    intent(owner,key,{sourceScope}={}) {requireEnabled();ledger.sweep();return uploadReceipt(ledger.create(owner,key,binding,{sourceScope}));},
    async upload(owner,id,input) {
      requireEnabled();need(Buffer.isBuffer(input?.bytes)&&input.bytes.length>0&&input.bytes.length<=MAX_IMAGE_BYTES&&mimeTypes.has(input.mime),'UPLOAD_IMAGE_INVALID');
      // Copy once before any await; caller cannot mutate the payload behind its hash.
      need(sending<concurrency,'UPLOAD_BUSY');const bytes=Buffer.from(input.bytes),mime=input.mime;
      const claim=ledger.claim(owner,id,binding,{digest:hash(bytes),size:bytes.length,mime});
      if(!claim.send)return uploadReceipt(claim.row);
      sending++;
      try {
        const asset=await transport.upload(id,bytes,mime,()=>{
          // Recheck the original credential after project identity's await and
          // persist custody before the only POST can leave the process.
          ledger.owned(owner,id,binding);beforeSend();custody?.start(id,binding);
        });
        custody?.known(id,binding,asset);
        const row=ledger.bind(owner,id,binding,asset);
        return uploadReceipt(terminal(row.state)?row:await probe(row));
      } catch(error){if(custody)custody.failed(id);else ledger.invalidate(ledger.read(id),'failed');throw error instanceof RuntimeError?error:new RuntimeError('UPLOAD_PROVIDER_UNAVAILABLE');}
      finally{sending--;}
    },
    async status(owner,id) {
      requireEnabled();ledger.sweep();const row=ledger.owned(owner,id,binding);
      return uploadReceipt(['pending','complete'].includes(row.state)?await probe(row):row);
    },
    remove(owner,id) {return uploadReceipt(ledger.remove(owner,id,binding));},
    async refresh(owner,ids) {
      // Maintenance warms individual proofs; it grants no customer operation.
      // A skipped proof may expire during this bounded pass without closing the session.
      const rows=ownedRows(owner,ids);
      await probeRows(rows.filter(row=>row.state!=='complete'||row.checked_until<=now()));
      ownedRows(owner,ids);
    },
    async validate(owner,ids,{fresh=true}={}) {
      const rows=ownedRows(owner,ids);
      // Decide once before awaiting: partial refresh can leave initially fresh
      // rows expired by the final aggregate assertion. Jobs still require all proofs.
      if(fresh||rows.some(row=>row.state!=='complete'||row.checked_until<=now()))await probeRows(rows);
      store.uploads(owner,ids);
    },
    async verifyOriginal(owner,id) {
      requireEnabled();let row=ledger.owned(owner,id,binding);
      if(row.state!=='complete'||row.checked_until<=now())row=await probe(row);
      store.uploads(owner,[row.asset]);
      const signed=signDelivery(c,row.asset,'original',now(),row.checked_until);
      const response=await (fetchImpl??fetch)(signed.url,{credentials:'omit',redirect:'error',signal:AbortSignal.timeout(15000)});
      need(response.status===200&&!response.redirected&&response.headers.get('content-type')?.split(';')[0]===row.mime,'SOURCE_UNVERIFIED');
      const digest=createHash('sha256');let size=0;
      for await(const chunk of response.body){size+=chunk.length;need(size<=row.size,'SOURCE_UNVERIFIED');digest.update(chunk);}
      need(size===row.size&&digest.digest('hex')===row.digest,'SOURCE_UNVERIFIED');
      const current=ledger.owned(owner,id,binding);store.uploads(owner,[current.asset]);
      need(current.state==='complete'&&current.asset===row.asset,'UPLOAD_STALE');
      return uploadReceipt(current);
    },
    async delivery(owner,id,variant='preview') {
      requireEnabled();ledger.sweep();
      const row=await probe(ledger.owned(owner,id,binding));
      // Probe can race removal/owner retirement: re-read the durable boundary
      // immediately before signing, with no asynchronous gap afterward.
      const current=ledger.owned(owner,id,binding);store.uploads(owner,[current.asset]);
      need(current.state==='complete'&&current.version===row.version,'UPLOAD_STALE');
      return signDelivery(c,current.asset,variant,now(),current.checked_until);
    },
    async crop(owner,id,input) {
      requireEnabled();const crop={...input};const modifiers=cropModifiers(crop);
      await probe(ledger.owned(owner,id,binding));
      let row=ledger.owned(owner,id,binding);store.uploads(owner,[row.asset]);
      const info=await transport.info(row.asset),size=info.content_info?.image;
      need(Number.isSafeInteger(size?.width)&&Number.isSafeInteger(size?.height)&&
        crop.left+crop.width<=size.width&&crop.top+crop.height<=size.height,'UPLOAD_CROP_INVALID');
      row=ledger.owned(owner,id,binding);store.uploads(owner,[row.asset]);
      const signed=signDelivery(c,row.asset,'crop',now(),row.checked_until,crop);
      const response=await (fetchImpl??fetch)(signed.url,{credentials:'omit',redirect:'error',signal:AbortSignal.timeout(15000)});
      need(response.status===200&&!response.redirected&&response.headers.get('content-type')?.split(';')[0]==='image/png','UPLOAD_CROP_UNAVAILABLE');
      const chunks=[];let length=0;
      for await(const chunk of response.body){length+=chunk.length;need(length<=MAX_IMAGE_BYTES,'UPLOAD_RESPONSE_LIMIT');chunks.push(chunk);}
      const bytes=Buffer.concat(chunks,length);
      need(bytes.length>=24&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&
        bytes.toString('ascii',12,16)==='IHDR'&&bytes.readUInt32BE(16)===crop.width&&bytes.readUInt32BE(20)===crop.height,'UPLOAD_CROP_INVALID');
      const current=ledger.owned(owner,id,binding);store.uploads(owner,[current.asset]);
      need(current.state==='complete'&&current.asset===row.asset,'UPLOAD_STALE');
      const file={id:current.asset,url:`${deliveryPolicy(c).origin}/${current.asset}/${modifiers}`,
        original:{sha256:current.digest,bytes:current.size,mime:current.mime,width:size.width,height:size.height},
        crop,sha256:hash(bytes),bytes:bytes.length,mime:'image/png'};
      return {receipt:uploadReceipt(current),file,...signDelivery(c,current.asset,'crop',now(),current.checked_until,crop)};
    },
    verifyUpload({owner,intent_id}) {
      const row=ledger.owned(owner,intent_id,binding);store.uploads(owner,[row.asset]);
      return {store:c.store,app:c.app,owner:row.owner,asset:{id:row.asset,state:'complete',verified:true,url:`${deliveryPolicy(c).origin}/${row.asset}/`}};
    },
    deleted({raw,signature}) {
      need(Buffer.isBuffer(raw)&&raw.length<=65536&&typeof signature==='string'&&/^v1=[a-f0-9]{64}$/.test(signature),'UPLOAD_WEBHOOK_INVALID');
      need(typeof c.webhookSecret==='string'&&c.webhookSecret.length===32&&c.webhookSecret!==c.secret,'UPLOAD_WEBHOOK_UNAVAILABLE');
      const expected=createHmac('sha256',c.webhookSecret).update(raw).digest();
      need(timingSafeEqual(expected,Buffer.from(signature.slice(3),'hex')),'UPLOAD_WEBHOOK_INVALID');
      let e;try{e=JSON.parse(raw.toString('utf8'));}catch{throw new RuntimeError('UPLOAD_WEBHOOK_INVALID');}
      // Hook IDs/project/URL are operator-pinned from authenticated registration.
      need(Number.isSafeInteger(c.projectId)&&c.projectId>0&&Number.isSafeInteger(c.hookId)&&c.hookId>0&&
        typeof c.webhookUrl==='string'&&c.webhookUrl.startsWith('https://')&&
        e?.hook?.id===c.hookId&&e.hook.project===c.projectId&&e.hook.target_url===c.webhookUrl&&
        e.hook.event==='file.deleted'&&e.hook.version==='0.7'&&uuid(e.data?.uuid)&&timestamp(e.data.datetime_removed),'UPLOAD_WEBHOOK_SCOPE');
      // No trusted event ID/timestamp is promised by this protocol. Deletion is
      // terminal, idempotent by pinned project+UUID; old signed replay cannot restore.
      return ledger.deleted(binding,e.data.uuid);
    },
  };
}
