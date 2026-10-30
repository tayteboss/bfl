// Uninstalled, explicit-call library. No UI, startup requests, persistent storage,
// cookie, global credential, context token or timer. Customer reload custody is
// explicit opt-in, tab-scoped, and never contains a native cart capability.
const storefront='https://bellows-film-printing-staging.myshopify.com';
const backend='https://film-printing-staging.bellowsfilmlab.com';
const purpose='bfl:resource-fresh-proof:v1',audience=`${storefront}/bfl-application-resources`;
const opaque=s=>typeof s==='string'&&/^[A-Za-z0-9_-]{43}$/.test(s);
const safeReasons=new Set(['CUSTOMER_SELECTION_REJECTED','CART_PRICE_UNVERIFIED','CHECKOUT_RESUME_REJECTED','CUSTOMER_FILES_INCOMPLETE','PRICE_UNAVAILABLE','PRICE_LIMIT','RESOURCE_EXPIRED','PREPARED_EXPIRED','ENGINEERING_EXPIRED','RESOURCE_REJECTED','DIAGNOSTIC_CLOSED','CUSTOMER_RESOURCES_CLOSED','PREPARATION_LIMIT','RESOURCE_ADMISSION_LIMIT','DIAGNOSTIC_LIMIT','CUSTOMER_JOB_SPENT','UPLOAD_IMAGE_INVALID','UPLOAD_BODY_LIMIT','TOO_LARGE','CONTENT_TYPE_UNSUPPORTED']);
const resource=s=>typeof s==='string'&&/^bflr1_[A-Za-z0-9_-]{43}$/.test(s);
export function createResourceSession({fetchImpl=fetch,now=Date.now,reloadStorage,reloadKey='bfl:accepted-cart-session:v1',preparedMode=false,clientPolicy,observe=()=>{}}={}) {
  if(location.origin!==storefront)throw Error('RESOURCE_TARGET');
  if(clientPolicy!==undefined&&(!preparedMode||clientPolicy!=='bfl-persistent-staging-client-v1'))throw Error('RESOURCE_SESSION_POLICY');
  let current=null,renewing=null,pending=false,epoch=0,recovery=null,acceptedRead=null,pendingRead=null,uploadSelection=null,uploadRead=null,initializing=false,issueRecovery=null;
  const fail=code=>{throw Error(code);};
  const suspend=()=>{acceptedRead=null;pendingRead=null;uploadRead=null;if(reloadStorage)reloadStorage.setItem(reloadKey,JSON.stringify(preparedMode&&current?{state:initializing?'initializing':'pending',...current,operation:recovery,...(recovery?.kind==='cancel_preparation'&&uploadSelection?{selection:uploadSelection}:{})}:{state:'blocked',...(issueRecovery?{initialization_recovery:issueRecovery}:{})}));};
  const safeOperation=operation=>{
    if(operation===null)return null;
    if(!operation||typeof operation!=='object'||Array.isArray(operation)||Object.keys(operation).some(k=>!['operation_id','kind','request_key','job','quantity','generation','reservation_id'].includes(k))||
      Object.entries(operation).some(([k,v])=>['quantity','generation'].includes(k)?!Number.isSafeInteger(v)||v<0:typeof v!=='string'||v.length>200))fail('RESOURCE_INPUT');
    return {...operation};
  };
  const safeSelection=value=>{
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==2||value.version!=='uncommitted-v1'||
      !Array.isArray(value.intent_ids)||!value.intent_ids.length||value.intent_ids.length>1000||new Set(value.intent_ids).size!==value.intent_ids.length||
      value.intent_ids.some(id=>typeof id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)))fail('RESOURCE_INPUT');
    return {version:value.version,intent_ids:[...value.intent_ids]};
  };
  const checkpoint=(state='accepted',operation=null,selection=undefined)=>{
    acceptedRead=null;pendingRead=null;uploadRead=null;
    if(!(preparedMode?['initialized','accepted','uploads','prepared']:['accepted','uploads']).includes(state))fail('RESOURCE_INPUT');
    const session=live();
    recovery=preparedMode?safeOperation(operation):null;
    if(selection!==undefined){if(!preparedMode||state!=='uploads')fail('RESOURCE_INPUT');uploadSelection=safeSelection(selection);}
    initializing=false;
    if(state==='initialized')uploadSelection=null;
    if(reloadStorage)reloadStorage.setItem(reloadKey,JSON.stringify({state,...session,...(preparedMode?{operation:recovery,...(uploadSelection?{selection:uploadSelection}:{})}:{})}));
  };
  const live=()=>{if(!current||current.expires<=now()){current=null;fail('RESOURCE_EXPIRED');}return current;};
  const readFailure=error=>Object.assign(error instanceof Error?error:Error('RESOURCE_UNAVAILABLE'),{readOnlyFailure:true});
  const post=async(path,input,token,mime)=>{
    const started=performance.now(),proofRequest=path==='/resource-proof/challenge';let phase='transport';
    try {
    const response=await fetchImpl(`${backend}${path}`,{method:'POST',mode:'cors',credentials:'omit',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(path.startsWith('/uploads/')?65000:['/diagnostic/checkout/resources','/checkout/eligible','/checkout/cancel_preparation','/checkout/continue'].includes(path)?30000:10000),
      headers:{'Content-Type':mime??'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:mime?input:JSON.stringify(input)});
    phase='response';
    if(!response.ok){
      // Only the one actionable identity-transition code is exposed. Never echo
      // server messages, tokens, request bodies or transport errors to callers.
      let data;try{data=await response.json();}catch{}
      if(proofRequest){
        const allowed=['PROOF_UNAVAILABLE','PROOF_ORIGIN','PROOF_REJECTED','PROOF_ACTION','PROOF_CAPACITY','PROOF_QUERY','PROOF_PREFLIGHT','PROOF_BODY','RESOURCE_FENCED','RESOURCE_CAPACITY','RESOURCE_RATE','RESOURCE_REJECTED','DIAGNOSTIC_NEW_OWNER_REQUIRED','NOT_FOUND'];
        observe({stage:'session-proof-request',state:'rejected',status:response.status,code:allowed.includes(data?.code)?data.code:'UNAVAILABLE'});phase='rejected';
      }
      if(path.startsWith('/uploads/')){
        const allowed=['UPLOAD_BODY_TIMEOUT','UPLOAD_BODY_LIMIT','UPLOAD_BUSY','UPLOAD_IMAGE_INVALID','CONTENT_TYPE_UNSUPPORTED','ENCODING_UNSUPPORTED','TOO_LARGE','RESOURCE_REJECTED','CUSTOMER_RESOURCES_CLOSED','UPLOAD_PROVIDER_UNAVAILABLE','SOURCE_UNVERIFIED'];
        observe({stage:'upload-request',state:'rejected',status:response.status,code:allowed.includes(data?.code)?data.code:'UNAVAILABLE'});
      }
      if(path==='/jobs'){
        const allowed=['CUSTOMER_SELECTION_REJECTED','ENGINEERING_ASSETS','CUSTOMER_FILES_INCOMPLETE','CUSTOMER_JOB_SPENT','RESOURCE_ADMISSION_LIMIT','PRICE_UNAVAILABLE','ENGINEERING_JOB','RESOURCE_EXPIRED','CUSTOMER_RESOURCES_CLOSED'];
        observe({stage:'prepare-request',state:'rejected',code:allowed.includes(data?.code)?data.code:'UNAVAILABLE'});
        // These checks run before immutable job admission. A corrected selection
        // can retry; all transport uncertainty remains blocked.
        if(preparedMode&&['CUSTOMER_SELECTION_REJECTED','ENGINEERING_ASSETS','CUSTOMER_FILES_INCOMPLETE'].includes(data?.code)){
          const error=Error('RESOURCE_UNAVAILABLE');error.definitive=true;if(safeReasons.has(data?.code))error.reason=data.code;throw error;
        }
      }
      const error=Error(data?.code==='RESOURCE_CONTEXT_CHANGED'?'RESOURCE_CONTEXT_CHANGED':'RESOURCE_UNAVAILABLE');if(safeReasons.has(data?.code))error.reason=data.code;throw error;
    }
    phase='json';return await response.json();
    }catch(error){
      if(proofRequest&&phase!=='rejected')observe({stage:'session-proof-request',state:'failed',phase,error:['AbortError','TimeoutError','TypeError','SyntaxError'].includes(error?.name)?error.name:'UNAVAILABLE'});
      if((phase==='transport'||phase==='json'&&['TypeError','AbortError','TimeoutError'].includes(error?.name))&&
        (['/checkout/resume','/checkout/resume_uploads'].includes(path)||path==='/resource-proof/challenge'&&input?.action==='cart-capability'))throw readFailure(error);
      throw error;
    }finally{observe({stage:'timing',operation:path.replace(/\/[a-f0-9-]{36}(?=\/)/g,'/:intent'),ms:Math.round(performance.now()-started)});}
  };
  const discard=async token=>{if(resource(token))try{await post('/resource-sessions/revoke',{},token);}catch{/* Best effort only; expiry remains the bound. */}};
  const check=attempt=>{if(epoch!==attempt)fail('RESOURCE_SUPERSEDED');};
  async function establish(action){
    if(pending)fail('RESOURCE_BUSY');
    if(clientPolicy&&action==='renew')fail('RESOURCE_SESSION_POLICY');
    if(action==='issue'&&current&&current.expires>now())fail('RESOURCE_ACTIVE');
    const old=action==='renew'?live():null;
    const newPersistentIssue=clientPolicy&&action==='issue'&&reloadStorage?.getItem(reloadKey)===null;
    suspend();const suspended=newPersistentIssue?reloadStorage.getItem(reloadKey):null;
    current=null;renewing=old;pending=true;const attempt=++epoch;let returned,dispatched=false;
    try {
      const c=await post('/resource-proof/challenge',{action},old?.token);check(attempt);
      const shape={challenge_valid:opaque(c?.challenge),verifier_valid:opaque(c?.verifier),purpose_matches:c?.purpose===purpose,audience_matches:c?.audience===audience,action_matches:c?.action===action,expiry_matches:c?.expires_in===30};
      observe({stage:'session-proof-shape',state:Object.values(shape).every(Boolean)?'accepted':'rejected',...shape});
      if(!Object.values(shape).every(Boolean))fail('RESOURCE_UNAVAILABLE');
      // Only the public challenge nonce goes in a URL. Verifier, ticket, proof
      // and resource credential are response/body/header custody exclusively.
      const query=new URLSearchParams({challenge:c.challenge,purpose,audience,action});
      const proxyStarted=performance.now();
        const response=await fetchImpl(`/apps/bfl-staging/resource-proof?${query}`,{credentials:'same-origin',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(10000)});
      observe({stage:'timing',operation:'proxy-proof',ms:Math.round(performance.now()-proxyStarted)});
        if(!response.ok)fail('RESOURCE_UNAVAILABLE');const p=await response.json();check(attempt);
      if(!opaque(p.ticket))fail('RESOURCE_UNAVAILABLE');
      const e=await post('/resource-proof/exchange',{action,challenge:c.challenge,verifier:c.verifier,ticket:p.ticket},old?.token);check(attempt);
      if(!opaque(e.proof)||!Number.isInteger(e.expires_in)||e.expires_in<0||e.expires_in>30)fail('RESOURCE_UNAVAILABLE');
      const sent=now();dispatched=true;returned=await post(`/resource-sessions/${action}`,{proof:e.proof},old?.token);
      check(attempt);
      if(!resource(returned.token)||returned.resource_only!==true||returned.cart_verified!==false||returned.checkout_ready!==false||
        !Number.isInteger(returned.expires_in)||returned.expires_in<1||returned.expires_in>(clientPolicy&&action==='issue'?86400:preparedMode&&action==='issue'?(returned.client_policy==='bfl-full-product-client-v1'?3600:600):300)||returned.generation!==(old?old.generation+1:1))fail('RESOURCE_UNAVAILABLE');
      const expires=clientPolicy?returned.expires_at:sent+returned.expires_in*1000;
      if(clientPolicy&&(!Number.isSafeInteger(expires)||expires>now()+86400000||returned.client_policy!==clientPolicy))fail('RESOURCE_SESSION_POLICY');
      if(expires<=now())fail('RESOURCE_EXPIRED');
      current={token:returned.token,expires,generation:returned.generation,...(clientPolicy?{client_policy:clientPolicy,cart_revision:0,...(issueRecovery?{initialization_recovery:issueRecovery}:{})}:{}),...(preparedMode?{prepared_generation:old?.prepared_generation??0}:{})};
      if(clientPolicy&&action==='issue'){initializing=true;suspend();} // Keep the original finite credential before any cart work.
      return {generation:current.generation,expires_at:expires,...(clientPolicy?{client_policy:clientPolicy}:{}),resource_only:true,cart_verified:false,checkout_ready:false};
    }catch(error){
      // A new visitor may retry fresh proof acquisition if owner issuance was
      // never dispatched. Lost/invalid issue responses keep their spent custody.
      if(newPersistentIssue&&!dispatched&&epoch===attempt&&reloadStorage.getItem(reloadKey)===suspended)reloadStorage.removeItem?.(reloadKey);
      await discard(returned?.token);await discard(old?.token);
      if(safeReasons.has(error?.reason))throw error;
      const safe=['RESOURCE_SUPERSEDED','RESOURCE_CONTEXT_CHANGED','RESOURCE_EXPIRED'];
      fail(safe.includes(error?.message)?error.message:'RESOURCE_UNAVAILABLE');
    }finally{renewing=null;pending=false;}
  }
  async function replaceSession(cartId){
    if(clientPolicy!=='bfl-persistent-staging-client-v1'||!reloadStorage||pending||current)fail('RESOURCE_SESSION_POLICY');
    const saved=reloadStorage.getItem(reloadKey);let prior;try{prior=JSON.parse(saved);}catch{}
    if(!prior||prior.client_policy!==clientPolicy||!['accepted','initialized','uploads','initializing'].includes(prior.state)||prior.operation!==null||
      !resource(prior.token)||!Number.isSafeInteger(prior.expires)||prior.expires<=0||prior.expires>now()||!Number.isSafeInteger(prior.generation)||prior.generation<1||
      typeof cartId!=='string'||!/^gid:\/\/shopify\/Cart\/[A-Za-z0-9_-]+\?key=[A-Za-z0-9_-]+$/.test(cartId))fail('RESOURCE_SESSION_POLICY');
    if(prior.state==='initializing'&&((prior.prepared_generation??0)!==0||(prior.cart_revision??0)!==0||prior.selection!==undefined))fail('RESOURCE_SESSION_POLICY');
    if(prior.initialization_recovery!==undefined){
      let original;try{original=JSON.parse(prior.initialization_recovery);}catch{}
      if(typeof prior.initialization_recovery!=='string'||!original||Object.keys(original).length!==1||original.state!=='blocked')fail('RESOURCE_SESSION_POLICY');
      issueRecovery=prior.initialization_recovery;
    }
    const replacement=JSON.stringify({...prior,state:'pending',operation:{kind:'replace_session',operation_id:crypto.randomUUID()}});
    reloadStorage.setItem(reloadKey,replacement);pending=true;const attempt=++epoch;let sent=false;
    try{
      // Replacement gets a fresh anonymous issue proof. The expired credential
      // is used only by the terminal endpoint, never ordinary protected routes.
      const action='issue',c=await post('/resource-proof/challenge',{action});check(attempt);
      if(!opaque(c?.challenge)||!opaque(c?.verifier)||c.purpose!==purpose||c.audience!==audience||c.action!==action||c.expires_in!==30)fail('RESOURCE_UNAVAILABLE');
      const query=new URLSearchParams({challenge:c.challenge,purpose,audience,action});
      const response=await fetchImpl(`/apps/bfl-staging/resource-proof?${query}`,{credentials:'same-origin',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(10000)});
      if(!response.ok)fail('RESOURCE_UNAVAILABLE');const signed=await response.json();check(attempt);if(!opaque(signed.ticket))fail('RESOURCE_UNAVAILABLE');
      const exchange=await post('/resource-proof/exchange',{action,challenge:c.challenge,verifier:c.verifier,ticket:signed.ticket});check(attempt);
      if(!opaque(exchange.proof)||!Number.isInteger(exchange.expires_in)||exchange.expires_in<0||exchange.expires_in>30)fail('RESOURCE_UNAVAILABLE');
      sent=true;const result=await post('/checkout/replace_session',{proof:exchange.proof,cart_id:cartId},prior.token);check(attempt);
      if(result?.replaced!==true||result.client_policy!==clientPolicy||!resource(result.token)||result.token===prior.token||result.generation!==1||
        result.resource_only!==true||result.cart_verified!==false||result.checkout_ready!==false||!Number.isInteger(result.expires_in)||result.expires_in<1||result.expires_in>86400||
        !Number.isSafeInteger(result.expires_at)||result.expires_at<=now()||result.expires_at>now()+86400000)fail('RESOURCE_UNAVAILABLE');
      current={token:result.token,expires:result.expires_at,generation:1,prepared_generation:0,client_policy:clientPolicy,cart_revision:0,...(issueRecovery?{initialization_recovery:issueRecovery}:{})};
      initializing=true;suspend(); // Persist replacement custody before any cart work.
      return {replaced:true,generation:1,expires_at:current.expires,client_policy:clientPolicy,resource_only:true,cart_verified:false,checkout_ready:false};
    }catch(error){
      if(!sent&&reloadStorage.getItem(reloadKey)===replacement)reloadStorage.setItem(reloadKey,saved);
      if(sent)error.cartUncertain=true;
      throw error;
    }finally{pending=false;}
  }
  async function checkoutAction(action,locate,customerFlow=false,input={}){
      if(pending)fail('RESOURCE_BUSY');
      if(!(customerFlow?['bind','install','publish','current','resume','resume_uploads',...(preparedMode?['eligible','cancel_preparation']:[])]:['bind','install','publish','observe','inspect','resources','copy_item','control']).includes(action)||typeof locate!=='function')fail('RESOURCE_INPUT');
      if(Object.keys(input).some(k=>!['reference','generation','reservation','operation',...(customerFlow&&preparedMode&&action==='resume_uploads'?['selection']:[])].includes(k)))fail('RESOURCE_INPUT');
      if(input.selection!==undefined)input={...input,selection:safeSelection(input.selection)};
      const session=live(),attempt=epoch,prefix=customerFlow?'/checkout/':'/diagnostic/checkout/';pending=true;
      if(!customerFlow||action!=='resume'||Object.keys(input).length||recovery!==null)acceptedRead=null;
      if(!customerFlow||action!=='resume'||Object.keys(input).length!==1||!Object.hasOwn(input,'operation')||
        JSON.stringify(input.operation)!==pendingRead?.operation)pendingRead=null;
      if(!customerFlow||!['resume','resume_uploads'].includes(action))uploadRead=null;
      if(customerFlow&&['install','publish'].includes(action))suspend();
      const guard=()=>{check(attempt);if(current!==session||session.expires<=now())fail('RESOURCE_EXPIRED');};
      const fresh=async()=>{
        const actionName='cart-capability',c=await post('/resource-proof/challenge',{action:actionName},session.token);guard();
        if(!opaque(c.challenge)||!opaque(c.verifier)||c.purpose!==purpose||c.audience!==audience||c.action!==actionName||c.expires_in!==30)fail('RESOURCE_UNAVAILABLE');
        const query=new URLSearchParams({challenge:c.challenge,purpose,audience,action:actionName});
        const proxyStarted=performance.now();
        let response;try{response=await fetchImpl(`/apps/bfl-staging/resource-proof?${query}`,{credentials:'same-origin',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(10000)});}catch(error){throw readFailure(error);}
        observe({stage:'timing',operation:'proxy-proof',ms:Math.round(performance.now()-proxyStarted)});
        if(!response.ok)fail('RESOURCE_UNAVAILABLE');let p;try{p=await response.json();}catch(error){if(['TypeError','AbortError','TimeoutError'].includes(error?.name))throw readFailure(error);throw error;}guard();if(!opaque(p.ticket))fail('RESOURCE_UNAVAILABLE');
        // The customer endpoint exchanges and consumes this one-use evidence
        // inside the same authenticated request. The challenge, signed proxy
        // observation, owner/epoch checks and post-clear ordering are unchanged.
        if(customerFlow)return {challenge:c.challenge,verifier:c.verifier,ticket:p.ticket};
        const e=await post('/resource-proof/exchange',{action:actionName,challenge:c.challenge,verifier:c.verifier,ticket:p.ticket},session.token);guard();if(!opaque(e.proof))fail('RESOURCE_UNAVAILABLE');return e.proof;
      };
      try{
        const cart_id=await locate();guard();if(typeof cart_id!=='string'||cart_id.length>4096)fail('RESOURCE_UNAVAILABLE');
        let result=await post(prefix+action,{...input,cart_id,proof:await fresh()},session.token);guard();
        if(result.continuation!==undefined){
          if(!['install','publish','eligible','cancel_preparation'].includes(action)||!opaque(result.continuation)||result.expires_in<1||result.expires_in>30)fail('RESOURCE_UNAVAILABLE');
          if(await locate()!==cart_id)fail('RESOURCE_SUPERSEDED');guard();
          // This exchange happens only AFTER the server's verified clear. A
          // pre-clear proof is neither cached nor submitted for continuation.
          result=await post(prefix+'continue',{cart_id,proof:await fresh(),continuation:result.continuation},session.token);guard();
        }
        if(result.continuation!==undefined||result.cart_verified!==false||result.checkout_ready!==false)fail('RESOURCE_UNAVAILABLE');
        return result;
      }catch(error){if(error?.readOnlyFailure===true||safeReasons.has(error?.reason)||error?.message==='RESOURCE_EXPIRED')throw error;fail('RESOURCE_UNAVAILABLE');}finally{pending=false;}
  }
  return Object.freeze({
    issue:()=>establish('issue'),renew:()=>establish('renew'),replaceSession,
    async recoverUnbound(){
      if(!clientPolicy||!reloadStorage||current||pending)fail('RESOURCE_SESSION_POLICY');
      const saved=reloadStorage.getItem(reloadKey);let value;try{value=JSON.parse(saved);}catch{}
      if(!value||Object.keys(value).length!==1||value.state!=='blocked')fail('RESOURCE_SESSION_POLICY');
      // One fresh owner is allowed for legacy tokenless initialization only.
      // Preserve the old receipt before proof/issue; a lost new response cannot
      // repeat this recovery. Normal server bind ledgers still reject any prior
      // cart attempt, including rejected/unknown attempts and a racing old page.
      issueRecovery=saved;suspend();return establish('issue');
    },
    receipt(){const row=live();return {generation:row.generation,expires_at:row.expires,...(row.client_policy?{client_policy:row.client_policy}:{})};},
    assertLive(){live();},
    suspend,checkpoint,
    rememberUploadSelection(selection){
      live();acceptedRead=null;pendingRead=null;uploadRead=null;if(!preparedMode||recovery&&recovery.kind!=='prepared')return false;
      uploadSelection=safeSelection(selection);
      if(recovery?.kind==='prepared')checkpoint('prepared',recovery);
      return recovery===null;
    },
    completedSelection(){return uploadSelection?{version:uploadSelection.version,intent_ids:[...uploadSelection.intent_ids]}:null;},
    clearUploadSelection(){uploadSelection=null;acceptedRead=null;pendingRead=null;uploadRead=null;},
    preserveUploadRead(error){
      const prior=uploadRead;uploadRead=null;
      if(!prior||prior.session!==current||prior.epoch!==epoch||JSON.stringify(recovery)!==prior.operation||
        JSON.stringify(uploadSelection)!==prior.selection||current.expires<=now()||error?.cartUncertain||
        !(error?.readOnlyFailure===true||error?.reason==='CART_PRICE_UNVERIFIED'))return false;
      checkpoint(prior.state,recovery);error.uploadReadRetry=true;return true;
    },

    preserveAcceptedRead(error){
      // Custody only: the next page must authenticate the same owner/cart again.
      // An intervening operation consumes this one-shot marker via suspend().
      const prior=acceptedRead;acceptedRead=null;
      if(!prior||prior.session!==current||prior.epoch!==epoch||recovery!==null||current.expires<=now()||error?.cartUncertain||
        !(error?.readOnlyFailure===true||error?.reason==='CART_PRICE_UNVERIFIED'))return false;
      checkpoint('accepted');error.acceptedReadRetry=true;return true;
    },
    preservePendingRead(error){
      // Keep custody of the same already-dispatched Add, never an accepted cart
      // or permission to send it again. A new page must recheck its actual result.
      const prior=pendingRead;pendingRead=null;
      if(!prior||prior.session!==current||prior.epoch!==epoch||JSON.stringify(recovery)!==prior.operation||current.expires<=now()||error?.cartUncertain||
        !(error?.readOnlyFailure===true||error?.reason==='CART_PRICE_UNVERIFIED'))return false;
      suspend();error.cartUncertain=true;return true;
    },
    preparationGeneration:()=>current?.prepared_generation??0,
    rememberPreparationGeneration(generation){
      const session=live();
      if(!preparedMode||!Number.isSafeInteger(generation)||generation<1||generation<(session.prepared_generation??0))fail('RESOURCE_INPUT');
      // This is only a monotonic request counter. Server reservations remain
      // authoritative, and the pending checkpoint cannot authorize a replay.
      session.prepared_generation=generation;suspend();
    },
    beginMutation(operation){if(!preparedMode)fail('RESOURCE_INPUT');const row=live();recovery=safeOperation(operation);if(clientPolicy){const revision=(row.cart_revision??0)+1;if(!Number.isSafeInteger(revision))fail('RESOURCE_INPUT');row.cart_revision=revision;}if(recovery?.kind==='add')uploadSelection=null;suspend();},
    restore(){
      if(!reloadStorage)return false;
      const saved=reloadStorage.getItem(reloadKey);if(saved===null)return false;
      let value;try{value=JSON.parse(saved);}catch{fail('RESOURCE_UNAVAILABLE');}
      if(value?.initialization_recovery!==undefined){
        let prior;try{prior=JSON.parse(value.initialization_recovery);}catch{}
        if(!clientPolicy||typeof value.initialization_recovery!=='string'||!prior||Object.keys(prior).length!==1||prior.state!=='blocked')fail('RESOURCE_SESSION_POLICY');
        issueRecovery=value.initialization_recovery;
      }
      // Initializing custody is already uncertain. Keep its original token even
      // if navigation interrupts validation; it never falls back to new issue.
      const diagnosing=clientPolicy&&value?.state==='pending'&&value.operation===null;
      if(!(clientPolicy&&value?.state==='initializing')&&!diagnosing)suspend();
      if(!(preparedMode?['initialized','accepted','uploads','prepared','pending',...(clientPolicy?['initializing']:[])]:['accepted','uploads']).includes(value?.state)||!resource(value.token)||!Number.isSafeInteger(value.expires)||
        !Number.isSafeInteger(value.generation)||value.generation<1)fail('RESOURCE_UNAVAILABLE');
      if(clientPolicy&&(value.client_policy!==clientPolicy||!Number.isSafeInteger(value.cart_revision??0)||(value.cart_revision??0)<0))fail('RESOURCE_SESSION_POLICY');
      if(value.expires<=now())fail('RESOURCE_EXPIRED');
      const preparedGeneration=value.prepared_generation??0;
      if(preparedMode&&(!Number.isSafeInteger(preparedGeneration)||preparedGeneration<0))fail('RESOURCE_UNAVAILABLE');
      initializing=clientPolicy&&value.state==='initializing';
      if(initializing&&(value.operation!==null||preparedGeneration!==0||(value.cart_revision??0)!==0||value.selection!==undefined))fail('RESOURCE_SESSION_POLICY');
      uploadSelection=null;
      if(value.selection!==undefined){if(!preparedMode||!(['uploads','prepared','accepted'].includes(value.state)||value.state==='pending'&&value.operation?.kind==='cancel_preparation'))fail('RESOURCE_INPUT');uploadSelection=safeSelection(value.selection);}
      current={token:value.token,expires:value.expires,generation:value.generation,...(clientPolicy?{client_policy:clientPolicy,cart_revision:value.cart_revision??0,...(issueRecovery?{initialization_recovery:issueRecovery}:{})}:{}),...(preparedMode?{prepared_generation:preparedGeneration}:{})};
      if(preparedMode){
        recovery=safeOperation(value.operation??null);
        if(initializing||diagnosing)suspend();
        if(uploadSelection){
          const draft=['prepared','cancel_preparation'].includes(recovery?.kind)&&Object.keys(recovery).length===4&&typeof recovery.operation_id==='string'&&recovery.operation_id&&typeof recovery.job==='string'&&recovery.job&&Number.isSafeInteger(recovery.generation)&&recovery.generation>0;
          if(['uploads','accepted'].includes(value.state)?recovery!==null:!draft||recovery.kind!==(value.state==='prepared'?'prepared':'cancel_preparation'))fail('RESOURCE_INPUT');
        }
        if(uploadSelection&&['uploads','prepared','accepted'].includes(value.state))uploadRead={session:current,epoch,state:value.state,operation:JSON.stringify(recovery),selection:JSON.stringify(uploadSelection)};
        if(uploadSelection&&value.state==='pending'&&recovery?.kind==='cancel_preparation')suspend();
        if(value.state==='accepted'&&recovery===null)acceptedRead={session:current,epoch};
        if(value.state==='pending'&&recovery?.kind==='add'&&Object.keys(recovery).length===4&&
          typeof recovery.operation_id==='string'&&recovery.operation_id&&typeof recovery.job==='string'&&recovery.job&&
          Number.isSafeInteger(recovery.quantity)&&recovery.quantity>0&&recovery.quantity<=10000)pendingRead={session:current,epoch,operation:JSON.stringify(recovery)};
        return {state:value.state,operation:recovery,...(uploadSelection?{selection:uploadSelection}:{})};
      }
      return value.state==='uploads'?'uploads':true; // Not authority until authenticated checkout resume succeeds.
    },
    async revoke(){suspend();++epoch;const old=current??renewing;current=null;renewing=null;
      // Local custody is cleared even on network failure. No remote-revocation
      // guarantee is returned unless the server explicitly confirms it.
      if(old){try{const result=await post('/resource-sessions/revoke',{},old.token);if(result.revoked!==true)fail('RESOURCE_UNAVAILABLE');}
        catch{fail('RESOURCE_UNAVAILABLE');}}
      return {local_cleared:true,remote_confirmed:!!old};
    },
    async ownedCart(action,cartId){
      if(pending)fail('RESOURCE_BUSY');
      if(!['bind','status'].includes(action)||typeof cartId!=='string'||cartId.length>4096)fail('RESOURCE_INPUT');
      const session=live(),attempt=epoch;acceptedRead=null;pendingRead=null;uploadRead=null;
      const guard=()=>{check(attempt);if(current!==session||session.expires<=now())fail('RESOURCE_EXPIRED');};
      try{
        const actionName='cart-capability';
        const c=await post('/resource-proof/challenge',{action:actionName},session.token);guard();
        if(!opaque(c.challenge)||!opaque(c.verifier)||c.purpose!==purpose||c.audience!==audience||c.action!==actionName||c.expires_in!==30)fail('RESOURCE_UNAVAILABLE');
        const query=new URLSearchParams({challenge:c.challenge,purpose,audience,action:actionName});
        const proxyStarted=performance.now();
        const response=await fetchImpl(`/apps/bfl-staging/resource-proof?${query}`,{credentials:'same-origin',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(10000)});
        observe({stage:'timing',operation:'proxy-proof',ms:Math.round(performance.now()-proxyStarted)});
        if(!response.ok)fail('RESOURCE_UNAVAILABLE');const p=await response.json();guard();if(!opaque(p.ticket))fail('RESOURCE_UNAVAILABLE');
        const e=await post('/resource-proof/exchange',{action:actionName,challenge:c.challenge,verifier:c.verifier,ticket:p.ticket},session.token);guard();if(!opaque(e.proof))fail('RESOURCE_UNAVAILABLE');
        const r=await post('/owned-cart/'+action,{proof:e.proof,cart_id:cartId},session.token);guard();
        if(r.owned!==true||r.owner_kind!=='application'||r.generation!==session.generation||r.cart_verified!==false||r.checkout_ready!==false||typeof r.binding_id!=='string')fail('RESOURCE_UNAVAILABLE');
        return r;
      }catch{fail('RESOURCE_UNAVAILABLE');}
    },
    // Finite diagnostic only. No route exists in ordinary serving. All secrets
    // stay in this closure and POST bodies/headers; no DOM/storage/global export.
    checkoutDiagnostic:(action,locate)=>checkoutAction(action,locate),
    checkout:(action,locate,input)=>checkoutAction(action,locate,true,input),
    async request(path,input,{mime}={}){
      if(pending)fail('RESOURCE_BUSY');
      const upload=/^\/uploads\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/(bytes|source|status|remove|preview|original|crop)$/.exec(path);
      if(!['/jobs','/uploads/intents'].includes(path)&&!upload)fail('RESOURCE_PATH');
      if(upload?.[1]==='bytes'?!['image/jpeg','image/png','image/tiff'].includes(mime):mime!==undefined)fail('RESOURCE_INPUT');
      const session=live(),attempt=epoch;
      suspend();
      try {const result=await post(path,input,session.token,mime);check(attempt);if(current!==session||session.expires<=now())fail('RESOURCE_EXPIRED');return result;}
      catch(error){if(error?.definitive===true||safeReasons.has(error?.reason)||['RESOURCE_SUPERSEDED','RESOURCE_EXPIRED'].includes(error?.message))throw error;fail('RESOURCE_UNAVAILABLE');}
    },
  });
}
