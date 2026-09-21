// Real OSU and UO applications, identical synthetic records, identical browser.
// Normalize institution-specific copy and color only for the pixel equality pass.
const {chromium}=require('playwright');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const assert=require('node:assert/strict');
const fixtures=require('./fixtures.cjs');
const root=path.resolve(__dirname,'../..'),out=path.join(root,'test-results/ab');
const referenceRoot=process.env.OSU_REFERENCE_ROOT||'/home/codex/Projects/osu-sal-report-data-and-site';
const refOrigin=process.env.OSU_PREVIEW_URL||'http://127.0.0.1:8084';
const uoOrigin=process.env.UO_PREVIEW_URL||'http://127.0.0.1:8085';
fs.mkdirSync(out,{recursive:true});
const digest=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
assert.equal(digest(path.join(root,'css/styles.css')),digest(path.join(referenceRoot,'css/styles.css')),'Shared CSS must be byte-identical to OSU');
const reference=require('./reference.json');
for(const [file,hash]of Object.entries(reference.files))assert.equal(digest(path.join(referenceRoot,file)),hash,`Reference drift: ${file}`);

async function normalizeCopy(page){
  await page.evaluate(()=>{
    document.querySelector('h1').textContent='Salary Transparency';
    const notice=document.querySelector('#capture-import-notice');notice.hidden=false;
    notice.textContent='Visual comparison using the same synthetic report records. This is a layout test, not published university salary data.';
    document.querySelector('.foia-content').innerHTML='<strong>⚠️ Data Record Update:</strong> Original salary reports are preserved for verification. <a href="records.html">Browse the original salary reports here</a>.';
    document.querySelector('#stats-bar').textContent='Found 15 matching personnel records.';
    document.querySelectorAll('.person-info > p').forEach(el=>el.textContent=el.textContent.replace(/^(Home Org|Department):/,'Department:'));
  });
}
const selectors=['.container','.title-row','h1','#info-btn','#stats-dashboard',...Array.from({length:3},(_,i)=>`#stats-dashboard > .stat-card:nth-child(${i+1})`),
  '.stat-column','.stat-column .stat-card:nth-child(1)','.stat-column .stat-card:nth-child(2)','#tenure-chart','.donut-container','#role-donut','#role-legend','#org-leaderboard',
  '.section-divider','.section-header','#historical-toggle','.search-container','.search-wrapper','#search','#advanced-toggle','#suggested-searches','.dsl-help','#stats-bar',
  '#card-0','#card-0 .card-header','#card-0 .name-header','#card-0 .latest-stat','#card-0 .latest-salary'];
