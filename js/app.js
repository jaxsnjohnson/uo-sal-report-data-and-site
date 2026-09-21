import { searchRecords } from './search.js';
import { $, esc, currency, dateLabel, periodLabel, getJSON, safeURL, trendChart } from './ui.js';

let data, aggregates, worker, workerReady = false, requestId = 0, workerTimer;
let kind = 'census', current = [], shown = 0, observer;
const byId = new Map(), buckets = new Map();
const PAGE_SIZE = 50;
const cap = value => value[0].toUpperCase() + value.slice(1);
const displayPay = (amount, measure) => amount == null ? 'Pay unavailable' : new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', maximumFractionDigits: measure === 'hourly_rate' ? 2 : 0
}).format(amount);
const median = values => {
  const sorted = values.slice().sort((a,b) => a-b), mid = Math.floor(sorted.length / 2);
  return sorted.length ? sorted.length % 2 ? sorted[mid] : (sorted[mid-1]+sorted[mid])/2 : null;
};

function filters() {
  return {kind, period: $('period').value, measure: $('measure').value, classification: $('type-filter').value,
    query: $('search').value, min: $('salary-min').value, max: $('salary-max').value, sort: $('sort-order').value,
    fullTime: $('fte-toggle').checked, flagged: $('data-flags-toggle').checked};
}

function setView() {
  const reports = data.reports.filter(report => report.kind === kind);
  const periods = [...new Set(reports.map(report => report.endDate))].sort().reverse();
  $('period').innerHTML = periods.map(date => `<option value="${date}">${esc(kind === 'census' ? dateLabel(date) : `FY ${date.slice(0,4)}`)}</option>`).join('');
  const latestImported = reports.filter(report => report.imported).map(report => report.endDate).sort().reverse()[0];
  if (latestImported) $('period').value = latestImported;
  $('period').disabled = !periods.length;
  const measures = Object.entries(data.measures).filter(([,info]) => info.kind === kind);
  $('measure').innerHTML = measures.map(([key,info]) => `<option value="${key}">${esc(info.label)}</option>`).join('');
  setPeriodMeasure();
}

function setPeriodMeasure() {
  const available = data.reports.find(report => report.kind === kind && report.imported && report.endDate === $('period').value);
  if (available) $('measure').value = available.measure;
  runSearch(); renderHistory();
}

function updateCoverage() {
  const imported = data.reports.filter(report => report.imported).length;
  const archived = data.reports.filter(report => report.file).length;
  $('capture-import-notice').textContent = imported
    ? `${imported} of ${data.reports.length} listed UO reports are imported. Counts describe source rows, not verified employee headcounts. Census rates and fiscal-year pay retain their original units. Original reports are available in the Records Archive.`
    : `${data.reports.length} official UO salary reports are cataloged; ${archived} PDFs are archived and 0 salary rows are imported. Downloaded reports are needed before salary statistics can be shown. Census rates and fiscal-year actual pay will remain separate.`;
  $('search').disabled = !data.records.length;
}

function runSearch() {
  if (!data) return;
  const id = ++requestId;
  clearTimeout(workerTimer);
  if (workerReady) {
    worker.postMessage({type: 'search', requestId: id, filters: filters()});
    workerTimer = setTimeout(() => { stopWorker(); fallback(id); }, 3000);
  } else fallback(id);
}
function fallback(id) {
  try { accept({requestId: id, ids: searchRecords(data.records, filters())}); }
  catch (error) { accept({requestId: id, error: error.message}); }
}
function stopWorker() { worker?.terminate(); workerReady = false; clearTimeout(workerTimer); }
function accept(message) {
  if (message.requestId !== requestId) return;
  clearTimeout(workerTimer);
  $('filter-error').hidden = !message.error;
  $('filter-error').textContent = message.error || '';
  current = (message.ids || []).map(id => byId.get(id));
  shown = 0;
  $('results').after($('scroll-sentinel'));
  $('results').replaceChildren();
  renderStats(); appendRecords();
  const available = data.reports.some(report => report.imported && report.kind === kind && report.endDate === $('period').value && report.measure === $('measure').value);
  $('empty-state').hidden = current.length > 0 || Boolean(message.error);
  $('empty-state').innerHTML = available
    ? 'No matching records found.'
    : 'No imported salary records. <a class="source-report-link" href="records.html">Browse source reports</a>.';
  $('stats-bar').textContent = available
    ? `Found ${current.length} matching personnel records. ${data.measures[$('measure').value].unit}; source rows, not headcounts.`
    : 'Salary records awaiting import. Select a report period and pay measure in Advanced.';
}

