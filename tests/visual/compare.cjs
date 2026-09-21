// Compare the real OSU and UO applications using identical data; no mock UI.
const fs=require('node:fs');
const path=require('node:path');
const {createServer}=require('node:http');
const {chromium}=require('/home/codex/tools/browser-tests/node_modules/playwright');
const assert=require('node:assert/strict');
const roots={osu:process.env.OSU_ROOT||'/home/codex/Projects/osu-sal-report-data-and-site',uo:path.resolve(__dirname,'../..')};
const load=(name)=>JSON.parse(fs.readFileSync(path.join(roots.osu,'data',name)));
const original=load('index.json');
const chosen=Object.keys(original).filter(n=>original[n].Meta['First Hired'] && !original[n]._captureDate && original[n]._totalPay>0).slice(0,24);
const index=Object.fromEntries(chosen.map(n=>[n,original[n]]));
const agg=load('aggregates.json');delete agg.captureImport;
agg.latestClassDate='';agg.latestUnclassDate='';
const search={records:load('search-index.json').records.filter(r=>chosen.includes(r.name))};
const fixtures={'index.json':index,'aggregates.json':agg,'search-index.json':search,'peer-medians.json':load('peer-medians.json')};
const out=path.join(roots.uo,'test-results/parity');fs.mkdirSync(out,{recursive:true});
const servers=[];
function serve(root){return new Promise(resolve=>{const server=createServer((req,res)=>{
 const relative=decodeURIComponent(req.url.split('?')[0]);
 const name=relative.replace(/^\/data\//,'');
 if(relative.startsWith('/data/') && fixtures[name]) {res.setHeader('Content-Type','application/json');res.end(JSON.stringify(fixtures[name]));return;}
 if(relative.startsWith('/data/people/')){const file=path.join(roots.osu,relative);res.setHeader('Content-Type','application/json');fs.createReadStream(file).pipe(res);return;}
 const file=path.resolve(root,'.'+(relative==='/'?'/index.html':relative));
 if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}
 res.setHeader('Content-Type',({'.html':'text/html','.js':'application/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml'})[path.extname(file)]||'application/octet-stream');fs.createReadStream(file).pipe(res);
 });servers.push(server);server.listen(0,'127.0.0.1',()=>resolve('http://127.0.0.1:'+server.address().port));});}
(async()=>{
 const browser=await chromium.launch();const report=[];
 const urls={osu:await serve(roots.osu),uo:await serve(roots.uo)};
 for(const width of [1440,390]){
  const measurements={};
  for(const institution of ['osu','uo']){
   const context=await browser.newContext({viewport:{width,height:1000}});
   await context.route('https://cdn.jsdelivr.net/npm/chart.js',r=>r.fulfill({path:path.join(roots.uo,'js/vendor/chart.umd.js'),contentType:'application/javascript'}));
   await context.route('**/*posthog*',r=>r.abort());
   const page=await context.newPage();
   await page.goto(urls[institution]);await page.waitForSelector('.card');
   // Institution/records-request copy are explicitly allowed differences.
   await page.evaluate(()=>{document.querySelector('h1').textContent='Salary Transparency';document.querySelector('#foia-notice').innerHTML='<div>Original source reports are preserved for review.</div>';document.querySelector('#capture-import-notice')?.remove();});
   const selectors=['.header .title-row','#stats-dashboard','#stat-total','#stat-median','#tenure-chart','#role-donut','#org-leaderboard','.section-header','#search','#advanced-toggle','.dsl-help','#stats-bar','.card','.card-header'];
   measurements[institution]=await page.evaluate(selectors=>Object.fromEntries(selectors.map(selector=>{const r=document.querySelector(selector).getBoundingClientRect();return[selector,{x:r.x,y:r.y,width:r.width,height:r.height}]})),selectors);
   await page.screenshot({path:path.join(out,`${institution}-${width}.png`)});
   await context.close();
  }
  for(const [selector,expected] of Object.entries(measurements.osu))for(const prop of ['x','y','width','height'])assert.ok(Math.abs(expected[prop]-measurements.uo[selector][prop])<=1,`${width} ${selector} ${prop}: OSU=${expected[prop]} UO=${measurements.uo[selector][prop]}`);
  report.push({width,matched:true,components:Object.keys(measurements.osu).length,measurements});
 }
 fs.writeFileSync(path.join(out,'comparison.json'),JSON.stringify(report,null,2));
 console.log('PASS: 14 component rectangles match OSU within 1 px at 1440 px and 390 px.');
 await browser.close();servers.forEach(s=>s.close());
})().catch(e=>{console.error(e);servers.forEach(s=>s.close());process.exit(1)});
