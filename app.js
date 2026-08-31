// ============================================================
//  CONFIG — swap these and the app is fully live
// ============================================================
const WORKER_URL   = "https://calloutapp.callout-ai.workers.dev";
const EMAIL_ENDPOINT = WORKER_URL;
const PAYMENT_LINK_SCAN     = "https://buy.stripe.com/dRmcN78Moge72QZ9hnb3q01"; // £5.99 one-time
const PAYMENT_LINK_PRO      = "https://buy.stripe.com/fZu5kF8MobXRfDL9hnb3q02"; // £9.99/month
const PAYMENT_LINK_LIFETIME = "https://buy.stripe.com/aFa3cx9Qsfa34Z7517b3q03"; // £29.99 lifetime
const UNLOCK_PRICE   = "£5.99";
// Cloudflare Turnstile sitekey (dashboard → Turnstile → your widget).
// Leave empty to skip the bot check client-side; the worker only enforces
// it when TURNSTILE_SECRET is set, so configure both together.
const TURNSTILE_SITE_KEY = "0x4AAAAAAD4XysFGTshW8qs9";
// ============================================================

// ---- funnel analytics: fires to Plausible custom events when present,
//      safely no-ops otherwise (cookieless; no consent banner required) ----
function track(name,params){
  try{ if(typeof window.plausible==='function') window.plausible(name,{props:params||{}}); }catch(e){}
  try{ if(typeof window.stats==='function') window.stats(name,params||{}); }catch(e){}
}

const VIEWS=[
  {id:"front",  letter:"F",t:"Front",     d:"chest · shoulders · arms · abs"},
  {id:"back",   letter:"B",t:"Back",      d:"back · traps · rear delts"},
  {id:"legs",   letter:"L",t:"Legs",      d:"quads · hams · glutes · calves"},
  {id:"arms_side",letter:"A",t:"Arms / Side",d:"arms · side delts (best arm read)"}
];
const MUSCLES=["shoulders","chest","arms","abs","back","traps","quads","hamstrings","glutes","calves","conditioning"];
const CONF_RANK={high:3,medium:2,low:1};

// ---- state ----
let profile={};
let viewsDone={};
let photos={};
let pendingView=null;

// ---- account / payment state ----
let userEmail  = null;
let entitlementToken = null;
let entitlementTokenExp = 0;
let refreshToken = null;    // long-lived device token from checkout / email code
let userTierDisplay = null; // display hint from the worker only; never authority

// ---- localStorage: convenience only, never authority ----
function saveState(){
  try{
    localStorage.setItem('pq_email',   userEmail||'');
    localStorage.setItem('pq_token',   entitlementToken||'');
    localStorage.setItem('pq_refresh', refreshToken||'');
    localStorage.setItem('pq_token_exp', String(entitlementTokenExp||0));
    localStorage.setItem('pq_profile', JSON.stringify(profile));
    localStorage.setItem('pq_views',   JSON.stringify(Object.keys(viewsDone)));
    localStorage.removeItem('pq_account');
    localStorage.removeItem('pq_tier');
  }catch(e){}
}
function loadState(){
  try{
    userEmail  = localStorage.getItem('pq_email')||null;
    entitlementToken = localStorage.getItem('pq_token')||null;
    refreshToken = localStorage.getItem('pq_refresh')||null;
    entitlementTokenExp = parseInt(localStorage.getItem('pq_token_exp')||'0',10)||0;
    const p=localStorage.getItem('pq_profile'); if(p) profile=JSON.parse(p);
    const v=localStorage.getItem('pq_views');   if(v) JSON.parse(v).forEach(id=>viewsDone[id]=true);
  }catch(e){}
}

function hasAccount(){ return !!userEmail; }
function hasFreshEntitlementToken(){ return !!entitlementToken && entitlementTokenExp > Date.now() + 30000; }
function hasEntitlementHint(){ return hasFreshEntitlementToken() && !!userTierDisplay; }
function isProHint(){ return hasFreshEntitlementToken() && (userTierDisplay === "pro" || userTierDisplay === "lifetime"); }
function storeEntitlement(data){
  if(!data) return;
  if(data.email) userEmail=data.email;
  if(data.token){
    entitlementToken=data.token;
    entitlementTokenExp=Date.now()+((data.expires_in||900)*1000);
  }
  if(data.refresh_token) refreshToken=data.refresh_token;
  if(data.tier) userTierDisplay=data.tier;
  saveState();
}
function clearEntitlement(){
  entitlementToken=null;
  entitlementTokenExp=0;
  userTierDisplay=null;
  saveState();
}

// ---- build view tiles ----
const grid=document.getElementById('viewGrid');
VIEWS.forEach(v=>{
  const b=document.createElement('button');b.className='vtile';b.id='vt-'+v.id;
  b.onclick=()=>pick(v.id);
  b.innerHTML=
    '<span class="chk">✓ done</span>'+
    '<div class="lock-badge"><svg viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></div>'+
    '<div class="ic">'+v.letter+'</div><div class="t">'+v.t+'</div><div class="d">'+v.d+'</div>';
  grid.appendChild(b);
});

// ---- init ----
window.addEventListener('DOMContentLoaded',()=>{
  loadState();
  userTierDisplay=null; // paid UI must relock until the worker re-issues a token
  refreshHome();
  loadPublicStats();
  if(userEmail) refreshEntitlementToken().then(refreshHome).catch(()=>{});

  // Handle Stripe success redirect (?session_id=...) — verified server-side
  const _params=new URLSearchParams(location.search);
  const _sessionId=_params.get('session_id');
  if(_sessionId){
    history.replaceState({},'',location.pathname);
    sessionStorage.removeItem('callout_checkout_started');
    document.getElementById('scanLetter').textContent='$';
    document.getElementById('aStatus').textContent='verifying payment…';
    document.getElementById('aSub').textContent='just a moment';
    show('screen-analyse');
    fetch(WORKER_URL,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'verify_payment',session_id:_sessionId})})
      .then(r=>r.json())
      .then(d=>{
        if(d.verified){
          storeEntitlement(d);
          track('purchase_verified',{tier:d.tier||''});
          showConfirmScreen();
        } else {
          track('purchase_verify_failed',{reason:d.reason||''});
          renderError('Payment could not be verified. If you were charged, contact support@callout-ai.com.');
          show('screen-result');
        }
      })
      .catch(()=>{
        renderError('Could not reach the server to verify payment. Please try again.');
        show('screen-result');
      });
  } else if(sessionStorage.getItem('callout_checkout_started')==='1'){
    sessionStorage.removeItem('callout_checkout_started');
    history.replaceState({},'',location.pathname);
    renderPaymentRecovery();
    show('screen-result');
  }

  if(!WORKER_URL){
    const n=document.getElementById('setupNote');
    n.style.display='block';
    n.innerHTML='<b>Not connected.</b> Set WORKER_URL at the top of the script.';
  }

  // Modal escape key
  document.addEventListener('keydown',e=>{
    if(e.key==='Escape'){
      document.querySelectorAll('.modal-overlay.open').forEach(m=>m.classList.remove('open'));
      document.body.style.overflow='';
    }
  });
});

// ---- pick a view ----
// NOTE: this must stay synchronous up to the filein.click() below. Browsers
// only honour a programmatic click on a file input while still inside the
// trusted user gesture; any `await` first drops out of it and Safari silently
// refuses to open the picker, so the button appears to do nothing at all.
// The entitlement refresh therefore runs in the background, never awaited here.
function pick(viewId){
  if(!WORKER_URL){alert("Set WORKER_URL first.");return;}

  if(userEmail && !hasFreshEntitlementToken()) refreshEntitlementToken().catch(()=>{});

  // Free scan already used and no paid access: show the paywall now instead
  // of letting the user pick + upload a photo the server will reject anyway.
  if(!hasEntitlementHint() && Object.keys(viewsDone).length>=1 && !viewsDone[viewId]){
    showPaywall();
    return;
  }

  pendingView=viewId;
  track('scan_pick',{view:viewId});
  let guideSeen=false;
  try{guideSeen=localStorage.getItem('pq_guide_ok')==='1';}catch(e){}
  if(!guideSeen){openGuide(false);return;}
  document.getElementById('filein').click();
}

// ---- upload guide (shown once before first pick, reopenable) ----
function openGuide(manual){
  if(manual) pendingView=null;
  const btn=document.getElementById('guideContinueBtn');
  if(btn) btn.textContent=pendingView?'Choose photo →':'Got it';
  track('upload_guide_shown',{manual:!!manual});
  openModal('guideModal');
}
function guideContinue(){
  try{const cb=document.getElementById('guideDontShow');if(cb&&cb.checked)localStorage.setItem('pq_guide_ok','1');}catch(e){}
  closeModal('guideModal');
  track('upload_guide_continue');
  if(pendingView) document.getElementById('filein').click();
}

async function refreshEntitlementToken(){
  if(!WORKER_URL) return false;

  // Preferred path: exchange the long-lived device token (granted at
  // checkout or after an email code) for a fresh short-lived access token.
  if(refreshToken){
    try{
      const res=await fetch(WORKER_URL,{
        method:'POST',
        headers:{'Content-Type':'application/json','Authorization':'Bearer '+refreshToken},
        body:JSON.stringify({action:'refresh_token'})
      });
      const data=await res.json().catch(()=>null);
      if(res.ok && data && data.active && data.token){ storeEntitlement(data); return true; }
      if(res.status===401){ refreshToken=null; saveState(); }
      else if(res.ok && data && data.active===false){ clearEntitlement(); return false; }
    }catch(err){ return false; }
  }

  // Fallback: direct issue by email. Only succeeds while the worker runs
  // with ALLOW_LEGACY_TOKEN_ISSUE=1; in magic-link mode the worker answers
  // code_required (and sends no email) — restoring then goes through the
  // recovery modal's email-code flow.
  if(!userEmail) return false;
  try{
    const res=await fetch(WORKER_URL,{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'issue_token',email:userEmail})
    });
    const data=await res.json().catch(()=>null);
    if(res.ok && data && data.active && data.token){ storeEntitlement(data); return true; }
    if(data && data.code_required) return false;
    if(res.ok) clearEntitlement();
    return false;
  }catch(err){
    return false;
  }
}

// ---- Turnstile (bot check on free scans) ----
let tsWidgetId=null, tsResolve=null;
if(TURNSTILE_SITE_KEY){
  const s=document.createElement('script');
  s.src='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  s.async=true; s.defer=true;
  document.head.appendChild(s);
}
function tsCallback(token){
  if(tsResolve){ const r=tsResolve; tsResolve=null; r(token); }
}
function getTurnstileToken(){
  if(!TURNSTILE_SITE_KEY) return Promise.resolve('');
  return new Promise(resolve=>{
    tsResolve=resolve;
    const fail=()=>{ if(tsResolve){ tsResolve=null; resolve(''); } };
    const start=Date.now();
    (function waitApi(){
      if(!window.turnstile){
        if(Date.now()-start>10000) return fail();
        return setTimeout(waitApi,150);
      }
      try{
        if(tsWidgetId===null){
          tsWidgetId=turnstile.render('#tsHolder',{
            sitekey:TURNSTILE_SITE_KEY,
            appearance:'interaction-only',
            callback:tsCallback,
            'error-callback':fail
          });
        } else {
          turnstile.reset(tsWidgetId);
        }
      }catch(e){ fail(); }
    })();
    setTimeout(fail,25000);
  });
}

// ---- file selected ----
document.getElementById('filein').addEventListener('change',async e=>{
  const file=e.target.files[0]; if(!file||!pendingView) return;
  if(!file.type.startsWith('image/')){renderError('Please upload a photo (JPG, PNG, WebP, or a phone photo your browser can read).');show('screen-result');return;}
  if(file.size>20*1024*1024){renderError('Photo is too large. Use a file under 20MB.');show('screen-result');return;}
  e.target.value='';
  const view=pendingView; pendingView=null;
  track('photo_selected',{view:view});
  const photoURL=URL.createObjectURL(file);
  document.getElementById('scanLetter').textContent=VIEWS.find(v=>v.id===view).letter;
  document.getElementById('aSub').textContent='grading '+VIEWS.find(v=>v.id===view).t.toLowerCase();
  document.getElementById('aStatus').textContent='preparing photo…';
  show('screen-analyse');
  try{
    const data=await analyzeView(view,file);
    if(data.refused){renderRefusal(data.reason);show('screen-result');return;}
    if(data.entitlement && data.entitlement.tier) userTierDisplay=data.entitlement.tier;
    photos[view]=photoURL;
    mergeIntoProfile(view,data);
    viewsDone[view]=true;
    saveState();
    renderViewResult(view,data,photoURL);
    refreshHome();
    show('screen-result');
    replayResultCardAnimation();
  }catch(err){
    if(err && err.locked){handleLocked(err.reason);return;}
    if(err && err.code==='invalid_token'){renderAccessRecovery();show('screen-result');return;}
    if(err && err.code==='rate_limited'){renderRateLimited(err.retryAfter);show('screen-result');return;}
    if(err && err.code==='bot_check'){renderError('We couldn\'t verify you\'re human. Refresh the page and try the scan again.');show('screen-result');return;}
    if(err && err.code==='bad_image'){renderBadImage();show('screen-result');return;}
    if(err && err.message==='image_processing_failed'){renderBadImage();show('screen-result');return;}
    renderError(String(err));show('screen-result');
  }
});