function renderStats() {
  const f = filters();
  const available = data.reports.some(report => report.imported && report.kind === kind && report.endDate === f.period && report.measure === f.measure);
  const amounts = current.filter(row => row.usable).map(row => row.amount);
  const classified = current.filter(row => row.classification === 'classified').length;
  $('stat-total').textContent = available ? current.length.toLocaleString() : '-';
  $('stat-median').textContent = amounts.length ? displayPay(median(amounts), f.measure) : '-';
  $('stat-median').setAttribute('data-tooltip', `${data.measures[f.measure].label}: ${amounts.length} usable amounts; ${current.length-amounts.length} unavailable.`);
  $('count-classified').textContent = available ? classified.toLocaleString() : '-';
  $('count-unclassified').textContent = available ? (current.length-classified).toLocaleString() : '-';
  $('bar-classified').style.width = `${current.length ? classified/current.length*100 : 0}%`;
  $('bar-unclassified').style.width = `${current.length ? (current.length-classified)/current.length*100 : 0}%`;
  // The UO source contract has no hire dates. Keep the reference chart empty, with
  // an explicit explanation, instead of inferring service from first appearance.
  $('tenure-chart').innerHTML = '';
  $('tenure-chart').setAttribute('aria-label', 'Years of service unavailable: no verified hire dates imported');
  $('tenure-chart').setAttribute('data-tooltip', 'Not reported: no verified hire dates are available.');
  rankOrganizations(); renderRoles();
}
function counts(field) {
  const result = new Map();
  current.forEach(row => result.set(row[field] || 'Not reported', (result.get(row[field] || 'Not reported') || 0)+1));
  return [...result].sort((a,b) => b[1]-a[1] || a[0].localeCompare(b[0]));
}
function rankOrganizations() {
  const top = counts('department').slice(0,5), maximum = top[0]?.[1] || 1;
  $('org-leaderboard').innerHTML = top.map(([name,count]) => `<div class="lb-row"><div class="lb-label" data-tooltip="${esc(name)}">${esc(name)}</div>
    <div class="lb-bar-container"><div class="lb-bar" style="width: ${count/maximum*100}%"></div><div class="lb-val">${count}</div></div></div>`).join('');
}
function renderRoles() {
  const roles = counts('title').slice(0,4);
  if (!roles.length) { $('role-donut').style.background = '#444'; $('role-legend').replaceChildren(); return; }
  const colors = ['var(--uo-green)', 'var(--uo-evergreen)', 'var(--uo-fern)', 'var(--uo-moss)', '#444444'];
  let degrees = 0, remainder = current.length;
  const gradient = [], legend = [];
  roles.forEach(([name,count],index) => {
    const end = degrees + count/current.length*360;
    gradient.push(`${colors[index]} ${degrees}deg ${end}deg`);
    degrees = end; remainder -= count;
    legend.push(`<div class="legend-item"><span class="dot" style="background:${colors[index]}"></span> ${esc(name)} (${Math.round(count/current.length*100)}%)</div>`);
  });
  if (remainder) {
    gradient.push(`${colors[4]} ${degrees}deg 360deg`);
    legend.push(`<div class="legend-item"><span class="dot" style="background:${colors[4]}"></span> Other (${Math.round(remainder/current.length*100)}%)</div>`);
  }
  $('role-donut').style.background = `conic-gradient(${gradient.join(', ')})`;
  $('role-legend').innerHTML = legend.join('');
}

