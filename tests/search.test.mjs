import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
// Load the browser ES module without adding a Node package/build dependency.
const source=await readFile(new URL('../js/search.js',import.meta.url),'utf8');
const {searchRecords}=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const base={kind:'census',date:'2025-11-01',measure:'annual_rate',classification:'classified',usable:true};
const records=[
  {...base,id:'a',name:'Test, Zoë',department:'Library',title:'Research Assistant',amount:60000},
  {...base,id:'b',name:'Test, 李',department:'Library',title:'Research Assistant',amount:90000},
  {...base,id:'c',name:'Test, Alex',department:'Athletics',title:'Analyst',amount:110000,classification:'unclassified'},
  {...base,id:'d',name:'Test, Missing',department:'Library',title:'Assistant',amount:null,usable:false},
  {...base,id:'e',name:'Test, Year',department:'Library',title:'Assistant',amount:20000,kind:'fiscal',measure:'fiscal_year_pay'},
];
const f={query:'',kind:'census',period:'2025-11-01',measure:'annual_rate',classification:'all',sort:'name',min:'',max:''};
test('Unicode and accent folding preserve non-Latin names',()=>{
  assert.deepEqual(searchRecords(records,{...f,query:'zoe'}),['a']);
  assert.deepEqual(searchRecords(records,{...f,query:'李'}),['b']);
});
test('phrases, AND terms, fields, and exclusions combine',()=>{
  assert.deepEqual(searchRecords(records,{...f,query:'role:"research assistant" org:library -zoe'}),['b']);
});
test('classified field never accidentally matches unclassified',()=>{
  assert.equal(searchRecords(records,{...f,query:'type:classified'}).length,3);
});
test('pay ranges use selected units and exclude unavailable amounts',()=>{
  assert.deepEqual(searchRecords(records,{...f,query:'pay:60k-90k',sort:'pay-desc'}),['b','a']);
  assert.deepEqual(searchRecords(records,{...f,query:'pay:>100k'}),['c']);
});
test('census cannot leak fiscal pay, and date filters are exact',()=>{
  assert.equal(searchRecords(records,f).length,4);
  assert.equal(searchRecords(records,{...f,period:'2024-11-01'}).length,0);
  assert.deepEqual(searchRecords(records,{...f,kind:'fiscal',measure:'fiscal_year_pay'}),['e']);
});
test('unknown pay sorts last in both directions',()=>{
  assert.equal(searchRecords(records,{...f,sort:'pay-asc'}).at(-1),'d');
  assert.equal(searchRecords(records,{...f,sort:'pay-desc'}).at(-1),'d');
});
test('malformed search and inverted ranges produce useful errors',()=>{
  assert.throws(()=>searchRecords(records,{...f,query:'pay:banana'}),/pay:/);
  assert.throws(()=>searchRecords(records,{...f,query:'status:active'}),/Unknown search/);
  assert.throws(()=>searchRecords(records,{...f,min:'90',max:'60'}),/Minimum/);
});
test('full-time and flagged controls use the reported fields',()=>{
  const data=[{...records[0],fte:1},{...records[1],fte:.5},{...records[3],fte:null}];
  assert.deepEqual(searchRecords(data,{...f,fullTime:true}),['a']);
  assert.deepEqual(searchRecords(data,{...f,flagged:true}),['d']);
});
test('reverse name sorting does not become salary sorting',()=>{
  assert.deepEqual(searchRecords(records,{...f,sort:'name-desc'}),searchRecords(records,f).reverse());
});

const globalFilters={...f,kind:'all',period:'all',measure:'all',groupNames:true};
const history=[
  {...records[0],id:'old',date:'2009-06-01',sourceRow:1,title:'Archivist'},
  {...records[0],id:'new',date:'2026-06-30',sourceRow:2,measure:'fiscal_year_pay',kind:'fiscal'},
  {...records[0],id:'second-job',date:'2026-06-30',sourceRow:3,measure:'fiscal_year_pay',kind:'fiscal'},
  {...records[0],id:'variant',name:'Test, Zoe',date:'2025-11-01',sourceRow:4},
  {...records[1],id:'historic-only',date:'2010-06-01',sourceRow:1},
];
test('all-report search groups exact names and keeps historical-only names and spelling variants',()=>{
  assert.deepEqual(new Set(searchRecords(history,globalFilters)),new Set(['new','variant','historic-only']));
  assert.deepEqual(new Set(searchRecords(history,{...globalFilters,query:'zoe'})),new Set(['new','variant']));
});
test('older roles and explicit periods find the latest matching entry, not just the latest job',()=>{
  assert.deepEqual(searchRecords(history,{...globalFilters,query:'role:archivist'}),['old']);
  assert.deepEqual(searchRecords(history,{...globalFilters,period:'2009-06-01'}),['old']);
  assert.deepEqual(searchRecords(history,{...globalFilters,kind:'fiscal'}),['new']);
  assert.deepEqual(searchRecords(history,{...globalFilters,query:'zoe',measure:'annual_rate',min:'60000',max:'60000'}).length,2);
});
test('equal-date representatives use stable source-row then record-ID tie breaks',()=>{
  const tie=[history[1],{...history[1],id:'aaa'}];
  assert.deepEqual(searchRecords(tie,globalFilters),['aaa']);
  assert.deepEqual(searchRecords(tie.reverse(),globalFilters),['aaa']);
});
test('mixed-unit pay ranges and sorts require an explicit measure',()=>{
  for(const filter of [{query:'pay:>50k'},{min:'100'},{max:'90000'},{sort:'pay-desc'}]) {
    assert.throws(()=>searchRecords(history,{...globalFilters,...filter}),/Choose one pay measure/);
  }
});

const datasetSource=await readFile(new URL('../js/dataset.js',import.meta.url),'utf8');
const {decodeSearchIndex}=await import(`data:text/javascript;base64,${Buffer.from(datasetSource).toString('base64')}`);
const {execFileSync}=await import('node:child_process');
const fixture=JSON.parse(execFileSync('python3',[new URL('./browser_fixture.py',import.meta.url).pathname],{encoding:'utf8'}));
const sharded=JSON.parse(execFileSync('python3',[new URL('./browser_fixture.py',import.meta.url).pathname,'--sharded'],{encoding:'utf8'}));
test('compact index round-trips every source entry, raw amount, FTE, unit and reviewed linkage',()=>{
  const decoded=decodeSearchIndex(sharded['data/search-index.json'],sharded['data/index.json']);
  const expected=new Map(fixture['data/index.json'].records.map(row=>[row.id,row]));
  assert.equal(decoded.length,expected.size);
  for(const row of decoded){
    const source=expected.get(row.id);
    for(const key of ['name','title','department','classification','kind','date','startDate','measure','amount','rawAmount','usable','payNote','fte','rawFte','sourcePage','sourceRow','identityBasis','amountDefinition']) {
      assert.deepEqual(row[key],source[key],`${row.id} ${key}`);
    }
    assert.equal(row.profileId,source.identityBasis==='Reviewed linkage'?source.profileId:null);
  }
});
test('incomplete or mixed-version indexes never masquerade as a complete all-report search',()=>{
  const index=sharded['data/search-index.json'],catalog=sharded['data/index.json'];
  assert.throws(()=>decodeSearchIndex({...index,version:'wrong'},catalog),/changed/);
  assert.throws(()=>decodeSearchIndex({...index,rows:index.rows.slice(1)},catalog),/incomplete/);
  assert.throws(()=>decodeSearchIndex({...index,reportIds:['unknown',...index.reportIds.slice(1)]},catalog),/unknown report/);
});
