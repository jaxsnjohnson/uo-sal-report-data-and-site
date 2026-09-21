import { searchRecords } from './search.js';
let records = [];
self.onmessage = event => {
  const message = event.data;
  if (message.type === 'init') { records = message.records; self.postMessage({type: 'ready'}); return; }
  try { self.postMessage({type: 'results', requestId: message.requestId, ids: searchRecords(records, message.filters)}); }
  catch (error) { self.postMessage({type: 'error', requestId: message.requestId, error: error.message}); }
};
