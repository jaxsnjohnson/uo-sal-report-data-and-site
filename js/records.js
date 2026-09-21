import { $, esc, getJSON, safeURL } from './ui.js';
import { normalize } from './search.js';

let catalog, selected = 'all';
const cap = value => value[0].toUpperCase()+value.slice(1);
function render() {
  const query = normalize($('record-search').value);
  const reports = catalog.reports.filter(report => (selected === 'all' || cap(report.classification) === selected)
    && normalize(`${report.title} ${report.endDate} ${report.classification} ${report.kind === 'census' ? 'fall census' : 'fiscal year'}`).includes(query))
    .sort((a,b) => b.endDate.localeCompare(a.endDate) || a.classification.localeCompare(b.classification));
  const list = $('records-list'); list.replaceChildren();
  if (!reports.length) { list.innerHTML = '<div class="loader-sentinel">No matching records found.</div>'; return; }
  const years = [...new Set(reports.map(report => report.endDate.slice(0,4)))];
  for (const year of years) {
    const heading = document.createElement('h2'); heading.className = 'year-separator'; heading.textContent = year; list.append(heading);
    const grid = document.createElement('div'); grid.className = 'records-grid';
    for (const report of reports.filter(report => report.endDate.startsWith(year))) {
      const card = document.createElement('article'); card.className = 'record-card';
      const title = `${year} ${cap(report.classification)} ${report.kind === 'census' ? 'Fall Census' : 'Fiscal Year'} Salary Report`;
      const status = report.imported ? 'Imported' : report.file ? 'Archived' : 'PDF needed';
      card.innerHTML = `<div class="meta-row"><span>${esc(report.endDate)}</span><span>${report.kind === 'census' ? 'Fall Census' : 'Fiscal Year'}</span></div>
        <h3 class="record-title">${esc(title)}</h3><div class="record-meta"><span class="tag type-${report.classification}">${cap(report.classification)}</span><span class="tag">Status: ${status}</span><span class="tag">Source: UO</span></div>
        <a href="${safeURL(report.file || report.sourceUrl)}" target="_blank" rel="noopener noreferrer" class="download-btn" aria-label="${report.file ? 'Download PDF' : 'Open official UO report'}: ${esc(title)}">${report.file ? 'Download PDF ⬇' : 'Open UO report ↗'}</a>`;
      if (report.file) {
        const details = document.createElement('details'); details.className = 'archive-provenance';
        details.innerHTML = `<summary>Source details</summary><p>Report ID: ${esc(report.id)}</p><p>SHA-256: ${esc(report.sha256)}</p><p>${report.imported ? `${report.rowCount} imported rows` : 'Not yet included in explorer calculations.'}</p><a class="source-report-link" href="${safeURL(report.sourceUrl)}">Official UO link</a>`;
        card.append(details);
      }
      grid.append(card);
    }
    list.append(grid);
  }
}
try {
  catalog = await getJSON('records.json');
  $('record-search').oninput = () => { $('clear-search').classList.toggle('hidden',!$('record-search').value); render(); };
  $('clear-search').onclick = () => { $('record-search').value = ''; $('clear-search').classList.add('hidden'); render(); $('record-search').focus(); };
  document.querySelectorAll('[data-filter]').forEach(chip => chip.onclick = () => {
    selected = chip.dataset.filter;
    document.querySelectorAll('[data-filter]').forEach(other => other.classList.toggle('active',other === chip));
    render();
  });
  render();
} catch (error) { $('records-list').innerHTML = `<div class="error" role="alert">Error loading records: ${esc(error.message)}</div>`; }
