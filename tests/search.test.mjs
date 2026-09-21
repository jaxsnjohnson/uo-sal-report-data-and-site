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