function appendRecords() {
  const start = shown;
  current.slice(shown, shown+PAGE_SIZE).forEach((row, offset) => {
    const card = document.createElement('div'), index = start+offset;
    card.className = 'card'; card.id = `card-${index}`; card.dataset.id = row.id;
    card.innerHTML = `<div class="card-header" tabindex="0" role="button" aria-expanded="false" aria-controls="history-${index}">
      <div class="person-info"><div class="name-header"><h2>${esc(row.name)}</h2>
        <button class="link-btn-card" type="button" aria-label="Copy link">🔗</button>
        <button class="link-btn-card report-btn" type="button" data-tooltip="View source report" aria-label="View source report">!</button>
      </div><p>Department: ${esc(row.department || 'N/A')}</p></div>
      <div class="latest-stat"><div class="latest-salary" data-tooltip="${esc(data.measures[row.measure].label)}">${row.usable ? esc(displayPay(row.amount,row.measure)) : 'Pay unavailable'}</div>
      <div class="latest-role">${esc(row.title || 'Unknown')}</div>${!row.usable ? '<div class="data-flag" data-tooltip="Missing or non-positive reported rate; see source details.">Data flags</div>' : ''}</div>
    </div><div id="history-${index}" class="history" role="region" aria-label="Job History" data-loaded="false"><div class="history-loading">Expand to load details...</div></div>`;
    const header = card.querySelector('.card-header');
    const toggle = () => {
      const expanded = card.classList.toggle('expanded');
      header.setAttribute('aria-expanded', String(expanded));
      if (expanded && card.querySelector('.history').dataset.loaded !== 'true') loadProfile(card,row);
    };
    header.addEventListener('click', event => { if (!event.target.closest('button')) toggle(); });
    header.addEventListener('keydown', event => {
      if (event.target === header && ['Enter',' '].includes(event.key)) { event.preventDefault(); toggle(); }
    });
    card.querySelector('.link-btn-card').addEventListener('click', async () => {
      const url = new URL(location.href); url.searchParams.set('record',row.id);
      try { await navigator.clipboard.writeText(url.href); toast('Record link copied.'); }
      catch { toast('Clipboard unavailable. Use the source report link in the expanded record.'); }
    });
    card.querySelector('.report-btn').addEventListener('click', () => {
      if (!card.classList.contains('expanded')) toggle();
      const source = data.reports.find(report => report.id === row.reportId);
      if (source?.file) window.open(new URL(`${source.file}#page=${row.sourcePage}`,location.href), '_blank', 'noopener');
    });
    $('results').append(card);
  });
  shown = Math.min(current.length, shown+PAGE_SIZE);
  const sentinel = $('scroll-sentinel');
  sentinel.hidden = !current.length;
  sentinel.textContent = shown < current.length ? 'Loading more...' : 'End of results';
  sentinel.tabIndex = shown < current.length ? 0 : -1;
  $('results').append(sentinel);
}

async function loadProfile(card,row) {
  if (card.dataset.loading) return;
  card.dataset.loading = 'true';
  const body = card.querySelector('.history'); body.textContent = 'Loading details...';
  const bucket = row.profileId[0];
  try {
    if (!buckets.has(bucket)) buckets.set(bucket, getJSON(`data/people/${bucket}.json?v=${data.version}`).catch(error => {buckets.delete(bucket); throw error;}));
    const result = await buckets.get(bucket);
    if (result.version !== data.version) throw new Error('The dataset changed. Reload the page to use the updated records.');
    const all = result.people[row.profileId]; if (!all) throw new Error('This history is missing from the dataset.');
    const same = all.filter(observation => observation.measure === row.measure);
    const duplicateDates = new Set(same.map(observation => observation.date)).size !== same.length;
    body.innerHTML = `<div class="history-meta" style="margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid #444;font-size:.9rem;color:#a0a0a0;"><strong>Pay measure:</strong> ${esc(data.measures[row.measure].label)} &nbsp;•&nbsp; <strong>FTE:</strong> ${esc(row.fte ?? 'Not reported')}</div>`;
    if (row.identityBasis !== 'Reviewed linkage' || !row.usable) body.innerHTML += `<div class="data-quality"><strong>Data quality flags:</strong>${row.identityBasis !== 'Reviewed linkage' ? '<div>Cross-report identity unconfirmed; kept as a separate source record.</div>' : ''}${!row.usable ? `<div>${esc(row.payNote)}</div>` : ''}</div>`;
    body.innerHTML += `<div class="personal-trend-section">${same.length > 1 && !duplicateDates
      ? trendChart(same.map(observation => ({date:observation.date,value:observation.usable ? observation.amount : null,series:row.name})), `${row.name}: ${data.measures[row.measure].label}`)
      : '<div class="history-loading">No comparable trend available. Multiple appointments are kept as separate observations.</div>'}</div>`;
    body.innerHTML += `<div class="collapsible-section"><button class="section-toggle" type="button" aria-expanded="false">Pay Definition</button><div class="collapsible-body hidden"><div class="insight-item">${esc(all.find(observation => observation.id === row.id)?.amountDefinition || 'See source report.')}</div></div></div>`;
    body.innerHTML += `<div class="collapsible-section record-appearances"><button class="section-toggle" type="button" aria-expanded="false">Record appearances</button><div class="collapsible-body hidden">${all.map(observation => `<div class="badge badge-source">${esc(dateLabel(observation.date))} · ${esc(data.measures[observation.measure].label)}</div>`).join('')}</div></div>`;
    body.innerHTML += `<div class="collapsible-section"><button class="section-toggle" type="button" aria-expanded="false">Date & Source / Job Details / Type / Salary</button><div class="collapsible-body hidden"><div class="table-wrap" tabindex="0" aria-label="Job history table"><table><thead><tr><th>Date & Source</th><th>Job Details</th><th>Type</th><th>Salary</th></tr></thead><tbody>${all.slice().reverse().map(observation => {
      const report = data.reports.find(report => report.id === observation.reportId);
      return `<tr><td class="date-cell"><div>${esc(periodLabel(report))}</div><a class="source-report-link" href="${safeURL(`${report.file}#page=${observation.sourcePage}`)}" target="_blank" rel="noopener">PDF page ${observation.sourcePage}</a><div class="badge badge-source">Row ${observation.sourceRow}</div></td><td><div style="font-weight:600;">${esc(observation.title || 'Not reported')}</div><div class="stat-sub">${esc(observation.department || 'Not reported')}</div><div class="stat-sub">FTE: ${esc(observation.rawFte ?? 'Not reported')}</div></td><td><span class="badge badge-type">${esc(cap(observation.classification))}</span></td><td class="money-cell">${esc(observation.rawAmount ?? 'Not reported')}<span class="hourly-rate">${esc(data.measures[observation.measure].unit)}</span>${observation.payNote ? `<span class="missing-pay">${esc(observation.payNote)}</span>` : ''}</td></tr>`;
    }).join('')}</tbody></table></div></div></div>`;
    body.dataset.loaded = 'true';
  } catch (error) {
    body.innerHTML = `<div class="history-loading">${esc(error.message)}</div><button class="advanced-toggle" type="button">Retry history</button>`;
    body.querySelector('button').onclick = () => loadProfile(card,row);
  } finally { delete card.dataset.loading; }
}

