# SharePoint archive ingestion — September 21, 2026

All **93 PDFs** in the supplied archive were preserved, cataloged, and parsed:
**65,390 physical PDF pages and 353,333 job records**, covering reporting periods
from **June 1, 2009 through June 30, 2026**. These counts describe this download,
not a claim that every historical UO report exists in it. The original ingestion was local. The subsequent website release is documented
in [README.md](../README.md#hosting).

## Coverage

| Original folder | PDFs | Pages | Job records | Interpretation |
| --- | ---: | ---: | ---: | --- |
| Fall | 24 | 15,072 | 79,692 | Fall 2014–2025 salary-rate snapshots |
| FY | 22 | 19,387 | 111,162 | FY 2014–15 through 2018–19 rates; FY 2020–21 through 2025–26 actual pay |
| Other | 47 | 30,931 | 162,479 | Earlier period/snapshot personnel lists, 2009–2018 |
| **Total** | **93** | **65,390** | **353,333** | Job observations, not employee headcounts |

There are 182,788 twelve-month rate records, 111,800 nine-month academic-year
rate records, and 58,745 actual-pay records. Fall and earlier personnel lists
remain separate even when their pay units match.

## Organization and provenance

The original `OneDrive_2026-09-21.zip` remains unchanged at the repository root,
ignored by Git because it duplicates the archived members and exceeds normal
GitHub file limits. Its SHA-256 is:
`949a566b12b32487e043908eb597159160ec58230ea57b2d6f5398fe35814f48`.

Original PDFs retain their filenames and folder structure under
`reports/sharepoint/Salary Reports/`. The [source manifest](../reports/sharepoint-manifest.json)
records checksums, sizes, pages, and extracted-text checksums. [The catalog](../records.json)
links verified PDF dates and stable IDs to each original. The 12 current catalog
reports retain individual official source links; historical entries link to the
UO SharePoint archive. No authentication or new live completeness check occurred.

[Normalized JSON](../normalized/) retains every labelled source field in one
file per report. Local `reports/text/` layout text is reproducible and ignored by
Git. Browser data loads by selected period; its initial manifest is about 143 KB
instead of requiring all 353,333 observations on first load.

## Validation and source limitations

All 93 reports passed label-based extraction and a second raw-order PDF pass.
All 65,390 pages, all 353,333 amount sequences, and the percentages/terms for all
294,588 rate records reconciled. Evidence is in the
[page extraction audit](../data/extraction-audit.json),
[independent source audit](../data/source-audit.json), and
[build audit](../data/import-audit.json). Both extraction passes use Poppler;
individual rows have not all been manually verified.

| Finding | Evidence and handling | Effect on use |
| --- | --- | --- |
| Missing FY coverage | Neither FY 2019–20 classification appears in the ZIP | Do not fill the gap or interpret it as zero pay |
| Missing paired historical file | Period ending May 31, 2012 has a classified report but no unclassified counterpart | That cross-classification comparison is incomplete |
| Different FY definitions | Ten older FY PDFs contain rates; twelve newer PDFs contain actual pay | Separate explorer series and measures |
| Appointment terms | All rate rows specify 9 or 12 months | Academic-year and twelve-month amounts stay separate |
| FTE absent | All 58,745 actual-pay rows lack appointment percent | FTE remains null; no full-time assumption |
| Zero and negative amounts | 36 zeros (six salary rates excluded from rate statistics) and two negative FY 2021–22 amounts (-$3,548 and -$3,394) | Retained without replacement or removal |
| Repeated printed blocks | Eight excess duplicates comparing name and every raw field within a report | Retained as distinct source rows; no deduplication/headcount inference |
| Filename anomalies | `Classified 070113 to 093313.pdf` prints September 30, 2013; the OA-grade file named `021216` prints February 1, 2016 as the salary snapshot | PDF headings control dates; original names remain unchanged |
| Fall timing | The 2014 snapshot is October 31; later fall reports use November 1 | Exact dates retained |
| Source text quirks | Wrapped/truncated titles, unusual punctuation, single-word names, multiple appointments | Preserve the original; do not invent name/title corrections |

The source grain is a job/position observation, sometimes further divided by
home/pay department combination. Identical names or blocks do not prove identity
or error. Profiles remain report-row-specific pending reviewed linkage. No pay
was annualized or multiplied by FTE.

## Reproducibility and review

Run the workflow in [README.md](../README.md). Parser and builder tests cover
unsafe ZIP paths, PDF dates, historical FY semantics, wrapped titles, single-word
names, original pay, percentage conversion, mixed terms, checksums, report parts,
and stale-artifact cleanup. Browser checks cover real report loading, all three
series, pay-unit selection, search, histories, mobile layout, worker fallback,
and error states in Chromium, Firefox, and WebKit.

Potential follow-up work is acquiring the missing reports and reviewing identity
links. Neither is necessary to preserve and search the supplied observations.

Sources: the user-supplied ZIP and preserved PDFs; the repository's saved official
UO catalog capture, referenced in [records.json](../records.json). Findings are
scoped to these artifacts.