function normaliseToJpeg(file){
  return new Promise((res,rej)=>{
    const url=URL.createObjectURL(file);
    const img=new Image();
    img.onload=()=>{
      try{
        const maxEdge=1600;
        const w=img.naturalWidth||img.width;
        const h=img.naturalHeight||img.height;
        if(!w||!h) throw new Error('bad_dimensions');
        const scale=Math.min(1,maxEdge/Math.max(w,h));
        const outW=Math.max(1,Math.round(w*scale));
        const outH=Math.max(1,Math.round(h*scale));
        const c=document.createElement('canvas');
        c.width=outW;c.height=outH;
        const ctx=c.getContext('2d',{alpha:false});
        ctx.fillStyle='#111';
        ctx.fillRect(0,0,outW,outH);
        ctx.drawImage(img,0,0,outW,outH);
        URL.revokeObjectURL(url);
        const dataUrl=c.toDataURL('image/jpeg',0.86);
        const base64=(dataUrl.split(',')[1]||'');
        if(!base64 || base64.length>5.6*1024*1024) throw new Error('processed_too_large');
        res(base64);
      }catch(e){
        URL.revokeObjectURL(url);
        rej(new Error('image_processing_failed'));
      }
    };
    img.onerror=()=>{URL.revokeObjectURL(url);rej(new Error('image_processing_failed'));};
    img.src=url;
  });
}
async function analyzeView(view,file,retriedToken){
  const image=await normaliseToJpeg(file);
  const media_type="image/jpeg";
  const status=document.getElementById('aStatus');
  if(status) status.textContent='reading image…';
  if(userEmail && !hasFreshEntitlementToken()) await refreshEntitlementToken();
  const headers={"Content-Type":"application/json"};
  if(hasFreshEntitlementToken()) headers.Authorization="Bearer "+entitlementToken;
  let ts_token='';
  if(!hasFreshEntitlementToken() && TURNSTILE_SITE_KEY){
    if(status) status.textContent='quick human check…';
    ts_token=await getTurnstileToken();
    if(status) status.textContent='reading image…';
  }
  const res=await fetch(WORKER_URL,{method:"POST",headers,body:JSON.stringify({region:view,image,media_type,email:userEmail||"",token:entitlementToken||"",ts_token})});
  const data=await res.json().catch(()=>null);
  if(res.status===401 && (!data || data.error==='invalid_token')){
    clearEntitlement();
    if(userEmail && !retriedToken){
      const refreshed=await refreshEntitlementToken();
      if(refreshed) return analyzeView(view,file,true);
    }
    const e=new Error('invalid_token');
    e.code='invalid_token';
    throw e;
  }
  if(res.status===402 && (!data || data.locked || data.error==='payment_required')){
    if(data && (data.reason==='token_stale'||data.reason==='entitlement_inactive') && userEmail){
      clearEntitlement();
      const refreshed=await refreshEntitlementToken();
      if(refreshed) return analyzeView(view,file,true);
    }
    const e=new Error((data&&data.reason)||'locked');
    e.locked=true;
    e.reason=(data&&data.reason)||'locked';
    throw e;
  }
  if(res.status===429){
    const e=new Error('rate_limited');
    e.code='rate_limited';
    e.retryAfter=data&&data.retry_after_seconds;
    throw e;
  }
  if(res.status===403 && data && data.error==='bot_check_failed'){
    const e=new Error('bot_check_failed');
    e.code='bot_check';
    throw e;
  }
  if(res.status===400 && data && (data.reason==='bad_image'||data.reason==='body_too_large'||data.reason==='bad_media_type')){
    const e=new Error('bad_image');
    e.code='bad_image';
    e.reason=data.reason;
    throw e;
  }
  if(!res.ok){const reason=data&&(data.detail||data.error)?(": "+(data.detail||data.error)):"";throw new Error("scan failed ("+res.status+")"+reason);}
  return data;
}

function handleLocked(reason){
  clearEntitlement();
  if(reason==='rescan_requires_pro'){
    showScanUpsell();
    return;
  }
  if(reason==='entitlement_inactive'){
    showToast('Access could not be confirmed. Please unlock again or contact support if you paid.');
  }
  showPaywall();
}

function mergeIntoProfile(view,data){
  const m=data.muscles||{};
  MUSCLES.forEach(k=>{
    const incoming=m[k];
    if(!incoming||incoming.score==null) return;
    const cur=profile[k];
    const better=!cur||(CONF_RANK[incoming.confidence]||0)>(CONF_RANK[cur.confidence]||0);
    if(better) profile[k]={score:incoming.score,confidence:incoming.confidence||'medium',fromView:view};
  });
}

function show(id){
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  window.scrollTo(0,0);
  if(typeof updateMobCta==='function') updateMobCta();
}
function goHome(id){
  show('screen-home');
  setTimeout(()=>{const el=document.getElementById(id);if(el)el.scrollIntoView({behavior:'smooth'});},60);
}
function scoreToGrade(s){if(s>=90)return'S';if(s>=75)return'A';if(s>=61)return'B';if(s>=40)return'C';if(s>=25)return'D';return'E';}
function gradeLabel(g){return{S:'Elite',A:'Advanced',B:'Experienced',C:'Developing',D:'Beginner',E:'Starting Out'}[g[0]]||'';}

let lastBodyfat=null;
// Overall physique score: a 50/50 blend of mass and conditioning, PLUS a "completeness"
// bonus that only rewards being strong at BOTH — so a big-AND-conditioned physique reaches
// S, while excelling at only one trait stays at the blend. Tuned to reference targets:
// monster 90/72 -> 90, lean 54/80 -> 67, shredded 55/90 -> 72, soft-big 85/45 -> 65.
function blendScore(mass, cond){
  if(mass==null && cond==null) return null;
  if(mass==null) return Math.round(cond);
  if(cond==null) return Math.round(mass);
  const bonus=Math.min(12, Math.max(0,mass-78)*Math.max(0,cond-60)*0.0625);
  return Math.min(100, Math.round((mass+cond)/2 + bonus));
}
// ============================================================
//  THE 1–10 DISPLAY SCALE
// ============================================================
// The 0–100 number the worker grades is raw material. It still drives the S–E
// letter and it is never shown. What people read is a 1–10 score given twice:
// once against the general population, once against people who actually train.
// One whole point is one standard deviation, so both numbers say directly how
// far out you are. The gym scale is the harder climb by design — the same
// physique scores lower on it, and its top end is open-class only.
const SCALE_POP_MULT=1.10;   // general population
const SCALE_GYM_MULT=1.05;   // gym-goers — harder
// Both scales work identically: average sits dead centre at 5.0 and one whole
// point is one standard deviation, so any score reads straight off as distance
// from average — 7.3 is 2.3 SD out, and a perfect 10.0 is exactly 5 SD.
// The ONLY difference between the two is the multiplier above: being measured
// against everyone (x1.10) is a slightly easier climb than being measured
// against people who train (x1.05), so the same physique scores a little higher
// and ranks a little rarer on the population side.
// Move either of these and every percentile on the site moves with it.
const SCALE_POP_MEAN=5.0;
const SCALE_GYM_MEAN=5.0;
// How many standard deviations one whole point is worth on each scale. The gym
// scale is the reference: 1 point = 1 SD, so 10.0 is exactly 5 SD out. The
// general population is a tighter cluster — almost everyone is untrained, so the
// same one-point step covers more of the spread — hence 1 point = 1.5 SD there,
// and ranks climb faster against everyone than against people who train.
const SCALE_GYM_SD_PER_POINT=1.0;
const SCALE_POP_SD_PER_POINT=1.1;

// The number both display scales are built from: a flat average of mass and
// conditioning. Deliberately NOT blendScore — the completeness bonus belongs to
// the hidden score and the letter grade, not to the 1–10 someone reads.
function rawBase(mass,cond){
  if(mass==null&&cond==null) return null;
  if(mass==null) return cond;
  if(cond==null) return mass;
  return (mass+cond)/2;
}
// Raw 0–100 → one decimal on the 1–10 scale, capped at a perfect 10.
function toScale(base,mult){
  if(base==null) return null;
  return Math.min(10,Math.round(base*mult)/10);
}
// Rounded values are what people read; the exact ones drive the percentiles, or
// the display rounding alone shifts an average gym-goer off their own median.
function scaleScores(base){
  if(base==null) return null;
  return {
    pop:toScale(base,SCALE_POP_MULT),
    gym:toScale(base,SCALE_GYM_MULT),
    popExact:Math.min(10,base*SCALE_POP_MULT/10),
    gymExact:Math.min(10,base*SCALE_GYM_MULT/10)
  };
}
function fmtScale(v){ return v==null?'—':v.toFixed(1); }

// Normal tail P(X > z). The asymptotic series holds its precision far out where
// the top of the gym scale lives; the polynomial covers the ordinary range.
function normTail(z){
  if(z<0) return 1-normTail(-z);
  const phi=Math.exp(-z*z/2)/Math.sqrt(2*Math.PI);
  if(z>5){const z2=z*z;return phi/z*(1-1/z2+3/(z2*z2)-15/(z2*z2*z2));}
  const t=1/(1+0.2316419*z);
  return phi*t*(0.319381530+t*(-0.356563782+t*(1.781477937+t*(-1.821255978+t*1.330274429))));
}
// Percentile of a 1–10 score inside its own population. Distance from that
// scale's average, converted to standard deviations by its own SD-per-point.
function scalePercentile(v,mean,sdPerPoint){
  if(v==null) return null;
  return (1-normTail((v-mean)*(sdPerPoint==null?1:sdPerPoint)))*100;
}

function computeOverall(){
  const have=MUSCLES.filter(k=>profile[k]);
  if(have.length===0) return null;
  const sizeKeys=have.filter(k=>k!=='conditioning');
  const massAvg=sizeKeys.length?Math.round(sizeKeys.reduce((s,k)=>s+profile[k].score,0)/sizeKeys.length):null;
  const condVal=(profile.conditioning&&profile.conditioning.score!=null)?Math.round(profile.conditioning.score):condFromBodyfat(lastBodyfat,massAvg);
  let avg=blendScore(massAvg,condVal); if(avg==null) avg=0;
  const base=rawBase(massAvg,condVal);
  const missing=MUSCLES.filter(k=>!profile[k]);
  const haveBack=!!profile.back, haveLegs=!!(profile.quads||profile.hamstrings||profile.calves);
  let capScore=avg,capped=false;
  if(!haveBack||!haveLegs){const c=Math.min(avg,67);capped=c<avg;capScore=c;}
  // The ceiling has to bite on the numbers people actually read, or "grade
  // capped" means nothing to them.
  const capBase=capped?Math.min(base==null?0:base,67):base;
  return{avg,capScore,base,capBase,scores:scaleScores(capBase),grade:scoreToGrade(capScore),missing,capped,haveBack,haveLegs,nViews:Object.keys(viewsDone).length};
}

// Real usage counters, served by the worker's own stats action. The markup ships
// with the last verified figures, so the numbers are never blank and never
// invented — a failed fetch simply leaves those in place.
const STATS_FALLBACK={scans:1050,people:800};
function paintStats(s){
  document.querySelectorAll('[data-stat]').forEach(el=>{
    const n=s[el.getAttribute('data-stat')];
    if(Number.isFinite(n)&&n>0) el.textContent=n.toLocaleString('en-GB')+'+';
  });
}
function loadPublicStats(){
  if(!WORKER_URL) return;
  fetch(WORKER_URL,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({action:'stats'})})
    .then(r=>r.ok?r.json():null)
    .then(d=>{
      if(!d) return;
      // Never display less than the verified baseline, whatever the counters say.
      paintStats({
        scans:Math.max(STATS_FALLBACK.scans,Number(d.scans)||0),
        people:Math.max(STATS_FALLBACK.people,Number(d.people)||0)
      });
    })
    .catch(()=>{});
}

function refreshHome(){
  const hl=document.getElementById('histLink');
  if(hl) hl.style.display=hasEntitlementHint()?'inline-block':'none';
  const pl=document.getElementById('progLink');
  if(pl) pl.style.display=hasEntitlementHint()?'inline-block':'none';
  const il=document.getElementById('impLink');
  if(il) il.style.display=hasEntitlementHint()?'inline-block':'none';
  const scansUsed=Object.keys(viewsDone).length;
  VIEWS.forEach(v=>{
    const tile=document.getElementById('vt-'+v.id);
    const isDone=!!viewsDone[v.id];
    const isLocked=!hasEntitlementHint() && scansUsed>=1 && !isDone;
    tile.classList.toggle('done',isDone);
    tile.classList.toggle('pay-locked',isLocked);
  });
  const o=computeOverall();
  const g=document.getElementById('ov-grade'),sc=document.getElementById('ov-score'),
        cta=document.getElementById('ov-cta'),see=document.getElementById('ov-see');
  if(!o){g.textContent='—';g.className='g locked';sc.textContent='';cta.textContent='Scan an angle to start building your grade.';see.style.display='none';return;}
  g.textContent=o.grade;g.className='g';
  sc.textContent=o.scores?(fmtScale(o.scores.gym)+'/10 gym · '+fmtScale(o.scores.pop)+'/10 overall'):'';
  see.style.display='inline-block';
  if(o.missing.length){
    const nm=!o.haveBack?'back':(!o.haveLegs?'legs':o.missing[0]);
    cta.innerHTML='Grade capped while parts stay hidden. <b>Scan your '+nm+'</b> to raise the ceiling.';
  } else { cta.textContent='Full profile — every region covered.'; }
}

function replayResultCardAnimation(){
  const card=document.querySelector('#resultBody .vc');
  if(!card) return;
  card.classList.remove('vc-result-reveal');
  void card.offsetWidth;
  card.classList.add('vc-result-reveal');
  if(navigator.vibrate) navigator.vibrate([24,18,18]);
}