function renderHistory() {
  const rows = aggregates.reports.filter(report => report.kind === kind && report.measure === $('measure').value)
    .sort((a,b) => a.date.localeCompare(b.date) || a.classification.localeCompare(b.classification));
  const container = $('historical-charts-container');
  if (!rows.length) { container.innerHTML = '<div class="historical-warning">Historical charts await imported reports. Census salary rates and fiscal-year actual pay remain separate.</div>'; return; }
  container.innerHTML = `<div class="historical-warning">Historical medians use all imported reports for the selected measure, independently of search. Counts are source rows, not a fixed employee cohort.</div><div class="historical-core-grid"><div class="stat-card historical-card"><div class="chart-title-row"><div class="stat-label">Median ${esc(data.measures[$('measure').value].label)}</div></div><div id="historical-chart">${trendChart(rows.map(report => ({date:report.date,value:report.median,series:cap(report.classification)})), `Median ${data.measures[$('measure').value].label}`)}</div></div></div><div class="collapsible-section"><button class="section-toggle" type="button" aria-expanded="false">Source data table</button><div class="collapsible-body hidden"><div id="historical-table" class="table-wrap" tabindex="0"><table><thead><tr><th>Period</th><th>Classification</th><th>Rows</th><th>Usable</th><th>Median</th><th>Source</th></tr></thead><tbody>${rows.map(row => {
    const report = data.reports.find(report => report.id === row.reportId);
    return `<tr><td>${esc(periodLabel(report))}</td><td>${cap(row.classification)}</td><td>${row.recordCount}</td><td>${row.usableCount}</td><td>${esc(currency(row.median))}</td><td><a class="source-report-link" href="${safeURL(report.file)}">PDF</a></td></tr>`;
  }).join('')}</tbody></table></div></div></div>`;
}

