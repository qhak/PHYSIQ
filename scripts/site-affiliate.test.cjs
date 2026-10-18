const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../worker/site.js'),'utf8');
const loaded=import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const env={ASSETS:{fetch:async()=>new Response('missing',{status:404})}};
test('all campaign URLs preserve source tracking and gain configured referral attribution',async()=>{
 const {default:worker}=await loaded;const original=global.fetch;
 global.fetch=async url=>{assert.match(url,/\/affiliate-link\/[ti](?:[1-9]|1[0-5])$/);return Response.json({affiliate_id:'creator'});};
 try{
   for(const prefix of ['t','i'])for(let n=1;n<=15;n++){
     const r=await worker.fetch(new Request('https://cutrank.app/'+prefix+n+'?utm_campaign=test'),env);
     assert.equal(r.status,302);const destination=new URL(r.headers.get('location'));
     assert.equal(destination.searchParams.get('ref'),'creator');assert.equal(destination.searchParams.get('utm_campaign'),'test');
     assert.equal(destination.searchParams.get('utm_source'),(prefix==='t'?'tiktok':'instagram')+n);
   }
 }finally{global.fetch=original;}
});
test('unassigned campaign and unavailable resolver keep campaign links usable',async()=>{
 const {default:worker}=await loaded;const original=global.fetch;
 try{
   for(const response of [()=>new Response('',{status:404}),()=>{throw Error('network');}]){
     global.fetch=async()=>response();const r=await worker.fetch(new Request('https://cutrank.app/t1'),env);
     const destination=new URL(r.headers.get('location'));assert.equal(destination.searchParams.get('utm_source'),'tiktok1');assert.equal(destination.searchParams.has('ref'),false);
   }
 }finally{global.fetch=original;}
});
test('personal short links preserve other query parameters and preview indexing rules',async()=>{
 const {default:worker}=await loaded;
 const r=await worker.fetch(new Request('https://cutrank-site.callout-ai.workers.dev/r/creator?utm_source=profile'),env);
 assert.equal(r.status,302);const destination=new URL(r.headers.get('location'));
 assert.equal(destination.pathname,'/');assert.equal(destination.searchParams.get('ref'),'creator');assert.equal(destination.searchParams.get('utm_source'),'profile');
 assert.equal(r.headers.get('x-robots-tag'),'noindex, nofollow');
});
