// The workspace is a view of existing scan, history and Improve data. It does
// not create scores or store photos. Paid history still comes from the worker.
let dashboardHistory=null;
let dashboardHistoryError=false;
let dashboardImprove=null;

function dashboardDate(ts){
  const date=new Date(Number(ts)*1000);
  return Number.isFinite(date.getTime())
    ? date.toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'})
    : 'Date unavailable';
}

function dashboardGrade(score){
  if(score==null) return '—';
  const value=Number(score);
  return Number.isFinite(value)?scoreToGrade(value):'—';
}

function dashboardScore(score){
  if(score==null) return '—';
  const value=Number(score);
  return Number.isFinite(value)?(Math.max(0,Math.min(100,value))/10).toFixed(1):'—';
}

function dashboardScanAction(){
  const done=VIEWS.filter(v=>viewsDone[v.id]);
  const next=VIEWS.find(v=>!viewsDone[v.id]);
  if(!done.length) return {label:'Start your first scan',action:"goHome('scanSection')"};
  if(next && hasEntitlementHint()) return {label:'Scan '+next.t.toLowerCase()+' view',action:"goHome('scanSection')"};
  if(next) return {label:'Unlock all four angles',action:"handlePurchase('scan')"};
  if(isProHint()) return {label:'Start a rescan',action:"goHome('scanSection')"};
  return {label:'Review scan history',action:'showHistory()'};
}

function dashboardCoverage(){
  const used=VIEWS.filter(v=>viewsDone[v.id]).length;
  return VIEWS.map((view,index)=>{
    const done=!!viewsDone[view.id];
    const locked=!done && used>0 && !hasEntitlementHint();
    const status=done?'Scanned':locked?'Unlock to scan':index===0?'Start here':'Ready to scan';
    const action=locked?"handlePurchase('scan')":"goHome('scanSection')";
    return '<button class="db-angle'+(done?' done':'')+(locked?' locked':'')+'" onclick="'+action+'" aria-label="'+esc(view.t)+': '+status+'">'+
      '<span class="db-angle-icon" aria-hidden="true">'+view.letter+'</span>'+
      '<span class="db-angle-copy"><strong>'+esc(view.t)+'</strong><small>'+status+'</small></span>'+
      '<span class="db-angle-arrow" aria-hidden="true">'+(done?'✓':'→')+'</span>'+
    '</button>';
  }).join('');
}

function dashboardHistoryHTML(){
  if(!hasEntitlementHint()) return '<div class="db-empty"><strong>Your scan record starts here.</strong><p>Saved scan history comes with the Full Body Audit. Restore access if you have already purchased it.</p><div class="db-inline-actions"><button onclick="showHistory()">See history access →</button><button onclick="openRecoveryModal()">Restore access</button></div></div>';
  if(dashboardHistoryError) return '<div class="db-empty"><strong>History is unavailable right now.</strong><p>Your saved scans could not be loaded. Try again from History.</p><button onclick="showHistory()">Try History →</button></div>';
  if(dashboardHistory===null) return '<div class="db-empty"><strong>Loading your scans…</strong></div>';
  if(!dashboardHistory.length) return '<div class="db-empty"><strong>No saved scans yet.</strong><p>Paid scans will appear here after you complete an angle.</p><button onclick="goHome(\'scanSection\')">Scan an angle →</button></div>';
  const names={front:'Front',back:'Back',legs:'Legs',arms_side:'Arms / Side'};
  return dashboardHistory.slice().sort((a,b)=>(Number(b.ts)||0)-(Number(a.ts)||0)).slice(0,3).map(h=>
    '<div class="db-history-row"><span class="db-history-grade">'+dashboardGrade(h.score)+'</span>'+
      '<span class="db-history-info"><strong>'+esc(names[h.region]||'Scan')+'</strong><small>'+esc(dashboardDate(h.ts))+'</small></span>'+
      '<span class="db-history-score">'+dashboardScore(h.score)+'<small>/10</small></span></div>'
  ).join('');
}

