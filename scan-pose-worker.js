// Only static model assets are fetched. Photo pixels remain on this device.
let modelPromise;
const runtime='https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1';
async function model(){
  if(!modelPromise) modelPromise=(async()=>{
    const {FilesetResolver,PoseLandmarker}=await import(runtime+'/vision_bundle.mjs');
    const files=await FilesetResolver.forVisionTasks(runtime+'/wasm');
    return PoseLandmarker.createFromOptions(files,{
      baseOptions:{modelAssetPath:'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',delegate:'CPU'},
      runningMode:'IMAGE',numPoses:2,minPoseDetectionConfidence:0.35,minPosePresenceConfidence:0.5
    });
  })();
  return modelPromise;
}
self.onmessage=async({data})=>{
  const {bitmap}=data;
  try{
    const detector=await model();
    const result=detector.detect(bitmap);
    // Animate only a single detected pose. This is not an eligibility check;
    // the existing grading worker still handles people the pose model misses.
    self.postMessage({landmarks:result.landmarks.length===1?result.landmarks[0]:null});
  }catch(error){self.postMessage({landmarks:null,error:String(error?.message||'pose_unavailable')});}
  finally{bitmap.close();}
};
