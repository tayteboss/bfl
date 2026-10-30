// Context-only browser module; no visible controls or automatic requests.
// Context tokens cannot authorize jobs/uploads. Consumers must bootstrap explicitly.
export function createStorefrontContext({backendOrigin,fetchImpl=fetch,now=Date.now}) {
  const storefront='https://bellows-film-printing-staging.myshopify.com';
  const url=new URL(backendOrigin);
  if(location.origin!==storefront||url.origin!==backendOrigin||url.protocol!=='https:'||url.hostname.endsWith('.myshopify.com'))throw Error('SESSION_TARGET');
  let current=null,generation=0;
  async function post(path,input={},token){
    const response=await fetchImpl(`${backendOrigin}${path}`,{method:'POST',mode:'cors',credentials:'omit',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(10000),
      headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(input)});
    if(!response.ok)throw Error('SESSION_UNAVAILABLE');return response.json();
  }
  return {
    async bootstrap(){const attempt=++generation,old=current;current=null;
      // Expired local contexts are already unusable; their rejected revocation
      // must not block renewal. Live revocation failures still fail closed.
      if(old&&old.expires>now())await post('/session/revoke',{},old.token);
      const c=await post('/session/challenge');
      const response=await fetchImpl(`/apps/bfl-staging/bootstrap?challenge=${encodeURIComponent(c.challenge)}`,{credentials:'same-origin',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(10000)});
      if(!response.ok)throw Error('SESSION_UNAVAILABLE');const {ticket}=await response.json();
      const result=await post('/session/exchange',{challenge:c.challenge,verifier:c.verifier,ticket});
      if(attempt!==generation){await post('/session/revoke',{},result.token);throw Error('SESSION_SUPERSEDED');}
      if(result.cart_verified!==false||result.checkout_ready!==false||result.expires_in!==60)throw Error('SESSION_UNAVAILABLE');
      current={token:result.token,expires:now()+result.expires_in*1000};return result.context;
    },
    async context(){if(!current||current.expires<=now())throw Error('SESSION_EXPIRED');return post('/session/context',{},current.token);},
    async revoke(){generation++;const old=current;current=null;if(old)await post('/session/revoke',{},old.token);},
  };
}
