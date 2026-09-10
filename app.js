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
  loadStrength();
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
    (v.id==='front'?'<span class="view-recommend">RECOMMENDED FIRST SCAN</span>':'')+
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
          renderError('Payment could not be verified. If you were charged, contact support@cutrank.app.');
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
  setTimeout(()=>{
    const el=document.getElementById(id);
    if(!el) return;
    // Navigation to a folded explanation also opens it.
    const details=el.querySelector('details');
    if(details) details.open=true;
    el.scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
  },60);
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
// letter and it is never shown. What people read is a 1–10 score compared with
// people who train. One whole point is one standard deviation, so the number
// says directly how far from the gym-goer average they are.
const SCALE_GYM_MULT=1.05;
const SCALE_GYM_MEAN=5.0;
// One score point equals one standard deviation, so 10.0 is exactly 5 SD out.
const SCALE_GYM_SD_PER_POINT=1.0;

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
// The rounded value is what people read; the exact one drives the percentile,
// so display rounding alone never shifts an average gym-goer off their median.
function scaleScores(base){
  if(base==null) return null;
  return {
    gym:toScale(base,SCALE_GYM_MULT),
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
  sc.textContent=o.scores?(fmtScale(o.scores.gym)+'/10 vs gym-goers'):'';
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
function buildSignatureCard(grade, photoURL, viewLabel, bodyfat, extraClass, gateHTML){
  const known = grade && grade !== '—';
  return '<div class="vc result-vc signature-card grade-' + (known ? grade : 'C') + ' ' + (extraClass || '') + '">' +
    '<div class="vc-inner">' +
      '<div class="vc-header"><span class="vc-brand-tag">CutRank</span><span class="vc-badge">' + esc(viewLabel) + '</span></div>' +
      '<div class="signature-main' + (photoURL ? '' : ' signature-no-photo') + '">' +
        (photoURL ? '<div class="vc-disc-wrap"><img class="vc-disc" src="' + esc(photoURL) + '" alt="Your uploaded physique photo"></div>' : '') +
        '<div class="vc-grade-section"><div class="signature-label">Your physique</div>' +
          '<div class="vc-grade-letter">' + esc(grade || '—') + '</div>' +
          '<div class="vc-grade-label">' + (known ? gradeLabel(grade) : 'Not graded') + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="vc-footer">' +
        (bodyfat ? '<span class="signature-bodyfat">Body fat ' + esc(bodyfat) + ' · est.</span>' : '') +
        '<span class="signature-footnote"><span>AI estimate</span><span class="vc-site">cutrank.app</span></span>' +
      '</div>' +
    '</div>' + (gateHTML || '') + '</div>';
}

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

  const viewName=VIEWS.find(v=>v.id===view).t.toUpperCase();

  const o=computeOverall();
  const tease=o?o.grade:(viewGrade!=='—'?viewGrade:'?');

  const gateHTML=hasAccount()?'':
    '<div class="gate-overlay" id="gateDiv">'+
      '<div class="gate-grade-tease">'+tease+'</div>'+
      '<div class="gate-ready-pill"><div class="gate-ready-dot"></div>Result generated</div>'+
      '<h3>Your grade is ready.</h3>'+
      '<p>Enter your email to view it. It links this result and any purchase so access can be restored — that\'s the whole account.</p>'+
      '<input class="gate-input" type="email" id="gateEmail" placeholder="your@email.com" autocomplete="email" inputmode="email" enterkeyhint="go" aria-label="Email address" onkeydown="if(event.key===\'Enter\')submitGate()">'+
      '<label class="gate-consent"><input type="checkbox" id="gateConsent"> Also send me physique tips and product updates (optional).</label>'+
      '<button class="btn" onclick="submitGate()">Show my grade →</button>'+
      // The moment a stranger is asked for an email is the moment they need the
      // limits restated — not buried in a policy they will not open.
      '<div class="gate-fine">No card · no password · unsubscribe anytime</div>'+
      '<div class="gate-fine">Photo already graded and not stored by CutRank · <a onclick="openModal(\'privacyModal\')">privacy</a></div>'+
    '</div>';
  track('scan_result',{view:view,grade:viewGrade,paid:hasEntitlementHint()});
  if(!hasAccount()) track('gate_shown',{view:view});

  document.getElementById('resultBody').innerHTML=
    buildSignatureCard(viewGrade,photoURL,VIEWS.find(v=>v.id===view).t+' view',
      hasEntitlementHint()?data.bodyfat_range:null,hasAccount()?'':'blurred',gateHTML)+
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
  const resultCard=document.querySelector('#resultBody .result-vc');
  if(resultCard){resultCard.dataset.grade=viewGrade;resultCard.dataset.score=viewScores?viewScores.gym:0;}
}

function configurePrimaryBtn(o){
  renderResultNext();
  const btn=document.getElementById('resPrimary');
  if(!btn) return;
  btn.style.display='block';
  if(o && o.missing.length===0 && hasEntitlementHint()){
    btn.textContent='See your full grade →';
    btn.onclick=showOverall;
  } else {
    btn.textContent='← Back to scans';
    btn.onclick=()=>goHome('scanSection');
  }
}

// Present existing product destinations alongside the result; no entitlement changes.
function renderResultNext(){
  const body=document.getElementById('resultBody');
  if(!body || !body.querySelector('.result-vc') || !hasAccount()) return;
  const old=document.getElementById('resultNext');if(old)old.remove();
  const next=document.createElement('section');next.id='resultNext';next.className='result-next';
  const pro=isProHint(),paid=hasEntitlementHint();
  next.innerHTML='<span class="section-kicker">YOUR NEXT STEP</span>'+
    '<h3>'+(pro?'Turn the feedback into a plan.':paid?'Build the full picture.':'Make this your starting point.')+'</h3>'+
    '<p>'+(pro?'Use Improve to review your training and diet against this scan. After your next training block, compare the same angle in similar lighting.':paid?'Add the remaining angles for a fuller picture of your development. Your scan history is available below.':'Take the main focus into your next training block. A full audit adds the other angles; Pro lets you compare scans over time.')+'</p>'+
    '<div class="result-next-actions">'+
    (pro?'<button onclick="showImprove()">Review my training ↗</button><button onclick="showProgress()">Compare progress</button>':
      '<button onclick="goHome(\'scanSection\')">'+(paid?'Continue my audit':'Back to my scans')+' →</button>')+
    (paid?'<button onclick="showHistory()">Scan history</button>':'')+'</div>';
  body.appendChild(next);
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

  const revealedCard=document.querySelector('#resultBody .result-vc');
  if(revealedCard){
    revealedCard.scrollTop=0;
    revealedCard.scrollIntoView({behavior:'smooth',block:'start'});
  }
  injectShareMoment(revealedCard?revealedCard.dataset.grade:'?',revealedCard?Number(revealedCard.dataset.score):0);
  // The inline Audit / Pro comparison already contains the upgrade options.

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
    '<div class="sm-eye">You\'ve been ranked</div>'+
    '<h3>Post your grade.</h3>'+
    '<p>Share your starting point, or keep it for yourself.</p>'+
    '<button class="share-btn-big" onclick="shareGrade(\''+grade+'\','+score+',true)">'+
      '<svg viewBox="0 0 24 24"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>'+
      'Share my '+grade+' grade →'+
    '</button>'+
    '<button class="sm-skip" onclick="this.closest(\'.share-moment\').remove()">Keep it private</button>';
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
  renderError('Checkout is not configured yet. Please contact support@cutrank.app.');
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
  const text='I just got ranked. '+grade+'-tier, '+score+'/10 against people who actually train, on CutRank — the AI that grades your physique. No flattery. Get your verdict: '+(location.origin+location.pathname);
  if(navigator.share){
    navigator.share({title:'My CutRank Grade',text,url:location.origin+location.pathname})
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

  const heroPhoto=photos.front||photos.arms_side||photos.back||photos.legs||null;
  const capHTML=o.capped?
    '<div class="vc-cap">Grade capped — '+
      (!o.haveBack?'no back view':'')+((!o.haveBack&&!o.haveLegs)?' and ':'')+(!o.haveLegs?'no legs view':'')+
      '. Complete your remaining views to build the full picture.</div>':'';
  document.getElementById('overallBody').innerHTML=
    buildSignatureCard(o.grade,heroPhoto,o.nViews+' view'+(o.nViews!==1?'s':'')+' · Overall',
      hasEntitlementHint()?lastBodyfat:null,'overall-vc','')+
    capHTML+
    buildRankHTML(o.capBase,o.grade)+
    '<details class="signature-breakdown"><summary>Muscle breakdown · '+(MUSCLES.length-o.missing.length)+'/'+MUSCLES.length+' regions</summary><div>'+muscleRows+'</div></details>';

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
    '<p>Stripe sent you back without a checkout session ID, so CutRank cannot unlock access from the URL. Enter the checkout email and we will restore access from the server if there is an active purchase.</p>'+
    '<button class="btn gold-btn" onclick="openRecoveryModal()">Restore access →</button>'+
    '<p style="font-size:12px;color:var(--faint);line-height:1.5;margin-top:14px">Still stuck? support@cutrank.app</p></div>';
  const btn=document.getElementById('resPrimary');
  btn.style.display='block';btn.textContent='← Back';btn.onclick=()=>show('screen-home');
}

function renderRefusal(reason){
  track('scan_refused',{reason:reason||''});
  const msg=reason==='age'
    ?{h:"We can't grade this one",p:"CutRank is adults only, and we can only assess photos where the subject is clearly 18 or over."}
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
        if(status){status.textContent='Too many attempts today. Try again later, or email support@cutrank.app.';status.className='recovery-status err';}
        return;
      }
      if(!sent.ok){
        if(status){status.textContent=(sdata&&sdata.message)||'Could not send the code. Contact support@cutrank.app.';status.className='recovery-status err';}
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
    if(status){status.textContent='No active purchase found for that email. For help, contact support@cutrank.app.';status.className='recovery-status err';}
  }catch(e){
    if(status){status.textContent='Could not check purchase status. Try again, or contact support@cutrank.app.';status.className='recovery-status err';}
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

// The gym-goer model is an estimate, so do not imply precision beyond this
// display floor or turn a modelled percentile into a claim about a headcount.
const RANK_FLOOR_GYM=0.01;
// Format "top X%" — integers for the common case, decimals as the tail thins out.
function fmtTop(pct,floor){
  const t=Math.max(floor==null?RANK_FLOOR_GYM:floor,100-pct);
  if(t>=10) return ''+Math.round(t);
  if(t>=1)  return ''+(Math.round(t*10)/10);
  if(t>=0.1)  return ''+(Math.round(t*100)/100);
  if(t>=0.01) return ''+(Math.round(t*1000)/1000);
  return ''+Number(t.toPrecision(1));
}
// Above the median → "Top X%"; below it → "Bottom X%", so a weak score never
// reads as "Top 91%", which sounds good but means the opposite.
function rankLabel(pct,floor){
  if(pct==null) return '—';
  // Guard the exact median: floating point lands it at 49.999… and "Bottom 50%"
  // for a dead-average physique reads worse than "Top 50%" for the same thing.
  if(pct<49.995) return 'Bottom '+Math.max(1,Math.round(pct))+'%';
  if(100-pct<(floor==null?RANK_FLOOR_GYM:floor)) return 'Top <'+(floor==null?RANK_FLOOR_GYM:floor)+'%';
  return 'Top '+fmtTop(pct,floor==null?RANK_FLOOR_GYM:floor)+'%';
}
// One gym-goer comparison. Score conversion, percentile maths and access rules
// are shared with the existing app; only presentation changes here.
function buildRankHTML(base, grade, blurred, opts){
  if(base==null) return '';
  const free=!!(opts&&opts.free), sc=scaleScores(base);
  const pct=scalePercentile(sc.gymExact,SCALE_GYM_MEAN,SCALE_GYM_SD_PER_POINT);
  const label=rankLabel(pct,RANK_FLOOR_GYM);
  const locked=free?false:!isProHint(), gated=!free&&(!hasAccount()||blurred);
  // A taller drawing area gives the distribution enough presence without
  // changing its width or the one-score-point / one-standard-deviation scale.
  const W=480,H=210,x0=12,x1=468,y0=8,y1=154;
  const px=v=>x0+Math.max(0,Math.min(10,v))/10*(x1-x0);
  // The curve is the same normal distribution used by scalePercentile: one
  // score point is one standard deviation, so its sigma is the inverse of
  // the points-per-standard-deviation value. Dividing by the peak preserves
  // the true shape while fitting the PDF inside this SVG.
  const sigma=1/SCALE_GYM_SD_PER_POINT;
  const gaussianPdf=v=>{
    const z=(v-SCALE_GYM_MEAN)/sigma;
    return Math.exp(-0.5*z*z)/(sigma*Math.sqrt(2*Math.PI));
  };
  const peak=gaussianPdf(SCALE_GYM_MEAN);
  const py=v=>y1-(gaussianPdf(v)/peak)*(y1-y0);
  function points(from,to){
    const result=[];
    for(let i=0;i<=100;i++){
      const v=from+(to-from)*i/100;
      result.push(px(v).toFixed(2)+' '+py(v).toFixed(2));
    }
    return result.join(' L ');
  }
  const line='M '+points(0,10);
  const area=line+' L '+x1+' '+y1+' L '+x0+' '+y1+' Z';
  // Blue is the portion of the modelled population the person has passed. The
  // marker is placed from the unrounded score on a SCORE axis, not a percentile
  // axis, so the filled curve and displayed percentile always use one model.
  const passed='M '+px(0).toFixed(2)+' '+y1+' L '+points(0,sc.gymExact)+' L '+px(sc.gymExact).toFixed(2)+' '+y1+' Z';
  const mx=px(sc.gymExact).toFixed(2), my=py(sc.gymExact).toFixed(2);
  return '<section class="res-rank rank-single reslock'+(locked?' locked':'')+(gated?' blurred':'')+'" aria-label="Gym-goer percentile">'+
    '<div class="reslock-in"'+(locked||gated?' inert aria-hidden="true"':'')+'>'+
      '<h3>Where you rank</h3>'+
      '<div class="rank-summary"><div><div class="rank-cohort">Gym-goers</div>'+
        '<div class="rank-score">'+fmtScale(sc.gym)+' <span>/10</span></div></div>'+
      '<div class="rank-placement">'+esc(label)+'</div></div>'+
      '<svg class="rank-single-curve" viewBox="0 0 '+W+' '+H+'" role="img" aria-label="'+esc('Modelled score distribution for gym-goers. Your score: '+fmtScale(sc.gym)+' out of 10. '+label)+ '">'+
        '<desc>'+esc('The blue area represents '+pct.toFixed(1)+'% of the modelled population passed by this score.')+'</desc>'+
        '<path class="rank-bell-area" d="'+area+'"/><path class="rank-bell-passed" d="'+passed+'"/>'+
        '<path class="rank-bell-line" d="'+line+'"/>'+
        '<line class="rank-baseline" x1="'+x0+'" y1="'+y1+'" x2="'+x1+'" y2="'+y1+'"/>'+
        '<line class="rank-position" x1="'+mx+'" y1="'+y1+'" x2="'+mx+'" y2="'+Math.min(y1-18,Number(my)).toFixed(2)+'"/>'+
        '<circle class="rank-position-dot" cx="'+mx+'" cy="'+my+'" r="4"/>'+
      '</svg>'+
      '<div class="rank-axis-labels" aria-hidden="true"><span>0</span><span>Score /10 · average 5.0</span><span>10</span></div>'+
      '<div class="rank-method"><p>Modelled estimate, not a measured ranking.</p>'+
        '<details><summary>How this is estimated</summary><p>Your score is compared with a model of gym-goers, centred at '+SCALE_GYM_MEAN.toFixed(1)+'. Each score point represents '+SCALE_GYM_SD_PER_POINT+' standard deviation'+(SCALE_GYM_SD_PER_POINT===1?'':'s')+'. The curve uses the same distribution and your unrounded score; the displayed score is rounded. This is an estimate, not a ranking from a measured population sample.</p></details></div>'+
    '</div>'+(locked?proVeil('See your percentile'):'')+'</section>';
}


// Shared Pro-lock overlay for premium result sections.
function proVeil(title){
  return '<div class="reslock-veil">'+
    '<svg class="reslock-lock" viewBox="0 0 24 24" fill="none" aria-hidden="true">'+
      '<rect x="4.5" y="10.5" width="15" height="9.5" rx="2.2" stroke="currentColor" stroke-width="1.8"/>'+
      '<path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" stroke="currentColor" stroke-width="1.8"/></svg>'+
    '<div class="reslock-t">'+title+'</div>'+
    '<div class="reslock-s">CutRank Pro</div>'+
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
      '<div class="rp-name">CutRank Pro</div>'+
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
  return {scan:'Full Body Audit',pro:'CutRank Pro',lifetime:'Lifetime'}[tier]||'Paid access';
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
      '<button class="btn gold-btn" onclick="handlePurchase(\'pro\')">Get CutRank Pro →</button>'+
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
      '<h2>Your split, ranked.</h2>'+
      '<p class="pr-sub">Enter your weekly sets and a normal day of eating. Improve audits both against what your scan actually shows — and tells you what to change.</p>'+
      '<ul class="pr-feats">'+
        '<li>Training analysis — your volume vs your visible weak points</li>'+
        '<li>Diet audit — direction and fixes, grounded in what you eat</li>'+
        '<li>Built from your latest scan, not a questionnaire</li>'+
        '<li>Rescan after — Progress shows whether it worked</li>'+
      '</ul>'+
      '<button class="btn gold-btn" onclick="handlePurchase(\'pro\')">Get CutRank Pro →</button>'+
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
      '<span><i style="background:var(--red);opacity:.5"></i>Ranked</span>'+
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
      '<div class="imp-rep-eyebrow">CutRank · IMPROVE REPORT</div>'+
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
  if(vc.classList.contains('signature-card')) return;

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

// ============================================================
// STRENGTH — a second rank, on the same scale as the physique one.
//
// The whole point of this module is that it lands on the SAME 0-100 base
// the photo grade produces, so scaleScores/scoreToGrade/buildRankHTML all
// work on it unchanged and the two ranks can be plotted against each other
// honestly. If you change the anchors below, the strength half of the
// profile chart stops being comparable to the physique half.
//
// Runs entirely in the browser. No worker call, no API cost, no account.
// ============================================================

// Reference bodyweight for the tables below. Every threshold is quoted at
// this weight and scaled from it.
const STR_REF_BW = 55;

// Product calibration for a gym-goer comparison. Every reference threshold is
// raised by the same amount, preserving each lift's relative ladder and the
// continuous bodyweight adjustment. The anchor is a 120kg deadlift at 59kg:
// it reads around Top 5% of gym-goers rather than the old Top 1–2%.
const STR_GYMGOER_CALIBRATION = 1.10;

// Absolute strength rises roughly with bodyweight^(2/3) — the surface law
// (Lietzke), which is the standard basis for bodyweight-adjusted lifting
// scores. So the required BODYWEIGHT MULTIPLE falls with bodyweight^(-1/3):
// 2.0x bench at 100kg is a far rarer feat than 2.0x at 50kg, and the
// thresholds have to say so.
const STR_SCALE_EXP = -1 / 3;

// Weight classes exist as the reference frame the standards are quoted in,
// but they are DELIBERATELY NEVER SHOWN and never used to bucket anyone.
// Bucketing would put a cliff at every boundary — 59.9kg and 60.0kg would
// get different thresholds for the same lift. Scaling continuously on the
// real bodyweight passes through the same values at each class midpoint
// with no cliff, which is what the classes were approximating anyway.
//   <50 · 50-59 · 60-69 · 70-79 · 80-89 · 90-99 · 100-109 · 110-119 · 120+

// Muscle groups. REAR DELTS ARE DELIBERATELY ABSENT — the owner excluded
// them, and there is no isolation lift for them anyone loads heavily enough
// to rank honestly. Order here is the order they appear in the UI.
const STR_GROUPS = [
  { k:'chest',      name:'Chest',        side:'front' },
  { k:'frontdelt',  name:'Front delts',  side:'front' },
  { k:'latdelt',    name:'Lateral delts',side:'front' },
  { k:'biceps',     name:'Biceps',       side:'front' },
  { k:'forearms',   name:'Forearms',     side:'front' },
  { k:'core',       name:'Core',         side:'front' },
  { k:'quads',      name:'Quads',        side:'front' },
  { k:'back',       name:'Back',         side:'back'  },
  { k:'traps',      name:'Traps',        side:'back'  },
  { k:'triceps',    name:'Triceps',      side:'back'  },
  { k:'glutes',     name:'Glutes',       side:'back'  },
  { k:'hamstrings', name:'Hamstrings',   side:'back'  },
  { k:'calves',     name:'Calves',       side:'back'  }
];
function strGroup(k){ return STR_GROUPS.find(g => g.k === k) || null; }

// Units. 'kg' is total load on the bar or stack; 'kgph' is per hand, so a
// pair of 30s is 30; 'add' is weight ADDED to a bodyweight movement.
const STR_UNITS = { kg:'kg', kgph:'kg per hand', add:'kg added' };

// The exercise library. `ref` is [novice, intermediate, advanced, elite] as a
// bodyweight multiple at STR_REF_BW. Bench is the owner's own ladder, used
// verbatim; the rest sit in the range of commonly-cited published standards.
// `total:true` means the movement already carries the lifter, so the scaling
// runs on bodyweight + added rather than on the added weight alone.
//
// CONFIDENCE: `soft:true` marks a lift whose ladder is a considered estimate
// rather than something anchored in competition records or long-established
// norms — every dumbbell, cable and machine movement, and the small isolation
// work. Machine loads are not even comparable between manufacturers, and no
// federation contests a lateral raise. Those rows carry a visible "rough
// standard" marker. Do NOT quietly drop the flag to make the UI tidier: it is
// the difference between an estimate and a claim.
// Crowd-sourced lifting sites were considered as a source and rejected — the
// data is self-reported by self-selected app users with no rep standard, so
// it measures who logs lifts, not who lifts.
const STR_EX = [
  // ---- chest ----
  { k:'bench',        name:'Barbell bench press',    g:'chest', u:'kg',   ref:[0.80,1.20,1.50,1.80] , t:'compound' },
  { k:'inclbench',    name:'Incline barbell press',  g:'chest', u:'kg',   ref:[0.65,1.00,1.28,1.55] , t:'secondary' },
  { k:'dbbench',      name:'Dumbbell bench press',   g:'chest', u:'kgph', ref:[0.30,0.46,0.60,0.74] , t:'secondary' , soft:true },
  { k:'incldb',       name:'Incline dumbbell press', g:'chest', u:'kgph', ref:[0.25,0.40,0.52,0.65] , t:'secondary' , soft:true },
  { k:'dip',          name:'Weighted dip',           g:'chest', u:'add',  ref:[1.15,1.38,1.62,1.90], total:true , t:'secondary' },
  { k:'machpress',    name:'Machine chest press',    g:'chest', u:'kg',   ref:[0.70,1.05,1.35,1.65] , t:'secondary' , soft:true },
  { k:'cablefly',     name:'Cable fly',              g:'chest', u:'kgph', ref:[0.12,0.20,0.28,0.36] , t:'isolation' , soft:true },
  // ---- front delts ----
  { k:'ohp',          name:'Overhead press',         g:'frontdelt', u:'kg',   ref:[0.50,0.75,0.95,1.15] , t:'secondary' },
  { k:'pushpress',    name:'Push press',             g:'frontdelt', u:'kg',   ref:[0.65,0.95,1.20,1.45] , t:'secondary' },
  { k:'dbshoulder',   name:'Seated DB shoulder press',g:'frontdelt',u:'kgph', ref:[0.20,0.32,0.43,0.54] , t:'secondary' , soft:true },
  { k:'frontraise',   name:'Front raise',            g:'frontdelt', u:'kgph', ref:[0.08,0.13,0.18,0.23] , t:'isolation' , soft:true },
  // ---- lateral delts ----
  { k:'latraise',     name:'DB lateral raise',       g:'latdelt', u:'kgph', ref:[0.08,0.14,0.21,0.28] , t:'isolation' , soft:true },
  { k:'cablelat',     name:'Cable lateral raise',    g:'latdelt', u:'kgph', ref:[0.07,0.12,0.18,0.24] , t:'isolation' , soft:true },
  { k:'uprightrow',   name:'Upright row',            g:'latdelt', u:'kg',   ref:[0.35,0.55,0.72,0.90] , t:'secondary' , soft:true },
  // ---- back ----
  { k:'deadlift',     name:'Deadlift',               g:'back', u:'kg',   ref:[1.20,1.80,2.35,2.85] , t:'compound' },
  { k:'pullup',       name:'Weighted pull-up',       g:'back', u:'add',  ref:[1.10,1.28,1.50,1.75], total:true , t:'secondary' },
  { k:'chinup',       name:'Weighted chin-up',       g:'back', u:'add',  ref:[1.15,1.35,1.58,1.85], total:true , t:'secondary' },
  { k:'barbellrow',   name:'Barbell row',            g:'back', u:'kg',   ref:[0.70,1.05,1.35,1.65] , t:'secondary' },
  { k:'pendlay',      name:'Pendlay row',            g:'back', u:'kg',   ref:[0.65,1.00,1.28,1.55] , t:'secondary' },
  { k:'tbar',         name:'T-bar row',              g:'back', u:'kg',   ref:[0.70,1.05,1.35,1.65] , t:'secondary' , soft:true },
  { k:'pulldown',     name:'Lat pulldown',           g:'back', u:'kg',   ref:[0.65,0.95,1.20,1.45] , t:'secondary' , soft:true },
  { k:'cablerow',     name:'Seated cable row',       g:'back', u:'kg',   ref:[0.65,0.95,1.22,1.50] , t:'secondary' , soft:true },
  // ---- traps ----
  { k:'shrug',        name:'Barbell shrug',          g:'traps', u:'kg',   ref:[1.00,1.50,1.95,2.40] , t:'secondary' , soft:true },
  { k:'dbshrug',      name:'Dumbbell shrug',         g:'traps', u:'kgph', ref:[0.40,0.62,0.82,1.00] , t:'secondary' , soft:true },
  // ---- biceps ----
  { k:'strict',       name:'Strict curl',            g:'biceps', u:'kg',   ref:[0.30,0.48,0.66,0.85] , t:'isolation' },
  { k:'curl',         name:'Barbell curl',           g:'biceps', u:'kg',   ref:[0.35,0.55,0.75,0.95] , t:'isolation' },
  { k:'dbcurl',       name:'Dumbbell curl',          g:'biceps', u:'kgph', ref:[0.14,0.22,0.30,0.38] , t:'isolation' , soft:true },
  { k:'preacher',     name:'Preacher curl',          g:'biceps', u:'kg',   ref:[0.25,0.40,0.53,0.66] , t:'isolation' , soft:true },
  { k:'hammer',       name:'Hammer curl',            g:'biceps', u:'kgph', ref:[0.15,0.24,0.32,0.41] , t:'isolation' , soft:true },
  // ---- triceps ----
  { k:'cgbench',      name:'Close-grip bench press', g:'triceps', u:'kg',  ref:[0.65,1.00,1.28,1.55] , t:'secondary' },
  { k:'skullcrusher', name:'Skullcrusher',           g:'triceps', u:'kg',  ref:[0.25,0.40,0.54,0.68] , t:'isolation' , soft:true },
  { k:'pushdown',     name:'Cable pushdown',         g:'triceps', u:'kg',  ref:[0.35,0.55,0.72,0.90] , t:'isolation' , soft:true },
  { k:'overheadext',  name:'Overhead tricep extension',g:'triceps',u:'kg', ref:[0.22,0.35,0.47,0.60] , t:'isolation' , soft:true },
  // ---- forearms ----
  { k:'wristcurl',    name:'Barbell wrist curl',     g:'forearms', u:'kg',   ref:[0.30,0.48,0.63,0.78] , t:'isolation' , soft:true },
  { k:'farmers',      name:"Farmer's walk",          g:'forearms', u:'kgph', ref:[0.50,0.75,1.00,1.25] , t:'secondary' , soft:true },
  // ---- quads ----
  { k:'squat',        name:'Back squat',             g:'quads', u:'kg',   ref:[1.00,1.50,1.95,2.40] , t:'compound' },
  { k:'frontsquat',   name:'Front squat',            g:'quads', u:'kg',   ref:[0.80,1.20,1.55,1.90] , t:'secondary' },
  { k:'hacksquat',    name:'Hack squat',             g:'quads', u:'kg',   ref:[1.00,1.50,1.95,2.40] , t:'secondary' , soft:true },
  { k:'legpress',     name:'Leg press',              g:'quads', u:'kg',   ref:[1.80,2.70,3.50,4.30] , t:'secondary' , soft:true },
  { k:'legext',       name:'Leg extension',          g:'quads', u:'kg',   ref:[0.50,0.78,1.02,1.25] , t:'isolation' , soft:true },
  { k:'bulgarian',    name:'Bulgarian split squat',  g:'quads', u:'kgph', ref:[0.25,0.40,0.55,0.70] , t:'secondary' , soft:true },
  // ---- hamstrings ----
  { k:'rdl',          name:'Romanian deadlift',      g:'hamstrings', u:'kg', ref:[0.95,1.45,1.88,2.30] , t:'secondary' },
  { k:'legcurl',      name:'Lying leg curl',         g:'hamstrings', u:'kg', ref:[0.40,0.62,0.82,1.00] , t:'isolation' , soft:true },
  { k:'goodmorning',  name:'Good morning',           g:'hamstrings', u:'kg', ref:[0.55,0.85,1.10,1.35] , t:'secondary' },
  // ---- glutes ----
  { k:'hipthrust',    name:'Hip thrust',             g:'glutes', u:'kg', ref:[1.20,1.85,2.45,3.00] , t:'secondary' , soft:true },
  { k:'sumo',         name:'Sumo deadlift',          g:'glutes', u:'kg', ref:[1.25,1.85,2.40,2.90] , t:'compound' },
  // ---- calves ----
  { k:'standcalf',    name:'Standing calf raise',    g:'calves', u:'kg', ref:[0.80,1.25,1.65,2.05] , t:'isolation' , soft:true },
  { k:'seatcalf',     name:'Seated calf raise',      g:'calves', u:'kg', ref:[0.50,0.78,1.02,1.25] , t:'isolation' , soft:true },
  // ---- core ----
  { k:'cablecrunch',  name:'Cable crunch',           g:'core', u:'kg',  ref:[0.35,0.55,0.72,0.90] , t:'isolation' , soft:true },
  { k:'hangingleg',   name:'Weighted hanging leg raise', g:'core', u:'add', ref:[0.05,0.12,0.20,0.30] , t:'isolation' , soft:true }
];

// A compound lift contributes its full exercise score to every primary mover.
// `g` remains the named/lead muscle for picking and display; this map makes
// the strength map and group averages reflect the other main muscles involved.
// Assistance work is deliberately excluded — a deadlift informs glutes and
// hamstrings, for example, but it does not pretend to be a calf exercise.
const STR_PRIMARY_MOVERS = {
  bench:['chest','triceps','frontdelt'], inclbench:['chest','triceps','frontdelt'],
  dbbench:['chest','triceps','frontdelt'], incldb:['chest','triceps','frontdelt'],
  dip:['chest','triceps','frontdelt'], machpress:['chest','triceps','frontdelt'],
  ohp:['frontdelt','triceps'], pushpress:['frontdelt','triceps','quads'],
  dbshoulder:['frontdelt','triceps'], uprightrow:['latdelt','traps'],
  deadlift:['back','glutes','hamstrings','quads'],
  pullup:['back','biceps'], chinup:['back','biceps'],
  barbellrow:['back','biceps'], pendlay:['back','biceps'], tbar:['back','biceps'],
  pulldown:['back','biceps'], cablerow:['back','biceps'],
  curl:['biceps','forearms'], farmers:['forearms','traps'],
  cgbench:['triceps','chest','frontdelt'],
  squat:['quads','glutes'], frontsquat:['quads','glutes'], hacksquat:['quads','glutes'],
  legpress:['quads','glutes'], bulgarian:['quads','glutes'],
  rdl:['hamstrings','glutes','back'], goodmorning:['hamstrings','glutes','back'],
  hipthrust:['glutes','hamstrings'], sumo:['glutes','quads','hamstrings','back']
};
function strEx(k){ return STR_EX.find(e => e.k === k) || null; }
function strPrimaryMovers(ex){ return STR_PRIMARY_MOVERS[ex.k] || [ex.g]; }

// The four thresholds are the four grade boundaries the photo grade already
// uses, so a level name and a letter mean the same thing on both halves of
// the profile: elite=S, advanced=A, intermediate=B, novice=C, under that D/E.
const STR_LEVELS = ['Novice', 'Intermediate', 'Advanced', 'Elite'];
const STR_ANCHORS = [40, 61, 75, 90];
// Above the elite threshold the scale keeps going rather than flattening —
// otherwise every elite lifter reads identically and the top of the ladder
// carries no information. It approaches 100 ASYMPTOTICALLY and never reaches
// it: each further step costs more than the last.
//
// HOW FAR the tail runs is per-lift and is NOT a free parameter. `head` is
// roughly where the human ceiling sits as a multiple of the elite threshold,
// and it differs enormously by lift type. Records sit far above elite on a
// bench press; an isolation lift has a hard biomechanical ceiling barely
// above it. A single global headroom (the first attempt used 1.6x for
// everything) produced impossible targets — it wanted a 73kg strict curl
// from a 59kg lifter to score 95, when a 67.5kg strict curl won the 75kg
// class at the 2023 Strict Curl World Cup. Scaled down, the real ceiling
// there is nearer 57kg.
const STR_HEAD = { compound:1.55, secondary:1.42, isolation:1.20 };
// Reaching `head` scores ~98: ln(1/(1-0.8)) = 1.609, so k = 1.609/(head-1).
const STR_HEAD_K = 1.609;

// Free tier ranks this many muscle groups. Pro ranks all of them and gets
// the heatmap. Enforced in the UI only — this is a client-side tool with
// nothing worth protecting server-side, unlike the scan.
const STR_FREE_GROUPS = 5;

// Epley, identical to one-rep-max-calculator.html. The two must not disagree:
// someone will check. Accuracy falls off hard above ~10 reps, which the UI says.
function strEpley(weight, reps){
  if(!(weight > 0)) return null;
  const r = (reps > 0) ? reps : 1;
  return weight * (1 + r / 30);
}

// Thresholds for one exercise at one bodyweight, as bodyweight multiples.
function strThresholds(ex, bw){
  const f = Math.pow(bw / STR_REF_BW, STR_SCALE_EXP) * STR_GYMGOER_CALIBRATION;
  // A pull-up or dip already carries the lifter, so the scaling has to run on
  // TOTAL load (bodyweight + added) and the ADDED weight is what falls out of
  // it. Scaling the added weight directly would wrongly let a 120kg lifter
  // add the same multiple as a 55kg one.
  if(ex.total) return ex.ref.map(v => v * f - 1);
  return ex.ref.map(v => v * f);
}

// One exercise → the same 0-100 base the photo grade produces.
function strExScore(ex, bw, kg){
  if(!(bw > 0) || !(kg > 0)) return null;
  const mult = kg / bw;
  const t = strThresholds(ex, bw);
  if(mult <= 0) return 0;
  if(mult < t[0]) return Math.max(0, (mult / t[0]) * STR_ANCHORS[0]);
  for(let i = 0; i < t.length - 1; i++){
    if(mult < t[i + 1]){
      const span = t[i + 1] - t[i];
      const frac = span > 0 ? (mult - t[i]) / span : 0;
      return STR_ANCHORS[i] + frac * (STR_ANCHORS[i + 1] - STR_ANCHORS[i]);
    }
  }
  const top = t[t.length - 1];
  const over = top > 0 ? (mult - top) / top : 0;
  const head = STR_HEAD[ex.t] || STR_HEAD.isolation;
  return 90 + 10 * (1 - Math.exp(-(STR_HEAD_K / (head - 1)) * over));
}

function strLevelName(ex, bw, kg){
  if(!(bw > 0) || !(kg > 0)) return null;
  const mult = kg / bw, t = strThresholds(ex, bw);
  let name = 'Beginner';
  for(let i = 0; i < t.length; i++) if(mult >= t[i]) name = STR_LEVELS[i];
  return name;
}

// ---- persistence: convenience only, same posture as the physique profile ----
// entries: { <exerciseKey>: {w:<weight>, r:<reps>} }
let strengthData = { bw:null, entries:{} };
function saveStrength(){
  try{ localStorage.setItem('pq_strength', JSON.stringify(strengthData)); }catch(e){}
}
function loadStrength(){
  try{
    const raw = localStorage.getItem('pq_strength');
    if(!raw) return;
    const d = JSON.parse(raw);
    if(!d || typeof d !== 'object') return;
    const out = { bw:(d.bw > 0 ? d.bw : null), entries:{} };
    // Migrate the first-version shape ({lifts:{key:kg}}), which stored a bare
    // 1RM with no rep count, into the {w,r} entry shape.
    const src = d.entries || d.lifts;
    if(src && typeof src === 'object'){
      Object.keys(src).forEach(function(k){
        if(!strEx(k)) return;               // drop keys no longer in the library
        const v = src[k];
        if(v && typeof v === 'object'){ if(v.w > 0) out.entries[k] = { w:v.w, r:(v.r > 0 ? v.r : 1) }; }
        else if(v > 0){ out.entries[k] = { w:v, r:1 }; }
      });
    }
    strengthData = out;
  }catch(e){}
}

// Which groups the person has actually trained, including every primary mover
// of each compound lift, in library order.
function strEnteredGroups(){
  const seen = {};
  Object.keys(strengthData.entries).forEach(function(k){
    const ex = strEx(k); if(ex) strPrimaryMovers(ex).forEach(g => { seen[g] = true; });
  });
  return STR_GROUPS.filter(g => seen[g.k]);
}
// Free users rank the first STR_FREE_GROUPS groups they filled in; the rest
// are held back. Pro ranks everything.
function strGroupsAllowed(){
  const entered = strEnteredGroups();
  if(isProHint()) return entered.map(g => g.k);
  return entered.slice(0, STR_FREE_GROUPS).map(g => g.k);
}

// Per-group scores. A compound appears in every primary-mover group, while a
// group still averages its own exercises — extra chest work refines chest
// rather than drowning out legs.
function computeStrengthGroups(){
  const bw = strengthData.bw;
  if(!(bw > 0)) return [];
  const allowed = strGroupsAllowed();
  const byGroup = {};
  Object.keys(strengthData.entries).forEach(function(k){
    const ex = strEx(k); if(!ex) return;
    const e = strengthData.entries[k];
    const orm = strEpley(e.w, e.r);
    const s = strExScore(ex, bw, orm);
    if(s == null) return;
    strPrimaryMovers(ex).forEach(function(groupKey){
      (byGroup[groupKey] = byGroup[groupKey] || []).push({ ex:ex, orm:orm, w:e.w, r:e.r, score:s, level:strLevelName(ex, bw, orm) });
    });
  });
  return STR_GROUPS.filter(g => byGroup[g.k]).map(function(g){
    const rows = byGroup[g.k];
    const score = rows.reduce((a, r) => a + r.score, 0) / rows.length;
    return {
      group:g, rows:rows, score:score,
      grade:scoreToGrade(score),
      locked:allowed.indexOf(g.k) === -1
    };
  });
}

// The strength equivalent of computeOverall(): same shape, same scale.
// Overall is the mean of GROUP scores, not of exercises — otherwise whoever
// logs the most chest lifts gets the highest strength rank.
function computeStrength(){
  const groups = computeStrengthGroups();
  const open = groups.filter(g => !g.locked);
  if(open.length === 0) return null;
  const base = open.reduce((a, g) => a + g.score, 0) / open.length;
  return {
    base: base,
    scores: scaleScores(base),
    grade: scoreToGrade(base),
    groups: groups,
    ranked: open.length,
    held: groups.length - open.length,
    nEx: Object.keys(strengthData.entries).length
  };
}

// ---- Strength screen ----------------------------------------------------

let strSearchQ = '';

function showStrength(){
  show('screen-strength');
  renderStrength();
  track('strength_open', {});
}

function strSetSearch(v){
  strSearchQ = v || '';
  const box = document.getElementById('strPickList');
  if(box) box.innerHTML = strPickListHTML();
}

// Search matches an exercise name or any of its primary movers, so "triceps"
// finds presses as well as isolation work.
function strSearchHits(){
  const q = strSearchQ.trim().toLowerCase();
  const free = STR_EX.filter(e => !strengthData.entries[e.k]);
  if(!q) return free;
  return free.filter(function(e){
    return e.name.toLowerCase().indexOf(q) !== -1 || strPrimaryMovers(e).some(function(k){
      const g = strGroup(k);
      return g && g.name.toLowerCase().indexOf(q) !== -1;
    });
  });
}

function strPickListHTML(){
  const hits = strSearchHits();
  if(hits.length === 0) return '<div class="str-pick-none">Nothing matches that. Try a muscle group &mdash; &ldquo;chest&rdquo;, &ldquo;delts&rdquo;, &ldquo;back&rdquo;.</div>';
  return hits.slice(0, 40).map(function(e){
    const movers = strPrimaryMovers(e).map(k => strGroup(k)).filter(Boolean).map(g => g.name).join(' · ');
    return '<button type="button" class="str-pick" onclick="strAdd(\'' + e.k + '\')">' +
        '<span class="str-pick-name">' + e.name + '</span>' +
        '<span class="str-pick-g">' + movers + '</span>' +
        '<span class="str-pick-add">+</span>' +
      '</button>';
  }).join('') + (hits.length > 40 ? '<div class="str-pick-none">' + (hits.length - 40) + ' more &mdash; keep typing to narrow it.</div>' : '');
}

function strAdd(k){
  const ex = strEx(k);
  if(!ex || strengthData.entries[k]) return;
  strengthData.entries[k] = { w:null, r:1 };
  saveStrength();
  renderStrength();
  track('strength_add_exercise', { ex:k, group:ex.g });
  setTimeout(function(){ const el = document.getElementById('strw-' + k); if(el) el.focus(); }, 40);
}

function strRemove(k){
  delete strengthData.entries[k];
  saveStrength();
  renderStrength();
}

// Reading straight from the DOM on every edit keeps one source of truth and
// means a half-typed row never silently reverts under the person's cursor.
function strSyncFromDOM(){
  const bwEl = document.getElementById('str-bw');
  if(bwEl){ const bw = parseFloat(bwEl.value); strengthData.bw = (bw > 0) ? bw : null; }
  Object.keys(strengthData.entries).forEach(function(k){
    const w = document.getElementById('strw-' + k), r = document.getElementById('strr-' + k);
    if(!w) return;
    const wv = parseFloat(w.value), rv = parseInt(r ? r.value : '1', 10);
    strengthData.entries[k] = { w:(wv > 0 ? wv : null), r:(rv > 0 ? rv : 1) };
  });
  saveStrength();
}

function strRecalc(){
  strSyncFromDOM();
  const out = document.getElementById('strResultWrap');
  if(out) out.innerHTML = strResultHTML(computeStrength());
}

function strEntryRow(k){
  const ex = strEx(k), e = strengthData.entries[k];
  const movers = strPrimaryMovers(ex).map(k => strGroup(k)).filter(Boolean).map(g => g.name).join(' · ');
  const bw = strengthData.bw;
  const orm = strEpley(e.w, e.r);
  const lvl = (bw > 0 && orm) ? strLevelName(ex, bw, orm) : null;
  // A single is its own 1RM, so showing "est. 1RM" there would be noise.
  const est = (orm && e.r > 1) ? '<span class="str-e-orm">&asymp; ' + orm.toFixed(1) + 'kg 1RM</span>' : '';
  return '<div class="str-e">' +
      '<div class="str-e-top">' +
        '<span class="str-e-name">' + ex.name + '</span>' +
        '<button type="button" class="str-e-x" onclick="strRemove(\'' + k + '\')" aria-label="Remove ' + ex.name + '">&times;</button>' +
      '</div>' +
      '<div class="str-e-g">' + movers + '</div>' +
      '<div class="str-e-in">' +
        '<label><input type="number" inputmode="decimal" step="0.5" min="0" max="700" id="strw-' + k + '" ' +
          'value="' + (e.w > 0 ? e.w : '') + '" placeholder="0" oninput="strRecalc()" aria-label="' + ex.name + ' weight"> ' +
          '<span>' + STR_UNITS[ex.u] + '</span></label>' +
        '<label><input type="number" inputmode="numeric" step="1" min="1" max="30" id="strr-' + k + '" ' +
          'value="' + (e.r > 0 ? e.r : 1) + '" oninput="strRecalc()" aria-label="' + ex.name + ' reps"> ' +
          '<span>reps</span></label>' +
      '</div>' +
      '<div class="str-e-out">' + est + (lvl ? '<span class="str-e-lvl">' + lvl + '</span>' : '') +
        // Epley drifts badly above ~10 reps -- one-rep-max-calculator.html says
        // so on the same formula, and a high-rep entry silently inflating into
        // an Elite grade is exactly how this rank loses credibility.
        (e.r > 10 ? '<span class="str-e-warn">high reps &mdash; rough estimate</span>' : '') +
        (ex.soft ? '<span class="str-e-soft">rough standard</span>' : '') +
      '</div>' +
    '</div>';
}

function renderStrength(){
  const keys = Object.keys(strengthData.entries);
  const entered = strEnteredGroups().length;

  const body =
    '<div class="sec-head" style="margin-bottom:22px">' +
      '<h2>Rank your lifts.</h2>' +
      '<p>Strength scored against bodyweight, on the same 1&ndash;10 scale as the photo grade &mdash; so the two can be read side by side. ' +
        'Enter any set and the 1RM is worked out for you.</p>' +
    '</div>' +
    '<div class="str-form">' +
      '<label class="str-row str-row-bw">' +
        '<span class="str-row-name">Bodyweight</span>' +
        '<span class="str-row-in">' +
          '<input type="number" inputmode="decimal" step="0.1" min="30" max="250" id="str-bw" ' +
            'value="' + (strengthData.bw > 0 ? strengthData.bw : '') + '" placeholder="—" oninput="strRecalc()" aria-label="Bodyweight in kg">' +
          '<span class="str-row-unit">kg</span>' +
        '</span>' +
      '</label>' +
      '<div class="str-search">' +
        '<input type="search" id="strSearch" placeholder="Search an exercise or muscle group…" ' +
          'value="' + esc(strSearchQ) + '" oninput="strSetSearch(this.value)" aria-label="Search exercises">' +
        '<div class="str-pick-list" id="strPickList">' + strPickListHTML() + '</div>' +
      '</div>' +
      (keys.length ?
        '<div class="str-entries">' + keys.map(strEntryRow).join('') + '</div>' :
        '<div class="str-empty">No lifts yet. Search above and add the ones you actually train.</div>') +
      (entered > 0 && !isProHint() ?
        '<div class="str-cap-note">Free ranks <b>' + STR_FREE_GROUPS + ' muscle groups</b>. ' +
          'You have ' + entered + '. Pro ranks every group and unlocks the body heatmap.</div>' : '') +
    '</div>' +
    '<div id="strResultWrap">' + strResultHTML(computeStrength()) + '</div>';

  document.getElementById('strengthBody').innerHTML = body;
}

function strGroupRowHTML(g){
  if(g.locked){
    return '<div class="str-g str-g-locked">' +
        '<span class="str-g-name">' + g.group.name + '</span>' +
        '<span class="str-g-lock">Pro</span>' +
      '</div>';
  }
  return '<div class="str-g grade-' + g.grade + '">' +
      '<span class="str-g-name">' + g.group.name + '</span>' +
      '<span class="str-g-n">' + (g.score / 10).toFixed(1) + '</span>' +
      '<div class="str-g-track"><div class="str-g-fill" style="width:' + Math.min(100, g.score).toFixed(0) + '%"></div></div>' +
      '<span class="str-g-lvl">' + gradeLabel(g.grade) + '</span>' +
    '</div>';
}

function strResultHTML(r){
  if(!r) return '';
  const gc = ' grade-' + r.grade;
  return '<div id="strResult" class="str-result' + gc + '">' +
      '<div class="res-sec-eyebrow">Your strength rank</div>' +
      '<div class="str-hero">' +
        '<div class="str-hero-letter">' + r.grade + '</div>' +
        '<div class="str-hero-right">' +
          '<div class="str-hero-label">' + gradeLabel(r.grade) + '</div>' +
          '<div class="str-hero-scores">' +
          '<div class="str-hero-stat"><b>' + fmtScale(r.scores.gym) + '</b><span>vs gym-goers</span></div>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="str-groups">' + r.groups.map(strGroupRowHTML).join('') + '</div>' +
      (r.held > 0 ? '<div class="str-cap-note">' + r.held + ' more muscle group' + (r.held > 1 ? 's' : '') +
        ' entered but not ranked on Free.</div>' : '') +
      '<div class="rank-note">Compound lifts count toward each primary muscle they train. Each group averages the exercises that hit it, and the overall rank ' +
        'is the average of the groups &mdash; so logging five chest lifts refines chest rather than outweighing legs. ' +
        'Thresholds are estimates, not measured fact. Anything tagged ' +
        '<b>rough standard</b> is a considered guess rather than a figure anchored in ' +
        'competition records &mdash; no federation contests a lateral raise, and machine ' +
        'loads are not comparable between manufacturers.</div>' +
      strHeatmapHTML(r) +
      buildRankHTML(r.base, r.grade, false, { free:true }) +
      '<button class="btn ghost" style="margin-top:12px" onclick="showProfile()">See your full profile &rarr;</button>' +
    '</div>';
}

// ---- Body heatmap (Pro) -------------------------------------------------
// Coordinates trace the neutral anatomical artwork, in its native 1254px square.
// Paired regions are mirrored about each figure's midline. Rear delts remain
// outside the map. All scores, group membership and Pro gating are unchanged.
const STR_BODY = {
  front:{
    axis:344,
    pair:[
      {k:'chest',d:'M263 260 C287 259 321 268 334 289 C340 308 343 344 335 361 C329 382 295 384 269 377 C243 371 229 350 225 329 C232 305 245 279 263 260 Z'},
      {k:'latdelt',d:'M233 251 C201 250 180 267 169 291 C160 312 164 342 178 362 L190 342 C194 310 211 276 233 251 Z'},
      {k:'frontdelt',d:'M236 251 C246 250 257 252 265 257 C250 280 232 304 219 329 L191 343 C197 309 210 276 236 251 Z'},
      {k:'biceps',d:'M217 333 C229 352 228 382 215 415 C205 440 193 453 180 455 C164 445 168 417 179 390 C188 364 201 344 217 333 Z'},
      {k:'forearms',d:'M148 436 C164 446 169 462 165 490 C160 529 145 563 130 590 L120 608 L105 605 C111 574 111 540 119 505 C125 475 135 449 148 436 Z M173 460 L197 450 C196 481 180 522 160 548 L136 584 C143 549 165 499 173 460 Z'},
      {k:'core',d:'M325 377 C331 375 338 378 340 385 L340 402 C324 402 308 405 291 414 L283 397 C296 387 310 380 325 377 Z M290 417 C306 408 329 405 339 409 L341 438 C325 437 309 439 290 445 C286 436 286 426 290 417 Z M290 449 C307 442 328 442 340 445 L341 484 C327 490 313 491 300 488 C292 480 289 463 290 449 Z M295 494 C308 491 329 493 341 499 L340 557 L310 555 C301 540 295 516 295 494 Z M245 397 C254 420 268 438 282 448 L291 546 C274 533 253 509 248 487 C242 460 237 428 245 397 Z'},
      {k:'quads',d:'M216 681 L274 697 C275 725 261 759 249 784 C246 800 239 818 230 833 C215 812 204 791 201 766 C197 736 205 700 216 681 Z M278 698 L332 702 C328 750 311 785 300 814 C295 835 283 850 274 842 C256 835 254 813 253 795 C265 761 280 727 278 698 Z'}
    ]
  },
  back:{
    axis:900,
    pair:[
      {k:'traps',d:'M856 205 C843 222 813 237 789 249 C818 248 839 251 855 265 C871 280 889 293 892 313 L893 404 C875 387 859 366 848 343 C837 318 835 290 832 270 L815 257 C840 253 859 233 865 215 L867 205 Z'},
      {k:'back',d:'M779 365 C810 369 837 369 851 360 C860 381 877 403 887 421 C887 444 874 468 860 488 L842 519 C829 484 813 466 800 440 C787 414 781 389 779 365 Z'},
      {k:'triceps',d:'M755 329 C767 342 778 365 777 388 C775 415 754 445 737 459 C725 441 717 414 724 388 C731 361 744 338 755 329 Z M729 340 C718 359 704 381 703 404 C701 421 706 438 715 448 C715 415 723 378 739 355 Z'},
      {k:'forearms',d:'M700 444 C713 449 724 462 725 480 C719 510 703 544 688 578 L678 612 L661 613 C662 578 665 541 673 507 C679 481 689 460 700 444 Z M729 462 L739 475 C730 511 709 548 690 579 C698 545 720 493 729 462 Z'},
      {k:'glutes',d:'M796 561 C825 551 866 552 896 557 L896 655 C873 673 844 676 817 666 C797 659 779 649 780 632 L789 582 Z'},
      {k:'hamstrings',d:'M780 697 L827 703 C830 750 818 797 793 839 L777 873 C770 848 767 815 767 784 C766 753 773 721 780 697 Z M831 705 L892 705 C887 758 873 811 853 857 L839 885 C831 863 819 850 808 845 C824 803 839 755 831 705 Z'},
      {k:'calves',d:'M791 882 C808 900 811 930 803 958 C793 986 782 1010 768 1023 C751 1005 748 985 750 965 C754 937 771 902 791 882 Z M799 879 C817 884 836 901 842 928 C851 955 848 979 838 1007 C833 1025 827 1035 821 1034 C805 1025 800 1007 802 987 C811 955 816 917 799 879 Z'}
    ]
  }
};

let strHeatSelection = '';

function strInspectMuscle(control){
  const map = control.closest('.str-heat');
  if(!map || map.classList.contains('locked')) return;
  const key = control.dataset.muscle || control.value;
  const region = map.querySelector('[data-muscle="' + key + '"]');
  if(!region) return;
  strHeatSelection = key;
  map.querySelectorAll('[data-muscle]').forEach(function(el){
    el.setAttribute('aria-pressed', String(el.dataset.muscle === key));
  });
  map.querySelector('.hm-picker select').value = key;
  map.querySelector('.hm-reading').textContent = region.dataset.reading;
}

function strHeatmapHTML(r){
  const locked = !isProHint(), byGroup = {}, paths = {};
  r.groups.forEach(function(g){ if(!g.locked) byGroup[g.group.k] = g; });
  Object.keys(STR_BODY).forEach(function(side){
    const body = STR_BODY[side];
    body.pair.forEach(function(p){
      const shape = '<path d="' + p.d + '"/>';
      paths[p.k] = (paths[p.k] || '') + shape +
        '<g transform="translate(' + (body.axis * 2) + ',0) scale(-1,1)">' + shape + '</g>';
    });
  });
  const selected = STR_GROUPS.some(g => g.k === strHeatSelection) ? strHeatSelection : '';
  function reading(key){
    const g = byGroup[key];
    return g ? (g.score / 10).toFixed(1) + '/10 · ' + g.grade + ' · ' + gradeLabel(g.grade) : 'No data — add a lift to rank';
  }
  const regions = STR_GROUPS.map(function(group){
    const g = byGroup[group.k], value = reading(group.k);
    return '<g class="hm-muscle ' + (g ? 'grade-' + g.grade : 'hm-none') + '" ' +
      'role="button" tabindex="' + (locked ? '-1' : '0') + '" data-muscle="' + group.k + '" ' +
      'data-reading="' + esc(value) + '" aria-label="' + esc(group.name + ': ' + value) + '" ' +
      'aria-pressed="' + (selected === group.k) + '" onclick="strInspectMuscle(this)" ' +
      'onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();strInspectMuscle(this)}">' +
      '<title>' + esc(group.name + ' — ' + value) + '</title>' + paths[group.k] + '</g>';
  }).join('');
  return '<section class="str-heat reslock' + (locked ? ' locked' : '') + '" aria-label="Muscle strength map">' +
    '<div class="reslock-in"' + (locked ? ' inert aria-hidden="true"' : '') + '>' +
      '<div class="hm-heading"><h3>Muscle map</h3><span>Strength by muscle group</span></div>' +
      '<div class="hm-stage"><svg class="hm-anatomy" viewBox="0 0 1254 1254" role="group" aria-label="Front and back muscle map. Select a muscle to see its rank.">' +
        '<image class="hm-art" href="/assets/strength-anatomy.png" width="1254" height="1254" aria-hidden="true"/>' +
        regions + '</svg></div>' +
      '<div class="hm-captions" aria-hidden="true"><span>Front</span><span>Back</span></div>' +
      '<div class="hm-legend" aria-label="Grade colour key">' +
        ['E','D','C','B','A','S'].map(g => '<span class="hm-key grade-' + g + '">' + g + '</span>').join('') +
        '<span class="hm-key hm-none-key">No data</span>' +
      '</div>' +
      '<div class="hm-inspect"><label class="hm-picker">' +
        '<select aria-label="Inspect muscle group" onchange="strInspectMuscle(this)">' +
          '<option value="" disabled' + (!selected ? ' selected' : '') + '>Select a muscle</option>' +
          STR_GROUPS.map(g => '<option value="' + g.k + '"' + (selected === g.k ? ' selected' : '') + '>' + g.name + '</option>').join('') +
        '</select></label><div class="hm-reading" aria-live="polite" aria-atomic="true">' +
          (selected ? esc(reading(selected)) : 'Tap the map to explore') + '</div></div>' +
      '<div class="rank-note">Grey means no lift data. Colours reflect your logged strength, not muscle size.</div>' +
    '</div>' + (locked ? proVeil('Unlock your body heatmap') : '') +
  '</section>';
}


// ---- Profile: both ranks, and the plot that puts them against each other --

function showProfile(){
  show('screen-profile');
  renderProfile();
  track('profile_open', {});
}

function strRankTile(kind, r, href, missingMsg){
  if(!r) return '<div class="pf-tile pf-tile-empty">' +
      '<div class="pf-tile-kind">' + kind + '</div>' +
      '<div class="pf-tile-missing">' + missingMsg + '</div>' +
    '</div>';
  return '<div class="pf-tile grade-' + r.grade + '">' +
      '<div class="pf-tile-kind">' + kind + '</div>' +
      '<div class="pf-tile-letter">' + r.grade + '</div>' +
      '<div class="pf-tile-label">' + gradeLabel(r.grade) + '</div>' +
      '<div class="pf-tile-scores">' +
        '<span><b>' + fmtScale(r.scores.gym) + '</b> vs gym-goers</span>' +
      '</div>' +
    '</div>';
}

// Strength (x) against physique (y). Deliberately the same quadrant plot as
// mass-vs-conditioning, because it answers the same shape of question and a
// second chart language would just make the two harder to compare.
function buildStrengthPhysiqueHTML(phys, str){
  if(!phys || !str) return '';
  const py100 = Math.max(0, Math.min(100, phys.capBase != null ? phys.capBase : phys.base));
  const sx100 = Math.max(0, Math.min(100, str.base));
  const diff = py100 - sx100;
  const type = diff >= 18 ? 'Looks ahead of lifts'
             : (diff <= -18 ? 'Lifts ahead of looks' : 'Balanced');

  const W = 320, H = 250, x0 = 34, x1 = 302, y0 = 16, y1 = 214;
  const plotW = x1 - x0, plotH = y1 - y0;
  const px = v => x0 + (v / 100) * plotW, pyf = v => y1 - (v / 100) * plotH;
  const dvx = px(50).toFixed(1), dvy = pyf(50).toFixed(1);
  const dotx = px(sx100).toFixed(1), doty = pyf(py100).toFixed(1);

  const quad = '<text class="mcp-quad" x="' + (x0 + 7) + '" y="' + (y0 + 13) + '" font-size="7.5">Aesthetic</text>' +
    '<text class="mcp-quad" x="' + (x1 - 7) + '" y="' + (y0 + 13) + '" text-anchor="end" font-size="7.5">Complete</text>' +
    '<text class="mcp-quad" x="' + (x0 + 7) + '" y="' + (y1 - 7) + '" font-size="7.5">Developing</text>' +
    '<text class="mcp-quad" x="' + (x1 - 7) + '" y="' + (y1 - 7) + '" text-anchor="end" font-size="7.5">Strong</text>';

  const right = sx100 < 50;
  const lblx = right ? (Number(dotx) + 9) : (Number(dotx) - 9);
  const anchor = right ? 'start' : 'end';

  const ax = '<text class="mcp-axtitle" x="' + ((x0 + x1) / 2).toFixed(1) + '" y="' + (y1 + 22) + '" text-anchor="middle" font-size="8">Strength</text>' +
    '<text class="mcp-axend" x="' + x0 + '" y="' + (y1 + 13) + '" font-size="7">Untrained</text>' +
    '<text class="mcp-axend" x="' + x1 + '" y="' + (y1 + 13) + '" text-anchor="end" font-size="7">Elite</text>' +
    '<text class="mcp-axtitle" x="13" y="' + ((y0 + y1) / 2).toFixed(1) + '" text-anchor="middle" font-size="8" transform="rotate(-90 13 ' + ((y0 + y1) / 2).toFixed(1) + ')">Physique</text>';

  return '<div class="res-mc grade-' + phys.grade + '">' +
    '<div class="res-sec-eyebrow">Strength vs physique</div>' +
    '<div class="mc-head"><div class="mc-stats">' +
      '<div class="mc-stat"><b class="mc-mass">' + (py100 / 10).toFixed(1) + '</b><span>Physique</span></div>' +
      '<div class="mc-stat"><b class="mc-cond">' + (sx100 / 10).toFixed(1) + '</b><span>Strength</span></div>' +
    '</div><span class="rank-tag">AI estimate + your lifts</span></div>' +
    '<div class="mc-type"><b>' + type + '</b> &mdash; graded independently, so neither one carries the other.</div>' +
    '<svg class="mc-plot" viewBox="0 0 ' + W + ' ' + H + '" aria-hidden="true">' +
      '<line class="mcp-div" x1="' + dvx + '" y1="' + y0 + '" x2="' + dvx + '" y2="' + y1 + '"/>' +
      '<line class="mcp-div" x1="' + x0 + '" y1="' + dvy + '" x2="' + x1 + '" y2="' + dvy + '"/>' +
      '<rect class="mcp-frame" x="' + x0 + '" y="' + y0 + '" width="' + plotW + '" height="' + plotH + '" rx="4"/>' +
      quad +
      '<circle class="mcp-ring" cx="' + dotx + '" cy="' + doty + '" r="9"/>' +
      '<circle class="mcp-dot" cx="' + dotx + '" cy="' + doty + '" r="5"/>' +
      '<text class="mcp-you" x="' + lblx.toFixed(1) + '" y="' + (Number(doty) + 3).toFixed(1) + '" text-anchor="' + anchor + '" font-size="7.5">You</text>' +
      ax +
    '</svg>' +
    '<div class="rank-note">The photo grade cannot see what you lift and the lift table cannot see what you look like. ' +
      'Where the two disagree is the useful part.</div>' +
  '</div>';
}

function renderProfile(){
  const phys = computeOverall();
  const str = computeStrength();

  document.getElementById('profileBody').innerHTML =
    '<div class="sec-head" style="margin-bottom:22px">' +
      '<h2>Your profile.</h2>' +
      '<p>Two ranks, same scale. One from the photo, one from the bar.</p>' +
    '</div>' +
    '<div class="pf-tiles">' +
      strRankTile('Physique', phys, null, 'No scan yet.') +
      strRankTile('Strength', str, null, 'No lifts entered yet.') +
    '</div>' +
    (phys && str ? buildStrengthPhysiqueHTML(phys, str) :
      '<div class="pf-need">' +
        (!phys ? '<p>Scan a photo to get your physique rank.</p>' : '') +
        (!str ? '<p>Enter your lifts to get your strength rank.</p>' : '') +
        '<p class="pf-need-sub">The comparison chart needs both.</p>' +
      '</div>') +
    '<div class="pf-actions">' +
      '<button class="btn ghost" onclick="showStrength()">' + (str ? 'Update my lifts' : 'Enter my lifts') + '</button>' +
      '<button class="btn ghost" onclick="show(\'screen-home\')">&larr; Back</button>' +
    '</div>';
}
