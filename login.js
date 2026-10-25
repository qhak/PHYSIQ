// Email ownership is verified by the worker. A saved email alone never opens
// the workspace; the code grants a refresh token for this device.
let loginBusy=false;

function loginStatus(message,isError){
  const status=document.getElementById('loginStatus');
  if(status){status.textContent=message;status.classList.toggle('error',!!isError);}
}

function prepareLoginScreen(){
  const email=document.getElementById('loginEmail');
  const code=document.getElementById('loginCode');
  const step=document.getElementById('loginCodeStep');
  const submit=document.getElementById('loginSubmit');
  const resend=document.getElementById('loginResend');
  if(email) email.value=userEmail||'';
  if(code) code.value='';
  if(step) step.hidden=true;
  if(submit){submit.textContent='Email me a code →';submit.onclick=requestLoginCode;submit.disabled=false;}
  if(resend) resend.hidden=true;
  loginStatus('',false);
}

function showLoginCodeStep(){
  const step=document.getElementById('loginCodeStep');
  const submit=document.getElementById('loginSubmit');
  const resend=document.getElementById('loginResend');
  if(step) step.hidden=false;
  if(submit){submit.textContent='Sign in →';submit.onclick=submitLoginCode;}
  if(resend) resend.hidden=false;
}

async function requestLoginCode(){
  if(loginBusy) return;
  const email=(document.getElementById('loginEmail')?.value||'').trim().toLowerCase();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)){
    loginStatus('Enter a valid email address.',true);
    return;
  }
  const submit=document.getElementById('loginSubmit');
  loginBusy=true;
  if(submit) submit.disabled=true;
  loginStatus('Sending your code…',false);
  try{
    const res=await fetch(WORKER_URL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'request_code',email}),signal:AbortSignal.timeout(25000)});
    const data=await res.json().catch(()=>null);
    if(!res.ok || !data?.ok) throw new Error(res.status===429?'Too many requests. Please try again later.':data?.message||'Could not send a code. Please try again.');
    showLoginCodeStep();
    loginStatus('If this email can receive messages, a six-digit code is on its way. It expires in 15 minutes.',false);
    document.getElementById('loginCode')?.focus();
    track('account_code_requested');
  }catch(error){
    loginStatus(error.name==='TimeoutError'?'The request timed out. Please try again.':error.message||'Could not send a code.',true);
  }finally{loginBusy=false;if(submit) submit.disabled=false;}
}

function clearCachedAccountProfile(){
  profile={};profileViews={};viewsDone={};profileScoringVersion=null;
  if(typeof strengthData!=='undefined') strengthData={bw:null,entries:{}};
  try{localStorage.removeItem('pq_strength');localStorage.removeItem('pq_scoring_version');}catch(e){}
}

async function submitLoginCode(){
  if(loginBusy) return;
  const email=(document.getElementById('loginEmail')?.value||'').trim().toLowerCase();
  const code=(document.getElementById('loginCode')?.value||'').trim();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || !/^\d{6}$/.test(code)){
    loginStatus('Enter the six-digit code from your email.',true);
    return;
  }
  const submit=document.getElementById('loginSubmit');
  loginBusy=true;
  if(submit) submit.disabled=true;
  loginStatus('Checking your code…',false);
  try{
    const res=await fetch(WORKER_URL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'redeem_code',email,code}),signal:AbortSignal.timeout(25000)});
    const data=await res.json().catch(()=>null);
    if(!res.ok || !data?.active || !data.token || !data.refresh_token) throw new Error(res.status===429?'Too many attempts. Please try later.':'That code is invalid or expired. Request a new one.');
    if(userEmail && userEmail.toLowerCase()!==email) clearCachedAccountProfile();
    storeEntitlement(data);
    refreshHome();
    track('account_login',{tier:data.tier||'free'});
    openWorkspaceDestination();
  }catch(error){
    loginStatus(error.name==='TimeoutError'?'Verification timed out. Try again.':error.message||'Could not verify the code.',true);
  }finally{loginBusy=false;if(submit) submit.disabled=false;}
}

function signOutWorkspace(){
  userEmail=null;entitlementToken=null;entitlementTokenExp=0;refreshToken=null;
  userTierDisplay=null;accountVerified=false;dateOfBirth=null;
  clearCachedAccountProfile();
  saveState();
  location.reload();
}
