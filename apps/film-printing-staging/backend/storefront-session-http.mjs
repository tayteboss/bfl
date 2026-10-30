import {createStorefrontSessions,STOREFRONT_ORIGIN} from './storefront-session.mjs';
import {RuntimeError,safeCode} from './config.mjs';
const direct=new Set(['/session/challenge','/session/exchange','/session/context','/session/revoke']);
export function createStorefrontSessionIngress(options) {
  const sessions=createStorefrontSessions(options);
  const send=(res,status,body,cors=false)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store',
    'Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff',...(cors?{'Access-Control-Allow-Origin':STOREFRONT_ORIGIN,'Vary':'Origin'}:{})});res.end(JSON.stringify(body));};
  return {
    close:()=>sessions.close(),
    async handle(req,res){
      const path=req.url.split('?')[0],isDirect=direct.has(path),proxy=path==='/proxy/bootstrap';
      if(!isDirect&&!proxy)return false;
      const cors=isDirect&&req.headers.origin===STOREFRONT_ORIGIN;
      try {
        if(isDirect&&!cors){send(res,403,{code:'SESSION_ORIGIN'});return true;}
        if(proxy){
          // Shopify proxy GET is the sole signed entry point, no direct CORS.
          if(req.method!=='GET'||!req.url.includes('?'))throw new RuntimeError('SESSION_METHOD');
          send(res,200,sessions.bootstrap(req.url.slice(req.url.indexOf('?')+1)));return true;
        }
        if(req.url!==path)throw new RuntimeError('SESSION_QUERY');
        if(req.method==='OPTIONS'){
          const method=req.headers['access-control-request-method'];
          const headers=(req.headers['access-control-request-headers']??'').toLowerCase().split(',').map(s=>s.trim()).filter(Boolean);
          if(method!=='POST'||headers.some(h=>!['content-type','authorization'].includes(h)))throw new RuntimeError('SESSION_PREFLIGHT');
          res.writeHead(204,{'Access-Control-Allow-Origin':STOREFRONT_ORIGIN,'Vary':'Origin','Access-Control-Allow-Methods':'POST',
            'Access-Control-Allow-Headers':'Content-Type, Authorization','Cache-Control':'no-store'});res.end();return true;
        }
        if(req.method!=='POST')throw new RuntimeError('SESSION_METHOD');
        // Validate current direct ingress, without retaining or returning IPs.
        // Proxy bootstrap never invokes this adapter: its peer is Shopify.
        if(options.resolveBuyerIp)await options.resolveBuyerIp(req);
        if(req.headers['content-encoding']||!/^application\/json(?:;|$)/i.test(req.headers['content-type']??''))throw new RuntimeError('SESSION_BODY');
        if(Number(req.headers['content-length']??0)>1024)throw new RuntimeError('SESSION_BODY');
        let bytes=0;const chunks=[];for await(const chunk of req){bytes+=chunk.length;if(bytes>1024)throw new RuntimeError('SESSION_BODY');chunks.push(chunk);}
        let input;try{input=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{throw new RuntimeError('SESSION_BODY');}
        if(!input||typeof input!=='object'||Array.isArray(input))throw new RuntimeError('SESSION_BODY');
        const expected=path==='/session/exchange'?['challenge','verifier','ticket']:[];
        if(Object.keys(input).some(k=>!expected.includes(k)))throw new RuntimeError('SESSION_BODY');
        const body=path==='/session/challenge'?sessions.challenge(req):path==='/session/exchange'?sessions.exchange(req,input):
          path==='/session/context'?sessions.authenticate(req):sessions.revoke(req);
        send(res,200,body,true);
      }catch(error){send(res,403,{code:error instanceof RuntimeError?safeCode(error):'SESSION_REJECTED',checkout_ready:false},cors);}
      return true;
    },
  };
}
