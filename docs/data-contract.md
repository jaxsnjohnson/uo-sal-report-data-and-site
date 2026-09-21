# UO import contract (versions 1 and 2)

The inspected SharePoint PDF layouts are supported by `scripts/parse_reports.py`.
See [import-report.md](import-report.md) for actual coverage and audit results.

## Source preservation

`scripts/ingest_sharepoint.py` validates ZIP paths, duplicate members, PDF
signatures, and CRCs before extraction. Originals retain the supplied folder
structure and filenames under `reports/sharepoint/Salary Reports/{Fall,FY,Other}/`.
Different existing bytes are never overwritten. The original ZIP stays at its
local path and is ignored by Git.

`reports/sharepoint-manifest.json` records ZIP/member SHA-256 checksums, sizes,
physical PDF page counts, and extracted-text checksums. The official index HTML
capture remains separately preserved. SharePoint provenance comes from the
user's account of the download; this import did not authenticate to SharePoint.

`records.json` links all originals, including the 12 reports previously listed
in the official index capture. Dates come from PDF headings, not filenames.
Fall reports use `kind: census`; newer FY actual-pay reports use `kind: fiscal`;
older FY rate reports and Other reports use `kind: historical`. Original
`sourceSeries` folder names are retained separately.

Extracted `reports/text/<report-id>.txt` files are local, reproducible
intermediates ignored by Git. Their checksums remain in the manifest. Original
PDFs and extracted text retain the source layout without manual text edits.

## Normalized observations

`normalized/<report-id>.json` retains every personnel block. `report_imports.json`
selects the files for the build. Unknown layouts fail the parser and are recorded
in `data/extraction-audit.json` rather than silently skipped.

Version 1 supports a single measure per report. Version 2 adds:

- `measures`: sorted list of the report's per-row measures.
- `measure`: the sole measure or `mixed` when multiple measures occur.
- `amountDefinitions`: definition keyed by measure.
- Per-row `measure`, `termOfService`, `appointmentPercent`, `sourceLine`, and
  `rawFields` containing every printed labelled field.
- `review.textSha256` and `review.pageReconciliation` alongside the existing
  PDF checksum, reviewer/method description, notes, and expected row count.

Each record has `name`, `title`, `department`, `amount`, `fte`, `sourcePage`, and
`sourceRow`. Pages are physical one-based PDF pages including covers; rows are
unique one-based personnel-block numbers across the report. `sourceLine` locates
the name on the extracted page. Wrapped titles retain newlines in `rawFields`;
the display title joins their lines with spaces.

## Pay definitions and transformations

- `amount` retains the printed dollar string. Numeric conversion does not alter
  units or multiply by FTE. Invalid money text fails the build.
- UO ANNUAL SALARY RATE is the full-time amount for the entire term of service.
  TERM OF SVC 9 maps to `academic_year_rate`; 12 maps to `annual_rate`. Unknown
  terms would be retained as `other_term_rate` and excluded from rate statistics.
  All imported rate rows have verified 9- or 12-month terms.
- TOTAL PAY maps to `fiscal_year_pay`: actual pay per position and home/pay or
  timesheet department combination. Older FY files contain rates; folder name
  alone never establishes the pay measure.
- APPT PERCENT is divided by 100 to obtain FTE; the printed percentage is also
  retained. Actual-pay reports have no such column, so their FTE stays null.
- `department` uses PAY DEPARTMENT or TMSHT DEPARTMENT. A leading six-digit org
  code is omitted from the display name but retained in `rawFields`. HOME
  DEPARTMENT stays separate and is never substituted.
- Multiple jobs, identical printed blocks, leave, terminated positions, zero pay,
  and negative adjustments are retained. Zero/negative rates are excluded from
  rate statistics; actual pay includes its zero/negative reported amounts.
- Person identities are never automatically joined. Optional `profileKey` linkage
  requires a documented `review.identityMethod`. This import uses source-row
  profiles. The explorer groups exact names for browsing without changing these
  identities or dropping any source rows. Accent folding affects search only;
  it does not merge differently spelled names.
- `reviewedBy` describes automated checks and representative visual review.
  It does not claim human approval or manual verification of every record.

## Reconciliation

The parser requires expected fields, rejects unexplained nonblank lines,
recognizes observed title continuations, and reconciles each data page's JOB TYPE
markers and pay fields. Full labelled fields remain in normalized records.

`scripts/audit_sources.py` performs a second `pdftotext -raw` pass on every PDF.
Every page's job count and exact amount sequence must match the normalized data,
as must each rate's appointment-percent and term sequence. Results are saved to
`data/source-audit.json`. Both passes use Poppler: separate extraction order is
not independent software or manual review.

## Browser artifacts

`./convert_data.sh --require-data` validates checksums, review metadata, row
counts, source locations, numeric values, kinds, and measures. All output files
share a deterministic content-derived version.

For more than 10,000 observations:

- `data/index.json` is a version-2 manifest with `recordCount`, reports, measures,
  `sharded: true`, and an empty `records` array.
- Each imported report's `dataFile` points to `data/reports/<report-id>.json`.
  These report parts remain available for independent consumers.
- `data/search-index.json` is the complete, dictionary-encoded all-report index
  (`uo-all-reports-v1`), including source dates, row/page references, original
  amounts, FTE, and pay definitions. The browser loads it once, searches every
  observation, and groups matching results by exact name. Cards show the latest
  matching entry (same-date ties use source row then ID); expansion shows all
  entries for that name, including those outside the active filters.
- `exactNameCount` in the manifest is distinct from the observation count and
  the reviewed identity count. None of these is a verified employee headcount.
- `data/aggregates.json` has one entry per report and measure, keeping 9-month
  and 12-month rates out of the same median.
- `data/people/<two-hex-digits>.json` retains source-profile details in 256 buckets.
  Full raw fields remain in normalized files instead of browser downloads.
- `data/import-audit.json` records import coverage and source checksums.

Small fixtures retain complete inline records and 16 history buckets. Rebuilds clear stale
report parts and history buckets. The build contract, catalog, and observations
all contribute to the cache version. The browser rejects mixed-version or
incomplete search data and ignores stale search responses. No ingestion step publishes
or pushes the repository.
