// Requires the documented host Playwright installation; no production dependency.
const {chromium, firefox, webkit}=require('playwright');
const assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const catalog=JSON.parse(fs.readFileSync(path.join(__dirname,'../records.json'),'utf8'));
const realAggregates=JSON.parse(fs.readFileSync(path.join(__dirname,'../data/aggregates.json'),'utf8'));
const countFor=(kind,date,measure)=>realAggregates.reports.filter(r=>r.kind===kind&&r.date===date&&r.measure===measure).reduce((n,r)=>n+r.recordCount,0);
const origin=process.env.UO_PREVIEW_URL||'http://127.0.0.1:8085';
const fixture=JSON.parse(execFileSync('python3',[path.join(__dirname,'browser_fixture.py')],{encoding:'utf8'}));
fs.mkdirSync(path.join(__dirname,'../test-results'),{recursive:true});

async function fixtureRoutes(page){
  await page.route('**/data/**',route=>{
    const name=new URL(route.request().url()).pathname.replace(/^\//,'');
    if(fixture[name])return route.fulfill({json:fixture[name]});
    return route.continue();
  });
}
async function waitCount(page,expected){await page.waitForFunction(value=>document.querySelector('#stat-total').textContent.replaceAll(',','')===value,String(expected));}

(async()=>{
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1180}});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(origin,{waitUntil:'networkidle'});
    await waitCount(page,countFor('census','2025-11-01','annual_rate'));
    assert.match(await page.locator('#capture-import-notice').textContent(),/93 of 93/);
    assert.equal(await page.locator('#search').isDisabled(),false);
    assert.equal(await page.locator('.card').count(),50);
    // Real sharded history, PDF URL, and a link into an older report period.
    await page.locator('.card').first().locator('.card-header').click();
    await page.waitForSelector('.card .history[data-loaded="true"]');
    await page.locator('.card.expanded .section-toggle').filter({hasText:'Date & Source'}).click();
    const sourceURL=await page.locator('.card.expanded table a').first().getAttribute('href');
    const source=await page.request.get(sourceURL);
    assert.equal(source.status(),200);assert.match(source.headers()['content-type'],/application\/pdf/);
    const linkedPage=await browser.newPage();
    await linkedPage.goto(`${origin}/?record=2009-08-31-personnel-classified:1`);
    await linkedPage.waitForSelector('.card[data-id="2009-08-31-personnel-classified:1"]');
    assert.equal(await linkedPage.locator('#report-series').inputValue(),'historical');
    assert.equal(await linkedPage.locator('#period').inputValue(),'2009-08-31');
    await linkedPage.close();
    await page.locator('#advanced-toggle').click();
    await page.locator('#report-series').selectOption('fiscal');
    await waitCount(page,countFor('fiscal','2026-06-30','fiscal_year_pay'));
    assert.equal(await page.locator('#measure').inputValue(),'fiscal_year_pay');
    assert.equal(await page.locator('#period').inputValue(),'2026-06-30');
    await page.locator('#report-series').selectOption('census');
    await waitCount(page,countFor('census','2025-11-01','annual_rate'));
    await page.locator('#measure').selectOption('academic_year_rate');
    await waitCount(page,countFor('census','2025-11-01','academic_year_rate'));
    await page.locator('#report-series').selectOption('historical');
    await waitCount(page,countFor('historical','2019-06-30','annual_rate'));
    await page.locator('#report-series').selectOption('census');
    await waitCount(page,countFor('census','2025-11-01','annual_rate'));
    await page.locator('#advanced-toggle').click();
    await page.screenshot({path:'test-results/explorer-desktop.png',fullPage:true});
    await page.goto(`${origin}/records.html`,{waitUntil:'networkidle'});
    assert.equal(await page.locator('.record-card').count(),93);
    assert.equal(await page.locator('.record-card .download-btn').count(),93);
    assert.equal(await page.locator('.record-card .tag').filter({hasText:'Status: Imported'}).count(),93);
    await page.locator('[data-filter="Classified"]').click();
    assert.equal(await page.locator('.record-card').count(),catalog.reports.filter(r=>r.classification==='classified').length);
    await page.locator('#record-search').fill('2026');
    assert.equal(await page.locator('.record-card').count(),1);
    await page.locator('#clear-search').click();
    await page.locator('[data-filter="all"]').click();
    await page.screenshot({path:'test-results/reports-desktop.png',fullPage:true});
    // The preview must not expose repository internals, source code, or listings.
    for(const target of ['/.git/config','/scripts/build_data.py','/data/','/normalized/README.md']){
      const response=await page.request.get(`${origin}${target}`);assert.ok([403,404].includes(response.status()),target);
    }
    await page.setViewportSize({width:390,height:844});
    for(const pathname of ['/','/records.html','/methodology.html']){
      await page.goto(origin+pathname,{waitUntil:'networkidle'});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${pathname} overflows mobile`);
    }
    await page.goto(origin,{waitUntil:'networkidle'});
    await page.locator('#info-btn').click();
    await page.waitForSelector('#info-modal:not(.hidden)');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#info-modal').isVisible(),false);
    await page.screenshot({path:'test-results/explorer-mobile.png',fullPage:true});
    // Inject generated fixtures at the network boundary; production data is untouched.
    await fixtureRoutes(page);await page.reload({waitUntil:'networkidle'});await waitCount(page,61);
    assert.equal(await page.locator('.card').count(),50);
    await page.locator('#scroll-sentinel').scrollIntoViewIfNeeded();
    await page.waitForFunction(()=>document.querySelectorAll('#results > .card').length===61);
    await page.locator('#search').fill('name:zoe');await waitCount(page,2);
    await page.locator('.card').first().locator('.card-header').click();
    await page.waitForSelector('.card .history[data-loaded="true"]');
    await page.locator('.card.expanded .section-toggle').filter({hasText:'Date & Source'}).click();
    assert.equal(await page.locator('.card.expanded table tbody tr').count(),4);
    assert.match(await page.locator('.card.expanded a').first().getAttribute('href'),/reports\/test.pdf#page=1/);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'expanded mobile overflows');
    await page.locator('#advanced-toggle').click();
    await page.locator('#type-filter').selectOption('classified');await waitCount(page,1);
    await page.locator('#search').fill('role:"test role" pay:60k-62k');await waitCount(page,4);
    await page.locator('#search').fill('pay:banana');await page.waitForSelector('#filter-error:not([hidden])');
    await page.locator('#clear-search').click();
    await page.locator('#type-filter').selectOption('all');await waitCount(page,61);
    await page.locator('#advanced-toggle').click();
    await page.locator('#historical-toggle').click();
    assert.equal(await page.locator('#historical-table tbody tr').count(),3);
    assert.equal(await page.locator('#historical-chart svg').count(),1);
    await page.locator('#advanced-toggle').click();
    await page.locator('#report-series').selectOption('fiscal');await waitCount(page,1);
    assert.equal(await page.locator('#stat-median').textContent(),'$0');
    assert.equal(await page.locator('#historical-table tbody tr').count(),1);
    // Same search engine runs when Workers are unavailable.
    await page.addInitScript(()=>{window.Worker=class{constructor(){throw new Error('Test Worker unavailable');}};});
    await page.reload({waitUntil:'networkidle'});await waitCount(page,61);
    await page.locator('#search').fill('李');await waitCount(page,2);
    assert.deepEqual(errors,[]);
    // Explicit fetch failure must surface as an error, not zero employees.
    const broken=await browser.newPage();
    await broken.route('**/data/index.json',route=>route.fulfill({status:503,body:'test failure'}));
    await broken.goto(origin);await broken.waitForSelector('#load-error:not([hidden])');
    assert.match(await broken.locator('#load-error').textContent(),/HTTP 503/);
    await broken.close();await page.close();
    const missingPart=await browser.newPage();
    await missingPart.route('**/data/reports/**',route=>route.fulfill({status:503,body:'test report failure'}));
    await missingPart.goto(origin);await missingPart.waitForSelector('#load-error:not([hidden])');
    assert.match(await missingPart.locator('#load-error').textContent(),/selected reports.*HTTP 503/);
    assert.equal(await missingPart.locator('.card').count(),0);
    await missingPart.close();
    console.log('Chromium: real archive, report shards, populated search/history, mobile, worker fallback, errors, and preview restrictions passed.');
  }finally{await browser.close();}
  for(const [name,engine] of [['Firefox',firefox],['WebKit',webkit]]){
    const browser=await engine.launch({headless:true});
    try{
      const page=await browser.newPage({viewport:{width:390,height:844}});
      await page.goto(origin);await waitCount(page,countFor('census','2025-11-01','annual_rate'));
      await fixtureRoutes(page);await page.reload();await waitCount(page,61);
      await page.locator('#search').fill('zoe');await waitCount(page,2);
      await page.locator('.card').first().locator('.card-header').click();
      await page.waitForSelector('.card .history[data-loaded="true"]');
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      console.log(`${name}: real data, search, and mobile history passed.`);
    }finally{await browser.close();}
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