// ============================================================
//  RESULT RENDERING
// ============================================================
function renderViewResult(view,data,photoURL){
  const m=data.muscles||{};
  const seen=MUSCLES.filter(k=>m[k]&&m[k].score!=null);

  // Overall = mass/conditioning blend + completeness bonus (see blendScore / computeOverall).
  lastBodyfat=data.bodyfat_range||lastBodyfat;
  const _sizeKeys=seen.filter(k=>k!=='conditioning');
  const _massAvg=_sizeKeys.length?Math.round(_sizeKeys.reduce((s,k)=>s+m[k].score,0)/_sizeKeys.length):null;
  const _cond=(m['conditioning']&&m['conditioning'].score!=null)?Math.round(m['conditioning'].score):condFromBodyfat(data.bodyfat_range,_massAvg);
  const viewAvg=blendScore(_massAvg,_cond);
  const viewBase=rawBase(_massAvg,_cond);
  const viewScores=scaleScores(viewBase);
  const viewGrade=viewAvg!=null?scoreToGrade(viewAvg):'—';

  // Muscle reads are the raw grade on the same 1–10 scale, with no population
  // multiplier — that gap is exactly why the headline sits above them.
  let muscleRows='';
  seen.forEach((k,i)=>{const v=m[k];
    muscleRows+='<div class="vc-muscle">'+
      '<span class="vc-muscle-name">'+cap(k)+'</span>'+
      '<div class="vc-muscle-track"><div class="vc-muscle-fill" style="width:'+v.score+'%;animation-delay:'+(.12+i*.06)+'s"></div></div>'+
      '<span class="vc-muscle-val">'+(v.score/10).toFixed(1)+'</span>'+
    '</div>';});

  const cardId=makeCardId();
  const bf=hasEntitlementHint()?esc(data.bodyfat_range||'Not estimated'):'Paid audit';
  const viewName=VIEWS.find(v=>v.id===view).t.toUpperCase();
  const photoLayer=photoURL?'<div class="vc-photo" style="background-image:url('+photoURL+')"></div>':'';
  const focusHTML=buildFocusHTML(data);

  const o=computeOverall();
  const tease=o?o.grade:(viewGrade!=='—'?viewGrade:'?');

  const gateHTML=hasAccount()?'':
    '<div class="gate-overlay" id="gateDiv">'+
      '<div class="gate-grade-tease">'+tease+'</div>'+
      '<div class="gate-ready-pill"><div class="gate-ready-dot"></div>Result generated</div>'+
      '<h3>Your grade is ready.</h3>'+
      '<p>Enter your email to view it. It links this result and any purchase so access can be restored — that\'s the whole account.</p>'+
      '<input class="gate-input" type="email" id="gateEmail" placeholder="your@email.com" autocomplete="email" inputmode="email" enterkeyhint="go" aria-label="Email address" onkeydown="if(event.key===\'Enter\')submitGate()">'+
      '<label class="gate-consent"><input type="checkbox" id="gateConsent" checked> Email me physique tips and updates. No spam, unsubscribe anytime.</label>'+
      '<button class="btn" onclick="submitGate()">Show my grade →</button>'+
      // The moment a stranger is asked for an email is the moment they need the
      // limits restated — not buried in a policy they will not open.
      '<div class="gate-fine">No card · no password · unsubscribe anytime</div>'+
      '<div class="gate-fine">Photo already graded and not stored by Callout-AI · <a onclick="openModal(\'privacyModal\')">privacy</a></div>'+
    '</div>';
  track('scan_result',{view:view,grade:viewGrade,paid:hasEntitlementHint()});
  if(!hasAccount()) track('gate_shown',{view:view});

  document.getElementById('resultBody').innerHTML=
    '<div class="vc result-vc vc-result-reveal grade-'+(viewGrade!=='—'?viewGrade:'C')+(hasAccount()?'':' blurred')+'">'+
      '<div class="vc-stripe"></div>'+
      photoLayer+
      '<div class="vc-inner">'+
        '<div class="vc-header">'+
          '<span class="vc-brand-tag">Callout-AI</span>'+
          '<span class="vc-badge">'+viewName+' VIEW</span>'+
        '</div>'+
        '<div class="vc-scorehero">'+
          '<div class="vc-score-big">'+(viewScores?fmtScale(viewScores.gym):'—')+'<span class="vc-score-max">/10</span></div>'+
          '<div class="vc-score-cap">vs gym-goers</div>'+
          (viewScores?'<div class="vc-score-alt"><span class="vc-score-alt-n">'+fmtScale(viewScores.pop)+'</span><span class="vc-score-alt-l">vs everyone</span></div>':'')+
          '<div class="vc-score-meta">'+
            (viewGrade!=='—'?'<span class="m-grade">'+viewGrade+' · '+gradeLabel(viewGrade)+'</span>':'')+
            (hasEntitlementHint()&&data.bodyfat_range?'<span class="m-sep">·</span><span class="m-bf">'+esc(data.bodyfat_range)+' BF</span>':'')+
          '</div>'+
        '</div>'+
        '<div class="vc-footer">'+
          '<span class="vc-serial">'+cardId+'</span>'+
          '<span class="vc-site">callout-ai.com</span>'+
          '<span class="vc-certified">AI ESTIMATE</span>'+
        '</div>'+
      '</div>'+
      gateHTML+
    '</div>'+
    buildRankHTML(viewBase,viewGrade)+
    buildMassCondHTML(m,seen,viewGrade,data.bodyfat_range)+
    ((data.verdict||data.strongest_visible_area||data.weakest_visible_area||data.next_focus)?
      '<div class="res-analysis grade-'+(viewGrade!=='—'?viewGrade:'C')+(hasAccount()?'':' blurred')+'">'+
        '<div class="res-sec-eyebrow">The analysis</div>'+
        (data.verdict?'<div class="res-verdict">"'+esc(data.verdict)+'"</div>':'')+
        ((data.strongest_visible_area||data.weakest_visible_area||data.next_focus)?
          '<div class="res-cards">'+
            (data.strongest_visible_area?'<div class="res-card"><div class="res-card-lbl str">Strength</div><div class="res-card-val">'+esc(data.strongest_visible_area)+'</div></div>':'')+
            (data.weakest_visible_area?'<div class="res-card"><div class="res-card-lbl weak">Weakness</div><div class="res-card-val">'+esc(data.weakest_visible_area)+'</div></div>':'')+
            (data.next_focus?'<div class="res-card"><div class="res-card-lbl focus">Main focus</div><div class="res-card-val">'+esc(data.next_focus)+'</div></div>':'')+
          '</div>':'')+
      '</div>':'')+
    (seen.length?
      '<div class="vc-breakdown-below grade-'+(viewGrade!=='—'?viewGrade:'C')+(hasAccount()?'':' blurred')+'">'+
        '<div class="vc-section-title">Breakdown — '+viewName+' view</div>'+muscleRows+
      '</div>'
      :'<div class="vc-details-below grade-'+(viewGrade!=='—'?viewGrade:'C')+(hasAccount()?'':' blurred')+'"><div class="vc-cap" style="margin:0">This view didn\'t clearly show a gradeable region. Try better lighting or framing.</div></div>')+
    buildUpsellHTML();

  const btn=document.getElementById('resPrimary');
  if(!hasAccount()){
    btn.style.display='none';
    setTimeout(()=>{const gate=document.getElementById('gateEmail');if(gate)gate.scrollIntoView({behavior:'smooth',block:'center'});},400);
  } else {
    btn.style.display='block';
    configurePrimaryBtn(computeOverall());
    injectShareMoment(viewGrade, viewScores?viewScores.gym:0);
    // Pro block (rendered inline for all non-Pro users) is the upsell now.
  }
}

function configurePrimaryBtn(o){
  const btn=document.getElementById('resPrimary');
  if(!btn) return;
  btn.style.display='block';
  if(o && o.missing.length===0 && hasEntitlementHint()){
    btn.textContent='See your full grade →';
    btn.onclick=showOverall;
  } else {
    btn.textContent='← Back to scans';
    btn.onclick=()=>show('screen-home');
  }
}

// ============================================================
//  GATE SUBMIT
// ============================================================
function submitGate(){
  const inp=document.getElementById('gateEmail');
  const email=(inp&&inp.value||'').trim();
  if(!email||!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)){
    if(inp){inp.classList.add('err');setTimeout(()=>inp.classList.remove('err'),400);}
    return;
  }

  userEmail=email;
  saveState();
  track('gate_submit');
  // Capture the signup as a lead (fire-and-forget — never block the reveal).
  // The email is always stored; the checkbox only sets the marketing-consent flag.
  try{
    const wantsMarketing=!!(document.getElementById('gateConsent')||{}).checked;
    fetch(WORKER_URL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'subscribe',email:email,consent:wantsMarketing})}).catch(()=>{});
  }catch(e){}
  refreshEntitlementToken().then(refreshHome).catch(()=>{});

  // unblur the card AND the detail/breakdown panels below it
  document.querySelectorAll('#resultBody .vc, #resultBody .res-rank, #resultBody .res-mc, #resultBody .res-analysis, #resultBody .vc-details-below, #resultBody .vc-breakdown-below')
    .forEach(el=>el.classList.remove('blurred'));

  const gate=document.getElementById('gateDiv');
  if(gate) gate.remove();

  const o=computeOverall();
  configurePrimaryBtn(o);

  injectShareMoment(o?o.grade:(document.querySelector('.vc-grade-letter')||{}).textContent||'?', (o&&o.scores)?o.scores.gym:0);

  if(!hasEntitlementHint()) injectUpsell();

  refreshHome();
  showToast('Grade revealed. No take-backs.');
}

// ============================================================
//  SCAN UPSELL — shown when scan-tier user tries to rescan
//  after completing all 4 views
// ============================================================
function showScanUpsell(){
  track('upsell_shown',{mode:'rescan_pro'});
  document.getElementById('resultBody').innerHTML=
    '<div class="refuse" style="padding:20px 0 12px">'+
      '<h2 style="margin-bottom:8px">This angle\'s already graded.</h2>'+
      '<p>Your audit covers each angle once — any you haven\'t scanned are still included. Rescanning an angle to see if the grade moved is what Pro is for.</p>'+
    '</div>';
  const btn=document.getElementById('resPrimary');
  btn.style.display='none';
  const old=document.getElementById('upsellPanel'); if(old) old.remove();
  const div=document.createElement('div');
  div.id='upsellPanel';
  div.className='upsell';
  div.innerHTML=
    '<div class="us-eye">Scan complete</div>'+
    '<h3>Rescan any angle, any time.</h3>'+
    '<p class="us-p">After the cut, the bulk, the PR — rescan, compare side by side, and let Improve audit your training and diet against the result.</p>'+
    '<div class="upsell-price">£9.99</div>'+
    '<div class="upsell-price-sub">PER MONTH · CANCEL ANYTIME</div>'+
    '<button class="btn gold-btn" onclick="handlePurchase(\'pro\')">Go Pro →</button>'+
    '<span style="font-size:13px;color:rgba(255,255,255,0.35);cursor:pointer;display:block;text-align:center;margin-top:12px;text-decoration:underline" onclick="show(\'screen-home\')">Not now</span>';
  const ref=document.getElementById('resPrimary');
  if(ref) ref.parentNode.insertBefore(div,ref);
  show('screen-result');
}

// ============================================================
//  PAYWALL — shown when trying to scan a 2nd+ view unpaid
// ============================================================
function showPaywall(){
  track('paywall_shown');
  document.getElementById('resultBody').innerHTML=
    '<div class="refuse" style="padding:20px 0 12px">'+
      '<h2 style="margin-bottom:8px">One angle is free.</h2>'+
      '<p>That was the free one. The other three angles are £5.99, once.</p>'+
    '</div>';
  const btn=document.getElementById('resPrimary');
  btn.style.display='none';
  const old=document.getElementById('upsellPanel'); if(old) old.remove();
  injectUpsell(true);
  show('screen-result');
}

// ============================================================
//  SHARE MOMENT
// ============================================================
function injectShareMoment(grade, score){
  const old=document.getElementById('shareMoment'); if(old) old.remove();
  const div=document.createElement('div');
  div.id='shareMoment';
  div.className='share-moment';
  div.innerHTML=
    '<div class="sm-eye">You\'ve been called out</div>'+
    '<h3>Post your grade.</h3>'+
    '<p>Tag the friend who needs humbling.</p>'+
    '<button class="share-btn-big" onclick="shareGrade(\''+grade+'\','+score+',true)">'+
      '<svg viewBox="0 0 24 24"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>'+
      'Share my '+grade+' grade →'+
    '</button>'+
    '<span class="sm-skip" onclick="this.closest(\'.share-moment\').remove()">Maybe later</span>';
  const ref=document.getElementById('resPrimary');
  if(ref) ref.parentNode.insertBefore(div,ref);
}

// ============================================================
//  UPSELL PANEL
// ============================================================
function injectUpsell(paywallMode){
  const old=document.getElementById('upsellPanel'); if(old) old.remove();
  track('upsell_shown',{mode:paywallMode?'paywall':'post_result'});

  const title  = paywallMode
    ? 'Free scan used. Your real grade needs all four angles.'
    : 'One angle isn\'t the full picture.';
  const sub    = paywallMode
    ? 'Back and legs are where most people drop — and where most people avoid the camera. That\'s the point. £5.99. One time. No subscription.'
    : 'One good angle can lie. Back and legs usually tell the part of the story people avoid.';

  const div=document.createElement('div');
  div.id='upsellPanel';
  div.className='upsell';
  div.innerHTML=
    '<div class="us-eye">One angle isn\'t the full picture</div>'+
    '<h3>'+title+'</h3>'+
    '<p class="us-p">'+sub+'</p>'+
    '<ul class="upsell-feats">'+
      '<li>All 4 views graded: Front, Back, Legs, Arms</li>'+
      '<li>Uncapped overall grade</li>'+
      '<li>Full muscle-by-muscle breakdown</li>'+
      '<li>Conditioning notes and broad body-fat estimate where visible</li>'+
    '</ul>'+
    '<div class="upsell-price">'+UNLOCK_PRICE+'</div>'+
    '<div class="upsell-price-sub">ONE-TIME · YOURS FOREVER</div>'+
    '<button class="btn gold-btn" onclick="handlePurchase(\'scan\')">See my real grade →</button>'+
    '<button class="recover-link" style="display:block;margin:12px auto 0" onclick="openRecoveryModal()">Already paid?</button>'+
    '<span style="font-size:13px;color:rgba(255,255,255,0.35);cursor:pointer;display:block;text-align:center;margin-top:12px;text-decoration:underline" onclick="show(\'screen-home\')">Not now</span>';

  const ref=document.getElementById('resPrimary');
  if(ref) ref.parentNode.insertBefore(div,ref);
}

// ============================================================
//  PURCHASE HANDLER
// ============================================================
function handlePurchase(tier){
  const links={
    scan:     PAYMENT_LINK_SCAN,
    pro:      PAYMENT_LINK_PRO,
    lifetime: PAYMENT_LINK_LIFETIME
  };
  const url=links[tier]||PAYMENT_LINK_SCAN;
  track('checkout_start',{tier:tier,transport_type:'beacon'});
  if(url){
    sessionStorage.setItem('callout_checkout_started','1');
    window.location.href=url;
    return;
  }
  renderError('Checkout is not configured yet. Please contact support@callout-ai.com.');
  show('screen-result');
}

function showConfirmScreen(){
  const sub=document.querySelector('#confirmBody .confirm-sub');
  if(sub) sub.textContent='Access confirmed'+(userTierDisplay?' · '+tierDisplayLabel(userTierDisplay):'')+'. Scan your remaining angles.';
  const anglesHTML=VIEWS.map(v=>{
    const done=!!viewsDone[v.id];
    return '<button class="confirm-angle-btn'+(done?' done-angle':'')+'" '+
      (done?'disabled':('onclick="show(\'screen-home\');pick(\''+v.id+'\')"'))+'>'+
      '<span class="confirm-angle-letter">'+v.letter+'</span>'+
      '<span class="confirm-angle-info">'+
        '<span class="confirm-angle-name">'+v.t+'</span>'+
        '<span class="confirm-angle-desc">'+v.d+'</span>'+
      '</span>'+
      '<span class="confirm-angle-status '+(done?'done':'pending')+'">'+(done?'✓ done':'Scan →')+'</span>'+
    '</button>';
  }).join('');
  document.getElementById('confirmAngles').innerHTML=anglesHTML;
  refreshHome();
  show('screen-confirm');
}

// ============================================================
//  SHARE
// ============================================================
function shareGrade(grade, score, fromMoment){
  track('share_click',{grade:grade,score:score,surface:fromMoment?'share_moment':'overall'});
  const text='I just got called out. '+grade+'-tier, '+score+'/10 against people who actually train, on Callout-AI — the AI that grades your physique. No flattery. Get your verdict: '+(location.origin+location.pathname);
  if(navigator.share){
    navigator.share({title:'My Callout-AI Grade',text,url:location.origin+location.pathname})
      .then(()=>{ if(fromMoment){ const m=document.getElementById('shareMoment'); if(m) m.remove(); }})
      .catch(()=>{});
  } else {
    navigator.clipboard.writeText(text)
      .then(()=>{
        showToast('Copied to clipboard!');
        if(fromMoment){ setTimeout(()=>{ const m=document.getElementById('shareMoment'); if(m) m.remove(); },1200); }
      })
      .catch(()=>showToast('Share: '+(location.origin+location.pathname)));
  }
}