async function geometry(page){return page.evaluate(selectors=>Object.fromEntries(selectors.map(selector=>{
  const el=document.querySelector(selector),r=el.getBoundingClientRect(),s=getComputedStyle(el);
  return[selector,{x:r.x,y:r.y,width:r.width,height:r.height,font:s.font,padding:s.padding,margin:s.margin,gap:s.gap,borderRadius:s.borderRadius}];
})),selectors);}
async function compareGeometry(a,b,name){
  const aa=await geometry(a),bb=await geometry(b),errors=[];
  for(const selector of selectors)for(const [property,value]of Object.entries(aa[selector])){
    const other=bb[selector][property];
    if(typeof value==='number'?Math.abs(value-other)>.05:value!==other)errors.push({selector,property,osu:value,uo:other});
  }
  fs.writeFileSync(path.join(out,`${name}-geometry.json`),JSON.stringify({osu:aa,uo:bb,errors},null,2));
  return errors;
}
(async()=>{
 const browser=await chromium.launch({headless:true});const results=[];
 try{
  for(const [label,viewport]of [['desktop',{width:1440,height:1300}],['mobile',{width:390,height:1800}]]){
   const reference=await browser.newPage({viewport}),uo=await browser.newPage({viewport});
   for(const page of [reference,uo]){
     await page.route('https://**/*',route=>route.abort());
     await page.emulateMedia({reducedMotion:'reduce'});
   }
   // Actual current sites, without fixture or copy normalization.
   await reference.goto(refOrigin,{waitUntil:'domcontentloaded'});await reference.waitForSelector('.card');
   await uo.goto(uoOrigin,{waitUntil:'networkidle'});await uo.waitForSelector('#empty-state:not([hidden])');
   await reference.screenshot({path:path.join(out,`${label}-actual-osu.png`),animations:'disabled'});
   await uo.screenshot({path:path.join(out,`${label}-actual-uo.png`),animations:'disabled'});
   // Only the data transport is replaced; both original apps build their own DOM.
   for(const [page,type]of [[reference,'osu'],[uo,'uo']]){
     await page.addInitScript(()=>{window.Worker=class{constructor(){throw new Error('Use main-thread search in visual comparisons');}};});
     await page.route('**/data/index.json*',route=>route.fulfill({json:fixtures[type]}));
     await page.route('**/data/aggregates.json*',route=>route.fulfill({json:fixtures[`${type}Aggregates`]}));
     await page.reload({waitUntil:'networkidle'});
     await page.waitForFunction(()=>document.querySelectorAll('#results > .card').length===15);
     await normalizeCopy(page);
     await page.mouse.move(0,0);
   }
   // A/B with UO colors preserved and shared content: the requested comparison.
   await reference.screenshot({path:path.join(out,`${label}-matched-osu.png`),animations:'disabled'});
   await uo.screenshot({path:path.join(out,`${label}-matched-uo.png`),animations:'disabled'});
   const errors=await compareGeometry(reference,uo,label);
   // Remove only UO's color sheet and restore its chart palette to OSU's colors.
   await uo.evaluate(()=>{document.querySelector('link[href="css/uo-theme.css"]').disabled=true;});
   await uo.addStyleTag({content:':root{--uo-green:#D73F09;--uo-evergreen:#b83508;--uo-fern:#992c06;--uo-moss:#7a2205}'});
   await reference.screenshot({path:path.join(out,`${label}-normalized-osu.png`),animations:'disabled'});
   await uo.screenshot({path:path.join(out,`${label}-normalized-uo.png`),animations:'disabled'});
   results.push({viewport:label,geometryErrors:errors});
   // Expanded filter state: preserve both actual source-specific control sets.
   await reference.locator('#advanced-toggle').click();await uo.locator('#advanced-toggle').click();
   await reference.mouse.move(0,0);await uo.mouse.move(0,0);
   await uo.evaluate(()=>{document.querySelector('link[href="css/uo-theme.css"]').disabled=false;});
   await reference.screenshot({path:path.join(out,`${label}-advanced-osu.png`),animations:'disabled'});
   await uo.screenshot({path:path.join(out,`${label}-advanced-uo.png`),animations:'disabled'});
   // Archive pages use the same official catalog entries, in each app's own schema.
   const catalog=JSON.parse(fs.readFileSync(path.join(root,'records.json'),'utf8'));
   const archiveReference=catalog.reports.map(report=>({
     title:`${report.endDate.slice(0,4)} ${report.classification[0].toUpperCase()+report.classification.slice(1)} ${report.kind==='census'?'Fall Census':'Fiscal Year'} Salary Report`,
     type:report.classification[0].toUpperCase()+report.classification.slice(1),year:Number(report.endDate.slice(0,4)),date:report.endDate,
     quarter:report.kind==='census'?'Fall Census':'Fiscal Year',author:'PDF needed',source:'UO',filename:'visual-source.pdf',format:'PDF'
   }));
   await reference.route('**/records.json*',route=>route.fulfill({json:archiveReference}));
   await reference.goto(`${refOrigin}/records.html`,{waitUntil:'networkidle'});
   await uo.goto(`${uoOrigin}/records.html`,{waitUntil:'networkidle'});
   for(const page of [reference,uo]){
     await page.waitForSelector('.record-card');
     await page.evaluate(()=>{
       document.querySelector('h1').textContent='Salary Reports Archive';
       document.querySelector('.subtitle').textContent='Browse original salary reports, including census rates and fiscal-year actual pay. Sources are labeled when they are not yet included in the explorer.';
       document.querySelectorAll('.record-card').forEach(card=>{
         card.querySelectorAll('.tag')[1].textContent='Status: PDF needed';
         card.querySelector('.download-btn').textContent='Open source report ↗';
       });
     });
     await page.mouse.move(0,0);
   }
   await reference.screenshot({path:path.join(out,`${label}-archive-osu.png`),animations:'disabled'});
   await uo.screenshot({path:path.join(out,`${label}-archive-uo.png`),animations:'disabled'});
   const archiveSelectors=['.container','.header','.back-link','h1','.controls-area','.search-container','#record-search','.chip-container','.section-divider','.year-separator','.records-grid','.record-card','.record-title','.download-btn'];
   const archiveRects=async page=>page.evaluate(selectors=>Object.fromEntries(selectors.map(selector=>{
     const r=document.querySelector(selector).getBoundingClientRect();return[selector,{x:r.x,y:r.y,width:r.width,height:r.height}];
   })),archiveSelectors);
   const ar=await archiveRects(reference),br=await archiveRects(uo),archiveErrors=[];
   for(const selector of archiveSelectors)for(const property of ['x','y','width','height']){
     if(Math.abs(ar[selector][property]-br[selector][property])>.05)archiveErrors.push({selector,property,osu:ar[selector][property],uo:br[selector][property]});
   }
   results.push({viewport:`${label}-archive`,geometryErrors:archiveErrors});
   await uo.evaluate(()=>{document.querySelector('link[href="css/uo-theme.css"]').disabled=true;});
   await reference.screenshot({path:path.join(out,`${label}-archive-normalized-osu.png`),animations:'disabled'});
   await uo.screenshot({path:path.join(out,`${label}-archive-normalized-uo.png`),animations:'disabled'});
   await reference.close();await uo.close();
  }
 }finally{await browser.close();}
 fs.writeFileSync(path.join(out,'geometry-summary.json'),JSON.stringify(results,null,2));
 console.log(JSON.stringify(results,null,2));
 if(results.some(result=>result.geometryErrors.length))process.exitCode=1;
})().catch(error=>{console.error(error);process.exitCode=1;});
