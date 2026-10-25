(function(root){
  'use strict';
  const scriptURL=document.currentScript?.src||new URL('/scan-animation.js',location.href).href;
  const ns='http://www.w3.org/2000/svg';
  const regionCopy={Chest:'Looking at visible chest development and proportion.',Shoulders:'Looking at shoulder shape and visible development.',Arms:'Reviewing upper-arm and forearm development.',Abs:'Looking at visible abdominal definition.'};
  let session=null;
  const mix=(a,b,t)=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t});
  const distance=(a,b)=>Math.hypot(b.x-a.x,b.y-a.y);
  function roundedPolygon(points){
    if(points.length<3)return '';
    const first=mix(points[points.length-1],points[0],0.88);
    return 'M'+first.x+' '+first.y+points.map((point,i)=>{
      const nextPoint=points[(i+1)%points.length];
      const next=mix(point,nextPoint,0.12),incoming=mix(point,nextPoint,0.88);
      return ' Q'+point.x+' '+point.y+' '+next.x+' '+next.y+' L'+incoming.x+' '+incoming.y;
    }).join('')+' Z';
  }
  function capsule(a,b,radius){
    const len=distance(a,b);if(len<1)return '';
    const x=-(b.y-a.y)/len*radius,y=(b.x-a.x)/len*radius;
    return 'M'+(a.x+x)+' '+(a.y+y)+' L'+(b.x+x)+' '+(b.y+y)+
      ' A'+radius+' '+radius+' 0 0 0 '+(b.x-x)+' '+(b.y-y)+
      ' L'+(a.x-x)+' '+(a.y-y)+' A'+radius+' '+radius+' 0 0 0 '+(a.x+x)+' '+(a.y+y)+' Z';
  }
  // Approximate visual regions anchored to pose joints, not muscle segmentation.
  // Work in image pixels so geometry stays correct on tall and wide photos.
  function regionsFromLandmarks(landmarks,width,height){
    if(!Array.isArray(landmarks)||landmarks.length<29||!width||!height)return [];
    const point=i=>{
      const p=landmarks[i];
      if(!p||!Number.isFinite(p.x)||!Number.isFinite(p.y)||p.x<0||p.x>1||p.y<0||p.y>1||
        (p.visibility??0)<0.55||(p.presence??1)<0.55)return null;
      return {x:p.x*width,y:p.y*height};
    };
    let left=point(11),right=point(12),hipLeft=point(23),hipRight=point(24);
    if(!left||!right||!hipLeft||!hipRight)return [];
    let elbowLeft=point(13),elbowRight=point(14),wristLeft=point(15),wristRight=point(16);
    if(left.x>right.x){[left,right]=[right,left];[hipLeft,hipRight]=[hipRight,hipLeft];
      [elbowLeft,elbowRight]=[elbowRight,elbowLeft];[wristLeft,wristRight]=[wristRight,wristLeft];}
    const span=distance(left,right),torso=distance(mix(left,right,.5),mix(hipLeft,hipRight,.5));
    if(span<width*.12||torso<height*.12||span>torso*2.2)return [];
    const row=t=>[mix(left,hipLeft,t),mix(right,hipRight,t)];
    const quad=(top,bottom,inset)=>{
      const a=row(top),b=row(bottom);
      return roundedPolygon([mix(a[0],a[1],inset),mix(a[0],a[1],1-inset),
        mix(b[0],b[1],1-inset),mix(b[0],b[1],inset)]);
    };
    const shoulders=[];
    for(const [joint,elbow,other] of [[left,elbowLeft,right],[right,elbowRight,left]]){
      if(!elbow)continue;
      const outer={x:joint.x+(joint.x-other.x)*.06,y:joint.y};
      shoulders.push(capsule(outer,mix(joint,elbow,.23),span*.14));
    }
    const arms=[];
    for(const [joint,elbow,wrist] of [[left,elbowLeft,wristLeft],[right,elbowRight,wristRight]]){
      if(!elbow)continue;
      arms.push(capsule(mix(joint,elbow,.36),mix(joint,elbow,.89),span*.13));
      if(wrist)arms.push(capsule(mix(elbow,wrist,.16),mix(elbow,wrist,.8),span*.07));
    }
    return [{name:'Chest',paths:[quad(.04,.38,.02)]},
      {name:'Shoulders',paths:shoulders},{name:'Arms',paths:arms},
      {name:'Abs',paths:[quad(.46,.87,.16)]}].filter(region=>region.paths.length);
  }
  function svgElement(tag,attributes){
    const el=document.createElementNS(ns,tag);
    for(const [key,value]of Object.entries(attributes||{}))el.setAttribute(key,value);
    return el;
  }
  function clearWorker(s){clearTimeout(s.workerTimer);if(s.worker){s.worker.terminate();s.worker=null;}}
  function fallback(s,reason){
    if(session!==s)return;
    s.panel.dataset.tracking='fallback';s.panel.dataset.trackingReason=reason;
    s.focus.textContent='Photo review';s.region.textContent='Reviewing your photo';
    s.detail.textContent='Checking the visible details. Your result will appear here when analysis finishes.';
    console.debug('CutRank scan: using photo review state',reason);
  }
  function stop(){
    if(!session)return;
    const s=session;session=null;
    clearInterval(s.timer);clearWorker(s);s.observer?.disconnect();
    s.motion.removeEventListener('change',s.onMotion);
    s.photo.onload=null;s.photo.onerror=null;s.photo.removeAttribute('src');
    s.panel.hidden=true;s.screen.classList.remove('has-photo-scan');s.overlay.replaceChildren();
  }
  function displayRegion(s,index){
    if(session!==s)return;
    s.index=index;
    const region=s.regions[index];
    s.panel.dataset.region=region?region.name.toLowerCase():'waiting';
    s.region.textContent=region?'Evaluating '+region.name.toLowerCase():'Preparing your breakdown';
    s.detail.textContent=region?regionCopy[region.name]:'Your analysis is still running. Your result will appear here as soon as it’s ready.';
    s.focus.textContent=region?'Muscle by muscle':'Bringing it together';
    s.counter.textContent=region?String(index+1).padStart(2,'0')+' / '+String(s.regions.length).padStart(2,'0'):'';
    s.overlay.querySelectorAll('[data-region-index]').forEach(el=>el.classList.toggle('is-current',Number(el.dataset.regionIndex)===index));
    s.steps.querySelectorAll('span').forEach((el,n)=>{el.classList.toggle('is-current',n===index);el.classList.toggle('is-seen',n<index);});
    s.frame.classList.toggle('is-waiting',!region);
    if(!region){clearInterval(s.timer);s.timer=null;}
  }
  function setRegions(s,regions){
    if(session!==s||!regions.length)return;
    s.regions=regions;s.panel.dataset.tracking='ready';s.frame.classList.add('is-tracked');
    s.overlay.setAttribute('viewBox','0 0 '+s.photo.naturalWidth+' '+s.photo.naturalHeight);
    s.overlay.replaceChildren();s.steps.replaceChildren();
    for(const [index,region]of regions.entries()){
      const group=svgElement('g',{'data-region-index':index});
      for(const path of region.paths){
        group.append(svgElement('path',{d:path,'class':'scan-region-outline','vector-effect':'non-scaling-stroke'}));
        group.append(svgElement('path',{d:path,'class':'scan-region-trace','vector-effect':'non-scaling-stroke'}));
      }
      s.overlay.append(group);
      const step=document.createElement('span');step.textContent=region.name;s.steps.append(step);
    }
    s.steps.hidden=false;displayRegion(s,0);
    // Cosmetic sequence, independent of API progress; no forced delay for results.
    s.timer=setInterval(()=>displayRegion(s,Math.min(s.index+1,s.regions.length)),3200);
  }
  async function locate(s){
    if(s.view!=='front'||!root.Worker||!root.createImageBitmap){fallback(s,'untracked-view');return;}
    let bitmap=null;
    try{
      const scale=Math.min(1,1024/Math.max(s.photo.naturalWidth,s.photo.naturalHeight));
      bitmap=await createImageBitmap(s.photo,{resizeWidth:Math.max(1,Math.round(s.photo.naturalWidth*scale)),resizeHeight:Math.max(1,Math.round(s.photo.naturalHeight*scale))});
      if(session!==s){bitmap.close();return;}
      s.worker=new Worker(new URL('scan-pose-worker.js',scriptURL));
      s.workerTimer=setTimeout(()=>{if(session===s){fallback(s,'timeout');clearWorker(s);}},12000);
      s.worker.onmessage=({data})=>{
        if(session!==s)return;
        clearWorker(s);
        if(data.error)console.debug('CutRank scan: optional pose detection unavailable',data.error);
        const regions=regionsFromLandmarks(data.landmarks,s.photo.naturalWidth,s.photo.naturalHeight);
        if(regions.length)setRegions(s,regions);else fallback(s,data.error||(!data.landmarks?'no-single-pose':'insufficient-landmarks'));
      };
      s.worker.onerror=event=>{if(session===s){fallback(s,'worker-error');console.debug('CutRank scan: optional pose worker unavailable',event.message);clearWorker(s);}};
      s.worker.postMessage({bitmap},[bitmap]);
      bitmap=null; // Ownership transferred to the worker.
    }catch(error){bitmap?.close();if(session===s){fallback(s,'bitmap-unavailable');clearWorker(s);}}
  }
  function start(view,photoURL){
    stop();
    const panel=document.getElementById('photoScan');if(!panel||!photoURL)return;
    // Create the shared presentation once for both the app and local preview.
    if(!panel.querySelector('.scan-region-detail')){
      const caption=panel.querySelector('.scan-region-caption');
      const focus=document.createElement('p');focus.className='scan-focus-label';caption.before(focus);
      const detail=document.createElement('p');detail.className='scan-region-detail';caption.after(detail);
      caption.setAttribute('role','status');caption.setAttribute('aria-live','polite');caption.setAttribute('aria-atomic','true');
      panel.querySelector('.scan-animation-note').textContent='Keep this page open. Your result will appear here.';
      const note=document.createElement('p');note.className='scan-sequence-note';note.textContent='Visual scan sequence · not live grading progress';panel.append(note);
    }
    const s={panel,screen:document.getElementById('screen-analyse'),photo:document.getElementById('scanPhoto'),
      overlay:document.getElementById('scanRegions'),frame:document.getElementById('scanPhotoFrame'),
      region:document.getElementById('scanRegionName'),counter:document.getElementById('scanRegionCounter'),
      steps:document.getElementById('scanRegionSteps'),motion:matchMedia('(prefers-reduced-motion: reduce)'),
      detail:panel.querySelector('.scan-region-detail'),focus:panel.querySelector('.scan-focus-label'),
      view,regions:[],index:0,timer:null,worker:null};
    session=s;s.screen.classList.add('has-photo-scan');panel.hidden=false;panel.dataset.tracking='locating';delete panel.dataset.trackingReason;
    panel.dataset.region='locating';s.frame.classList.remove('is-tracked','is-waiting');s.steps.replaceChildren();
    s.steps.hidden=true;s.region.textContent='Reading your photo';s.counter.textContent='';
    s.focus.textContent='A closer look';s.detail.textContent='Getting a clear view of your physique and the visible muscle groups.';
    document.getElementById('scanViewLabel').textContent=view==='front'?'FRONT VIEW':view==='back'?'BACK VIEW':view==='legs'?'LEGS':'ARMS';
    s.photo.onload=()=>{if(session!==s)return;s.frame.style.aspectRatio=s.photo.naturalWidth+'/'+s.photo.naturalHeight;s.frame.style.width=Math.min(368,320*s.photo.naturalWidth/s.photo.naturalHeight)+'px';locate(s);};
    s.photo.onerror=()=>{if(session===s)stop();};
    s.photo.src=photoURL;
    // Reduced motion disables visual movement in CSS; readable status updates remain.
    s.onMotion=()=>{};
    s.motion.addEventListener('change',s.onMotion);
    // Also stop when navigation changes outside app.show (e.g. dashboard routes).
    s.observer=new MutationObserver(()=>{if(session===s&&!s.screen.classList.contains('active'))stop();});
    s.observer.observe(s.screen,{attributes:true,attributeFilter:['class']});
  }
  // This optional visual must never fail the existing grading/navigation flow.
  function safeStop(){try{stop();}catch(error){console.debug('CutRank scan: animation cleanup unavailable');}}
  function safeStart(view,photoURL){try{start(view,photoURL);}catch(error){safeStop();console.debug('CutRank scan: animation unavailable');}}
  root.CutRankScan={start:safeStart,stop:safeStop,regionsFromLandmarks};
})(globalThis);
