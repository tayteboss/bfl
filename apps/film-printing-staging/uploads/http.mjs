import {STORE,APP,CLIENT} from '../configuration/schema.mjs';
import {INSTALLATION,RuntimeError,safeCode,need} from '../backend/config.mjs';
import {MAX_IMAGE_BYTES} from './uploadcare.mjs';
const uuid='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const actions=new RegExp(`^/uploads/(${uuid})/(bytes|source|status|remove|preview|original|crop)$`);
const types=new Set(['image/jpeg','image/png','image/tiff']);
const send=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store',
  'X-Content-Type-Options':'nosniff','Connection':'close'});res.end(JSON.stringify({...body,checkout_ready:false}));};
// Only trusted process composition can mount this handler. No env/client enable flag.
export function createUploadIngress({config,enabled=false,authenticate,upload,receiveUploadDeletion,rejectUpload=()=>{},concurrency=1,bodyTimeoutMs=10000,privatePreview=false,privateOriginal=false,privateSource=false,privateCrop=false}) {
  need(config?.store===STORE&&config.app===APP&&config.clientId===CLIENT&&config.installation===INSTALLATION,'WRONG_TARGET');
  need(typeof authenticate==='function'&&typeof upload==='function'&&typeof receiveUploadDeletion==='function','UPLOAD_INGRESS_INVALID');
  need(Number.isInteger(bodyTimeoutMs)&&bodyTimeoutMs>0&&bodyTimeoutMs<=30000,'UPLOAD_INGRESS_INVALID');
  need(Number.isInteger(concurrency)&&concurrency>=1&&concurrency<=4,'UPLOAD_CONCURRENCY');
  let busy=0; // Bound memory before reading any request body.
  return async function handle(req,res) {
    const match=actions.exec(req.url??''),intent=req.url==='/uploads/intents',webhook=req.url==='/hooks/uploadcare';
    if(!enabled||(!match&&!intent&&!webhook)||match?.[2]==='preview'&&!privatePreview||match?.[2]==='original'&&!privateOriginal||match?.[2]==='source'&&!privateSource||match?.[2]==='crop'&&!privateCrop)return false;
    const rejected=()=>{if(match&&['bytes','source'].includes(match[2]))rejectUpload(req,match[1]);};
    const reject=(status,code)=>{rejected();send(res,status,{code});return true;};
    if(req.method!=='POST')return reject(405,'METHOD_UNSUPPORTED');
    const rawHeader=name=>{
      const values=[];for(let i=0;i<(req.rawHeaders??[]).length;i+=2)if(req.rawHeaders[i].toLowerCase()===name)values.push(req.rawHeaders[i+1]);
      return values.length===1?values[0]:null;
    };
    const mime=rawHeader('content-type'),signature=rawHeader('x-uc-signature');
    if(req.headers['content-encoding']||req.headers.expect)return reject(415,'ENCODING_UNSUPPORTED');
    const bytes=match?.[2]==='bytes',limit=bytes?MAX_IMAGE_BYTES:webhook?65536:1024;
    if(!(bytes?types.has(mime):mime==='application/json'))return reject(415,'CONTENT_TYPE_UNSUPPORTED');
    const length=req.headers['content-length'];
    if(length!==undefined&&(!/^\d+$/.test(length)||Number(length)>limit))return reject(413,'TOO_LARGE');
    if(webhook&&!/^v1=[a-f0-9]{64}$/.test(signature??'')){send(res,401,{code:'UPLOAD_WEBHOOK_INVALID'});return true;}
    if(busy>=concurrency)return reject(429,'UPLOAD_BUSY');busy++;
    let timer;
    try {
      // No data listener/iterator is attached until the actual session/Origin AND
      // independent owner resolver pass. Body cannot nominate the owner.
      const intake=async()=>{
        if(!webhook){const verified=await authenticate(req);need(verified&&!req.destroyed,'OWNER_REJECTED');}
        const chunks=[];let size=0;
        for await(const chunk of req){size+=chunk.length;need(size<=limit,'UPLOAD_BODY_LIMIT');chunks.push(chunk);}
        return Buffer.concat(chunks,size);
      };
      const raw=await Promise.race([intake(),new Promise((_,reject)=>{
        timer=setTimeout(()=>{req.destroy();reject(new RuntimeError('UPLOAD_BODY_TIMEOUT'));},bodyTimeoutMs);timer.unref();
      })]);
      clearTimeout(timer);
      let receipt;
      if(webhook)receipt=await receiveUploadDeletion({raw,signature}); // exact untouched bytes/header
      else if(bytes){need(raw.length>0,'UPLOAD_IMAGE_INVALID');receipt=await upload('bytes',req,{intent_id:match[1],bytes:raw,mime});}
      else {
        let body;try{body=JSON.parse(raw.toString('utf8'));}catch{throw new RuntimeError('INVALID_JSON');}
        need(body&&typeof body==='object'&&!Array.isArray(body),'UPLOAD_INPUT_INVALID');
        const source=match?.[2]==='source',crop=match?.[2]==='crop';
        need(Object.keys(body).length===(crop?4:intent||source?1:0)&&(!intent||(typeof body.request_key==='string'&&/^[a-zA-Z0-9_-]{8,100}$/.test(body.request_key)))&&
          (!source||(typeof body.url==='string'&&body.url.length<=768)),'UPLOAD_INPUT_INVALID');
        receipt=await upload(intent?'intent':match[2],req,intent?{request_key:body.request_key}:{intent_id:match[1],...(source?{url:body.url}:crop?{crop:body}:{})});
      }
      send(res,200,receipt);
    } catch(error) {
      rejected();
      if(!res.headersSent&&!res.destroyed)send(res,error.code==='OWNER_REJECTED'?403:error.code==='UPLOAD_BODY_LIMIT'?413:422,{code:safeCode(error)});
    } finally {clearTimeout(timer);busy--;}
    return true;
  };
}
