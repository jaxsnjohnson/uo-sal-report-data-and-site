// Decode the complete compact index. Dictionary strings are shared by all rows.
export function decodeSearchIndex(index, catalog) {
  if (index.format !== 'uo-all-reports-v1' || index.version !== catalog.version) {
    throw new Error('Search data changed. Reload after the update completes.');
  }
  if (index.rows.length !== index.recordCount || index.recordCount !== catalog.recordCount) {
    throw new Error('The all-report search index is incomplete.');
  }
  const reports = new Map(catalog.reports.map(report => [report.id, report]));
  const sources = index.reportIds.map(id => {
    const report = reports.get(id);
    if (!report) throw new Error('Search data references an unknown report.');
    return report;
  });
  const d = index.dictionaries;
  return index.rows.map(values => {
    const [source, sourceRow, name, title, department, unit, amount, rawAmount,
      rawFte, sourcePage, definition, profileId, appointmentPercent, termOfService, fte] = values;
    const report = sources[source], measure = d.measure[unit];
    const usable = amount != null && (measure === 'fiscal_year_pay' || amount > 0) && measure !== 'other_term_rate';
    return {id: `${report.id}:${sourceRow}`, profileId, name: d.name[name], title: d.title[title],
      department: d.department[department], classification: report.classification,
      reportId: report.id, kind: report.kind, date: report.endDate, startDate: report.startDate,
      measure, amount, rawAmount, usable,
      payNote: measure === 'other_term_rate' ? 'Term of service not verified as 9 or 12 months; excluded from rate statistics' : usable ? null : amount == null ? 'Amount unavailable' : 'Non-positive rate; excluded from rate statistics',
      fte, rawFte, sourcePage, sourceRow,
      identityBasis: profileId ? 'Reviewed linkage' : 'Source row only',
      amountDefinition: d.amountDefinition[definition], appointmentPercent, termOfService};
  });
}
