// Requires the documented host Playwright installation; no production dependency.
const {chromium, firefox, webkit}=require('playwright');
const assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const catalog=JSON.parse(fs.readFileSync(path.join(root,'data/index.json'),'utf8'));
const index=JSON.parse(fs.readFileSync(path.join(root,'data/search-index.json'),'utf8'));
const reports=index.reportIds.map(id=>catalog.reports.find(report=>report.id===id));
const countFor=(kind='all',date='all',measure='all')=>new Set(index.rows.filter(row=>
  (kind==='all'||reports[row[0]].kind===kind)&&(date==='all'||reports[row[0]].endDate===date)&&
  (measure==='all'||index.dictionaries.measure[row[5]]===measure)).map(row=>row[2])).size;
const histories=new Map();
for(const row of index.rows){
  if(!histories.has(row[2]))histories.set(row[2],[]);
  histories.get(row[2]).push(row);
}
const historicName=[...histories].find(([name,rows])=>rows.every(row=>reports[row[0]].endDate<'2011')&&
  index.dictionaries.name.filter(value=>value.toLowerCase().includes(index.dictionaries.name[name].toLowerCase())).length===1)[0];
const historicRows=histories.get(historicName);
const linkedRow=historicRows[0];
const origin=process.env.UO_PREVIEW_URL||'http://127.0.0.1:8085';
const fixture=JSON.parse(execFileSync('python3',[path.join(__dirname,'browser_fixture.py')],{encoding:'utf8'}));
fs.mkdirSync(path.join(root,'test-results'),{recursive:true});
async function fixtureRoutes(page){
  await page.route('**/data/**',route=>{
    const name=new URL(route.request().url()).pathname.replace(/^\//,'');
    return fixture[name]?route.fulfill({json:fixture[name]}):route.continue();
  });
}
async function waitCount(page,expected){await page.waitForFunction(value=>document.querySelector('#stat-total').textContent.replaceAll(',','')===value,String(expected));}
async function noOverflow(page,label){assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,label);}
(async()=>{
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1180}});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    const started=Date.now();
    await page.goto(origin,{waitUntil:'networkidle'});await waitCount(page,catalog.exactNameCount);
    console.log(`All-report index ready in ${Date.now()-started} ms; ${catalog.exactNameCount} names, ${catalog.recordCount} entries.`);
    assert.match(await page.locator('#capture-import-notice').textContent(),/93 of 93/);
    assert.equal(await page.locator('#search').isDisabled(),false);
    assert.equal(await page.locator('.card').count(),50);
    assert.equal(await page.locator('#stat-median').textContent(),'-');
    assert.equal(await page.locator('#period').inputValue(),'all');
    assert.equal(await page.locator('#measure').inputValue(),'all');
    // A name found only in older reports remains searchable from the default view.
    await page.locator('#search').fill(`name:"${index.dictionaries.name[historicName]}"`);await waitCount(page,1);
    await page.locator('.card-header').click();
    assert.equal(await page.locator('.history table tbody tr').count(),historicRows.length);
    assert.match(await page.locator('.history a').first().getAttribute('href'),/\/reports\/sharepoint\/.*#page=\d+$/);
    assert.match(await page.locator('.name-match-note').textContent(),/Shared names/);
    const linkedId=`${reports[linkedRow[0]].id}:${linkedRow[1]}`;
    await page.goto(`${origin}/?record=${encodeURIComponent(linkedId)}`,{waitUntil:'networkidle'});await waitCount(page,1);
    assert.equal(await page.locator('.linked-source').count(),1);
    assert.equal(await page.locator('.card.expanded').count(),1);
    await page.locator('#clear-search').click();await waitCount(page,catalog.exactNameCount);
    await page.locator('#advanced-toggle').click();
    for(const [kind,date,measure] of [
      ['fiscal','2026-06-30','fiscal_year_pay'],
      ['census','2025-11-01','annual_rate'],
      ['census','2025-11-01','academic_year_rate'],
      ['historical','2019-06-30','annual_rate']]){
      await page.locator('#report-series').selectOption(kind);
      await waitCount(page,countFor(kind));
      assert.equal(await page.locator('#period').inputValue(),'all');
      await page.locator('#period').selectOption(date);
      await page.locator('#measure').selectOption(measure);
      await waitCount(page,countFor(kind,date,measure));
    }
    await page.locator('#report-series').selectOption('all');await waitCount(page,catalog.exactNameCount);
    await page.locator('#advanced-toggle').click();
    await page.screenshot({path:'test-results/explorer-desktop.png',fullPage:true});
    await page.goto(`${origin}/records.html`,{waitUntil:'networkidle'});
    assert.equal(await page.locator('.record-card').count(),93);
    assert.equal(await page.locator('.record-card .download-btn').count(),93);
    assert.equal(await page.locator('.record-card .tag').filter({hasText:'Status: Imported'}).count(),93);
    await page.locator('[data-filter="Classified"]').click();
    assert.equal(await page.locator('.record-card').count(),catalog.reports.filter(r=>r.classification==='classified').length);
    await page.locator('#record-search').fill('2026');assert.equal(await page.locator('.record-card').count(),1);
    await page.locator('#clear-search').click();await page.locator('[data-filter="all"]').click();
    // The preview must not expose repository internals, source code, or listings.
    for(const target of ['/.git/config','/scripts/build_data.py','/data/','/normalized/README.md']){
      const response=await page.request.get(`${origin}${target}`);assert.ok([403,404].includes(response.status()),target);
    }
    await page.setViewportSize({width:390,height:844});
    for(const pathname of ['/','/records.html','/methodology.html']){
      await page.goto(origin+pathname,{waitUntil:'networkidle'});await noOverflow(page,`${pathname} overflows mobile`);
    }
    await page.goto(origin,{waitUntil:'networkidle'});await waitCount(page,catalog.exactNameCount);
    await page.locator('#advanced-toggle').click();await noOverflow(page,'real mobile Advanced filters overflow');
    await page.locator('#advanced-toggle').click();await page.locator('#info-btn').click();
    await page.waitForSelector('#info-modal:not(.hidden)');await page.keyboard.press('Escape');
    assert.equal(await page.locator('#info-modal').isVisible(),false);
    await page.screenshot({path:'test-results/explorer-mobile.png',fullPage:true});
    // Fixtures cover shared names, old jobs, missing/zero pay, and escaped source text.
    await fixtureRoutes(page);await page.reload({waitUntil:'networkidle'});await waitCount(page,60);
    await page.locator('#scroll-sentinel').scrollIntoViewIfNeeded();
    await page.waitForFunction(()=>document.querySelectorAll('#results > .card').length===60);
    assert.equal(await page.locator('.name-header h2').filter({hasText:'<script>Example</script>'}).count(),1);
    await page.locator('#search').fill('name:zoe');await waitCount(page,1);
    await page.locator('.card-header').click();
    assert.equal(await page.locator('.history table tbody tr').count(),4);
    assert.match(await page.locator('.history a').first().getAttribute('href'),/reports\/test.pdf#page=1/);
    await noOverflow(page,'expanded mobile overflows');
    await page.locator('#advanced-toggle').click();
    await page.locator('#type-filter').selectOption('classified');await waitCount(page,1);
    await page.locator('#search').fill('role:"test role" pay:60k-62k');
    await page.waitForSelector('#filter-error:not([hidden])');
    assert.match(await page.locator('#filter-error').textContent(),/Choose one pay measure/);
    await page.locator('#measure').selectOption('annual_rate');await waitCount(page,4);
    await page.locator('#search').fill('pay:banana');await page.waitForSelector('#filter-error:not([hidden])');
    await page.locator('#clear-search').click();await page.locator('#type-filter').selectOption('all');await waitCount(page,60);
    await page.locator('#report-series').selectOption('census');await page.locator('#measure').selectOption('annual_rate');
    await page.locator('#historical-toggle').click();
    assert.equal(await page.locator('#historical-table tbody tr').count(),3);
    assert.equal(await page.locator('#historical-chart svg').count(),1);
    await page.locator('#report-series').selectOption('fiscal');await page.locator('#measure').selectOption('fiscal_year_pay');await waitCount(page,1);
    await page.waitForFunction(()=>document.querySelector('#stat-median').textContent==='$0');
    assert.equal(await page.locator('#historical-table tbody tr').count(),1);
    // Expanding a filtered card still shows all four source observations.
    await page.locator('.card-header').click();assert.equal(await page.locator('.history table tbody tr').count(),4);
    // Same search engine runs when Workers are unavailable.
    await page.addInitScript(()=>{window.Worker=class{constructor(){throw new Error('Test Worker unavailable');}};});
    await page.reload({waitUntil:'networkidle'});await waitCount(page,60);
    await page.locator('#search').fill('李');await waitCount(page,1);
    assert.deepEqual(errors,[]);
    await page.close();
    for(const target of ['**/data/index.json*','**/data/search-index.json*']){
      const broken=await browser.newPage();
      await broken.route(target,route=>route.fulfill({status:503,body:'test failure'}));
      await broken.goto(origin);await broken.waitForSelector('#load-error:not([hidden])');
      assert.match(await broken.locator('#load-error').textContent(),/HTTP 503/);
      assert.equal(await broken.locator('.card').count(),0);assert.equal(await broken.locator('#search').isDisabled(),true);
      await broken.close();
    }
    console.log('Chromium: all-report search, complete histories, old deep links, units, filters, mobile, fallback and failure states passed.');
  }finally{await browser.close();}
  for(const [name,engine] of [['Firefox',firefox],['WebKit',webkit]]){
    const browser=await engine.launch({headless:true});
    try{
      const page=await browser.newPage({viewport:{width:390,height:844}});
      await page.goto(origin);await waitCount(page,catalog.exactNameCount);
      await fixtureRoutes(page);await page.reload();await waitCount(page,60);
      await page.locator('#search').fill('zoe');await waitCount(page,1);
      await page.locator('.card-header').click();
      assert.equal(await page.locator('.history table tbody tr').count(),4);
      await noOverflow(page,`${name} expanded history`);
      console.log(`${name}: real all-report index, grouped search, and mobile history passed.`);
    }finally{await browser.close();}
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
