import {need,RuntimeError,safeCode} from '../backend/config.mjs';
// Single in-process supervisor over the existing database. A deadline fences the
// result even if a test/dependency ignores abort; it never unlocks a remote write.
export function createOrderWorker({inbox,handoff,enabled=false,deadlineMs=6000,onRecorded=()=>{}}) {
  need(deadlineMs>0&&deadlineMs<=6000,'ORDER_WORKER_LIMIT');
  let active=null,controller=null,stopping=false,timer=null,fault=null;
  const run=()=>{
    if(!enabled||stopping||fault||active)return active??Promise.resolve();
    let ticket;try{ticket=inbox.claim();}catch(error){fault=safeCode(error);return Promise.resolve();}
    if(!ticket)return Promise.resolve();
    controller=new AbortController();const signal=controller.signal;
    active=(async()=>{
      let timeout,abortListener;
      try {
        const deadline=new Promise((_,reject)=>{
          abortListener=()=>reject(new RuntimeError(stopping?'ORDER_PROCESS_SHUTDOWN':'ORDER_PROCESS_TIMEOUT'));
          signal.addEventListener('abort',abortListener,{once:true});
          timeout=setTimeout(()=>controller.abort(),deadlineMs);
        });
        const result=await Promise.race([handoff.processClaim(ticket,{signal}),deadline]);
        inbox.finish(ticket,result);onRecorded();
      }catch(error){
        const code=safeCode(error);
        // No new reads after an uncooperative deadline. Restart/review required.
        if(code==='ORDER_PROCESS_TIMEOUT')fault=code;
        try{inbox.fail(ticket,code);}catch(failure){fault=safeCode(failure);}
      }finally{clearTimeout(timeout);signal.removeEventListener('abort',abortListener);active=null;controller=null;}
    })();
    return active;
  };
  return {
    run,
    start(){if(enabled&&!timer&&!stopping){timer=setInterval(()=>void run(),250);timer.unref();void run();}},
    status:()=>({enabled,active:!!active,fault}),
    async stop(){stopping=true;clearInterval(timer);timer=null;controller?.abort();if(active)await active;},
  };
}
