import {STOREFRONT_ORIGIN} from './storefront-session.mjs';
import {need,safeCode} from './config.mjs';
const direct=new Set(['/resource-proof/challenge','/resource-proof/exchange']);
export function createResourceProofHttp(proofs) {
  const send=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store',
    'Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(body));};
  return async(req,res)=>{
    const path=req.url?.split('?')[0],proxy=path==='/proxy/resource-proof';
    if(!proxy&&!direct.has(path))return false;
    try {
      if(proxy){
        // No CORS, no body-derived identity; response-only ticket is indispensable.
        need(req.method==='GET'&&req.url.includes('?')&&!req.headers.authorization&&!req.headers.cookie,'PROOF_METHOD');
        send(res,200,proofs.bootstrap(req.url.slice(req.url.indexOf('?')+1)));return true;
      }
      need(req.headers.origin===STOREFRONT_ORIGIN&&req.headers.cookie===undefined,'PROOF_ORIGIN');
      for(const name of ['origin','authorization'])if(req.rawHeaders)need(req.rawHeaders.filter((_,i)=>i%2===0&&req.rawHeaders[i].toLowerCase()===name).length<=1,'PROOF_REJECTED');
      res.setHeader('Access-Control-Allow-Origin',STOREFRONT_ORIGIN);res.setHeader('Vary','Origin');
      need(req.url===path,'PROOF_QUERY');
      if(req.method==='OPTIONS'){
        const headers=(req.headers['access-control-request-headers']??'').toLowerCase().split(',').map(h=>h.trim()).filter(Boolean);
        need(req.headers['access-control-request-method']==='POST'&&headers.every(h=>['content-type','authorization'].includes(h)),'PROOF_PREFLIGHT');
        res.writeHead(204,{'Access-Control-Max-Age':'300','Access-Control-Allow-Methods':'POST','Access-Control-Allow-Headers':'Content-Type, Authorization','Cache-Control':'no-store'});res.end();return true;
      }
      need(req.method==='POST'&&!req.headers['content-encoding']&&req.headers['content-type']==='application/json','PROOF_BODY');
      need(!req.headers['content-length']||/^\d+$/.test(req.headers['content-length'])&&Number(req.headers['content-length'])<=1024,'PROOF_BODY');
      let bytes=0;const chunks=[];for await(const chunk of req){bytes+=chunk.length;need(bytes<=1024,'PROOF_BODY');chunks.push(chunk);}
      let input;try{input=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{need(false,'PROOF_BODY');}
      const challenge=path.endsWith('/challenge'),keys=challenge?['action']:['action','challenge','verifier','ticket'];
      need(input&&typeof input==='object'&&!Array.isArray(input)&&Object.keys(input).length===keys.length&&keys.every(k=>Object.hasOwn(input,k)),'PROOF_BODY');
      send(res,200,challenge?proofs.challenge(req,input):proofs.exchange(req,input));
    }catch(error){send(res,403,{code:safeCode(error),checkout_ready:false});}
    return true;
  };
}
