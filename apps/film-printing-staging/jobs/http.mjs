import { ShippingError } from '../shipping/packing.mjs';
// Mount behind a real authenticated same-origin server. No app-proxy/cookie assumption:
// authenticate must verify a session/CSRF boundary using the chosen hosting transport.
export function createJobHandler({service, authenticate, quote}) {
  if (typeof authenticate !== 'function' || !service) throw Error('Authenticated server dependencies required');
  return async (req,res) => {
    const send=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(body));};
    if(req.method!=='POST' || !['/jobs','/quote'].includes(req.url)) return send(404,{code:'NOT_FOUND'});
    try {
      const owner=await authenticate(req);
      if(typeof owner!=='string' || !owner) return send(401,{code:'UNAUTHENTICATED'});
      if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']??'')) return send(415,{code:'JSON_REQUIRED'});
      let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>32768)return send(413,{code:'TOO_LARGE'});}
      const input=JSON.parse(raw);
      if(req.url==='/jobs') return send(200,await service.prepare(owner,input));
      // Quote service resolves the authenticated transport context itself; body cannot be normalized server input.
      if(!quote)return send(200,{status:'unavailable',code:'VERIFIED_DELIVERY_CONTEXT_REQUIRED',quotes:[]});
      return send(200,await quote.quote({owner,request:req}));
    } catch(error) { return send(error instanceof SyntaxError?400:422,{code:error instanceof ShippingError?error.code:'UNAVAILABLE'}); }
  };
}
