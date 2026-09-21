export const $ = id => document.getElementById(id);
export const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
export const currency = value => value == null ? 'Unavailable' : new Intl.NumberFormat('en-US', {style:'currency',currency:'USD',maximumFractionDigits:2}).format(value);
export const dateLabel = value => new Date(`${value}T12:00:00Z`).toLocaleDateString('en-US', {month:'short',day:'numeric',year:'numeric',timeZone:'UTC'});
export const periodLabel = report => report.kind === 'fiscal'
  ? `FY ${report.endDate.slice(0,4)} · July ${report.startDate.slice(0,4)}–June ${report.endDate.slice(0,4)}`
  : report.startDate === report.endDate ? dateLabel(report.endDate) : `${dateLabel(report.startDate)}–${dateLabel(report.endDate)}`;
export async function getJSON(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Could not load ${path} (HTTP ${response.status}).`);
  return response.json();
}
export function safeURL(value) {
  if (typeof value !== 'string' || !value || value.startsWith('//') || value.includes('\\')) return '#';
  try { const url = new URL(value, location.href); return ['http:', 'https:'].includes(url.protocol) ? esc(url.href) : '#'; }
  catch { return '#'; }
}
export function trendChart(rows, title) {
  const dates = [...new Set(rows.map(row => row.date))].sort();
  const values = rows.map(row => row.value).filter(Number.isFinite);
  if (dates.length < 2 || !values.length) return '<p class="chart-empty">At least two comparable report periods are needed for a trend chart. Available observations appear in the table below.</p>';
  const width = 900, height = 250, left = 90, top = 20, bottom = 205;
  const max = Math.max(...values, 1), min = Math.min(0, ...values), range = max - min;
  const x = date => left + dates.indexOf(date) * (width - left - 25) / (dates.length - 1);
  const y = value => bottom - (value - min) / range * (bottom - top);
  let content = `<title>${esc(title)}</title>`;
  for (let tick = 0; tick <= 4; tick++) {
    const value = min + range * tick / 4;
    content += `<line x1="${left}" x2="${width-25}" y1="${y(value)}" y2="${y(value)}" stroke="var(--border)"/><text x="${left-12}" y="${y(value)+4}" fill="var(--text-muted)" font-size="11" text-anchor="end">${esc(currency(value))}</text>`;
  }
  const series = [...new Set(rows.map(row => row.series))];
  series.forEach((name, i) => {
    const color = i ? 'var(--primary)' : 'var(--purple)';
    const points = rows.filter(row => row.series === name).sort((a,b) => a.date.localeCompare(b.date));
    // A missing amount breaks the line rather than drawing through uncertainty.
    let segment = [];
    function flush() { if (segment.length) content += `<polyline points="${segment.join(' ')}" stroke="${color}" stroke-width="2" fill="none"/>`; segment = []; }
    for (const point of points) {
      if (!Number.isFinite(point.value)) { flush(); continue; }
      segment.push(`${x(point.date)},${y(point.value)}`);
      content += `<circle cx="${x(point.date)}" cy="${y(point.value)}" r="4" fill="${color}"><title>${esc(name)} · ${esc(dateLabel(point.date))}: ${esc(currency(point.value))}</title></circle>`;
    }
    flush();
  });
  const labelStep = Math.max(1, Math.ceil(dates.length / 5));
  dates.forEach((date, i) => { if (i % labelStep === 0 || i === dates.length-1) content += `<text x="${x(date)}" y="234" fill="var(--text-muted)" font-size="11" text-anchor="middle">${esc(dateLabel(date))}</text>`; });
  return `<svg class="chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title)}">${content}</svg><div class="chart-legend">${series.map((name,i) => `<span><span class="dot ${i?'unclassified':'classified'}"></span>${esc(name)}</span>`).join('')}</div>`;
}
