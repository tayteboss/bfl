import {need,RuntimeError,safeCode} from '../backend/config.mjs';
import {STORE} from '../configuration/schema.mjs';
const PATH='/webhooks/orders/create';
const send=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','Connection':'close','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(body));};
export function createOrderIngress({enabled=false,secret,inbox,wake=()=>{},bodyTimeoutMs=1500}) {
  need(enabled===true&&typeof secret==='string'&&secret.length>=32,'ORDER_INGRESS_UNAVAILABLE');
  need(bodyTimeoutMs>0&&bodyTimeoutMs<=2000,'ORDER_INGRESS_LIMIT');let active=0;
  return async(req,res)=>{
    if(req.method!=='POST'||req.url!==PATH)return false;
    if(active>=4){send(res,503,{code:'ORDER_INTAKE_BUSY'});return true;}active++;
    try {
      const h=req.headers;
      const names=(req.rawHeaders??[]).filter((_,i)=>i%2===0).map(k=>k.toLowerCase());
      need(names.every((n,i)=>names.indexOf(n)===i),'ORDER_HEADERS_INVALID');
      need(h['x-shopify-topic']==='orders/create'&&h['x-shopify-shop-domain']===STORE&&h['x-shopify-api-version']==='2026-10','ORDER_SOURCE_REJECTED');
      need(/^application\/json(?:;|$)/i.test(h['content-type']??'')&&!h['content-encoding'],'ORDER_ENCODING_REJECTED');
      need(!h['content-length']||/^\d{1,9}$/.test(h['content-length'])&&Number(h['content-length'])<=262144,'ORDER_BODY_LIMIT');
      const rawBody=await new Promise((resolve,reject)=>{
        const chunks=[];let size=0;
        const cleanup=()=>{clearTimeout(timer);req.off('data',data);req.off('end',end);req.off('error',error);req.off('aborted',aborted);};
        const fail=e=>{cleanup();req.pause();reject(e);};
        const error=()=>fail(new RuntimeError('ORDER_BODY_ABORTED'));
        const aborted=error;
        const data=chunk=>{size+=chunk.length;if(size>262144)fail(new RuntimeError('ORDER_BODY_LIMIT'));else chunks.push(chunk);};
        const end=()=>{cleanup();resolve(Buffer.concat(chunks));};
        const timer=setTimeout(()=>fail(new RuntimeError('ORDER_BODY_TIMEOUT')),bodyTimeoutMs);
        req.on('data',data);req.once('end',end);req.once('error',error);req.once('aborted',aborted);
      });
      // HMAC, complete bytes/selectors and identity checked inside enqueue; its
      // synchronous transaction must succeed before any 200 response is sent.
      const receipt=inbox.enqueue({rawBody,headers:h},secret);
      res.once('finish',()=>setImmediate(wake));send(res,200,receipt);
    }catch(error){
      const code=safeCode(error),status=code==='ORDER_SIGNATURE_INVALID'?401:code==='ORDER_BODY_LIMIT'?413:code==='ORDER_BODY_TIMEOUT'?408:
        code==='ORDER_DELIVERY_CONFLICT'?409:['ORDER_INBOX_FULL','UNAVAILABLE'].includes(code)?503:400;
      if(!res.headersSent&&!res.destroyed)send(res,status,{code,received:false,checkout_ready:false});
    }finally{active--;}
    return true;
  };
}
