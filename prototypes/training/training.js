const STORAGE='cutrank_training_prototype_v1';
const TODAY='2026-10-18';
const goalNames={gain:'Build muscle',lose:'Lose fat',maintain:'Maintain'};
const templates={
  upper:[{id:'bench',name:'Barbell bench press',group:'Chest · compound',range:'6–10',load:80,reps:8},{id:'row',name:'Chest-supported row',group:'Back · compound',range:'8–12',load:60,reps:10},{id:'press',name:'Seated dumbbell press',group:'Shoulders · compound',range:'8–12',load:24,reps:10},{id:'raise',name:'Cable lateral raise',group:'Shoulders · isolation',range:'12–15',load:7.5,reps:12}],
  lower:[{id:'squat',name:'Barbell back squat',group:'Quads · compound',range:'6–10',load:100,reps:8},{id:'rdl',name:'Romanian deadlift',group:'Hamstrings · compound',range:'8–12',load:80,reps:10},{id:'curl',name:'Seated leg curl',group:'Hamstrings · isolation',range:'10–15',load:45,reps:12},{id:'calf',name:'Standing calf raise',group:'Calves · isolation',range:'10–15',load:60,reps:12}]
};
function seed(){
  const dates=['2026-09-27','2026-10-04','2026-10-11','2026-10-14'];
  const history={bench:[75,77.5,77.5,80].map((load,i)=>({date:dates[i],load,reps:8,rir:2})),squat:[90,95,97.5,100].map((load,i)=>({date:dates[i],load,reps:8,rir:2})),row:[55,55,57.5,60].map((load,i)=>({date:dates[i],load,reps:10,rir:2}))};
  return {version:1,goal:'gain',calorieTarget:2700,proteinTarget:160,checkin:null,history,drafts:{},sessions:[],messages:[]};
}
let state=seed();
try{const saved=JSON.parse(localStorage.getItem(STORAGE)||'null');if(saved?.version===1&&saved.history&&saved.drafts&&Array.isArray(saved.messages))state={...state,...saved};}catch{}
let currentTab='today',metric='load',routine='upper',period=90,toastTimer;
const $=selector=>document.querySelector(selector);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function persist(){try{localStorage.setItem(STORAGE,JSON.stringify(state));}catch{toast('Browser storage is unavailable. Changes will last for this visit.');}}
function toast(message){$('#toast').textContent=message;$('#toast').classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('visible'),3500);}
function dateLabel(date){return new Date(date+'T12:00:00Z').toLocaleDateString('en-GB',{day:'numeric',month:'short',timeZone:'UTC'});}
function e1rm(set){return Math.round(set.load*(1+set.reps/30)*10)/10;}
function exampleTrend(id){
  const earlier={bench:[60,60,62.5,62.5,65,65,65,67.5,67.5,65,67.5,70,70,70,72.5,72.5,70,72.5,75,75],squat:[70,72.5,72.5,75,75,77.5,77.5,80,80,77.5,80,82.5,82.5,85,85,85,82.5,85,87.5,90],row:[40,40,42.5,42.5,45,45,45,47.5,47.5,45,47.5,50,50,50,52.5,52.5,50,52.5,55,55]};
  return earlier[id].map((load,index)=>({date:new Date(Date.parse('2026-09-27T12:00:00Z')-(20-index)*7*86400000).toISOString().slice(0,10),load,reps:id==='row'?10:8,rir:2})).concat(state.history[id]||[]);
}
function periodEntries(entries){const cutoff=Date.parse(TODAY+'T00:00:00Z')-period*86400000;return entries.filter(entry=>Date.parse(entry.date+'T12:00:00Z')>=cutoff).sort((a,b)=>a.date.localeCompare(b.date));}
function periodName(){return period===28?'4 weeks':period===90?'3 months':'6 months';}
function weekWeights(){const values=[80.0,80.1,80.1,80.1];if(state.checkin?.weight)values[3]=Math.round(((80.1*6+state.checkin.weight)/7)*10)/10;return values;}
function calorieReview(){
  const weights=weekWeights(),change=+(weights[3]-weights[0]).toFixed(1),flat=Math.abs(change)<0.3;
  if(!flat)return {title:'Give the trend more time.',text:'Your latest check-in changes the recent average. Keep logging consistently before changing the example calorie target.',evidence:['4 weekly averages','Check recent consistency'],adjustment:0};
  if(state.goal==='maintain')return {title:'Your weight is holding steady.',text:'That fits your maintenance goal. The example log does not suggest a calorie adjustment right now.',evidence:['80.0 → '+weights[3].toFixed(1)+' kg','Goal: maintain'],adjustment:0};
  const gaining=state.goal==='gain';
  return {title:gaining?'Time to review your calorie target?':'Your calorie target needs a check-in.',text:'The example weight trend has stayed around 80.1 kg across four weekly averages. Before '+(gaining?'increasing':'reducing')+' calories, check that your intake logging and activity have been consistent.',evidence:['4 weekly averages','Goal: '+(gaining?'build muscle':'lose fat')],adjustment:gaining?150:-150};
}
let chartSequence=0;
function svgChart(values,labels,{unit='kg',color='#3978d6',label='Progress chart',width=600,minSpan=10,details=[],dates=[]}={}){
  const id='trend-'+(++chartSequence),height=width<400?220:246,left=42,right=18,top=27,bottom=35;
  const span=Math.max(Math.max(...values)-Math.min(...values),minSpan),mid=(Math.max(...values)+Math.min(...values))/2;
  const roughStep=span/3,power=10**Math.floor(Math.log10(roughStep));
  const step=([1,2,2.5,5,10].find(n=>n*power>=roughStep)||10)*power;
  const min=Math.max(0,Math.floor((mid-span*.55)/step)*step),max=Math.ceil((mid+span*.55)/step)*step;
  const time=dates.map(date=>Date.parse(date+'T12:00:00Z'));
  const x=i=>left+(width-left-right)*(values.length===1?.5:time.length===values.length&&time.at(-1)!==time[0]?(time[i]-time[0])/(time.at(-1)-time[0]):i/(values.length-1));
  const y=value=>top+(height-top-bottom)*(1-(value-min)/(max-min));
  const points=values.map((value,i)=>x(i)+','+y(value)).join(' '),base=height-bottom;
  let grid='';
  for(let tick=min;tick<=max+step*.01;tick+=step){
    const value=Number(tick.toFixed(2)),py=y(value);
    grid+=`<line x1="${left}" y1="${py}" x2="${width-right}" y2="${py}" class="chart-grid"/><text x="${left-12}" y="${py+4}" text-anchor="end">${value}</text>`;
  }
  const dots=values.map((value,i)=>{
    const start=i===0?left:(x(i-1)+x(i))/2,end=i===values.length-1?width-right:(x(i)+x(i+1))/2;
    return `<g class="chart-point ${i===values.length-1?'latest':''}" data-point="${i}" data-x="${x(i)}" data-y="${y(value)}" tabindex="0" role="button" aria-label="${esc(labels[i]+': '+value+' '+unit+(details[i]?', '+details[i]:''))}" aria-describedby="${id}-tip"><rect x="${start}" y="${top}" width="${end-start}" height="${base-top}" fill="transparent"/><circle class="point-halo" cx="${x(i)}" cy="${y(value)}" r="9" fill="${color}"/><circle class="point-dot" cx="${x(i)}" cy="${y(value)}" r="${i===values.length-1?4.5:3}" fill="white" stroke="${color}" stroke-width="2"/></g>`;
  }).join('');
  const labelCount=width<400?3:5;
  const labelIndexes=new Set(Array.from({length:Math.min(labelCount,values.length)},(_,i)=>Math.round(i*(values.length-1)/(Math.min(labelCount,values.length)-1||1))));
  const axisDates=labels.map((date,i)=>labelIndexes.has(i)?`<text x="${x(i)}" y="${height-8}" text-anchor="${i===0?'start':i===values.length-1?'end':'middle'}">${esc(date)}</text>`:'').join('');
  const series=esc(JSON.stringify({values,labels,unit,details}));
  return `<div class="chart-canvas ${values.length>8?'dense':''}" data-series="${series}"><svg viewBox="0 0 ${width} ${height}" role="group" aria-label="${esc(label)}"><defs><linearGradient id="${id}-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="${color}" stop-opacity=".09"/><stop offset="100%" stop-color="${color}" stop-opacity="0"/></linearGradient></defs><text class="axis-unit" x="${left-12}" y="11" text-anchor="end">${esc(unit)}</text>${grid}<polygon points="${x(0)},${base} ${points} ${x(values.length-1)},${base}" fill="url(#${id}-fill)"/><polyline points="${points}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/><line class="chart-guide" x1="0" x2="0" y1="${top}" y2="${base}"/>${axisDates}${dots}</svg><div class="chart-tooltip" id="${id}-tip" role="tooltip" hidden></div></div>`;
}
function chartWidth(id){return Math.max(250,$(id).clientWidth||560);}
function drawOverviewChart(){
  const sets=state.history.bench.filter(set=>set.rir===2).slice(-4),latest=sets.at(-1),change=latest.load-sets[0].load;
  $('#overviewTrend').innerHTML=`<div><strong>${latest.load}<small>kg</small></strong><span>Latest working set</span></div><p><b>${change===0?'No change':(change>0?'+':'−')+Math.abs(Number(change.toFixed(1)))+' kg'}</b> over ${sets.length} sessions</p>`;
  $('#overviewChart').innerHTML=svgChart(sets.map(set=>set.load),sets.map(set=>dateLabel(set.date)),{width:chartWidth('#overviewChart'),label:'Bench working weight at 2 RIR',details:sets.map(set=>set.reps+' reps · '+set.rir+' RIR')});
}
function renderOverview(){
  const bench=state.history.bench,last=bench.at(-1),first=bench[0],gain=((last.load-first.load)/first.load*100).toFixed(1),completed=state.sessions.length;
  $('#summary').innerHTML=[['SESSIONS THIS WEEK',3+completed,'/ 4',completed?'Session saved in your log':'Your next session is ready'],['BENCH PRESS',last.load,'kg × '+last.reps,last.rir===first.rir?(gain>0?'+':'')+gain+'% at a comparable RIR':'Logged at '+last.rir+' RIR · effort differs'],['WEEKLY AVG. WEIGHT',weekWeights()[3].toFixed(1),'kg','4 weekly averages'],['CALORIE TARGET',state.calorieTarget.toLocaleString('en-GB'),'kcal','Protein target · '+state.proteinTarget+' g']].map((s,i)=>`<div class="summary-stat"><span>${s[0]}</span><div><b>${s[1]}</b><small>${s[2]}</small></div><p class="${i===1&&gain>0?'positive':''}">${s[3]}</p></div>`).join('');
  const comparable=bench.filter(set=>set.rir===2).slice(-4);
  const trendPercent=comparable[0].load?(comparable.at(-1).load-comparable[0].load)/comparable[0].load*100:null;
  $('.trend-tag').textContent=trendPercent===null?'New baseline':(trendPercent>0?'+':'')+trendPercent.toFixed(1)+'%';
  $('.trend-tag').classList.toggle('neutral',trendPercent===null||trendPercent<=0);
  drawOverviewChart();
  const insight=calorieReview();$('#insightTitle').textContent=insight.title;$('#insightText').textContent=insight.text;$('#insightEvidence').innerHTML=insight.evidence.map(text=>'<span>'+esc(text)+'</span>').join('');
  $('#weekDays').innerHTML=['M','T','W','T','F','S','S'].map((day,i)=>`<div class="week-day ${[0,2,4].includes(i)?'done':''} ${i===6?'today':''}"><span>${day}</span><b>${[0,2,4].includes(i)?'✓':i===6&&completed?'✓':12+i}</b></div>`).join('');
  if(state.checkin){for(const name of ['calories','protein','weight'])$('#checkinForm [name="'+name+'"]').value=state.checkin[name]??'';$('#checkinStatus').textContent='Saved for 18 October · edit any time';}
}
function getDraft(){if(!state.drafts[routine])state.drafts[routine]=templates[routine].map(exercise=>{const last=state.history[exercise.id]?.at(-1)||exercise;return {...exercise,load:last.load,reps:last.reps,sets:Array.from({length:3},()=>({load:last.load,reps:last.reps,rir:2,done:false}))};});return state.drafts[routine];}
function renderLogger(){
  const draft=getDraft();
  $('#exerciseLogger').innerHTML=draft.map((exercise,e)=>`<article class="card exercise-card"><div class="exercise-heading"><span class="exercise-number">${String(e+1).padStart(2,'0')}</span><div><h2>${esc(exercise.name)}</h2><p>${esc(exercise.group)} · ${esc(exercise.range)} reps</p></div><small>TARGET: 2 RIR</small></div><div class="set-grid head"><span>SET</span><span>PREVIOUS</span><span>KG</span><span>REPS</span><span>RIR</span><span class="sr-only">Completed</span></div>${exercise.sets.map((set,s)=>`<div class="set-grid ${set.done?'completed':''}"><span>${s+1}</span><span class="previous">${exercise.load} × ${exercise.reps} <small>@2</small></span>${['load','reps','rir'].map(field=>`<input type="number" aria-label="${esc(exercise.name)} set ${s+1} ${field==='load'?'weight in kg':field}" data-exercise="${e}" data-set="${s}" data-field="${field}" min="${field==='reps'?1:0}" max="${field==='load'?1000:field==='rir'?5:100}" step="${field==='load'?.5:1}" value="${esc(set[field])}" ${set.done?'readonly':''}>`).join('')}<button class="complete-set" data-complete="${e}:${s}" aria-label="${set.done?'Unmark':'Complete'} ${esc(exercise.name)} set ${s+1}" aria-pressed="${set.done}">✓</button></div>`).join('')}<button class="add-set" data-add-set="${e}">＋ Add set</button></article>`).join('');
  updateCompleted();
}
function updateCompleted(){const sets=getDraft().flatMap(exercise=>exercise.sets),done=sets.filter(set=>set.done).length;$('#completedCount').textContent=done+' / '+sets.length+' sets logged';$('#sessionStatus').textContent=done?'Session in progress':'Ready when you are';}
function validSet(set){return Number.isFinite(set.load)&&set.load>=0&&set.load<=1000&&Number.isInteger(set.reps)&&set.reps>=1&&set.reps<=100&&Number.isInteger(set.rir)&&set.rir>=0&&set.rir<=5;}
function finishWorkout(){
  const draft=getDraft(),logged=draft.flatMap(exercise=>exercise.sets.filter(set=>set.done));
  if(!logged.length){toast('Complete at least one set to save a workout.');return;}
  for(const exercise of draft){const sets=exercise.sets.filter(set=>set.done);if(!sets.length)continue;const best=sets.reduce((a,b)=>e1rm(b)>e1rm(a)?b:a);(state.history[exercise.id]??=[]).push({date:TODAY,load:best.load,reps:best.reps,rir:best.rir});}
  state.sessions.push({date:TODAY,routine,exercises:JSON.parse(JSON.stringify(draft)),sets:logged.length});delete state.drafts[routine];persist();renderAll();openTab('today');toast('Workout saved · '+logged.length+' working sets logged.');
}
function renderProgress(){
  const id=$('#chartExercise').value,sets=periodEntries(exampleTrend(id)),label=$('#chartExercise').selectedOptions[0].textContent;
  const values=sets.map(set=>metric==='load'?set.load:metric==='reps'?set.reps:e1rm(set));
  const unit=metric==='reps'?'reps':'kg',latest=values.at(-1),difference=+(latest-values[0]).toFixed(1),pct=values[0]?Math.abs(difference/values[0]*100).toFixed(1):null;
  $('#progressSummary').innerHTML=`<div><strong>${latest}<small>${unit}</small></strong><span>${metric==='strength'?'Latest estimated 1RM':metric==='reps'?'Reps in latest set':'Latest working weight'}</span></div><div class="trend-change ${difference<=0?'steady':''}"><b>${difference===0?'No change':(difference>0?'+':'−')+Math.abs(difference)+' '+unit}</b><span>${difference===0?'Across '+sets.length+' sessions':(pct?pct+'% '+(difference>0?'increase':'decrease')+' · ':'')+sets.length+' sessions'}</span></div>`;
  $('#progressChart').innerHTML=svgChart(values,sets.map(set=>dateLabel(set.date)),{width:chartWidth('#progressChart'),unit,minSpan:metric==='reps'?4:10,label:label+' '+(metric==='strength'?'estimated one rep max':metric)+' over '+periodName(),dates:sets.map(set=>set.date),details:sets.map(set=>set.load+' kg × '+set.reps+' · '+set.rir+' RIR')});
  const rirs=[...new Set(sets.map(set=>set.rir))];$('#chartContext').textContent=rirs.length===1?'Comparing sets at '+rirs[0]+' RIR.':'RIR differs across these sets. Check the table before comparing.';
  $('#liftHistory').innerHTML=sets.slice().reverse().map(set=>`<tr><td>${dateLabel(set.date)}</td><td>${set.load} kg</td><td>${set.reps}</td><td>${set.rir}</td><td>${e1rm(set)} kg</td></tr>`).join('');
  const weightHistory=[78.8,78.9,78.8,79.0,79.1,79.0,79.2,79.3,79.2,79.4,79.4,79.5,79.6,79.5,79.7,79.8,79.7,79.9,79.9,80.0,...weekWeights()].map((weight,index)=>({date:new Date(Date.parse('2026-10-18T12:00:00Z')-(23-index)*7*86400000).toISOString().slice(0,10),weight}));
  const weightEntries=periodEntries(weightHistory),weights=weightEntries.map(entry=>entry.weight),weightDelta=+(weights.at(-1)-weights[0]).toFixed(1);
  $('#weightChart').innerHTML=svgChart(weights,weightEntries.map(entry=>dateLabel(entry.date)),{width:chartWidth('#weightChart'),minSpan:2,label:'Weekly average body weight over '+periodName(),color:'#5a8e85',dates:weightEntries.map(entry=>entry.date),details:weights.map(()=> 'Average of 7 weigh-ins · example data')});$('#weightAverage').textContent=weights.at(-1).toFixed(1);$('#weightChange').textContent=Math.abs(weightDelta)<.3?'Holding steady':(weightDelta>0?'+':'')+weightDelta+' kg';$('#weightPeriod').textContent='Over '+periodName();
}
function renderContext(){
  const last=state.history.bench.at(-1);
  $('#coachContext').innerHTML=[['GOAL',goalNames[state.goal]],['TRAINING',3+state.sessions.length+' sessions this week'],['LATEST BENCH',last.load+' kg × '+last.reps+' · '+last.rir+' RIR'],['WEIGHT TREND','80.0 → '+weekWeights()[3].toFixed(1)+' kg · 4 weeks'],['DAILY TARGET',state.calorieTarget.toLocaleString('en-GB')+' kcal · '+state.proteinTarget+' g protein'],['RECENT INTAKE','Example history: 19 of 21 days logged']].map(([label,value])=>`<div class="context-item"><small>${esc(label)}</small><b>${esc(value)}</b></div>`).join('');
  const profile=state.onboardingProfile;
  if(profile){const equipment={gym:'Full gym',home:'Dumbbells at home',bodyweight:'Body weight'};$('#coachContext').insertAdjacentHTML('beforeend',[['SETUP SCHEDULE',profile.days+' days per week'],['AVAILABLE EQUIPMENT',equipment[profile.equipment]],['YOUR PRIORITIES',profile.priorities?.join(', ')||'Explore as you go'],...(profile.notes?[['YOUR NOTES',profile.notes]]:[])].map(([label,value])=>`<div class="context-item"><small>${esc(label)}</small><b>${esc(value)}</b></div>`).join(''));}
}
function renderMessages(){
  if(!state.messages.length)state.messages.push({role:'coach',text:'I can help you explore this example training log. Ask about your next session, the weight trend, or a plateau.\n\nThese are simulated responses for the mockup. A live coach would review your full log and ask for missing context.'});
  $('#chatMessages').innerHTML=state.messages.map((message,i)=>`<div class="message ${message.role==='user'?'user':''}"><small>${message.role==='user'?'YOU':'CUTRANK COACH · DEMO'}</small>${esc(message.text)}${message.target&&!message.handled?`<div class="message-actions"><button data-accept="${i}">Try ${Number(message.target).toLocaleString('en-GB')} kcal</button><button data-keep="${i}">Keep my target</button></div>`:''}</div>`).join('');
  $('#chatMessages').scrollTop=$('#chatMessages').scrollHeight;
}
function coachReply(prompt){
  const query=prompt.toLowerCase(),last=state.history.bench.at(-1);
  if(/pain|injur|dizz|faint|eating disorder|pregnan/.test(query))return {text:'This demo cannot assess symptoms or injury. Pause the affected activity and seek appropriate professional advice. A live coach should recognise this limit rather than change your training or calorie target.'};
  if(/calori|weight|bulk|cut|nutrition|diet|protein/.test(query)){
    const review=calorieReview();if(!review.adjustment)return {text:review.text+'\n\nKeep the current example target of '+state.calorieTarget+' kcal while collecting more consistent check-ins.'};
    if(state.calorieReviewedFor===state.goal)return {text:'You already reviewed the example calorie target for this goal. Give the updated plan time and collect new weekly averages before making another adjustment.'};
    return {text:'Here’s what the example log shows:\n• Goal: '+goalNames[state.goal].toLowerCase()+'\n• Weekly average weight: 80.0 → '+weekWeights()[3].toFixed(1)+' kg over four weeks\n• Intake history: 19 of 21 days logged\n\nFirst, are those intake totals accurate, and has your activity stayed similar? If both are consistent, this demo proposes a small '+(review.adjustment>0?'increase':'decrease')+' of 150 kcal, from '+state.calorieTarget+' to '+(state.calorieTarget+review.adjustment)+' kcal.\n\nYou choose whether to try it. Your target stays the same until you accept.',target:state.calorieTarget+review.adjustment};
  }
  if(/stall|plateau|recover|tired/.test(query))return {text:'The example bench log goes from 75 kg × 8 to '+last.load+' kg × '+last.reps+', both at about 2 RIR. That shows progress across the block, even though two middle sessions used the same weight.\n\nBefore changing the plan, I’d ask about sleep, rest between sets, technique and how hard the last sets felt. A few repeated sessions can be useful evidence; one flat session alone isn’t enough to rewrite your routine.'};
  if(/bench|next|reps|overload|rir|session|train/.test(query))return {text:'Your latest bench set is '+last.load+' kg × '+last.reps+' at '+last.rir+' RIR. Your example routine uses a 6–10 rep range.\n\nFor the next session, keep the same weight and see whether you can add a clean rep while staying around 2 RIR. When the working sets reach the top of the range at the intended effort, review a small load increase.\n\nKeep the setup and technique consistent so the comparison means something.'};
  return {text:'This prototype has demo replies for next-session planning, plateaus and calorie reviews. Try “What should I aim for on bench?” or “Should I change my calories?”\n\nThe connected version would answer freely using your saved workouts and check-ins.'};
}
function sendMessage(prompt){const value=String(prompt).trim().slice(0,1000);if(!value)return;state.messages.push({role:'user',text:value},{role:'coach',...coachReply(value)});state.messages=state.messages.slice(-40);persist();renderMessages();}
function openTab(tab){
  if(!['today','workout','progress','coach'].includes(tab))tab='today';currentTab=tab;
  document.querySelectorAll('.tab').forEach(section=>{section.hidden=section.id!=='tab-'+tab;section.classList.toggle('active',!section.hidden);});
  document.querySelectorAll('[data-tab]').forEach(button=>{if(button.dataset.tab===tab)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');});
  const headings={today:['Make your next move.','A clear view of the work you’re putting in.'],workout:['Show up. Log the work.','Your last session is the starting point for your next one.'],progress:['See what’s changing.','Compare your lifts, effort and weight trend over time.'],coach:['A little context goes a long way.','Connect the dots between your training and daily check-ins.']};
  $('#pageTitle').textContent=headings[tab][0];$('#pageSubtitle').textContent=headings[tab][1];
  if(tab==='today')drawOverviewChart();if(tab==='workout')renderLogger();if(tab==='progress')renderProgress();if(tab==='coach'){renderContext();renderMessages();}
  history.replaceState(null,'','#'+tab);window.scrollTo({top:0,behavior:'instant'});
}
function renderAll(){$('#goal').value=state.goal;renderOverview();renderProgress();renderContext();}
function inspectChart(point){
  const canvas=point.closest('.chart-canvas'),series=JSON.parse(canvas.dataset.series),index=Number(point.dataset.point),tooltip=canvas.querySelector('.chart-tooltip');
  canvas.querySelectorAll('.chart-point').forEach(item=>item.classList.toggle('inspected',item===point));
  const guide=canvas.querySelector('.chart-guide');guide.setAttribute('x1',point.dataset.x);guide.setAttribute('x2',point.dataset.x);guide.classList.add('visible');
  tooltip.innerHTML=`<span>${esc(series.labels[index])}</span><strong>${esc(series.values[index])}<small>${esc(series.unit)}</small></strong>${series.details[index]?'<p>'+esc(series.details[index])+'</p>':''}`;
  tooltip.hidden=false;
  const svg=canvas.querySelector('svg'),box=svg.viewBox.baseVal;
  tooltip.style.left=Math.max(0,Math.min(canvas.clientWidth-tooltip.offsetWidth,Number(point.dataset.x)/box.width*canvas.clientWidth-tooltip.offsetWidth/2))+'px';
  tooltip.style.top=Math.max(0,Number(point.dataset.y)/box.height*svg.clientHeight-tooltip.offsetHeight-13)+'px';
}
function clearChart(canvas){if(!canvas)return;canvas.querySelector('.chart-tooltip').hidden=true;canvas.querySelector('.chart-guide').classList.remove('visible');canvas.querySelectorAll('.inspected').forEach(point=>point.classList.remove('inspected'));}
document.addEventListener('pointerover',event=>{const point=event.target.closest('[data-point]');if(point)inspectChart(point);});
document.addEventListener('focusin',event=>{const point=event.target.closest('[data-point]');if(point)inspectChart(point);});
document.addEventListener('pointerout',event=>{const canvas=event.target.closest('.chart-canvas');if(canvas&&!canvas.contains(event.relatedTarget)&&!canvas.contains(document.activeElement))clearChart(canvas);});
document.addEventListener('focusout',event=>{const canvas=event.target.closest('.chart-canvas');if(canvas&&!canvas.contains(event.relatedTarget))clearChart(canvas);});
document.addEventListener('keydown',event=>{const point=event.target.closest('[data-point]');if(!point)return;const points=[...point.closest('.chart-canvas').querySelectorAll('[data-point]')],index=points.indexOf(point);let next;if(event.key==='ArrowRight')next=Math.min(points.length-1,index+1);if(event.key==='ArrowLeft')next=Math.max(0,index-1);if(event.key==='Home')next=0;if(event.key==='End')next=points.length-1;if(next!==undefined){event.preventDefault();points[next].focus();}if(event.key==='Escape')clearChart(point.closest('.chart-canvas'));});
document.addEventListener('click',event=>{const point=event.target.closest('[data-point]');if(point)inspectChart(point);else document.querySelectorAll('.chart-canvas').forEach(clearChart);});
let chartResizeTimer;
window.addEventListener('resize',()=>{clearTimeout(chartResizeTimer);chartResizeTimer=setTimeout(()=>{drawOverviewChart();renderProgress();},100);});
document.addEventListener('click',event=>{
  const button=event.target.closest('button');if(!button)return;
  if(button.dataset.tab)openTab(button.dataset.tab);
  if(button.dataset.open)openTab(button.dataset.open);
  if(button.dataset.metric){metric=button.dataset.metric;document.querySelectorAll('[data-metric]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));renderProgress();}
  if(button.dataset.period){period=Number(button.dataset.period);document.querySelectorAll('[data-period]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));renderProgress();}
  if(button.dataset.complete){const [e,s]=button.dataset.complete.split(':').map(Number),set=getDraft()[e].sets[s];if(!set.done&&!validSet(set)){toast('Check weight, reps and RIR. RIR must be a whole number from 0 to 5.');return;}set.done=!set.done;persist();renderLogger();}
  if(button.dataset.addSet){const exercise=getDraft()[Number(button.dataset.addSet)];if(exercise.sets.length>=10){toast('This demo supports up to 10 sets per exercise.');return;}const previous=exercise.sets.at(-1);exercise.sets.push({...previous,done:false});persist();renderLogger();}
  if(button.dataset.prompt)sendMessage(button.dataset.prompt);
  if(button.hasAttribute('data-accept')||button.hasAttribute('data-keep')){const index=Number(button.dataset.accept??button.dataset.keep),message=state.messages[index];if(!message||message.handled)return;message.handled=true;if(button.hasAttribute('data-accept')){state.calorieTarget=message.target;state.calorieReviewedFor=state.goal;state.messages.push({role:'coach',text:'Example calorie target updated to '+state.calorieTarget+' kcal. Collect new check-ins and weekly averages before reviewing it again.'});toast('Example calorie target updated.');}else state.messages.push({role:'coach',text:'Current calorie target kept. You can return to this when you have more consistent check-ins.'});persist();renderAll();renderMessages();}
});
$('#exerciseLogger').addEventListener('input',event=>{const input=event.target;if(!input.dataset.field)return;const set=getDraft()[Number(input.dataset.exercise)].sets[Number(input.dataset.set)];set[input.dataset.field]=input.value===''?null:Number(input.value);persist();});
$('#routine').addEventListener('change',event=>{routine=event.target.value;renderLogger();});
$('#chartExercise').addEventListener('change',renderProgress);
$('#goal').addEventListener('change',event=>{state.goal=event.target.value;for(const message of state.messages)if(message.target)message.handled=true;persist();renderAll();if(currentTab==='coach')renderMessages();toast('Example goal updated to '+goalNames[state.goal].toLowerCase()+'.');});
$('#finishWorkout').addEventListener('click',finishWorkout);
$('#checkinForm').addEventListener('submit',event=>{event.preventDefault();const values={};for(const key of ['calories','protein','weight']){const input=event.target.elements[key];values[key]=input.value===''?null:Number(input.value);}if(Object.values(values).every(value=>value===null)){toast('Add at least one number to save a check-in.');return;}state.checkin={date:TODAY,...values};persist();renderAll();toast('Check-in saved in this browser.');});
$('#chatForm').addEventListener('submit',event=>{event.preventDefault();sendMessage($('#chatInput').value);$('#chatInput').value='';});
for(const id of ['discussInsight','askWeight'])$('#'+id).addEventListener('click',()=>{openTab('coach');sendMessage('Should I change my calories?');});
$('#resetDemo').addEventListener('click',()=>{state=seed();persist();$('#checkinForm').reset();renderAll();openTab('today');toast('Example data reset.');});
renderAll();openTab(location.hash.slice(1)||'today');