// ============================================================
//  OVERALL SCREEN
// ============================================================
function showOverall(){
  const o=computeOverall();
  if(!o){show('screen-home');return;}
  track('overall_viewed',{grade:o.grade,views:o.nViews});

  let muscleRows='';
  MUSCLES.forEach((k,i)=>{
    const p=profile[k];const na=!p;
    muscleRows+='<div class="vc-muscle'+(na?' vc-muscle-na':'')+'">'+
      '<span class="vc-muscle-name">'+cap(k)+'</span>'+
      '<div class="vc-muscle-track"><div class="vc-muscle-fill" style="width:'+(na?100:p.score)+'%;animation-delay:'+(.1+i*.045)+'s"></div></div>'+
      '<span class="vc-muscle-val">'+(na?'—':(p.score/10).toFixed(1))+'</span>'+
    '</div>';});

  const cardId=makeCardId();
  const heroPhoto=photos.front||photos.arms_side||photos.back||photos.legs||null;
  const photoLayer=heroPhoto?'<div class="vc-photo" style="background-image:url('+heroPhoto+')"></div>':'';
  const capHTML=o.capped?
    '<div class="vc-cap">⚠ Grade capped — '+
      (!o.haveBack?'no back view':'')+((!o.haveBack&&!o.haveLegs)?' and ':'')+(!o.haveLegs?'no legs view':'')+
      '. Unlock to remove the ceiling.</div>':'';

  document.getElementById('overallBody').innerHTML=
    '<div class="vc overall-vc grade-'+o.grade+'">'+
      '<div class="vc-stripe"></div>'+
      photoLayer+
      '<div class="vc-inner">'+
        '<div class="vc-header">'+
          '<span class="vc-brand-tag">Callout-AI</span>'+
          '<span class="vc-badge">'+o.nViews+' VIEW'+(o.nViews!==1?'S':'')+' · OVERALL</span>'+
        '</div>'+
        '<div class="vc-grade-section">'+
          '<div class="vc-grade-letter">'+o.grade+'</div>'+
          '<div class="vc-grade-label">'+gradeLabel(o.grade)+' Lifter</div>'+
        '</div>'+
        '<div class="vc-strip four">'+
          '<div><div class="vc-strip-val">'+(o.scores?fmtScale(o.scores.gym):'—')+'</div><div class="vc-strip-lbl">vs gym</div></div>'+
          '<div class="vc-strip-div"></div>'+
          '<div><div class="vc-strip-val">'+(o.scores?fmtScale(o.scores.pop):'—')+'</div><div class="vc-strip-lbl">vs all</div></div>'+
          '<div class="vc-strip-div"></div>'+
          '<div><div class="vc-strip-val">'+(o.missing.length===0?'FULL':o.missing.length+' left')+'</div><div class="vc-strip-lbl">Profile</div></div>'+
          '<div class="vc-strip-div"></div>'+
          '<div><div class="vc-strip-val">'+o.nViews+'/4</div><div class="vc-strip-lbl">Views</div></div>'+
        '</div>'+
        capHTML+
        '<div class="vc-section-title">Full muscle breakdown</div>'+
        muscleRows+
        '<div class="vc-footer">'+
          '<span class="vc-serial">'+cardId+'</span>'+
          '<span class="vc-site">callout-ai.com</span>'+
          '<span class="vc-certified">AI ESTIMATE</span>'+
        '</div>'+
      '</div>'+
    '</div>';

  const backBtn=document.getElementById('overallBack');
  ['overallShareRow','overallUpsell'].forEach(id=>{const el=document.getElementById(id);if(el)el.remove();});
  backBtn.style.display='block';

  // Share row
  const shareRow=document.createElement('div');
  shareRow.id='overallShareRow'; shareRow.className='share-row';
  shareRow.innerHTML=
    '<button class="btn ghost" onclick="shareGrade(\''+o.grade+'\','+((o.scores)?o.scores.gym:0)+')" style="display:flex;align-items:center;justify-content:center;gap:8px">'+
      '<svg viewBox="0 0 24 24" style="width:16px;height:16px;stroke:currentColor;stroke-width:2;fill:none"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>'+
      'Share my grade'+
    '</button>';
  backBtn.parentNode.insertBefore(shareRow,backBtn);

  if(!hasEntitlementHint()){
    const upsellDiv=document.createElement('div');
    upsellDiv.id='overallUpsell'; upsellDiv.className='upsell';
    upsellDiv.innerHTML=
      '<div class="us-eye">Your grade isn\'t complete yet</div>'+
      '<h3>See your true overall grade</h3>'+
      '<p class="us-p">A full audit needs the remaining angles. Unlock the one-time Full Body Audit to complete it.</p>'+
      '<div class="upsell-price">'+UNLOCK_PRICE+'</div>'+
      '<div class="upsell-price-sub">ONE-TIME · ALL 4 VIEWS</div>'+
      '<button class="btn gold-btn" onclick="handlePurchase(\'scan\')">Unlock the Full Body Audit →</button>'+
      '<button class="btn ghost" style="margin-top:8px" onclick="show(\'screen-home\')">Back to scans</button>';
    backBtn.parentNode.insertBefore(upsellDiv,backBtn);
    backBtn.style.display='none';
  }

  show('screen-overall');
  // Trigger cinematic reveal
  requestAnimationFrame(()=>requestAnimationFrame(playRevealAnimation));
}

// ============================================================
//  REFUSAL / ERROR RENDERING
// ============================================================
function renderAccessRecovery(){
  document.getElementById('resultBody').innerHTML=
    '<div class="refuse"><div class="big"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.01"/></svg></div>'+
    '<h2>Access needs refreshing</h2>'+
    '<p>Your secure access token expired or could not be verified. We can try restoring it from your email, or you can unlock again if this email has no paid access.</p></div>'+
    '<div class="upsell" style="margin-top:18px">'+
      '<button class="btn gold-btn" onclick="attemptAccessRecovery()">Restore access</button>'+
      '<button class="btn ghost" style="margin-top:8px" onclick="showPaywall()">Unlock Full Body Audit</button>'+
      '<button class="btn ghost" style="margin-top:8px" onclick="show(\'screen-home\')">Back to scans</button>'+
    '</div>';
  const btn=document.getElementById('resPrimary');
  btn.style.display='none';
}

async function attemptAccessRecovery(){
  const ok=await refreshEntitlementToken();
  if(ok){
    showToast('Access restored. Try the scan again.');
    refreshHome();
    show('screen-home');
    return;
  }
  // Silent restore failed — verify ownership with an email code instead.
  openRecoveryModal();
}

function renderRateLimited(retryAfter){
  track('scan_rate_limited');
  const mins=retryAfter?Math.max(1,Math.ceil(retryAfter/60)):null;
  document.getElementById('resultBody').innerHTML=
    '<div class="refuse"><div class="big"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.01"/></svg></div>'+
    '<h2>Scan limit reached</h2>'+
    '<p>Too many scans were requested from this account or connection. '+(mins?'Try again in about '+mins+' minutes.':'Please try again later.')+'</p></div>';
  const btn=document.getElementById('resPrimary');
  btn.style.display='block';btn.textContent='← Back';btn.onclick=()=>show('screen-home');
}

function renderBadImage(){
  track('scan_bad_image');
  document.getElementById('resultBody').innerHTML=
    '<div class="refuse"><div class="big"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.01"/></svg></div>'+
    '<h2>Upload did not pass checks</h2><p>Please re-upload a clear JPG, PNG, or WebP image under the size limit. Avoid screenshots, edited files, or unsupported formats.</p></div>';
  const btn=document.getElementById('resPrimary');
  btn.style.display='block';btn.textContent='← Try again';btn.onclick=()=>show('screen-home');
}

function renderPaymentRecovery(){
  document.getElementById('resultBody').innerHTML=
    '<div class="refuse"><div class="big"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M9 12l2 2 4-5"/></svg></div>'+
    '<h2>Payment received?</h2>'+
    '<p>Stripe sent you back without a checkout session ID, so Callout-AI cannot unlock access from the URL. Enter the checkout email and we will restore access from the server if there is an active purchase.</p>'+
    '<button class="btn gold-btn" onclick="openRecoveryModal()">Restore access →</button>'+
    '<p style="font-size:12px;color:var(--faint);line-height:1.5;margin-top:14px">Still stuck? support@callout-ai.com</p></div>';
  const btn=document.getElementById('resPrimary');
  btn.style.display='block';btn.textContent='← Back';btn.onclick=()=>show('screen-home');
}

function renderRefusal(reason){
  track('scan_refused',{reason:reason||''});
  const msg=reason==='age'
    ?{h:"We can't grade this one",p:"Callout-AI is adults only, and we can only assess photos where the subject is clearly 18 or over."}
    :reason==='unclear_subject'
    ?{h:"Couldn't tell who to grade",p:"There seem to be multiple people. Use a photo where one person is clearly the subject."}
    :{h:"Couldn't read this view",p:"Need a clear, well-lit photo of an adult — shorts only, full region in frame, plain background."};
  document.getElementById('resultBody').innerHTML=
    '<div class="refuse"><div class="big"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.01"/></svg></div>'+
    '<h2>'+msg.h+'</h2><p>'+msg.p+'</p></div>';
  const btn=document.getElementById('resPrimary');
  btn.style.display='block';btn.textContent='← Try again';btn.onclick=()=>show('screen-home');
}
function renderError(detail){
  track('scan_error');
  document.getElementById('resultBody').innerHTML=
    '<div class="refuse"><div class="big"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.01"/></svg></div>'+
    '<h2>Scan failed</h2><p>'+esc(detail)+'</p></div>';
  const btn=document.getElementById('resPrimary');
  btn.style.display='block';btn.textContent='← Back';btn.onclick=()=>show('screen-home');
}

// ============================================================
//  TOAST
// ============================================================
function showToast(msg){
  const t=document.getElementById('toast');
  t.textContent=msg; t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'),2800);
}

let recoveryStage='email';
function handleAuthLink(){
  try{
    const qs=new URLSearchParams(location.search);
    const rc=(qs.get('rc')||'').trim(), re=(qs.get('re')||'').trim();
    if(!/^\d{6}$/.test(rc)||!re) return;
    history.replaceState(null,'',location.pathname);
    openRecoveryModal();
    const e=document.getElementById('recoveryEmail');
    const c=document.getElementById('recoveryCode');
    const btn=document.getElementById('recoverySubmit');
    if(e) e.value=re;
    recoveryStage='code';
    if(c){c.style.display='block';c.value=rc;}
    if(btn) btn.textContent='Verify code';
    submitRecoveryCode();
  }catch(err){}
}
window.addEventListener('DOMContentLoaded',handleAuthLink);
function openRecoveryModal(){
  const input=document.getElementById('recoveryEmail');
  const codeInput=document.getElementById('recoveryCode');
  const btn=document.getElementById('recoverySubmit');
  const status=document.getElementById('recoveryStatus');
  recoveryStage='email';
  if(input) input.value=userEmail||'';
  if(codeInput){codeInput.value='';codeInput.style.display='none';}
  if(btn) btn.textContent='Restore access';
  if(status){status.textContent='';status.className='recovery-status';}
  openModal('recoveryModal');
  setTimeout(()=>{if(input) input.focus();},80);
}

async function submitRecoveryEmail(){
  if(recoveryStage==='code') return submitRecoveryCode();
  const input=document.getElementById('recoveryEmail');
  const btn=document.getElementById('recoverySubmit');
  const status=document.getElementById('recoveryStatus');
  const email=(input&&input.value||'').trim();
  if(!email||!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)){
    if(status){status.textContent='Enter the email used at checkout.';status.className='recovery-status err';}
    return;
  }
  if(btn) btn.disabled=true;
  if(status){status.textContent='Checking purchase status…';status.className='recovery-status';}
  try{
    // Legacy mode answers with a token directly; magic-link mode answers
    // code_required, and we then explicitly ask for a code email.
    const res=await fetch(WORKER_URL,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'issue_token',email})
    });
    const data=await res.json().catch(()=>null);
    if(res.ok && data && data.active && data.token){
      storeEntitlement(data);
      refreshHome();
      track('recovery_success',{tier:data.tier||''});
      if(status){status.textContent='Access restored.';status.className='recovery-status ok';}
      showToast('Paid access restored.');
      setTimeout(()=>{closeModal('recoveryModal');showConfirmScreen();},450);
      return;
    }
    if(data && data.code_required){
      const sent=await fetch(WORKER_URL,{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({action:'request_code',email})
      });
      const sdata=await sent.json().catch(()=>null);
      if(sent.status===429){
        if(status){status.textContent='Too many attempts today. Try again later, or email support@callout-ai.com.';status.className='recovery-status err';}
        return;
      }
      if(!sent.ok){
        if(status){status.textContent=(sdata&&sdata.message)||'Could not send the code. Contact support@callout-ai.com.';status.className='recovery-status err';}
        return;
      }
      userEmail=email; saveState();
      recoveryStage='code';
      const codeInput=document.getElementById('recoveryCode');
      if(codeInput){codeInput.style.display='block';setTimeout(()=>codeInput.focus(),60);}
      if(btn) btn.textContent='Verify code';
      if(status){status.textContent='If this email has an active purchase, a 6-digit code is on its way. Enter it above — it expires in 15 minutes.';status.className='recovery-status';}
      track('recovery_code_requested');
      return;
    }
    if(res.status===429){
      if(status){status.textContent='Too many attempts today. Try again later.';status.className='recovery-status err';}
      return;
    }
    track('recovery_failed');
    clearEntitlement();
    userEmail=email;
    saveState();
    if(status){status.textContent='No active purchase found for that email. For help, contact support@callout-ai.com.';status.className='recovery-status err';}
  }catch(e){
    if(status){status.textContent='Could not check purchase status. Try again, or contact support@callout-ai.com.';status.className='recovery-status err';}
  }finally{
    if(btn) btn.disabled=false;
  }
}

