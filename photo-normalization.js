// Locate the person locally, before the full photo loses detail during resizing.
// Only model/runtime assets are downloaded; the detector does not upload photos.
// The original is always retained for scene, eligibility and conditioning checks.
(function(root){
  'use strict';
  const RUNTIME='https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1';
  const MODEL='https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float32/1/efficientdet_lite0.tflite';
  let detectorPromise;
  function detector(){
    if(!detectorPromise) detectorPromise=(async()=>{
      const {FilesetResolver,ObjectDetector}=await import(RUNTIME+'/vision_bundle.mjs');
      const files=await FilesetResolver.forVisionTasks(RUNTIME+'/wasm');
      return ObjectDetector.createFromOptions(files,{
        baseOptions:{modelAssetPath:MODEL,delegate:'CPU'},runningMode:'IMAGE',
        categoryAllowlist:['person'],scoreThreshold:0.5,maxResults:3
      });
    })().catch(err=>{detectorPromise=null;throw err;});
    return detectorPromise;
  }
  function bounded(promise,ms){
    let timer;
    return Promise.race([promise,new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(new Error('detector_timeout')),ms);
    })]).finally(()=>clearTimeout(timer));
  }
  function subjectCrop(detections,width,height){
    const people=(detections||[]).filter(d=>(d.categories||[]).some(c=>c.categoryName==='person'&&c.score>=0.5));
    // Never choose one person out of a group. The original still reaches the
    // worker for its eligibility checks, including people missed by detection.
    if(people.length!==1) return null;
    const b=people[0].boundingBox;
    if(!b||![b.originX,b.originY,b.width,b.height].every(Number.isFinite)||b.width<32||b.height<64) return null;
    const left=Math.max(0,b.originX),top=Math.max(0,b.originY);
    const right=Math.min(width,b.originX+b.width),bottom=Math.min(height,b.originY+b.height);
    if(right<=left||bottom<=top) return null;
    const padX=(right-left)*0.12,padY=(bottom-top)*0.10;
    const x=Math.max(0,Math.floor(left-padX)),y=Math.max(0,Math.floor(top-padY));
    const w=Math.min(width,Math.ceil(right+padX))-x,h=Math.min(height,Math.ceil(bottom+padY))-y;
    // Close/full-frame photos gain no useful extra detail from a duplicate.
    if(w*h>=width*height*0.85) return null;
    return {x,y,width:w,height:h};
  }
  function mergePeople(detections){
    const merged=[];
    for(const detection of detections){
      const b=detection.boundingBox;
      if(!b||![b.originX,b.originY,b.width,b.height].every(Number.isFinite)||b.width<=0||b.height<=0) continue;
      const match=merged.find(d=>{
        const a=d.boundingBox;
        const intersection=Math.max(0,Math.min(a.originX+a.width,b.originX+b.width)-Math.max(a.originX,b.originX))*
          Math.max(0,Math.min(a.originY+a.height,b.originY+b.height)-Math.max(a.originY,b.originY));
        return intersection/(a.width*a.height+b.width*b.height-intersection)>0.3;
      });
      if(!match){merged.push({...detection,boundingBox:{...b}});continue;}
      const a=match.boundingBox,x=Math.min(a.originX,b.originX),y=Math.min(a.originY,b.originY);
      match.boundingBox={originX:x,originY:y,width:Math.max(a.originX+a.width,b.originX+b.width)-x,height:Math.max(a.originY+a.height,b.originY+b.height)-y};
    }
    return merged;
  }
  async function detectPeople(model,img,width,height){
    const isPerson=d=>(d.categories||[]).some(c=>c.categoryName==='person'&&c.score>=0.5);
    const direct=(model.detect(img).detections||[]).filter(isPerson);
    if(direct.length) return direct;
    // The detector internally downsamples. Search overlapping sections only on
    // a miss, so a tiny person gets more detector pixels. Keep all detections,
    // including other people, and merge duplicate boxes from tile overlaps.
    const found=[],tileW=Math.ceil(width*0.65),tileH=Math.ceil(height*0.65);
    for(const y of [0,height-tileH])for(const x of [0,width-tileW]){
      await new Promise(resolve=>setTimeout(resolve,0)); // let the progress UI paint
      const scale=Math.min(1,1280/Math.max(tileW,tileH));
      const tile=document.createElement('canvas');
      tile.width=Math.round(tileW*scale);tile.height=Math.round(tileH*scale);
      const ctx=tile.getContext('2d');if(!ctx) continue;
      ctx.drawImage(img,x,y,tileW,tileH,0,0,tile.width,tile.height);
      for(const d of (model.detect(tile).detections||[]).filter(isPerson)){
        const b=d.boundingBox;if(!b) continue;
        found.push({...d,boundingBox:{originX:x+b.originX*tileW/tile.width,originY:y+b.originY*tileH/tile.height,
          width:b.width*tileW/tile.width,height:b.height*tileH/tile.height}});
      }
    }
    return mergePeople(found);
  }
  function encode(img,box,maxEdge=1600){
    const scale=Math.min(1,maxEdge/Math.max(box.width,box.height));
    const c=document.createElement('canvas');
    c.width=Math.max(1,Math.round(box.width*scale));
    c.height=Math.max(1,Math.round(box.height*scale));
    const ctx=c.getContext('2d',{alpha:false});
    if(!ctx) throw new Error('canvas_unavailable');
    ctx.fillStyle='#111';ctx.fillRect(0,0,c.width,c.height);
    ctx.drawImage(img,box.x,box.y,box.width,box.height,0,0,c.width,c.height);
    // Two images together must remain below the worker's existing request cap.
    for(const quality of [0.88,0.76,0.62]){
      const base64=c.toDataURL('image/jpeg',quality).split(',')[1]||'';
      if(base64 && base64.length<=2.8*1024*1024) return base64;
    }
    throw new Error('processed_too_large');
  }
  async function prepare(file,options={}){
    const url=URL.createObjectURL(file);
    try{
      const img=new Image();
      await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=()=>reject(new Error('image_processing_failed'));img.src=url;});
      const width=img.naturalWidth,height=img.naturalHeight;
      if(!width||!height) throw new Error('image_processing_failed');
      const image=encode(img,{x:0,y:0,width,height});
      let crop=null;
      try{
        const model=await bounded((options.detector||detector)(),12000);
        const people=await detectPeople(model,img,width,height);
        crop=subjectCrop(people,width,height);
      }catch(e){/* Detection is optional; preserve the existing upload path. */}
      if(!crop) return {image,normalized_image:null};
      try{return {image,normalized_image:encode(img,crop)};}
      catch(e){return {image,normalized_image:null};}
    }finally{URL.revokeObjectURL(url);}
  }
  root.CutRankPhotos={prepare,subjectCrop,mergePeople};
})(globalThis);
