// Private presentation; every generation is authorized again by the worker.
let devAllowed=false, devBusy=false, devPhoto=null, devResult=null, devFrame=0;
function resetDevAccess(){
  devAllowed=false;cancelAnimationFrame(devFrame);
  document.getElementById('devAccessTab').hidden=true;
  document.getElementById('devCard').replaceChildren();
  devResult=null;
  if(devPhoto){URL.revokeObjectURL(devPhoto);devPhoto=null;}
  if(document.getElementById('screen-dev').classList.contains('active')) show('screen-home');
}
async function refreshDevAccess(){
  const token=entitlementToken;
  if(!token){resetDevAccess();return false;}
  try{
    const res=await fetch(WORKER_URL,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({action:'dev_access'})});
    const data=await res.json();
    if(token!==entitlementToken)return false;
    devAllowed=res.ok&&data.dev_access===true;
    document.getElementById('devAccessTab').hidden=!devAllowed;
    if(!devAllowed)resetDevAccess();
    return devAllowed;
  }catch(e){if(token===entitlementToken)resetDevAccess();return false;}
}
async function showDevAccess(){
  if(!hasFreshEntitlementToken())await refreshEntitlementToken();
  if(await refreshDevAccess())show('screen-dev');
}
function devMetrics(data){
  const m=data.muscles||{}, keys=MUSCLES.filter(k=>k!=='conditioning'&&m[k]&&m[k].score!=null);
  const mass=keys.length?Math.round(keys.reduce((s,k)=>s+m[k].score,0)/keys.length):null;
  const cond=m.conditioning&&m.conditioning.score!=null?Math.round(m.conditioning.score):condFromBodyfat(data.bodyfat_range,mass);
  const score=blendScore(mass,cond), base=rawBase(mass,cond);
  if(score==null||base==null)throw new Error('No readable physique. Try a clearer photo.');
  const scaled=scaleScores(base);
  return {grade:scoreToGrade(score),displayScore:scaled.gym,pct:scalePercentile(scaled.gymExact,SCALE_GYM_MEAN,SCALE_GYM_SD_PER_POINT)};
}
function renderDevCard(grade,view,loading){
  const host=document.getElementById('devCard');
  host.innerHTML=buildSignatureCard(grade,devPhoto,view+' view',null,'dev-card'+(loading?' dev-scanning':''),'');
  const card=host.firstElementChild;
  card.querySelector('.vc-footer').insertAdjacentHTML('beforebegin','<div class="dev-rank"><span class="dev-rank-label">PHYSIQUE SCORE</span><strong class="dev-score"><span class="dev-score-number">—</span><span class="dev-score-total"> / 10</span></strong><span class="dev-placement">'+(loading?'Reading your photo…':'')+'</span></div>');
  card.querySelector('.signature-footnote').innerHTML='<span>Modelled estimate · 18+</span><span class="vc-site">cutrank.app</span>';
  card.querySelector('.vc-disc-wrap').insertAdjacentHTML('beforeend','<span class="dev-sweep" aria-hidden="true"></span>');
  if(loading){card.querySelector('.vc-grade-label').textContent='Analysing';card.querySelector('.signature-label').textContent='Your physique';}
  return card;
}
function replayDevReveal(){
  if(!devResult||!devAllowed||devBusy)return;
  document.getElementById('devStatus').textContent='Playing the reveal…';
  cancelAnimationFrame(devFrame);
  const {metrics,view}=devResult, card=renderDevCard(metrics.grade,view,false);
  const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
  // One continuous reveal: photo, grade, then the same /10 score used by the app.
  const duration=reduced?0:2800, start=performance.now();
  card.classList.add(reduced?'dev-finished':'dev-revealing');
  function frame(now){
    if(!card.isConnected||!devAllowed)return;
    const elapsed=now-start, progress=duration?Math.min(1,Math.max(0,(elapsed-1100)/1700)):1;
    const displayScore=metrics.displayScore*(1-Math.pow(1-progress,3));
    card.querySelector('.dev-score-number').textContent=displayScore.toFixed(1);
    card.querySelector('.dev-placement').textContent=rankLabel(metrics.pct,RANK_FLOOR_GYM);
    if(elapsed<duration)devFrame=requestAnimationFrame(frame);
    else{card.classList.remove('dev-revealing');card.classList.add('dev-finished');document.getElementById('devStatus').textContent='Reveal ready. Replay it whenever you’re recording.';}
  }
  devFrame=requestAnimationFrame(frame);
}
document.getElementById('devUpload').addEventListener('change',async event=>{
  const file=event.target.files[0];event.target.value='';
  if(!file||devBusy)return;
  const status=document.getElementById('devStatus'),upload=event.target,replay=document.getElementById('devReplay');
  if(!file.type.startsWith('image/')||file.size>20*1024*1024){status.textContent='Choose an image under 20MB.';return;}
  devBusy=true;upload.disabled=true;document.getElementById('devUploadButton').disabled=true;replay.disabled=true;devResult=null;cancelAnimationFrame(devFrame);
  const viewId=document.getElementById('devView').value,view=VIEWS.find(v=>v.id===viewId).t;
  try{
    status.textContent='Checking access…';
    if(!hasFreshEntitlementToken())await refreshEntitlementToken();
    if(!await refreshDevAccess())throw new Error('Dev Access is unavailable. Sign in with your authorized account.');
    if(devPhoto)URL.revokeObjectURL(devPhoto);
    devPhoto=URL.createObjectURL(file);renderDevCard('—',view,true);
    status.textContent='Grading your photo…';
    const prepared=window.CutRankPhotos?await window.CutRankPhotos.prepare(file):{image:await normaliseToJpeg(file)};
    async function request(){return fetch(WORKER_URL,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+entitlementToken},body:JSON.stringify({action:'dev_grade',region:viewId,...prepared,media_type:'image/jpeg'})});}
    let res=await request();
    if(res.status===401&&await refreshEntitlementToken())res=await request();
    const data=await res.json();
    if(!res.ok)throw new Error(res.status===429?'Daily scan limit reached. Try again tomorrow.':res.status===403?'This account does not have Dev Access.':'Generation failed. Please try again.');
    if(data.refused)throw new Error('This photo could not be graded ('+String(data.reason||'unclear photo')+'). Choose another adult physique photo.');
    if(!devAllowed)throw new Error('Access changed. Sign in again.');
    devResult={metrics:devMetrics(data),view};devBusy=false;replay.disabled=false;replayDevReveal();
  }catch(error){
    document.getElementById('devCard').replaceChildren();
    if(devPhoto){URL.revokeObjectURL(devPhoto);devPhoto=null;}
    status.textContent=error.message||'Could not process this image. Try another photo.';
  }finally{devBusy=false;upload.disabled=false;document.getElementById('devUploadButton').disabled=false;}
});
window.addEventListener('pagehide',()=>{cancelAnimationFrame(devFrame);if(devPhoto)URL.revokeObjectURL(devPhoto);});