async function submitRecoveryCode(){
  const codeInput=document.getElementById('recoveryCode');
  const btn=document.getElementById('recoverySubmit');
  const status=document.getElementById('recoveryStatus');
  const email=((document.getElementById('recoveryEmail')||{}).value||'').trim();
  const code=(codeInput&&codeInput.value||'').trim();
  if(!/^\d{6}$/.test(code)){
    if(status){status.textContent='Enter the 6-digit code from the email.';status.className='recovery-status err';}
    return;
  }
  if(btn) btn.disabled=true;
  if(status){status.textContent='Verifying code…';status.className='recovery-status';}
  try{
    const res=await fetch(WORKER_URL,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'redeem_code',email,code})
    });
    const data=await res.json().catch(()=>null);
    if(res.ok && data && data.active && data.token){
      storeEntitlement(data);
      refreshHome();
      track('recovery_success',{tier:data.tier||'',method:'code'});
      if(status){status.textContent='Access restored on this device.';status.className='recovery-status ok';}
      showToast('Paid access restored.');
      setTimeout(()=>{closeModal('recoveryModal');showConfirmScreen();},450);
      return;
    }
    if(res.ok && data && data.active===false){
      if(status){status.textContent='No active purchase found for that email.';status.className='recovery-status err';}
      return;
    }
    if(status){status.textContent='Code invalid or expired. Re-enter your email to get a new one.';status.className='recovery-status err';}
    recoveryStage='email';
    const b=document.getElementById('recoverySubmit'); if(b) b.textContent='Restore access';
  }catch(e){
    if(status){status.textContent='Could not verify the code. Try again.';status.className='recovery-status err';}
  }finally{
    if(btn) btn.disabled=false;
  }
}

function makeCardId(){
  const c='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id='CO-';for(let i=0;i<8;i++){if(i===4)id+='-';id+=c[Math.floor(Math.random()*c.length)];}
  return id;
}

function buildFocusHTML(data){
  // The callout block: WEAKNESS + NEXT GOAL, front and centre. Strongest
  // area lives in the verdict's voice, not as a stat row.
  const rows=[
    ['weak','Weakness',data.weakest_visible_area],
    ['next','Next goal',data.next_focus]
  ].filter(r=>r[2]);
  if(!rows.length) return '';
  return '<div class="vc-call">'+rows.map(r=>
    '<div class="vc-call-row"><span class="vc-call-lbl '+r[0]+'">'+esc(r[1])+'</span><span class="vc-call-val">'+esc(r[2])+'</span></div>'
  ).join('')+'</div>';
}

// Both scales now print real rarity. The only ceiling is reality: once the
// modelled figure passes the number of people alive there is nobody left to be
// rarer than, so "1 in N" stops describing anything and we say so instead.
const WORLD_POP=8.2e9;
const RANK_FLOOR_GYM=100/WORLD_POP;
const RANK_FLOOR_POP=100/WORLD_POP;
// Format "top X%" — integers for the common case, decimals as the tail thins out.
function fmtTop(pct,floor){
  const t=Math.max(floor==null?RANK_FLOOR_GYM:floor,100-pct);
  if(t>=10) return ''+Math.round(t);
  if(t>=1)  return ''+(Math.round(t*10)/10);
  if(t>=0.1)  return ''+(Math.round(t*100)/100);
  if(t>=0.01) return ''+(Math.round(t*1000)/1000);
  return ''+Number(t.toPrecision(1));
}
// How many people you'd have to line up to find one of you. "Top 0.0004%" means
// nothing to most readers; "about 1 in 230,000" does.
function oneInCount(pct,floor){
  const t=Math.max(floor==null?RANK_FLOOR_GYM:floor,100-pct)/100;
  return 1/t;
}
function fmtOneIn(pct,floor){
  const n=oneInCount(pct,floor);
  // Past the world's population the label already says so — don't repeat it.
  if(n<20||n>WORLD_POP) return null;
  if(n<1000) return 'about 1 in '+(Math.round(n/10)*10);
  if(n<1e6) return 'about 1 in '+Math.round(n/1000).toLocaleString('en-GB')+',000';
  if(n<1e9) return 'about 1 in '+(Math.round(n/1e5)/10)+' million';
  return 'about 1 in '+(Math.round(n/1e8)/10)+' billion';
}
// Above the median → "Top X%"; below it → "Bottom X%", so a weak score never
// reads as "Top 91%", which sounds good but means the opposite. Beyond the world
// population a percentage is unreadable anyway ("top 0.000000000003%"), so the
// label states the honest thing instead.
function rankLabel(pct,floor){
  if(pct==null) return '—';
  // Guard the exact median: floating point lands it at 49.999… and "Bottom 50%"
  // for a dead-average physique reads worse than "Top 50%" for the same thing.
  if(pct<49.995) return 'Bottom '+Math.max(1,Math.round(pct))+'%';
  if(oneInCount(pct,floor)>WORLD_POP) return 'Rarer than 1 in 8 billion';
  return 'Top '+fmtTop(pct,floor==null?RANK_FLOOR_GYM:floor)+'%';
}
// Two bell curves on one 1–10 axis: everyone, and everyone who trains. Both are
// normal with SD 1.0 by construction, so the gym curve is the same shape shifted
// right — which is the whole point. The same physique sits high on the left
// curve and much further down the right one.
function buildRankHTML(base, grade, blurred){
  if(base==null) return '';
  const sc=scaleScores(base);
  const popPct=scalePercentile(sc.popExact,SCALE_POP_MEAN,SCALE_POP_SD_PER_POINT);
  const gymPct=scalePercentile(sc.gymExact,SCALE_GYM_MEAN,SCALE_GYM_SD_PER_POINT);

  const W=320,H=168,x0=30,x1=310,y0=26,y1=132;
  const plotW=x1-x0,plotH=y1-y0;
  const px=v=>x0+(Math.max(0,Math.min(10,v))/10)*plotW;
  // Both curves share a height scale, so the shift between them stays readable.
  const dens=(v,mean,sdpp)=>{const z=(v-mean)*(sdpp==null?1:sdpp);return Math.exp(-(z*z)/2);};
  const py=d=>y1-d*plotH;

  function curve(mean,sdpp){
    let pts=[];
    for(let v=0;v<=10;v+=0.1) pts.push(px(v).toFixed(1)+' '+py(dens(v,mean,sdpp)).toFixed(1));
    return {line:'M '+pts.join(' L '),
            area:'M '+px(0).toFixed(1)+' '+y1+' L '+pts.join(' L ')+' L '+px(10).toFixed(1)+' '+y1+' Z'};
  }
  const cPop=curve(SCALE_POP_MEAN,SCALE_POP_SD_PER_POINT), cGym=curve(SCALE_GYM_MEAN,SCALE_GYM_SD_PER_POINT);
  // When both scales share an average the two bells sit exactly on top of each
  // other, and drawing both just looks like a rendering fault. Draw one, and let
  // the two markers carry the comparison.
  const oneCurve=Math.abs(SCALE_POP_MEAN-SCALE_GYM_MEAN)<0.05 && Math.abs(SCALE_POP_SD_PER_POINT-SCALE_GYM_SD_PER_POINT)<0.02;

  let grid='';
  [0,2,4,6,8,10].forEach(function(v){ const gx=px(v).toFixed(1); grid+='<line class="rc-grid" x1="'+gx+'" y1="'+y0+'" x2="'+gx+'" y2="'+y1+'"/>'; });
  [0,.5,1].forEach(function(f){ const gy=(y1-f*plotH).toFixed(1); grid+='<line class="rc-grid" x1="'+x0+'" y1="'+gy+'" x2="'+x1+'" y2="'+gy+'"/>'; });

  let ax='';
  [0,2,4,6,8,10].forEach(function(v){ ax+='<text class="rc-axtext" x="'+px(v).toFixed(1)+'" y="'+(y1+11)+'" text-anchor="middle" font-size="8">'+v+'</text>'; });
  ax+='<text class="rc-axtitle" x="'+((x0+x1)/2).toFixed(1)+'" y="'+(y1+24)+'" text-anchor="middle" font-size="8">Score out of 10 · average 5.0</text>';

  // Each population's average, marked on its own curve.
  const refs=(function(){
    function m(v,l){const rx=px(v).toFixed(1);
      return '<line class="rc-ref" x1="'+rx+'" y1="'+py(1).toFixed(1)+'" x2="'+rx+'" y2="'+y1+'"/>'+
             '<text class="rc-reftext" x="'+rx+'" y="'+(y0-14)+'" text-anchor="middle" font-size="6.5">'+l+'</text>';}
    // Two labels at the same x overprint into unreadable mush. When the scales
    // share an average there is only one line to label, whatever the widths.
    const sameMean=Math.abs(SCALE_POP_MEAN-SCALE_GYM_MEAN)<0.05;
    return sameMean?m(SCALE_GYM_MEAN,'AVERAGE'):(m(SCALE_POP_MEAN,'EVERYONE AVG')+m(SCALE_GYM_MEAN,'GYM AVG'));
  })();

  // One marker per curve. The two sit close together on purpose — the gap is the
  // 5% the gym scale takes off you.
  function mark(v,mean,sdpp,cls){
    const mx=px(v);
    return '<line class="rc-marker '+cls+'" x1="'+mx.toFixed(1)+'" y1="'+y1+'" x2="'+mx.toFixed(1)+'" y2="'+(y0+2)+'"/>'+
           '<circle class="rc-dot '+cls+'" cx="'+mx.toFixed(1)+'" cy="'+py(dens(v,mean,sdpp)).toFixed(1)+'" r="3.4"/>';
  }

  const gc=(grade&&grade!=='—')?' grade-'+grade:'';
  const locked=!isProHint();
  const oneInGym=fmtOneIn(gymPct,RANK_FLOOR_GYM), oneInPop=fmtOneIn(popPct,RANK_FLOOR_POP);

  return '<div class="res-rank reslock'+gc+(locked?' locked':'')+(hasAccount()?'':' blurred')+'">'+
    '<div class="reslock-in">'+
    '<div class="res-sec-eyebrow">Where you rank</div>'+
    '<div class="rank-dual">'+
      '<div class="rank-d rank-d-gym">'+
        '<div class="rank-d-n">'+fmtScale(sc.gym)+'<span class="rank-d-max">/10</span></div>'+
        '<div class="rank-d-l">vs gym-goers</div>'+
        '<div class="rank-d-p">'+rankLabel(gymPct,RANK_FLOOR_GYM)+(oneInGym?' <span class="rank-d-oi">'+oneInGym+'</span>':'')+'</div>'+
      '</div>'+
      '<div class="rank-d rank-d-pop">'+
        '<div class="rank-d-n">'+fmtScale(sc.pop)+'<span class="rank-d-max">/10</span></div>'+
        '<div class="rank-d-l">vs everyone</div>'+
        '<div class="rank-d-p">'+rankLabel(popPct,RANK_FLOOR_POP)+(oneInPop?' <span class="rank-d-oi">'+oneInPop+'</span>':'')+'</div>'+
      '</div>'+
    '</div>'+
    '<svg class="rank-curve" viewBox="0 0 '+W+' '+H+'" aria-hidden="true">'+
      grid+
      (oneCurve?'':'<path class="rc-area" d="'+cPop.area+'"/>')+
      '<path class="rc-area rc-area-gym" d="'+cGym.area+'"/>'+
      refs+
      (oneCurve?'':'<path class="rc-line" d="'+cPop.line+'"/>')+
      '<path class="rc-line rc-line-gym" d="'+cGym.line+'"/>'+
      '<line class="rc-axis" x1="'+x0+'" y1="'+y1+'" x2="'+x1+'" y2="'+y1+'"/>'+
      mark(sc.pop,SCALE_POP_MEAN,SCALE_POP_SD_PER_POINT,'rc-pop')+
      mark(sc.gym,SCALE_GYM_MEAN,SCALE_GYM_SD_PER_POINT,'rc-gym')+
      ax+
    '</svg>'+
    '<div class="rank-legend">'+
      '<span class="rank-key rank-key-gym">People who train · 1 pt = 1 SD</span>'+
      '<span class="rank-key rank-key-pop">Everyone · 1 pt = '+SCALE_POP_SD_PER_POINT+' SD</span>'+
    '</div>'+
    '<div class="rank-note">Two modelled distributions, not a measured ranking. Both average 5.0. Against people who train, one point is one standard deviation — so '+fmtScale(sc.gym)+' is '+((sc.gymExact-SCALE_GYM_MEAN)*SCALE_GYM_SD_PER_POINT).toFixed(1)+' SD out. The general population is a tighter cluster, so the same step covers more ground and '+fmtScale(sc.pop)+' is '+((sc.popExact-SCALE_POP_MEAN)*SCALE_POP_SD_PER_POINT).toFixed(1)+' SD out. The gym number is the one worth chasing.</div>'+
    '</div>'+
    (locked?proVeil('See both percentiles'):'')+
  '</div>';
}

// Shared Pro-lock overlay for premium result sections.
function proVeil(title){
  return '<div class="reslock-veil">'+
    '<svg class="reslock-lock" viewBox="0 0 24 24" fill="none" aria-hidden="true">'+
      '<rect x="4.5" y="10.5" width="15" height="9.5" rx="2.2" stroke="currentColor" stroke-width="1.8"/>'+
      '<path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" stroke="currentColor" stroke-width="1.8"/></svg>'+
    '<div class="reslock-t">'+title+'</div>'+
    '<div class="reslock-s">Callout-AI Pro</div>'+
    '<button class="btn gold-btn reslock-btn" onclick="handlePurchase(\'pro\')">Unlock with Pro →</button>'+
  '</div>';
}