function dashboardProgressHTML(){
  if(!isProHint()) return '<p>Compare two scans of the same angle to see what changed after a training block.</p><span class="db-feature-tag">PRO FEATURE</span>';
  if(!dashboardHistory || dashboardHistoryError) return '<p>Repeat an angle after your next training block to see the change here.</p>';
  const groups={};
  const newest=dashboardHistory.slice().sort((a,b)=>(Number(b.ts)||0)-(Number(a.ts)||0))[0];
  const version=newest?.scoring_version||'legacy-unknown';
  dashboardHistory.filter(h=>(h.scoring_version||'legacy-unknown')===version).forEach(h=>{
    if(!VIEWS.some(v=>v.id===h.region) || h.score==null || !Number.isFinite(Number(h.score))) return;
    (groups[h.region]=groups[h.region]||[]).push(h);
  });
  const comparable=Object.entries(groups).filter(([,list])=>list.length>=2)
    .map(([region,list])=>({region,list:list.sort((a,b)=>(Number(b.ts)||0)-(Number(a.ts)||0))}))
    .sort((a,b)=>(Number(b.list[0].ts)||0)-(Number(a.list[0].ts)||0))[0];
  if(!comparable) return '<p>No same-angle comparison yet. Rescan one angle in similar lighting and pose to build a useful trend.</p>';
  const latest=Number(comparable.list[0].score),previous=Number(comparable.list[1].score);
  const delta=(latest-previous)/10;
  const name=VIEWS.find(v=>v.id===comparable.region).t;
  return '<div class="db-progress-delta '+(delta>0?'up':delta<0?'down':'flat')+'">'+(delta>0?'+':'')+delta.toFixed(1)+' <small>/10</small></div>'+
    '<p>'+esc(name)+' view since '+esc(dashboardDate(comparable.list[1].ts))+'. Compare matched scans before reading a small change as progress.</p>';
}

function dashboardPlanHTML(lowest,done){
  const report=isProHint()&&dashboardImprove?.report;
  const firstChange=report?.training?.changes?.find(change=>change?.action);
  const focus=report?.focus;
  const weeks=Number(report?.recheck_weeks);
  const created=Number(dashboardImprove?.created);
  const recheck=Number.isFinite(weeks)&&weeks>0&&weeks<=52&&Number.isFinite(created)&&created>0
    ?dashboardDate(created+weeks*7*86400):null;
  const observation=lowest
    ?'<div class="db-focus"><span>LOWEST VISIBLE MUSCLE SCORE</span><strong>'+esc(cap(lowest))+'</strong><small>'+dashboardScore(profile[lowest].score)+'/10 from your current profile · a visual observation, not a training diagnosis</small></div>'
    :'<p>Your first scan will give you a starting point.</p>';
  return '<section class="db-card db-next" aria-labelledby="dbPlanTitle">'+
    '<span class="db-kicker">YOUR NEXT BLOCK</span><h2 id="dbPlanTitle">From scan to progress.</h2>'+
    (focus?'<div class="db-plan-report"><span>YOUR IMPROVE FOCUS</span><strong>'+esc(focus)+'</strong>'+
      (firstChange?'<p><b>'+esc(firstChange.area||'Training')+':</b> '+esc(firstChange.action)+'</p>':'')+'</div>':observation)+
    '<ol class="db-plan-steps">'+
      '<li class="'+(done.length?'complete':'')+'"><span>01</span><div><strong>Get a baseline</strong><small>'+(done.length?done.length+' of 4 angles scanned':'Start with a front view')+'</small></div></li>'+
      '<li class="'+(focus?'complete':'')+'"><span>02</span><div><strong>Choose your focus</strong><small>'+(focus?'Your Improve report is ready':isProHint()?'Review your training in Improve':'Add your training details in Improve with Pro')+'</small></div></li>'+
      '<li><span>03</span><div><strong>Rescan the same angle</strong><small>'+(recheck?'Report suggests a recheck around '+esc(recheck):'Keep pose, distance and lighting similar')+'</small></div></li>'+
    '</ol>'+
    '<div class="db-plan-actions"><button class="db-plan-primary" onclick="'+(done.length?'showImprove()':"goHome('scanSection')")+'">'+(done.length?'Open Improve':'Start a scan')+' →</button>'+
      (done.length?'<button class="db-text-link" onclick="showProgress()">View progress →</button>':'')+'</div>'+
    (!isProHint()?'<span class="db-feature-tag">IMPROVE REQUIRES PRO</span>':'')+
  '</section>';
}

