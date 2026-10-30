import {STOREFRONT_ORIGIN} from './storefront-session.mjs';
import {need,safeCode,RuntimeError} from './config.mjs';
const routes=new Set(['/resource-sessions/issue','/resource-sessions/renew','/resource-sessions/revoke']);
// The runtime mounts this handler only through its loopback test composition.
// A fresh independent context observer must consume its own proof. A client
// body, context bearer or proxy customer alone is never a resource credential.
export function createResourceSessionHttp({sessions,observeFreshContext}) {
  const send=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store',
    'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});res.end(JSON.stringify(body));};
  return async(req,res)=>{
    const path=req.url?.split('?')[0],sessionRoute=routes.has(path);
    const resourceRoute=path==='/jobs'||path==='/quote'||path?.startsWith('/uploads/');
    if(!sessionRoute&&!resourceRoute)return false;
    try {
      need(req.headers.origin===STOREFRONT_ORIGIN&&req.headers.cookie===undefined,'RESOURCE_ORIGIN');
      for(const name of ['origin','authorization'])if(req.rawHeaders)need(req.rawHeaders.filter((_,i)=>i%2===0&&req.rawHeaders[i].toLowerCase()===name).length<=1,'RESOURCE_REJECTED');
      res.setHeader('Access-Control-Allow-Origin',STOREFRONT_ORIGIN);res.setHeader('Vary','Origin');
      need(req.url===path,'RESOURCE_QUERY');
      if(req.method==='OPTIONS'){
        const headers=(req.headers['access-control-request-headers']??'').toLowerCase().split(',').map(h=>h.trim()).filter(Boolean);
        need(req.headers['access-control-request-method']==='POST'&&headers.every(h=>['content-type','authorization'].includes(h)),'RESOURCE_PREFLIGHT');
        res.writeHead(204,{'Access-Control-Max-Age':'300','Access-Control-Allow-Methods':'POST','Access-Control-Allow-Headers':'Content-Type, Authorization','Cache-Control':'no-store'});res.end();return true;
      }
      need(req.method==='POST','RESOURCE_METHOD');
      // App resources do not grant quote/cart/publication authority.
      if(path==='/quote'){send(res,403,{code:'RESOURCE_CART_PROOF_UNAVAILABLE',checkout_ready:false});return true;}
      if(!sessionRoute)return false;
      need(!req.headers['content-encoding']&&req.headers['content-type']==='application/json','RESOURCE_BODY');
      need(!req.headers['content-length']||/^\d+$/.test(req.headers['content-length'])&&Number(req.headers['content-length'])<=1024,'RESOURCE_BODY');
      const issue=path.endsWith('/issue'),renew=path.endsWith('/renew');
      const ticket=issue?null:sessions.authenticate(req);
      if(issue)need(!req.headers.authorization,'RESOURCE_REJECTED');
      const chunks=[];let size=0;
      for await(const chunk of req){size+=chunk.length;need(size<=1024,'RESOURCE_BODY');chunks.push(chunk);}
      let input;try{input=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{need(false,'RESOURCE_BODY');}
      need(input&&typeof input==='object'&&!Array.isArray(input),'RESOURCE_BODY');
      need(Object.keys(input).length===(issue||renew?1:0),'RESOURCE_BODY');
      let result;
      if(issue||renew){
        need(typeof input.proof==='string'&&/^[A-Za-z0-9_-]{43}$/.test(input.proof),'RESOURCE_BODY');
        let timer,e;
        try {e=await Promise.race([observeFreshContext({request:req,proof:input.proof,action:issue?'issue':'renew',ticket}),new Promise((_,reject)=>{
          timer=setTimeout(()=>reject(new RuntimeError('RESOURCE_EVIDENCE_TIMEOUT')),5000);timer.unref();
        })]);}finally{clearTimeout(timer);}
        need(!res.destroyed,'RESOURCE_ABORTED');
        result=issue?sessions.issue(e):sessions.renew(ticket,e);
      }else result=sessions.revoke(ticket);
      send(res,result.rejected?403:200,result);
    }catch(error){send(res,403,{code:safeCode(error),checkout_ready:false});}
    return true;
  };
}