// Mass vs conditioning — a quadrant separating size/development (Y) from leanness (X).
// Pro-gated like the percentile. Needs both a conditioning read and at least one size muscle.
// Rough conditioning (leanness) score from a body-fat range, used only when the model
// didn't return one. Lower body fat = leaner — but dampened by mass, because "shredded"
// needs muscle to reveal: a lean but unmuscular frame reads lean, not conditioned.
function condFromBodyfat(bf, mass){
  if(!bf) return null;
  const nums=(String(bf).match(/\d+(\.\d+)?/g)||[]).map(Number);
  if(!nums.length) return null;
  const mid=nums.reduce((a,b)=>a+b,0)/nums.length;
  let lean=95-(mid-6)*2.8;
  if(mass!=null) lean*=0.5+0.5*Math.min(1,Math.max(0,mass)/55); // no muscle → can't be shredded
  return Math.max(8,Math.min(96,Math.round(lean)));
}
function buildMassCondHTML(m, seen, grade, bodyfat){
  const sizeKeys=(seen||[]).filter(k=>k!=='conditioning');
  if(sizeKeys.length===0) return '';
  const mass=Math.round(sizeKeys.reduce((s,k)=>s+m[k].score,0)/sizeKeys.length);
  let cond=(m['conditioning']&&m['conditioning'].score!=null)?Math.round(m['conditioning'].score):condFromBodyfat(bodyfat,mass);
  if(cond==null) return '';
  const diff=mass-cond;
  const type=diff>=18?'Mass-dominant':(diff<=-18?'Conditioning-dominant':'Balanced');
  const W=320,H=250,x0=34,x1=302,y0=16,y1=214;
  const plotW=x1-x0,plotH=y1-y0;
  const px=v=>x0+(v/100)*plotW, py=v=>y1-(v/100)*plotH;
  const dvx=px(50).toFixed(1), dvy=py(50).toFixed(1);
  const dotx=px(cond).toFixed(1), doty=py(mass).toFixed(1);
  const quad='<text class="mcp-quad" x="'+(x0+7)+'" y="'+(y0+13)+'" font-size="7.5">Mass monster</text>'+
    '<text class="mcp-quad" x="'+(x1-7)+'" y="'+(y0+13)+'" text-anchor="end" font-size="7.5">Complete</text>'+
    '<text class="mcp-quad" x="'+(x0+7)+'" y="'+(y1-7)+'" font-size="7.5">Developing</text>'+
    '<text class="mcp-quad" x="'+(x1-7)+'" y="'+(y1-7)+'" text-anchor="end" font-size="7.5">Shredded</text>';
  const yousideRight=cond<50;
  const lblx=yousideRight?(Number(dotx)+9):(Number(dotx)-9);
  const anchor=yousideRight?'start':'end';
  const ax='<text class="mcp-axtitle" x="'+((x0+x1)/2).toFixed(1)+'" y="'+(y1+22)+'" text-anchor="middle" font-size="8">Conditioning</text>'+
    '<text class="mcp-axend" x="'+x0+'" y="'+(y1+13)+'" font-size="7">Soft</text>'+
    '<text class="mcp-axend" x="'+x1+'" y="'+(y1+13)+'" text-anchor="end" font-size="7">Shredded</text>'+
    '<text class="mcp-axtitle" x="13" y="'+((y0+y1)/2).toFixed(1)+'" text-anchor="middle" font-size="8" transform="rotate(-90 13 '+((y0+y1)/2).toFixed(1)+')">Mass</text>';
  const gc=(grade&&grade!=='—')?' grade-'+grade:'';
  const locked=!isProHint();
  return '<div class="res-mc reslock'+gc+(locked?' locked':'')+(hasAccount()?'':' blurred')+'">'+
    '<div class="reslock-in">'+
    '<div class="res-sec-eyebrow">Mass vs conditioning</div>'+
    '<div class="mc-head"><div class="mc-stats">'+
      '<div class="mc-stat"><b class="mc-mass">'+(mass/10).toFixed(1)+'</b><span>Mass</span></div>'+
      '<div class="mc-stat"><b class="mc-cond">'+(cond/10).toFixed(1)+'</b><span>Cond</span></div>'+
    '</div><span class="rank-tag">AI estimate</span></div>'+
    '<div class="mc-type"><b>'+type+'</b> — size and leanness scored independently.</div>'+
    '<svg class="mc-plot" viewBox="0 0 '+W+' '+H+'" aria-hidden="true">'+
      '<line class="mcp-div" x1="'+dvx+'" y1="'+y0+'" x2="'+dvx+'" y2="'+y1+'"/>'+
      '<line class="mcp-div" x1="'+x0+'" y1="'+dvy+'" x2="'+x1+'" y2="'+dvy+'"/>'+
      '<rect class="mcp-frame" x="'+x0+'" y="'+y0+'" width="'+plotW+'" height="'+plotH+'" rx="4"/>'+
      quad+
      '<circle class="mcp-ring" cx="'+dotx+'" cy="'+doty+'" r="9"/>'+
      '<circle class="mcp-dot" cx="'+dotx+'" cy="'+doty+'" r="5"/>'+
      '<text class="mcp-you" x="'+lblx.toFixed(1)+'" y="'+(Number(doty)+3).toFixed(1)+'" text-anchor="'+anchor+'" font-size="7.5">You</text>'+
      ax+
    '</svg>'+
    '<div class="rank-note">Mass is your size and development; conditioning is how lean you are. A big build isn\'t dragged down by soft conditioning — and being lean doesn\'t fake size.</div>'+
    '</div>'+
    (locked?proVeil('See your build type'):'')+
  '</div>';
}

// Post-grade upsell. Free users see the two tiers side by side (one-time Audit vs
// ongoing Pro, Pro highlighted); Audit owners see just the Pro upgrade; Pro users see nothing.
function buildUpsellHTML(){
  if(isProHint()) return '';
  const pro='<div class="res-plan rp-featured">'+
      '<div class="rp-tag">Best value</div>'+
      '<div class="rp-name">Callout-AI Pro</div>'+
      '<div class="rp-price">£9.99<small>/mo</small></div>'+
      '<div class="rp-desc">Everything in the Audit — plus track and improve over time.</div>'+
      '<ul class="rp-list">'+
        '<li>Every angle graded</li>'+
        '<li>Rescan any time — 20/day</li>'+
        '<li>Progress — compare two scans</li>'+
        '<li>Improve — training + diet audit</li>'+
        '<li>Full scan history</li>'+
      '</ul>'+
      '<button class="btn gold-btn rp-btn" onclick="handlePurchase(\'pro\')">Get Pro →</button>'+
    '</div>';
  if(hasEntitlementHint()){
    // already owns the Audit — offer the upgrade only
    return '<div class="res-plans-wrap">'+
      '<div class="res-plans-head"><div class="res-pro-eye">Go further</div>'+
      '<div class="res-plans-title">Keep scanning as you grow.</div></div>'+
      '<div class="res-plans">'+pro+'</div>'+
      '<div class="res-plans-foot">Cancel anytime from the Stripe portal.</div>'+
    '</div>';
  }
  const audit='<div class="res-plan">'+
      '<div class="rp-name">Full Body Audit</div>'+
      '<div class="rp-price">£5.99<small>once</small></div>'+
      '<div class="rp-desc">Just this scan, unlocked in full.</div>'+
      '<ul class="rp-list">'+
        '<li>All four angles graded</li>'+
        '<li>Full muscle breakdown</li>'+
        '<li>Body-fat read</li>'+
        '<li>Yours forever</li>'+
      '</ul>'+
      '<button class="btn ghost rp-btn" onclick="handlePurchase(\'scan\')">Unlock — £5.99</button>'+
    '</div>';
  return '<div class="res-plans-wrap">'+
    '<div class="res-plans-head"><div class="res-pro-eye">Unlock everything</div>'+
    '<div class="res-plans-title">You\'ve seen the grade. Now see everything.</div></div>'+
    '<div class="res-plans">'+audit+pro+'</div>'+
    '<div class="res-plans-foot">One-time unlock, or go Pro and keep scanning. Cancel Pro anytime.</div>'+
  '</div>';
}

function tierDisplayLabel(tier){
  return {scan:'Full Body Audit',pro:'Callout-AI Pro',lifetime:'Lifetime'}[tier]||'Paid access';
}

// ============================================================
//  SCAN HISTORY
// ============================================================
async function showHistory(){
  track('history_viewed');
  const body=document.getElementById('histBody');
  body.innerHTML='<p class="hist-empty">Loading…</p>';
  show('screen-history');
  if(!hasFreshEntitlementToken()) await refreshEntitlementToken().catch(()=>{});
  if(!hasFreshEntitlementToken()){
    body.innerHTML='<p class="hist-empty">Scan history is part of paid access. '+
      '<button class="recover-link" onclick="openRecoveryModal()">Restore access</button> if you\'ve already paid, '+
      'or unlock the <button class="recover-link" onclick="handlePurchase(\'scan\')">Full Body Audit</button>.</p>';
    return;
  }
  try{
    const res=await fetch(WORKER_URL,{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+entitlementToken},
      body:JSON.stringify({action:'get_history'})
    });
    const data=await res.json().catch(()=>null);
    if(!res.ok || !data || !Array.isArray(data.history)) throw new Error('history_failed');
    if(!data.history.length){
      body.innerHTML='<p class="hist-empty">No scans saved yet. Paid scans are stored here automatically from now on — scan an angle to start your record.</p>';
      return;
    }
    const viewNames={front:'Front',back:'Back',legs:'Legs',arms_side:'Arms / Side'};
    body.innerHTML=data.history.slice().reverse().map(h=>{
      const g=(h.score!=null)?scoreToGrade(h.score):'—';
      const d=new Date((h.ts||0)*1000);
      const date=d.toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'});
      let quote='';
      if(h.verdict){
        const v=String(h.verdict);
        quote=' · “'+esc(v.length>80?v.slice(0,80)+'…':v)+'”';
      }
      return '<div class="hist-row">'+
        '<div class="hist-grade">'+g+'</div>'+
        '<div><div class="hist-name">'+esc(viewNames[h.region]||h.region||'Scan')+'</div>'+
        '<div class="hist-date">'+esc(date)+quote+'</div></div>'+
        '<div class="hist-score">'+(h.score!=null?(h.score/10).toFixed(1)+'/10':'—')+'</div>'+
      '</div>';
    }).join('');
  }catch(e){
    body.innerHTML='<p class="hist-empty">Could not load history right now. Try again in a moment.</p>';
  }
}

// ============================================================
//  PROGRESS — compare two scans of the same angle (Pro)
// ============================================================
let progHist=null, progRegion=null, progA=0, progB=0;

function progShell(inner){
  return '<div class="result-wrap"><div class="card-area">'+
    '<div class="sec-head" style="margin-bottom:24px">'+
      '<h2>Progress.</h2>'+
      '<p>Two scans of the same angle, side by side — which muscles actually moved.</p>'+
    '</div>'+inner+
    '<button class="btn ghost" style="margin-top:18px" onclick="show(\'screen-home\')">← Back</button>'+
  '</div></div>';
}

async function showProgress(){
  track('progress_viewed');
  const body=document.getElementById('progressBody');
  body.innerHTML=progShell('<p class="hist-empty">Loading…</p>');
  show('screen-progress');
  if(!hasFreshEntitlementToken()) await refreshEntitlementToken().catch(()=>{});
  if(!isProHint()){renderProgressLocked();return;}
  try{
    const res=await fetch(WORKER_URL,{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+entitlementToken},
      body:JSON.stringify({action:'get_history'})
    });
    const data=await res.json().catch(()=>null);
    if(!res.ok || !data || !Array.isArray(data.history)) throw new Error('history_failed');
    progHist={};
    data.history.forEach(h=>{
      if(!h||!h.region) return;
      (progHist[h.region]=progHist[h.region]||[]).push(h);
    });
    Object.values(progHist).forEach(l=>l.sort((a,b)=>(a.ts||0)-(b.ts||0)));
    const usable=VIEWS.filter(v=>(progHist[v.id]||[]).length>=2);
    if(!usable.length){
      const scanned=Object.keys(progHist).length>0;
      body.innerHTML=progShell(
        '<p class="hist-empty">'+(scanned
          ?'No angle has two scans yet. Rescan one you\'ve already graded — as soon as an angle has two scans, the comparison lives here.'
          :'No scans saved yet. Scan an angle, then rescan it after your next block — the comparison lives here.')+'</p>'+
        '<button class="btn" style="margin-top:16px" onclick="goHome(\'scanSection\')">Scan an angle →</button>'
      );
      return;
    }
    if(!progRegion || (progHist[progRegion]||[]).length<2){
      progRegion=usable[0].id;
    }
    progA=0; progB=progHist[progRegion].length-1;
    renderProgress();
  }catch(e){
    body.innerHTML=progShell('<p class="hist-empty">Could not load your scans right now. Try again in a moment.</p>');
  }
}

function renderProgressLocked(){
  track('progress_locked_shown');
  document.getElementById('progressBody').innerHTML=
    '<div class="progress-wrap"><div class="progress-card">'+
      '<div class="progress-lock-icon"><svg viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></div>'+
      '<div class="pr-eye">Pro feature</div>'+
      '<h2>Prove it moved.</h2>'+
      '<p class="pr-sub">Rescan after the cut, the bulk, the PR — then put any two scans of an angle side by side and see which muscles actually changed.</p>'+
      '<div class="pr-chart-preview">'+
        '<div class="pr-chart-label">Score over time</div>'+
        '<div class="pr-chart-bars">'+
          '<div class="pr-bar" style="height:38%"></div>'+
          '<div class="pr-bar" style="height:52%"></div>'+
          '<div class="pr-bar" style="height:47%"></div>'+
          '<div class="pr-bar" style="height:61%"></div>'+
          '<div class="pr-bar" style="height:58%"></div>'+
          '<div class="pr-bar" style="height:74%"></div>'+
        '</div>'+
        '<div class="pr-coming-badge">Included with Pro</div>'+
      '</div>'+
      '<ul class="pr-feats">'+
        '<li>Rescan all four angles — up to 20 scans a day</li>'+
        '<li>Side-by-side comparison of any two scans</li>'+
        '<li>Per-muscle score deltas</li>'+
        '<li>Improve: training + diet audits against your scan</li>'+
        '<li>Scan history tied to your email, on any device</li>'+
      '</ul>'+
      '<button class="btn gold-btn" onclick="handlePurchase(\'pro\')">Get Callout-AI Pro →</button>'+
      '<button class="btn ghost" style="margin-top:8px" onclick="show(\'screen-home\')">← Back</button>'+
      '<p class="recover-inline">Already Pro? <button class="recover-link" onclick="openRecoveryModal()">Restore access</button></p>'+
    '</div></div>';
}

function renderProgress(){
  const list=progHist[progRegion]||[];
  progA=Math.max(0,Math.min(progA,list.length-1));
  progB=Math.max(0,Math.min(progB,list.length-1));

  const pills=VIEWS.map(v=>{
    const n=(progHist[v.id]||[]).length;
    return '<button class="prog-pill'+(v.id===progRegion?' active':'')+'"'+(n<2?' disabled':'')+
      ' onclick="progPick(\''+v.id+'\')">'+esc(v.t)+'<span class="n">'+n+'</span></button>';
  }).join('');

  const opts=sel=>list.map((h,j)=>
    '<option value="'+j+'"'+(j===sel?' selected':'')+'>Scan '+(j+1)+' — '+esc(progDate(h.ts,true))+
    (h.score!=null?' · '+(clampNum(h.score)/10).toFixed(1)+'/10':'')+'</option>'
  ).join('');
  const selects='<div class="prog-selects">'+
    '<div><div class="prog-select-lbl">Baseline</div><select class="prog-select" onchange="progSetA(this.value)">'+opts(progA)+'</select></div>'+
    '<div><div class="prog-select-lbl">Compare with</div><select class="prog-select" onchange="progSetB(this.value)">'+opts(progB)+'</select></div>'+
  '</div>';

  document.getElementById('progressBody').innerHTML=progShell(
    '<div class="prog-pills">'+pills+'</div>'+selects+buildCompareHTML(list[progA],list[progB])
  );
}

function progPick(r){
  if(!progHist || (progHist[r]||[]).length<2) return;
  progRegion=r; progA=0; progB=progHist[r].length-1;
  track('progress_region',{region:r});
  renderProgress();
}
function progSetA(v){ progA=parseInt(v,10)||0; renderProgress(); }
function progSetB(v){ progB=parseInt(v,10)||0; renderProgress(); }