function renderDashboard(){
  const body=document.getElementById('dashboardBody');
  if(!body) return;
  const overall=computeOverall();
  const done=VIEWS.filter(v=>viewsDone[v.id]);
  const action=dashboardScanAction();
  const tier=tierDisplayLabel(userTierDisplay);
  const muscles=MUSCLES.filter(k=>k!=='conditioning' && profile[k] && Number.isFinite(Number(profile[k].score)))
    .sort((a,b)=>Number(profile[a].score)-Number(profile[b].score));
  const lowest=muscles[0];
  const grade=overall?overall.grade:'—';
  const score=overall?.scores?.gym!=null?fmtScale(overall.scores.gym):'—';
  body.innerHTML=
    '<div class="db-heading"><div><span class="db-eyebrow">YOUR CUTRANK WORKSPACE <i></i> '+esc(tier)+'</span>'+
      '<h1>Your physique, over time.</h1><p>Review the scan you have, choose your next angle, and return after a training block to see what moved.</p></div>'+
      '<button class="db-heading-cta" onclick="goHome(\'scanSection\')">＋ New scan</button></div>'+
    '<div class="db-layout"><main class="db-main">'+
      '<section class="db-card db-overview" aria-labelledby="dbOverviewTitle">'+
        '<div class="db-card-heading"><div><span class="db-kicker">01 / CURRENT READ</span><h2 id="dbOverviewTitle">Physique overview</h2></div><span class="db-meta">'+done.length+' of 4 angles</span></div>'+
        '<div class="db-overview-inner"><div class="db-grade grade-'+grade+'"><span>Current profile</span><strong>'+grade+'</strong><small>'+esc(overall?gradeLabel(grade):'No scan yet')+'</small></div>'+
          '<div class="db-overview-copy"><div class="db-score"><strong>'+score+'</strong><span>/10 · modelled score</span></div>'+
            '<p>'+(overall?(done.length<4?'This profile is based on '+done.length+' angle'+(done.length===1?'':'s')+'. The overall grade stays capped until the missing views are scanned.':'All four angles have been scanned for this profile.'):'Your first scan gives you a grade and visible muscle scores. More angles build a fuller profile.')+'</p>'+
            '<button class="db-primary" onclick="'+action.action+'">'+esc(action.label)+' →</button></div></div>'+
      '</section>'+
      '<section class="db-card" aria-labelledby="dbCoverageTitle"><div class="db-card-heading"><div><span class="db-kicker">02 / BUILD YOUR PROFILE</span><h2 id="dbCoverageTitle">Scan coverage</h2></div><span class="db-meta">Front · Back · Legs · Arms</span></div>'+
        '<div class="db-angles">'+dashboardCoverage()+'</div></section>'+
      '<section class="db-card" aria-labelledby="dbHistoryTitle"><div class="db-card-heading"><div><span class="db-kicker">03 / YOUR RECORD</span><h2 id="dbHistoryTitle">Recent scans</h2></div><button class="db-text-link" onclick="showHistory()">View all →</button></div>'+
        dashboardHistoryHTML()+'</section>'+
    '</main><aside class="db-side" aria-label="Your next steps">'+
      dashboardPlanHTML(lowest,done)+
      '<section class="db-card db-progress"><span class="db-kicker">TRACK THE CHANGE</span><h2>Progress</h2>'+dashboardProgressHTML()+
        '<button class="db-text-link" onclick="showProgress()">Compare scans →</button></section>'+
      '<section class="db-card db-small"><span class="db-kicker">BEYOND THE PHOTO</span><h2>Strength profile</h2><p>Enter your lifts to see how your strength rank compares with your physique read.</p><button class="db-text-link" onclick="showStrength()">Open Strength →</button></section>'+
    '</aside></div>'+
    '<p class="db-disclaimer">Scores are AI visual estimates. Compare scans taken at the same angle, distance, pose and lighting. CutRank does not store your uploaded photos.</p>';
}

async function showDashboard(){
  if(!await requireWorkspaceAccess('screen-dashboard')) return;
  dashboardHistory=null;
  dashboardHistoryError=false;
  dashboardImprove=null;
  show('screen-dashboard');
  renderDashboard();
  track('dashboard_viewed');
  if(userEmail && !hasFreshEntitlementToken()) await refreshEntitlementToken().catch(()=>{});
  if(!document.getElementById('screen-dashboard').classList.contains('active')) return;
  renderDashboard();
  if(!hasEntitlementHint()) return;
  const request=async action=>{
    const res=await fetch(WORKER_URL,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+entitlementToken},body:JSON.stringify({action})});
    if(!res.ok) throw new Error(action+'_failed');
    return res.json();
  };
  const [history,improve]=await Promise.allSettled([
    request('get_history'),
    isProHint()?request('get_improve'):Promise.resolve(null)
  ]);
  if(history.status==='fulfilled'&&Array.isArray(history.value?.history)) dashboardHistory=history.value.history;
  else dashboardHistoryError=true;
  if(improve.status==='fulfilled'&&improve.value?.record?.report) dashboardImprove=improve.value.record;
  if(document.getElementById('screen-dashboard').classList.contains('active')) renderDashboard();
}
