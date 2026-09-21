import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../js/search-worker.js',import.meta.url),'utf8');
function search(query, overrides={}) {
 const context=vm.createContext({self:{},postMessage(){},performance,recordsInput:[
  {name:'Abshere, Alex',homeOrg:'Housing',lastOrg:'Housing',roles:['Manager'],isActive:true,totalPay:70000},
  {name:'García, María',homeOrg:'Library',lastOrg:'Library',roles:['Librarian'],isActive:true,totalPay:80000},
  {name:'Flagged, Example',homeOrg:'Library',lastOrg:'Library',roles:['Librarian'],isActive:true,totalPay:0,payMissing:true,hasFlags:true},
 ]});
 vm.runInContext(source+'\nrecords=prepareRecords(recordsInput);recordMap=new Map(records.map(r=>[r.name,r]));isReady=true;',context);
 context.payload={query,minSalary:null,maxSalary:null,exclusionsMode:'off',sort:'name-asc',...overrides};
 return JSON.parse(JSON.stringify(vm.runInContext('parseAndSearch(payload)',context))).names;
}
test('regex keeps original name punctuation',()=>assert.deepEqual(search('/^abshere,/i'),['Abshere, Alex']));
test('accent-insensitive search retains source spelling',()=>assert.ok(search('name:garcia').includes('García, María')));
test('unknown pay is not zero-pay range data',()=>assert.deepEqual(search('pay:0-1'),[]));
test('data flags filter still exposes uncertain source rows',()=>assert.deepEqual(search('',{dataFlagsOnly:true}),['Flagged, Example']));
