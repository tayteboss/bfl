// Native cart reads are safe to stop waiting for; native mutations are never
// raced or retried here. Some SDK versions do not settle after abort, so the
// local deadline also rejects the wait and consumes any late SDK completion.
export function readNativeCart(actions,{signal}={}){
  return new Promise((resolve,reject)=>{
    const controller=new AbortController();let done=false,timer;
    const finish=(error,value)=>{
      if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',disposed);
      if(error){controller.abort(error);reject(error);}else resolve(value);
    };
    const disposed=()=>finish(Object.assign(Error('PERSISTENT_CART_UNAVAILABLE'),{readOnlyFailure:true}));
    if(signal?.aborted){disposed();return;}
    signal?.addEventListener('abort',disposed,{once:true});
    timer=setTimeout(()=>finish(Object.assign(Error('NATIVE_CART_TIMEOUT'),{readOnlyFailure:true})),10000);
    Promise.resolve().then(()=>{
      if(done)return;
      return actions.getCart(undefined,{signal:controller.signal});
    }).then(value=>finish(null,value),error=>finish(error));
  });
}
