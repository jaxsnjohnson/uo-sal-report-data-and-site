# UO import contract (version 1)

The official catalog is available, but its linked PDFs could not be retrieved
anonymously during initial setup. **An automated UO PDF parser is not yet
implemented or validated.** Do not reuse OSU's PDF regular expressions or salary
conversions. Inspect the downloaded UO reports, including headers and footnotes,
before writing that adapter. The builder below is ready for reviewed observations.

## Source preservation

The 12 current report IDs are in `records.json`. Preserve a downloaded original:

```sh
python3 scripts/archive_reports.py add 2025-census-classified /path/to/report.pdf
```

This copies the bytes to `reports/2025-census-classified.pdf`, validates the PDF
signature, records a SHA-256 checksum, and refuses to overwrite different bytes.
Check that the PDF is the indicated report; the signature check cannot establish
its period or completeness. Archive attachment is not authorization to import it.

Use `pdftotext -layout reports/2025-census-classified.pdf temp_txt/report.txt` after
creating `temp_txt/`. Also inspect rendered PDF pages and reconcile parsed rows
against page totals. No OCR or layout inference is currently performed.

## Normalized report

Each reviewed report becomes `normalized/<report-id>.json`. Add its relative path
to `report_imports.json` to select it for the build. This **invented structural
example is not UO data** and is not shipped in the explorer:

```json
{
  "schemaVersion": 1,
  "reportId": "2025-census-classified",
  "measure": "annual_rate",
  "amountDefinition": "Replace with the verified meaning of UO's amount column.",
  "review": {
    "sourceSha256": "Replace with the checksum from records.json",
    "reviewedBy": "Reviewer name",
    "notes": "Document column definitions, exclusions and row reconciliation.",
    "expectedRowCount": 1
  },
  "records": [
    {
      "name": "Example, Alex",
      "title": "Example role",
      "department": "Example department",
      "amount": "60,000.00",
      "fte": "1.0",
      "sourcePage": 1,
      "sourceRow": 1
    }
  ]
}
```

- `sourceRow` is a unique, one-based row number across the complete report;
  `sourcePage` is the one-based PDF page, including any cover page.
- Amounts retain source text. Missing amounts are null or blank. Invalid text
  fails the build. No annualization or FTE multiplication is performed.
- FTE is an optional fraction, not percent. Preserve the original PDF and
  document any required transcription conversion. Never invent missing FTE.
- Census measures: `annual_rate`, `academic_year_rate`, `monthly_rate`,
  `hourly_rate`. Fiscal reports must use `fiscal_year_pay`.
- One normalized report has one reviewed amount definition. If a PDF mixes units,
  stop and extend this contract to support explicitly reviewed per-row measures
  before importing it; never coerce mixed units into one measure.
- An optional `profileKey` can link observations, including multiple appointments,
  across reports. Add `review.identityMethod` to explain the evidence. Use an
  opaque, non-sensitive linkage key; never put SSNs or private identifiers here.
  Missing keys generate report-row-specific profiles. Names are never auto-joined.
- Keep reports, raw values, original pages, and review notes even if a row's pay is
  unusable. Do not silently discard unknown rows to make the build pass.

## Browser artifacts

Run `./convert_data.sh`. It produces `data/index.json` (summary observations and
coverage), `data/search-index.json`, `data/aggregates.json`, `data/import-audit.json`,
and 16 `data/people/<hex>.json` history buckets. Index and search operate on source
observations, not inferred headcounts. The worker receives the loaded summary;
the separate search index is also available for independent consumers.

Every artifact has a shared content-derived version. History loads reject mixed
versions, and a rebuild clears stale bucket content. No giant combined file is
required. Builds are deterministic and use Python's standard library.

`./convert_data.sh --require-data` intentionally fails while no reports are
imported. Use this readiness check before a data-bearing production release.

## Next adapter verification

Inspect all four families (classified/unclassified × census/fiscal), and test
multiple years if formats changed. Reconcile row counts, wrapped names and titles,
Unicode, multi-appointment rows, missing values, zeros, negative adjustments,
duplicate names, page boundaries, and pay units against original PDF pages.
Add real-format fixtures only once those source files are available.
