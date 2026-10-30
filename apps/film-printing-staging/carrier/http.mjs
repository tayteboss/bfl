import {createServer} from 'node:http';
import {ShippingError,requireValue as need} from '../shipping/packing.mjs';
import {MAX_BODY,parseCarrierRequest,carrierRates} from './contract.mjs';
import {unavailableCallback} from './preparation.mjs';

const EMPTY=Object.freeze({rates:[]});
const send=(res,status,body=EMPTY)=>{
  if(res.destroyed||res.writableEnded)return;
  res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','Connection':'close','X-Content-Type-Options':'nosniff'});
  res.end(JSON.stringify(body));
};
function readBody(req,signal) {
  return new Promise((resolve,reject)=>{
    const chunks=[];let bytes=0;
    const cleanup=()=>{req.off('data',data);req.off('end',end);req.off('error',fail);req.off('aborted',fail);signal.removeEventListener('abort',fail);};
    const fail=()=>{cleanup();req.pause();reject(new ShippingError('CALLBACK_BODY_UNAVAILABLE'));};
    const data=chunk=>{bytes+=chunk.length;if(bytes>MAX_BODY)fail();else chunks.push(chunk);};
    const end=()=>{cleanup();resolve(Buffer.concat(chunks));};
    if(signal.aborted)return fail();
    req.on('data',data);req.once('end',end);req.once('error',fail);req.once('aborted',fail);signal.addEventListener('abort',fail,{once:true});
  });
}
function headers(req) {
  need(req.rawHeaders.length<=128,'CALLBACK_HEADERS');
  const names=new Set();let bytes=0;
  for(let i=0;i<req.rawHeaders.length;i+=2) {
    const name=req.rawHeaders[i].toLowerCase(),value=req.rawHeaders[i+1];
    bytes+=Buffer.byteLength(name)+Buffer.byteLength(value);
    need(!names.has(name)&&typeof value==='string'&&value.length<=4096,'CALLBACK_HEADERS');names.add(name);
  }
  need(bytes<=8192,'CALLBACK_HEADERS');
  const h=req.headers;
  need(/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(h['content-type']??'')&&!h['content-encoding']&&!h.expect,'CALLBACK_ENCODING');
  need(h['content-length']===undefined||/^\d{1,6}$/.test(h['content-length'])&&Number(h['content-length'])<=MAX_BODY,'CALLBACK_BODY_LIMIT');
  need(h['transfer-encoding']===undefined||h['transfer-encoding']==='chunked','CALLBACK_ENCODING');
  // A preserved header is unverified metadata, never proof of source or owner.
  return Object.freeze({...h});
}

// Preparation only: no listen(), runtime import, registration, environment switch
// or remote transport. The executable does not mount this server. Positive local
// composition is supplied exclusively by the synthetic fixture, not merchant data.
export function createCarrierServer({enabled=false,processCallback=unavailableCallback,deadlineMs=2000,callbackPath='/carrier/rates',record=()=>{}}={}) {
  need(typeof processCallback==='function'&&Number.isSafeInteger(deadlineMs)&&deadlineMs>0&&deadlineMs<=2000,'CALLBACK_DEPENDENCY');
  need(callbackPath==='/carrier/rates'||/^\/carrier\/rates\/[a-f0-9]{64}$/.test(callbackPath),'CALLBACK_PATH');
  let active=0,closing=false;
  const controllers=new Set();
  const server=createServer({maxHeaderSize:8192,headersTimeout:2500,requestTimeout:2500,connectionsCheckingInterval:100},(req,res)=>{
    // The private path is an application bearer, not a Shopify body signature.
    // Match before reading the body or invoking any provider; never log the URL.
    if(!enabled||req.method!=='POST'||req.url!==callbackPath)return send(res,404);
    if(closing||active>=4)return send(res,200);
    active++;
    const controller=new AbortController();controllers.add(controller);
    let expired=false;
    const timer=setTimeout(()=>{expired=true;controller.abort();send(res,200);},deadlineMs);
    const disconnect=()=>{if(!res.writableEnded){expired=true;controller.abort();}};
    res.once('close',disconnect);
    // Keep the slot until an abort-ignoring dependency actually settles; a
    // deadline must not admit unbounded orphan provider promises or raw bodies.
    void (async()=>{
      try {
        const rawHeaders=headers(req),rawBody=await readBody(req,controller.signal);
        need(!controller.signal.aborted,'QUOTE_CANCELLED');
        const callback=parseCarrierRequest(rawBody);
        const result=await processCallback({callback,rawBody,headers:rawHeaders,rawHeaders:Object.freeze([...req.rawHeaders])},{signal:controller.signal});
        need(!expired&&!controller.signal.aborted,'QUOTE_CANCELLED');
        send(res,200,result?.status==='available'?carrierRates(result):EMPTY);
      }catch(error){record({event:'carrier_unavailable',code:typeof error?.code==='string'&&/^[A-Z_]{1,80}$/.test(error.code)?error.code:'CALLBACK_UNAVAILABLE'});send(res,200);}
      finally {clearTimeout(timer);res.off('close',disconnect);controllers.delete(controller);active--;}
    })();
  });
  server.maxConnections=16;server.maxRequestsPerSocket=1;
  server.setTimeout(2500,socket=>socket.destroy());
  server.on('checkContinue',(_req,res)=>send(res,200));
  server.on('checkExpectation',(_req,res)=>send(res,200));
  return {
    server,status:()=>({enabled,active,checkout_ready:false}),
    async close(){closing=true;for(const c of controllers)c.abort();server.closeAllConnections();await new Promise(resolve=>server.listening?server.close(resolve):resolve());},
  };
}