function progDate(ts,withYear){
  const o=withYear?{day:'numeric',month:'short',year:'numeric'}:{day:'numeric',month:'short'};
  return new Date((ts||0)*1000).toLocaleDateString(undefined,o);
}
function clampNum(v){
  const n=Number(v);
  return Number.isFinite(n)?Math.max(0,Math.min(100,Math.round(n))):null;
}
// Deltas arrive on the raw 0–100 scale and are shown on the 1–10 one, so a
// 6-point raw gain reads as +0.6 next to the scores it belongs to.
function deltaChip(d,cls){
  const v=(d==null)?null:(d/10);
  return '<span class="'+cls+' '+(d==null?'flat':(d>0?'up':(d<0?'down':'flat')))+'">'+
    (v==null?'—':(v>0?'+'+v.toFixed(1):v.toFixed(1)))+'</span>';
}

function buildCompareHTML(a,b){
  const sa=clampNum(a.score), sb=clampNum(b.score);
  const overall=(sa!=null&&sb!=null)?sb-sa:null;

  const head='<div class="cmp-head">'+
    '<div class="cmp-side"><div class="cmp-date">'+esc(progDate(a.ts))+'</div>'+
      '<div class="cmp-grade">'+(sa!=null?scoreToGrade(sa):'—')+'</div>'+
      '<div class="cmp-score">'+(sa!=null?(sa/10).toFixed(1)+'/10':'—')+'</div></div>'+
    deltaChip(overall,'cmp-delta')+
    '<div class="cmp-side now"><div class="cmp-date">'+esc(progDate(b.ts))+'</div>'+
      '<div class="cmp-grade">'+(sb!=null?scoreToGrade(sb):'—')+'</div>'+
      '<div class="cmp-score">'+(sb!=null?(sb/10).toFixed(1)+'/10':'—')+'</div></div>'+
  '</div>';

  const ma=a.muscles||{}, mb=b.muscles||{};
  const rows=MUSCLES.filter(k=>ma[k]!=null||mb[k]!=null).map(k=>{
    const va=clampNum(ma[k]), vb=clampNum(mb[k]);
    const d=(va!=null&&vb!=null)?vb-va:null;
    return '<div class="cmp-row">'+
      '<span class="cmp-name">'+cap(k)+'</span>'+
      '<div class="cmp-bars">'+
        '<div class="cmp-track"><div class="cmp-fill then" style="width:'+(va||0)+'%"></div></div>'+
        '<div class="cmp-track"><div class="cmp-fill now" style="width:'+(vb||0)+'%"></div></div>'+
      '</div>'+
      '<span class="cmp-nums">'+(va!=null?(va/10).toFixed(1):'—')+'→'+(vb!=null?(vb/10).toFixed(1):'—')+deltaChip(d,'cmp-chip')+'</span>'+
    '</div>';
  }).join('');

  return '<div class="cmp-card">'+head+
    '<div class="cmp-rows">'+(rows||'<p class="hist-empty">No muscle scores stored for these scans.</p>')+'</div>'+
    '<div class="cmp-note">Grey bar — '+esc(progDate(a.ts))+'. Blue — '+esc(progDate(b.ts))+'. '+
    'Scores are AI visual estimates: match lighting, distance and pose for the fairest comparison.</div>'+
  '</div>';
}

// ============================================================
//  IMPROVE — training + diet audit (Pro)
// ============================================================
let improveRecord=null;
const IMP_SET_FIELDS=[['chest','Chest'],['back','Back'],['shoulders','Shoulders'],['biceps','Biceps'],['triceps','Triceps'],['abs','Abs'],['quads','Quads'],['hamstrings','Hamstrings'],['glutes','Glutes'],['calves','Calves']];

function impShell(inner){
  return '<div class="result-wrap"><div class="card-area">'+
    '<div class="sec-head" style="margin-bottom:24px">'+
      '<h2>Improve.</h2>'+
      '<p>Your split and your diet, audited against what the scan actually shows.</p>'+
    '</div>'+inner+
    '<button class="btn ghost" style="margin-top:18px" onclick="show(\'screen-home\')">← Back</button>'+
  '</div></div>';
}

async function showImprove(){
  track('improve_viewed');
  const body=document.getElementById('improveBody');
  body.innerHTML=impShell('<p class="hist-empty">Loading…</p>');
  show('screen-improve');
  if(!hasFreshEntitlementToken()) await refreshEntitlementToken().catch(()=>{});
  if(!isProHint()){renderImproveLocked();return;}
  try{
    const res=await fetch(WORKER_URL,{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+entitlementToken},
      body:JSON.stringify({action:'get_improve'})
    });
    const data=await res.json().catch(()=>null);
    if(!res.ok||!data) throw new Error('improve_fetch');
    improveRecord=data.record||null;
    if(improveRecord&&improveRecord.report) renderImproveReport(improveRecord.report,improveRecord.scan);
    else renderImproveForm();
  }catch(e){
    body.innerHTML=impShell('<p class="hist-empty">Could not load right now. Try again in a moment.</p>');
  }
}

function renderImproveLocked(){
  track('improve_locked_shown');
  document.getElementById('improveBody').innerHTML=
    '<div class="progress-wrap"><div class="progress-card">'+
      '<div class="progress-lock-icon"><svg viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></div>'+
      '<div class="pr-eye">Pro feature</div>'+
      '<h2>Your split, called out.</h2>'+
      '<p class="pr-sub">Enter your weekly sets and a normal day of eating. Improve audits both against what your scan actually shows — and tells you what to change.</p>'+
      '<ul class="pr-feats">'+
        '<li>Training analysis — your volume vs your visible weak points</li>'+
        '<li>Diet audit — direction and fixes, grounded in what you eat</li>'+
        '<li>Built from your latest scan, not a questionnaire</li>'+
        '<li>Rescan after — Progress shows whether it worked</li>'+
      '</ul>'+
      '<button class="btn gold-btn" onclick="handlePurchase(\'pro\')">Get Callout-AI Pro →</button>'+
      '<button class="btn ghost" style="margin-top:8px" onclick="show(\'screen-home\')">← Back</button>'+
      '<p class="recover-inline">Already Pro? <button class="recover-link" onclick="openRecoveryModal()">Restore access</button></p>'+
    '</div></div>';
}

function renderImproveForm(){
  const inp=(improveRecord&&improveRecord.inputs)||{};
  const stats=inp.stats||{}, sets=inp.sets||{}, intake=inp.intake||{};
  const goal=inp.goal||'gain';
  const gPills=[['gain','Add size'],['lean','Get leaner'],['recomp','Recomp']].map(g=>
    '<button type="button" class="prog-pill'+(g[0]===goal?' active':'')+'" data-goal="'+g[0]+'" onclick="impPickGoal(this)">'+g[1]+'</button>'
  ).join('');
  const statF=(id,lbl,ph,val)=>'<div class="imp-field"><span>'+lbl+'</span><input class="imp-input" id="'+id+'" type="number" inputmode="numeric" placeholder="'+ph+'"'+(val!=null?' value="'+Number(val)+'"':'')+'></div>';
  const setF=IMP_SET_FIELDS.map(f=>
    '<div class="imp-field"><span>'+f[1]+'</span><input class="imp-input" id="imp-set-'+f[0]+'" type="number" inputmode="numeric" min="0" max="60" placeholder="0"'+(sets[f[0]]!=null?' value="'+Number(sets[f[0]])+'"':'')+'></div>'
  ).join('');
  document.getElementById('improveBody').innerHTML=impShell(
    '<div class="imp-lbl" style="margin-top:0">Goal</div><div class="imp-goals" id="impGoals">'+gPills+'</div>'+
    '<div class="imp-lbl">You</div><div class="imp-stats">'+
      statF('imp-h','Height (cm)','178',stats.height_cm)+
      statF('imp-w','Weight (kg)','80',stats.weight_kg)+
      statF('imp-y','Years training','3',stats.training_years)+
    '</div>'+
    '<div class="imp-lbl">Daily intake — if you track it</div><div class="imp-stats" style="grid-template-columns:1fr 1fr">'+
      statF('imp-kcal','Calories (kcal)','3000',intake.calories_kcal)+
      statF('imp-prot','Protein (g)','140',intake.protein_g)+
    '</div>'+
    '<p class="imp-note">Tracked numbers beat guesses — the protein check is computed from these, not vibes.</p>'+
    '<div class="imp-lbl">Weekly sets per muscle</div><div class="imp-sets">'+setF+'</div>'+
    '<p class="imp-note">Count a set when the muscle works hard in it — presses count for delts, rows count for biceps. Rough numbers are fine; skip what you don\'t track.</p>'+
    '<div class="imp-lbl">A normal day of eating</div>'+
    '<textarea class="imp-input" id="imp-diet" maxlength="2500" placeholder="Be honest. e.g. 8am oats and whey · 1pm chicken wrap and a coke · 7pm pasta with mince · biscuits most evenings"></textarea>'+
    '<p class="imp-note">Skip it and the report audits training only.</p>'+
    '<div class="imp-status" id="impStatus"></div>'+
    '<button class="btn gold-btn" id="impGo" style="margin-top:6px" onclick="submitImprove()">Build my report →</button>'
  );
  const dt=document.getElementById('imp-diet');
  if(dt&&typeof inp.diet==='string') dt.value=inp.diet;
}

function impPickGoal(el){
  document.querySelectorAll('#impGoals .prog-pill').forEach(b=>b.classList.remove('active'));
  el.classList.add('active');
}

async function submitImprove(){
  const btn=document.getElementById('impGo');
  const st=document.getElementById('impStatus');
  const num=id=>{const el=document.getElementById(id);const n=parseFloat(el&&el.value);return Number.isFinite(n)?n:null;};
  const sets={};
  IMP_SET_FIELDS.forEach(f=>{const n=num('imp-set-'+f[0]);if(n!=null)sets[f[0]]=n;});
  const goalEl=document.querySelector('#impGoals .prog-pill.active');
  const diet=((document.getElementById('imp-diet')||{}).value||'').trim();
  if(!Object.keys(sets).length && !diet){
    st.className='imp-status err';
    st.textContent='Enter your weekly sets, a day of eating, or both — there\'s nothing to audit yet.';
    return;
  }
  const payload={
    action:'improve',
    goal:goalEl?goalEl.getAttribute('data-goal'):'gain',
    height_cm:num('imp-h'),weight_kg:num('imp-w'),training_years:num('imp-y'),
    calories_kcal:num('imp-kcal'),protein_g:num('imp-prot'),
    sets:sets,diet:diet
  };
  btn.disabled=true;
  st.className='imp-status';
  st.textContent='Building your report — usually 15–20 seconds…';
  track('improve_submit');
  try{
    if(!hasFreshEntitlementToken()) await refreshEntitlementToken().catch(()=>{});
    const res=await fetch(WORKER_URL,{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+entitlementToken},
      body:JSON.stringify(payload)
    });
    const data=await res.json().catch(()=>null);
    if(res.status===400&&data&&data.reason==='no_scans'){
      st.className='imp-status err';
      st.textContent='No scans on this account yet — the report is built against your scan. Scan an angle first.';
      btn.disabled=false;return;
    }
    if(res.status===429){
      st.className='imp-status err';
      st.textContent='Report limit reached for today (6/day). Tomorrow.';
      btn.disabled=false;return;
    }
    if(!res.ok||!data) throw new Error('improve_failed');
    if(data.refused){
      st.className='imp-status err';
      st.textContent=data.reason==='unsafe_request'
        ?'This one needs a human, not an app. Part of what you entered is something a doctor or registered professional should guide — nothing was generated.'
        :(data.reason==='insufficient_input'
          ?'Not enough to work with. Add your sets or a day of eating and try again.'
          :'The report engine choked. Try again in a minute.');
      btn.disabled=false;return;
    }
    improveRecord={
      inputs:{goal:payload.goal,stats:{height_cm:payload.height_cm,weight_kg:payload.weight_kg,training_years:payload.training_years},intake:{calories_kcal:payload.calories_kcal,protein_g:payload.protein_g},sets:sets,diet:diet},
      report:data.report,scan:data.scan,created:data.created
    };
    track('improve_report');
    renderImproveReport(data.report,data.scan);
  }catch(e){
    st.className='imp-status err';
    st.textContent='Could not build the report right now. Try again in a moment.';
    btn.disabled=false;
  }
}

function hmClass(s){
  if(s==null) return 'hm-none';
  if(s<55) return 'hm-weak';
  if(s<75) return 'hm-mid';
  return 'hm-strong';
}

// Stylised front/back muscle maps. Regions are filled by score band from the
// account's latest scan; unscanned regions render as dashed outlines.
function impBodyMap(m){
  const c=k=>hmClass(m[k]!=null?Number(m[k]):null);
  const front=
    '<svg viewBox="0 0 140 280" aria-label="Front body map">'+
      '<circle cx="70" cy="20" r="12" class="hm-out"/>'+
      '<path d="M63,32 L63,40 M77,32 L77,40" class="hm-out"/>'+
      '<path d="M48,42 C46,80 52,110 56,138 L84,138 C88,110 94,80 92,42 Z" class="hm-out"/>'+
      '<ellipse cx="41" cy="50" rx="12" ry="10" class="'+c('shoulders')+'"/>'+
      '<ellipse cx="99" cy="50" rx="12" ry="10" class="'+c('shoulders')+'"/>'+
      '<path d="M69,56 C56,54 48,60 48,72 C48,83 58,89 69,87 Z" class="'+c('chest')+'"/>'+
      '<path d="M71,56 C84,54 92,60 92,72 C92,83 82,89 71,87 Z" class="'+c('chest')+'"/>'+
      '<rect x="24" y="62" width="13" height="34" rx="6.5" class="'+c('arms')+'"/>'+
      '<rect x="103" y="62" width="13" height="34" rx="6.5" class="'+c('arms')+'"/>'+
      '<rect x="22" y="100" width="11" height="30" rx="5.5" class="hm-out"/>'+
      '<rect x="107" y="100" width="11" height="30" rx="5.5" class="hm-out"/>'+
      '<rect x="58" y="94" width="24" height="44" rx="8" class="'+c('abs')+'"/>'+
      '<path d="M70,96 L70,136 M60,109 L80,109 M60,123 L80,123" class="hm-grid"/>'+
      '<rect x="50" y="146" width="17" height="54" rx="8" class="'+c('quads')+'"/>'+
      '<rect x="73" y="146" width="17" height="54" rx="8" class="'+c('quads')+'"/>'+
      '<rect x="53" y="206" width="13" height="42" rx="6" class="hm-out"/>'+
      '<rect x="74" y="206" width="13" height="42" rx="6" class="hm-out"/>'+
      '<text x="70" y="272" class="hm-lbl">FRONT</text>'+
    '</svg>';
  const back=
    '<svg viewBox="0 0 140 280" aria-label="Back body map">'+
      '<circle cx="70" cy="20" r="12" class="hm-out"/>'+
      '<path d="M63,32 L63,38 M77,32 L77,38" class="hm-out"/>'+
      '<path d="M48,42 C46,80 52,110 56,138 L84,138 C88,110 94,80 92,42 Z" class="hm-out"/>'+
      '<path d="M70,36 L48,50 C56,58 64,64 70,74 C76,64 84,58 92,50 Z" class="'+c('traps')+'"/>'+
      '<ellipse cx="41" cy="50" rx="12" ry="10" class="'+c('shoulders')+'"/>'+
      '<ellipse cx="99" cy="50" rx="12" ry="10" class="'+c('shoulders')+'"/>'+
      '<path d="M54,76 C46,82 44,96 50,110 C56,118 64,116 68,110 L68,80 Z" class="'+c('back')+'"/>'+
      '<path d="M86,76 C94,82 96,96 90,110 C84,118 76,116 72,110 L72,80 Z" class="'+c('back')+'"/>'+
      '<rect x="24" y="62" width="13" height="34" rx="6.5" class="'+c('arms')+'"/>'+
      '<rect x="103" y="62" width="13" height="34" rx="6.5" class="'+c('arms')+'"/>'+
      '<rect x="22" y="100" width="11" height="30" rx="5.5" class="hm-out"/>'+
      '<rect x="107" y="100" width="11" height="30" rx="5.5" class="hm-out"/>'+
      '<ellipse cx="58" cy="150" rx="12" ry="11" class="'+c('glutes')+'"/>'+
      '<ellipse cx="82" cy="150" rx="12" ry="11" class="'+c('glutes')+'"/>'+
      '<rect x="50" y="164" width="17" height="48" rx="8" class="'+c('hamstrings')+'"/>'+
      '<rect x="73" y="164" width="17" height="48" rx="8" class="'+c('hamstrings')+'"/>'+
      '<rect x="52" y="218" width="15" height="36" rx="7" class="'+c('calves')+'"/>'+
      '<rect x="73" y="218" width="15" height="36" rx="7" class="'+c('calves')+'"/>'+
      '<text x="70" y="272" class="hm-lbl">BACK</text>'+
    '</svg>';
  return '<div class="imp-maps">'+front+back+'</div>'+
    '<div class="imp-legend">'+
      '<span><i style="background:var(--red);opacity:.5"></i>Called out</span>'+
      '<span><i style="background:var(--blue-muted)"></i>Building</span>'+
      '<span><i style="background:var(--blue);opacity:.75"></i>Strong</span>'+
      '<span><i style="border:1px dashed var(--line2)"></i>Not scanned</span>'+
    '</div>';
}

