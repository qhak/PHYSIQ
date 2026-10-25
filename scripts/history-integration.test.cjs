const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const worker=import('data:text/javascript;base64,'+fs.readFileSync(path.join(root,'worker/site.js')).toString('base64'));
const assets={fetch:async request=>{
 const pathname=new URL(request.url).pathname;
 const filename=path.join(root,'dist',pathname);
 return fs.existsSync(filename)&&fs.statSync(filename).isFile()?new Response(fs.readFileSync(filename)):new Response('missing',{status:404});
}};
test('build retains current affiliate UI, excludes private implementation and local training prototype',()=>{
 const html=fs.readFileSync(path.join(root,'dist/index.html'),'utf8');
 assert.match(html,/affiliateDashboard|screen-affiliate/);
 assert.match(html,/scan-animation\.js/);
 for(const filename of ['worker','scripts','prototypes','what-are-peptides.html'])assert.equal(fs.existsSync(path.join(root,'dist',filename)),false,filename);
 const guide=fs.readFileSync(path.join(root,'dist/ai-physique-grading-app.html'),'utf8');
 assert.match(guide,/\$7\.99 once/);assert.match(guide,/\$16\.99 monthly/);assert.match(guide,/\$66\.99 yearly/);assert.doesNotMatch(guide,/£|Lifetime \/|favicon\.svg/);
 assert.match(fs.readFileSync(path.join(root,'dist/sitemap.xml'),'utf8'),/ai-physique-grading-app\.html/);
});
test('canonical redirects, retired page handling, and preview indexing survive integration',async()=>{
 const {default:w}=await worker;
 for(const suffix of ['what-are-peptides','what-are-peptides.html','what-are-peptides/']) {
  const r=await w.fetch(new Request('https://cutrank.app/'+suffix),{ASSETS:assets});assert.equal(r.status,410);
 }
 const canonical=await w.fetch(new Request('https://cutrank.app/ai-physique-grading-app?x=1'),{ASSETS:assets});
 assert.equal(canonical.status,301);assert.equal(canonical.headers.get('location'),'https://cutrank.app/ai-physique-grading-app.html?x=1');
 const home=await w.fetch(new Request('https://cutrank-site.callout-ai.workers.dev/'),{ASSETS:assets});assert.equal(home.status,200);assert.equal(home.headers.get('x-robots-tag'),'noindex, nofollow');
 const legacy=await w.fetch(new Request('https://callout-ai.com/tools.html'),{ASSETS:assets});assert.equal(legacy.headers.get('location'),'https://cutrank.app/tools.html');
});
test('homepage and retained explainer reference available local styles, scripts and images',()=>{
 for(const name of ['index.html','ai-physique-grading-app.html']){
  const html=fs.readFileSync(path.join(root,'dist',name),'utf8');
  for(const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)){
   const value=match[1].split(/[?#]/)[0];if(!value||/^(?:https?:|mailto:|data:|\/\/)/.test(value)||!/[.](?:js|css|png|webp|jpg|svg)$/.test(value))continue;
   assert.equal(fs.existsSync(path.join(root,'dist',value)),true,`${name}: ${value}`);
  }
 }
});
