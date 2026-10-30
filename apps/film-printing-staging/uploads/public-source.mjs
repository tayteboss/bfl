import {lookup} from 'node:dns/promises';
import {request} from 'node:https';
import {BlockList,isIP} from 'node:net';
import {createHash} from 'node:crypto';
import {need,RuntimeError} from '../backend/config.mjs';
import {MAX_IMAGE_BYTES} from './uploadcare.mjs';

// Conservative special-purpose exclusions from IANA's IPv4/IPv6 registries.
// No IP literals, local names, transition addresses, redirects or caller headers.
const blocked4=new BlockList(),blocked6=new BlockList(),global6=new BlockList();
for(const [ip,bits] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]])blocked4.addSubnet(ip,bits,'ipv4');
global6.addSubnet('2000::',3,'ipv6');
for(const [ip,bits] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]])blocked6.addSubnet(ip,bits,'ipv6');
export function publicAddress(address){
  const family=isIP(address);
  return family===4?!blocked4.check(address,'ipv4'):family===6&&global6.check(address,'ipv6')&&!blocked6.check(address,'ipv6');
}
export function sourceURL(value){
  need(typeof value==='string'&&value.length<=768&&!/[\s\\\x00-\x1f\x7f]/.test(value),'SOURCE_URL_INVALID');
  let url;try{url=new URL(value);}catch{throw new RuntimeError('SOURCE_URL_INVALID');}
  need(url.protocol==='https:'&&!url.username&&!url.password&&!url.hash&&!url.port&&
    !isIP(url.hostname)&&url.hostname.length<=253&&
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(url.hostname)&&
    !/\.(?:localhost|local|internal|test|invalid|example|onion)$/.test(url.hostname),'SOURCE_URL_INVALID');
  return url;
}
export function imageSignature(bytes,mime){
  return mime==='image/png'?bytes.length>=33&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&bytes.toString('ascii',12,16)==='IHDR'&&bytes.readUInt32BE(16)>0&&bytes.readUInt32BE(20)>0:
    mime==='image/jpeg'?bytes.length>=4&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255:
    mime==='image/tiff'?bytes.length>=8&&['49492a00','4d4d002a'].includes(bytes.subarray(0,4).toString('hex')):false;
}

// Dependency seams are server-only, used by local rejection tests. The real
// connection cannot re-resolve a hostname after validation (DNS rebinding).
export function createPublicSource({resolve=lookup,requestImpl=request,timeoutMs=10000}={}){
  return async value=>{
    const url=sourceURL(value),controller=new AbortController();
    let req,timer;
    const operation=async()=>{
      const answers=await resolve(url.hostname,{all:true,verbatim:true});
      need(!controller.signal.aborted&&Array.isArray(answers)&&answers.length>0&&answers.length<=32&&
        answers.every(a=>a.family===isIP(a.address)&&publicAddress(a.address)),'SOURCE_ADDRESS_REJECTED');
      const pinned=answers.find(a=>a.family===4)??answers[0];
      return new Promise((accept,reject)=>{
        req=requestImpl(url,{method:'GET',agent:false,signal:controller.signal,maxHeaderSize:8192,
          servername:url.hostname,family:pinned.family,autoSelectFamily:false,
          lookup:(_host,options,callback)=>callback(null,...(options.all?[[pinned]]:[pinned.address,pinned.family])),
          headers:{Accept:'image/png, image/jpeg, image/tiff','Accept-Encoding':'identity'}},async response=>{
          try{
            need(response.statusCode===200,'SOURCE_RESPONSE_REJECTED'); // Never follow Location.
            const mime=response.headers['content-type']?.split(';')[0].trim().toLowerCase();
            need(['image/png','image/jpeg','image/tiff'].includes(mime)&&
              (!response.headers['content-encoding']||response.headers['content-encoding']==='identity'),'SOURCE_IMAGE_INVALID');
            const length=response.headers['content-length'];
            need(length===undefined||/^\d+$/.test(length)&&Number(length)>0&&Number(length)<=MAX_IMAGE_BYTES,'SOURCE_BODY_LIMIT');
            const chunks=[];let size=0;
            for await(const chunk of response){size+=chunk.length;need(size<=MAX_IMAGE_BYTES,'SOURCE_BODY_LIMIT');chunks.push(chunk);}
            const bytes=Buffer.concat(chunks,size);
            need(length===undefined||Number(length)===size,'SOURCE_IMAGE_INVALID');
            need(imageSignature(bytes,mime),'SOURCE_IMAGE_INVALID');
            const sha256=createHash('sha256').update(bytes).digest('hex');
            accept({bytes,mime,source:{kind:'public_https',origin:url.origin,url_sha256:createHash('sha256').update(url.href).digest('hex'),sha256,bytes:size,mime}});
          }catch(error){response.destroy();reject(error);}
        });
        req.once('error',reject);req.end();
      });
    };
    try{return await Promise.race([operation(),new Promise((_,reject)=>{
      timer=setTimeout(()=>{controller.abort();req?.destroy();reject(new RuntimeError('SOURCE_TIMEOUT'));},timeoutMs);timer.unref?.();
    })]);}catch(error){controller.abort();req?.destroy();throw error instanceof RuntimeError?error:new RuntimeError('SOURCE_UNAVAILABLE');}
    finally{clearTimeout(timer);}
  };
}
