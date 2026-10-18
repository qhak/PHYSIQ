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
let currentTab='today',metric='load',routine='upper',toastTimer;
const $=selector=>document.querySelector(selector);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function persist(){try{localStorage.setItem(STORAGE,JSON.stringify(state));}catch{toast('Browser storage is unavailable. Changes will last for this visit.');}}
function toast(message){$('#toast').textContent=message;$('#toast').classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('visible'),3500);}
function dateLabel(date){return new Date(date+'T12:00:00Z').toLocaleDateString('en-GB',{day:'numeric',month:'short',timeZone:'UTC'});}
function e1rm(set){return Math.round(set.load*(1+set.reps/30)*10)/10;}
function weekWeights(){const values=[80.0,80.1,80.1,80.1];if(state.checkin?.weight)values[3]=Math.round(((80.1*6+state.checkin.weight)/7)*10)/10;return values;}
function calorieReview(){
  const weights=weekWeights(),change=+(weights[3]-weights[0]).toFixed(1),flat=Math.abs(change)<0.3;
  if(!flat)return {title:'Give the trend more time.',text:'Your latest check-in changes the recent average. Keep logging consistently before changing the example calorie target.',evidence:['4 weekly averages','Check recent consistency'],adjustment:0};
  if(state.goal==='maintain')return {title:'Your weight is holding steady.',text:'That fits your maintenance goal. The example log does not suggest a calorie adjustment right now.',evidence:['80.0 → '+weights[3].toFixed(1)+' kg','Goal: maintain'],adjustment:0};
  const gaining=state.goal==='gain';
  return {title:gaining?'Time to review your calorie target?':'Your calorie target needs a check-in.',text:'The example weight trend has stayed around 80.1 kg across four weekly averages. Before '+(gaining?'increasing':'reducing')+' calories, check that your intake logging and activity have been consistent.',evidence:['4 weekly averages','Goal: '+(gaining?'build muscle':'lose fat')],adjustment:gaining?150:-150};
}
function svgChart(values,labels,{unit='kg',color='#3978d6',label='Progress chart',suffix=''}={}){
  const width=510,height=205,left=38,right=25,top=28,bottom=35;
  const span=Math.max(...values)-Math.min(...values),padding=Math.max(span*.5,unit==='reps'?1:.4);
  const min=Math.min(...values)-padding,max=Math.max(...values)+padding;
  const x=i=>left+(width-left-right)*(values.length===1?.5:i/(values.length-1));
  const y=v=>top+(height-top-bottom)*(1-(v-min)/(max-min));
  const points=values.map((value,i)=>x(i)+','+y(value)).join(' '),base=height-bottom;
  const grid=[0,.5,1].map(t=>{const v=min+(max-min)*t,py=y(v);return `<line x1="${left}" y1="${py}" x2="${width-right}" y2="${py}" stroke="#edf0f5" stroke-dasharray="3 4"/><text x="${left-9}" y="${py+3}" text-anchor="end">${Number.isInteger(v)?v:v.toFixed(1)}</text>`;}).join('');
  const dots=values.map((v,i)=>`<g><circle cx="${x(i)}" cy="${y(v)}" r="5" fill="white" stroke="${color}" stroke-width="2"><title>${esc(labels[i])}: ${v} ${esc(unit)}</title></circle><text class="chart-value" x="${x(i)}" y="${y(v)-14}" text-anchor="middle">${v}${esc(suffix)}</text><text x="${x(i)}" y="${height-10}" text-anchor="middle">${esc(labels[i])}</text></g>`).join('');
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label+': '+values.map((v,i)=>labels[i]+' '+v+' '+unit).join(', '))}">${grid}<polygon points="${x(0)},${base} ${points} ${x(values.length-1)},${base}" fill="${color}" fill-opacity=".045"/><polyline points="${points}" fill="none" stroke="${color}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>${dots}</svg>`;
}
function renderOverview(){
  const bench=state.history.bench,last=bench.at(-1),first=bench[0],gain=((last.load-first.load)/first.load*100).toFixed(1),completed=state.sessions.length;
  $('#summary').innerHTML=[['SESSIONS THIS WEEK',3+completed,'/ 4',completed?'Session saved in your log':'Your next session is ready'],['BENCH PRESS',last.load,'kg × '+last.reps,last.rir===first.rir?'+'+gain+'% at a comparable RIR':'Logged at '+last.rir+' RIR · effort differs'],['WEEKLY AVG. WEIGHT',weekWeights()[3].toFixed(1),'kg','4 weekly averages'],['CALORIE TARGET',state.calorieTarget.toLocaleString('en-GB'),'kcal','Protein target · '+state.proteinTarget+' g']].map((s,i)=>`<div class="summary-stat"><span>${s[0]}</span><div><b>${s[1]}</b><small>${s[2]}</small></div><p class="${i===1?'positive':''}">${s[3]}</p></div>`).join('');
  const comparable=bench.filter(set=>set.rir===2).slice(-4);
  $('.trend-tag').textContent='↗ +'+((comparable.at(-1).load-comparable[0].load)/comparable[0].load*100).toFixed(1)+'%';
  $('#overviewChart').innerHTML=svgChart(comparable.map(set=>set.load),comparable.map(set=>dateLabel(set.date)),{label:'Bench working weight at 2 RIR'});
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
  const id=$('#chartExercise').value,sets=(state.history[id]||[]).slice(-4),label=$('#chartExercise').selectedOptions[0].textContent;
  const values=sets.map(set=>metric==='load'?set.load:metric==='reps'?set.reps:e1rm(set));
  $('#progressChart').innerHTML=svgChart(values,sets.map(set=>dateLabel(set.date)),{unit:metric==='reps'?'reps':'kg',label:label+' '+(metric==='strength'?'estimated one rep max':metric)});
  const rirs=[...new Set(sets.map(set=>set.rir))];$('#chartContext').textContent=rirs.length===1?'Comparing sets at '+rirs[0]+' RIR.':'RIR differs across these sets. Check the table before comparing.';
  $('#liftHistory').innerHTML=sets.slice().reverse().map(set=>`<tr><td>${dateLabel(set.date)}</td><td>${set.load} kg</td><td>${set.reps}</td><td>${set.rir}</td><td>${e1rm(set)} kg</td></tr>`).join('');
  const weights=weekWeights();$('#weightChart').innerHTML=svgChart(weights,['Week 1','Week 2','Week 3','Week 4'],{label:'Weekly average body weight',color:'#5a8e85'});$('#weightAverage').textContent=weights[3].toFixed(1);$('#weightChange').textContent=Math.abs(weights[3]-weights[0])<.3?'Holding steady':((weights[3]-weights[0])>0?'+':'')+(weights[3]-weights[0]).toFixed(1)+' kg';
}
function renderContext(){
  const last=state.history.bench.at(-1);
  $('#coachContext').innerHTML=[['GOAL',goalNames[state.goal]],['TRAINING',3+state.sessions.length+' sessions this week'],['LATEST BENCH',last.load+' kg × '+last.reps+' · '+last.rir+' RIR'],['WEIGHT TREND','80.0 → '+weekWeights()[3].toFixed(1)+' kg · 4 weeks'],['DAILY TARGET',state.calorieTarget.toLocaleString('en-GB')+' kcal · '+state.proteinTarget+' g protein'],['RECENT INTAKE','Example history: 19 of 21 days logged']].map(([label,value])=>`<div class="context-item"><small>${esc(label)}</small><b>${esc(value)}</b></div>`).join('');
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
  if(tab==='workout')renderLogger();if(tab==='progress')renderProgress();if(tab==='coach'){renderContext();renderMessages();}
  history.replaceState(null,'','#'+tab);window.scrollTo({top:0,behavior:'instant'});
}
function renderAll(){$('#goal').value=state.goal;renderOverview();renderProgress();renderContext();}
document.addEventListener('click',event=>{
  const button=event.target.closest('button');if(!button)return;
  if(button.dataset.tab)openTab(button.dataset.tab);
  if(button.dataset.open)openTab(button.dataset.open);
  if(button.dataset.metric){metric=button.dataset.metric;document.querySelectorAll('[data-metric]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));renderProgress();}
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