function impGoalLabel(g){return {gain:'Add size',lean:'Get leaner',recomp:'Recomp'}[g]||'—';}

function renderImproveReport(rep,scan){
  const inp=(improveRecord&&improveRecord.inputs)||{};
  const stats=inp.stats||{};
  const setTotal=Object.values(inp.sets||{}).reduce((s,v)=>s+(Number(v)||0),0);
  const created=(improveRecord&&improveRecord.created)||Math.floor(Date.now()/1000);
  const serial='R-'+created.toString(36).toUpperCase();
  const dateStr=new Date(created*1000).toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'});
  const recheckDate=new Date((created+rep.recheck_weeks*7*86400)*1000)
    .toLocaleDateString(undefined,{day:'numeric',month:'short'});

  const meta=[impGoalLabel(inp.goal)]
    .concat(stats.weight_kg!=null?[stats.weight_kg+'kg']:[])
    .concat(stats.height_cm!=null?[stats.height_cm+'cm']:[])
    .concat(stats.training_years!=null?[stats.training_years+' yrs training']:[])
    .concat(setTotal?[setTotal+' sets/wk']:[])
    .map(t=>'<span class="imp-chipstat">'+esc(t)+'</span>').join('');

  let mapBlock='';
  if(scan&&scan.muscles){
    const m=scan.muscles;
    const scored=MUSCLES.filter(k=>k!=='conditioning'&&m[k]!=null);
    const weakest=scored.length?scored.reduce((a,b)=>Number(m[a])<=Number(m[b])?a:b):null;
    const chips=(weakest?'<span class="imp-chipstat red">Weakest: '+esc(cap(weakest))+' '+Number(m[weakest])+'</span>':'')+
      (m.conditioning!=null?'<span class="imp-chipstat">Conditioning '+Number(m.conditioning)+'</span>':'')+
      (scan.bodyfat_range&&scan.bodyfat_range!=='unknown'?'<span class="imp-chipstat">BF est. '+esc(scan.bodyfat_range)+'</span>':'');
    mapBlock='<div class="imp-block"><div class="imp-block-title">01 · Body map</div>'+
      impBodyMap(m)+
      (chips?'<div class="imp-meta" style="margin:14px 0 0;justify-content:center">'+chips+'</div>':'')+
    '</div>';
  }

  const trainRows=(rep.training&&rep.training.changes||[]).map(c=>
    '<div class="imp-change"><span class="imp-change-tag">'+esc(c.area)+'</span><span class="imp-change-txt">'+esc(c.action)+'</span></div>'
  ).join('');
  const dietRows=rep.diet?(rep.diet.changes||[]).map(c=>
    '<div class="imp-change"><span class="imp-change-tag">Fix</span><span class="imp-change-txt">'+esc(c.what)+' <em>— '+esc(c.why)+'</em></span></div>'
  ).join(''):'';

  document.getElementById('improveBody').innerHTML=impShell(
    '<div class="imp-rephead"><div>'+
      '<div class="imp-rep-eyebrow">Callout-AI · IMPROVE REPORT</div>'+
      '<div class="imp-rep-serial">'+esc(serial)+' · '+esc(dateStr)+'</div>'+
    '</div></div>'+
    (meta?'<div class="imp-meta">'+meta+'</div>':'')+
    '<div class="imp-focus">'+esc(rep.focus)+'</div>'+
    mapBlock+
    '<div class="imp-block"><div class="imp-block-title">'+(mapBlock?'02':'01')+' · Training analysis</div>'+
      '<div class="imp-read">'+esc(rep.training.read)+'</div>'+trainRows+'</div>'+
    (rep.diet
      ?'<div class="imp-block"><div class="imp-block-title">'+(mapBlock?'03':'02')+' · Diet audit</div>'+
        '<div class="imp-read">'+esc(rep.diet.read)+'</div>'+dietRows+'</div>'
      :'')+
    '<div class="imp-block"><div class="imp-block-title">'+(mapBlock?(rep.diet?'04':'03'):(rep.diet?'03':'02'))+' · Recheck</div>'+
      '<div class="imp-read" style="margin-bottom:0">Run this for '+esc(String(rep.recheck_weeks))+' weeks, then rescan around '+esc(recheckDate)+' — '+
      '<button class="recover-link" onclick="showProgress()">Progress</button> will show whether it moved.</div></div>'+
    '<button class="btn" onclick="goHome(\'scanSection\')">Rescan an angle →</button>'+
    '<button class="btn ghost" style="margin-top:8px" onclick="renderImproveForm()">Edit inputs / regenerate</button>'+
    '<p class="imp-disclaimer">General training and nutrition guidance generated from your inputs and scan results. Not medical, dietetic, or coaching advice.</p>'
  );
}

function esc(value){
  return String(value==null?'':value)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}

function cap(s){return s[0].toUpperCase()+s.slice(1);}

// ============================================================
//  MODALS — privacy / terms
// ============================================================
function openModal(id){
  const m=document.getElementById(id);
  if(!m) return;
  m.classList.add('open');
  document.body.style.overflow='hidden';
}
function closeModal(id){
  const m=document.getElementById(id);
  if(!m) return;
  m.classList.remove('open');
  document.body.style.overflow='';
}
// Close on backdrop click
document.querySelectorAll('.modal-overlay').forEach(overlay=>{
  overlay.addEventListener('click',e=>{
    if(e.target===overlay) closeModal(overlay.id);
  });
});

// ============================================================
//  REVEAL ANIMATION
// ============================================================
function playRevealAnimation(){
  const vc = document.querySelector('#overallBody .overall-vc');
  if(!vc) return;

  // ── helpers ──────────────────────────────────────────────
  const cssVar = (name) => parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  ) * 1000; // → ms

  // ── cinematic bg dimmer ───────────────────────────────────
  let dimmer = document.getElementById('ra-dimmer');
  if(dimmer) dimmer.remove();
  dimmer = document.createElement('div');
  dimmer.id = 'ra-dimmer';
  dimmer.className = 'ra-cinematic-bg';
  document.body.appendChild(dimmer);
  // activate after one frame so transition fires
  requestAnimationFrame(()=>dimmer.classList.add('ra-dim'));

  // ── scan line element ─────────────────────────────────────
  let scanEl = vc.querySelector('.vc-scan-line');
  if(!scanEl){
    scanEl = document.createElement('div');
    scanEl.className = 'vc-scan-line';
    vc.insertAdjacentElement('afterbegin', scanEl);
  }

  // ── start all elements invisible then animate in phases ──
  const brandTag   = vc.querySelector('.vc-brand-tag');
  const gradeLetterEl = vc.querySelector('.vc-grade-letter');
  const gradeLabelEl  = vc.querySelector('.vc-grade-label');
  const strip      = vc.querySelector('.vc-strip');
  const footer     = vc.querySelector('.vc-footer');
  const secTitle   = vc.querySelector('.vc-section-title');
  const capNote    = vc.querySelector('.vc-cap');
  const muscles    = [...vc.querySelectorAll('.vc-muscle')];
  const badge      = vc.querySelector('.vc-badge');

  // Force everything invisible before first paint
  [brandTag, gradeLetterEl, gradeLabelEl, strip, footer, secTitle, badge]
    .filter(Boolean)
    .forEach(el => el.classList.add('ra-hidden'));
  if(capNote) capNote.classList.add('ra-hidden');
  muscles.forEach(m => m.classList.add('ra-hidden'));

  // ── Phase 2: brand tag ────────────────────────────────────
  const brandDelay = cssVar('--ra-brand-delay');
  setTimeout(()=>{
    if(brandTag){ brandTag.classList.remove('ra-hidden'); }
    if(badge)   { badge.classList.remove('ra-hidden'); }
    vc.classList.add('ra-brand-animate');
  }, brandDelay);

  // ── Phase 3: scan line sweep ──────────────────────────────
  const scanDelay = cssVar('--ra-scan-delay');
  setTimeout(()=>{ vc.classList.add('ra-scanning'); }, scanDelay);

  // ── Phase 4: grade slam + haptic ─────────────────────────
  const gradeDelay = cssVar('--ra-grade-delay');
  setTimeout(()=>{
    if(gradeLetterEl) gradeLetterEl.classList.remove('ra-hidden');
    vc.classList.add('ra-grade-animate');
    // Mobile haptic — verdict delivered
    if(navigator.vibrate) navigator.vibrate([80, 30, 40]);
  }, gradeDelay);

  // ── Phase 5: grade label ──────────────────────────────────
  const labelDelay = cssVar('--ra-label-delay');
  setTimeout(()=>{
    if(gradeLabelEl){ gradeLabelEl.classList.remove('ra-hidden'); }
    vc.classList.add('ra-label-animate');
  }, labelDelay);

  // ── Phase 6: score strip ──────────────────────────────────
  const stripDelay = cssVar('--ra-strip-delay');
  setTimeout(()=>{
    if(strip){ strip.classList.remove('ra-hidden'); }
    if(capNote){ capNote.classList.remove('ra-hidden'); }
    if(secTitle){ secTitle.classList.remove('ra-hidden'); }
    vc.classList.add('ra-strip-animate');
  }, stripDelay);

  // ── Phase 7: muscle bars staggered ───────────────────────
  const musclesDelay = cssVar('--ra-muscles-delay');
  const STAGGER = 45; // ms between each bar
  vc.classList.add('ra-bars-init');

  muscles.forEach((m, i)=>{
    const t = musclesDelay + (i * STAGGER);
    setTimeout(()=>{
      m.classList.remove('ra-hidden');
      m.style.animationDelay = '0ms';
      m.classList.add('ra-bar-ready');
      // let the existing fill animation run now
      const fill = m.querySelector('.vc-muscle-fill');
      if(fill) fill.style.animationPlayState = 'running';
    }, t);
  });

  // ── Phase 8: footer ───────────────────────────────────────
  const footerDelay = musclesDelay + (muscles.length * STAGGER) + 120;
  setTimeout(()=>{
    if(footer){
      footer.classList.remove('ra-hidden');
      footer.style.animation = 'ra-fade-up 0.22s ease both';
    }
  }, footerDelay);

  // ── Phase 9: share button pulse ───────────────────────────
  const sharePulseDelay = footerDelay + 320;
  setTimeout(()=>{
    // undim background
    dimmer.classList.remove('ra-dim');
    dimmer.classList.add('ra-undim');
    setTimeout(()=>dimmer.remove(), 1800);

    // pulse the share button
    const shareBtn = document.querySelector('#overallShareRow button');
    if(shareBtn){
      shareBtn.classList.remove('ra-share-pulse');
      void shareBtn.offsetWidth; // reflow to restart animation
      shareBtn.classList.add('ra-share-pulse');
      shareBtn.addEventListener('animationend', ()=>shareBtn.classList.remove('ra-share-pulse'), {once:true});
    }
  }, sharePulseDelay);
}

// ============================================================
//  PRICING VIEW TRACKING
// ============================================================
(function(){
  const sec=document.getElementById('pricingSection');
  if(!sec || !('IntersectionObserver' in window)) return;
  const io=new IntersectionObserver((entries)=>{
    entries.forEach(e=>{
      if(e.isIntersecting){track('pricing_viewed');io.disconnect();}
    });
  },{threshold:0.2});
  io.observe(sec);
})();

// ============================================================
//  MOBILE STICKY CTA — shows between hero and the next
//  conversion point; never over scan or pricing sections
// ============================================================
(function(){
  const bar=document.getElementById('mobCta');
  if(!bar) return;
  let heroVis=true,scanVis=false,priceVis=false;
  window.updateMobCta=function(){
    const home=document.getElementById('screen-home').classList.contains('active');
    const on=home&&!heroVis&&!scanVis&&!priceVis;
    bar.classList.toggle('on',on);
    bar.setAttribute('aria-hidden',on?'false':'true');
  };
  if(!('IntersectionObserver' in window)) return;
  const io=new IntersectionObserver(es=>{
    es.forEach(e=>{
      if(e.target.classList.contains('hero')) heroVis=e.isIntersecting;
      else if(e.target.id==='scanSection') scanVis=e.isIntersecting;
      else if(e.target.id==='pricingSection') priceVis=e.isIntersecting;
    });
    window.updateMobCta();
  },{threshold:.08});
  const h=document.querySelector('.hero'); if(h) io.observe(h);
  const s=document.getElementById('scanSection'); if(s) io.observe(s);
  const p=document.getElementById('pricingSection'); if(p) io.observe(p);
})();