function toast(message) {
  $('toast-notification').textContent = message; $('toast-notification').classList.add('show');
  setTimeout(() => $('toast-notification').classList.remove('show'), 2200);
}
function setupControls() {
  $('advanced-toggle').onclick = () => {
    const open = $('advanced-search').classList.toggle('hidden') === false;
    $('advanced-toggle').setAttribute('aria-expanded',String(open));
  };
  $('historical-toggle').onclick = () => {
    const open = $('historical-charts').classList.toggle('hidden') === false;
    $('historical-toggle').setAttribute('aria-expanded',String(open));
    $('historical-charts').setAttribute('aria-hidden',String(!open));
    $('historical-toggle').textContent = open ? 'Hide historical charts' : 'Show historical charts';
  };
  const closeModal = () => { $('info-modal').classList.add('hidden'); $('info-btn').focus(); };
  $('info-btn').onclick = () => { $('info-modal').classList.remove('hidden'); $('close-modal').focus(); };
  $('close-modal').onclick = closeModal;
  $('info-modal').onclick = event => { if (event.target === $('info-modal')) closeModal(); };
  document.addEventListener('click', event => {
    const button = event.target.closest('.collapsible-section > .section-toggle, .collapsible-btn');
    if (!button) return;
    const body = button.nextElementSibling, open = body.classList.toggle('hidden') === false;
    button.setAttribute('aria-expanded',String(open));
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      if (!$('info-modal').classList.contains('hidden')) closeModal();
      else if ($('search').value) clearSearch();
    }
    if (event.key === 'Tab' && !$('info-modal').classList.contains('hidden')) {
      const focusable = [...$('info-modal').querySelectorAll('button,a[href]')].filter(el => el.getClientRects().length);
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    if (event.key === '/' && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) && !$('search').disabled) {
      event.preventDefault(); $('search').focus();
    }
  });
  const tooltip = $('custom-tooltip');
  document.addEventListener('mouseover', event => {
    const target = event.target.closest('[data-tooltip]');
    if (target) { tooltip.textContent = target.dataset.tooltip; tooltip.classList.remove('hidden'); }
  });
  document.addEventListener('mousemove', event => {
    tooltip.style.left = `${Math.min(event.clientX+10, innerWidth-tooltip.offsetWidth-20)}px`;
    tooltip.style.top = `${Math.min(event.clientY+10, innerHeight-tooltip.offsetHeight-20)}px`;
  });
  document.addEventListener('mouseout', event => { if (event.target.closest('[data-tooltip]')) tooltip.classList.add('hidden'); });
}
function clearSearch() { $('search').value = ''; $('clear-search').classList.add('hidden'); runSearch(); }

async function start() {
  setupControls();
  try {
    data = await getJSON('data/index.json'); aggregates = await getJSON(`data/aggregates.json?v=${data.version}`);
    if (aggregates.version !== data.version) throw new Error('Dataset files are from different builds. Reload after the update completes.');
    data.records.forEach(row => byId.set(row.id,row));
    updateCoverage(); setView();
    try {
      worker = new Worker(new URL('./search-worker.js',import.meta.url),{type:'module'});
      worker.onmessage = event => { if (event.data.type === 'ready') { workerReady=true; runSearch(); } else accept(event.data); };
      worker.onerror = () => { stopWorker(); runSearch(); };
      worker.postMessage({type:'init',records:data.records});
    } catch { workerReady=false; }
    $('fiscal-toggle').onchange = () => { kind = $('fiscal-toggle').checked ? 'fiscal' : 'census'; setView(); };
    $('period').onchange = setPeriodMeasure;
    $('measure').onchange = () => { runSearch(); renderHistory(); };
    ['type-filter','sort-order','fte-toggle','data-flags-toggle'].forEach(id => $(id).addEventListener('change',runSearch));
    let debounce;
    ['search','salary-min','salary-max'].forEach(id => $(id).addEventListener('input', () => {
      ++requestId; clearTimeout(workerTimer); clearTimeout(debounce);
      $('clear-search').classList.toggle('hidden',!$('search').value);
      debounce = setTimeout(runSearch,250);
    }));
    $('clear-search').onclick = clearSearch;
    $('suggested-searches').innerHTML = ['Professor','Athletics','Physics','Coach','Dean'].map(term => `<button class="chip" type="button">${term}</button>`).join('');
    $('suggested-searches').onclick = event => {
      if (!event.target.matches('button')) return;
      $('search').value = event.target.textContent; $('clear-search').classList.remove('hidden'); runSearch();
    };
    $('scroll-sentinel').onclick = () => { if (shown < current.length) appendRecords(); };
    $('scroll-sentinel').onkeydown = event => {
      if (['Enter',' '].includes(event.key) && shown < current.length) { event.preventDefault(); appendRecords(); }
    };
    observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting) && shown < current.length) appendRecords(); }, {rootMargin:'100px'});
    observer.observe($('scroll-sentinel'));
    const linkedId = new URL(location.href).searchParams.get('record');
    const linked = byId.get(linkedId);
    if (linked) {
      kind = linked.kind; $('fiscal-toggle').checked = kind === 'fiscal'; setView();
      $('period').value = linked.date; $('measure').value = linked.measure;
      $('search').value = `name:"${linked.name.replaceAll('"','')}"`; $('clear-search').classList.remove('hidden'); runSearch();
    }
  } catch (error) {
    $('load-error').hidden = false;
    $('load-error').textContent = `The report data could not be loaded. ${error.message}`;
    $('capture-import-notice').textContent = 'Salary data could not be loaded.';
    $('stats-bar').textContent = 'Data loading failed.';
  }
}
start();
