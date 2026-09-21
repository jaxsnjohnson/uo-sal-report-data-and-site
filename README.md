# UO Salary Transparency

A University of Oregon salary explorer in the style of
[OSU Salary Transparency](https://github.com/jaxsnjohnson/osu-sal-report-data-and-site).
Vanilla HTML/CSS/JavaScript, browser-side search, and a Python static data build.
GPL-3.0; see [ATTRIBUTION.md](ATTRIBUTION.md) and [LICENSE](LICENSE).

## Current status

The user-supplied `OneDrive_2026-09-21.zip` has been preserved and processed:
**93 original PDFs, 65,390 pages, and 353,333 job records**, covering June 2009
through June 2026. All 93 reports are available in the local explorer and source
archive. See [the ingestion report](docs/import-report.md) for coverage, checks,
and source limitations. These are job observations, not unique employee counts.

The source PDFs distinguish full-time **9-month and 12-month salary rates** from
**actual fiscal-year pay**. FY 2014–15 through 2018–19 files contain rates; actual
pay files begin with FY 2020–21. FY 2019–20 is absent from this download.
Search covers all reports by default and shows **26,127 exact-name groups**.
Expand a name for all its source entries, including entries outside the selected
filters. Exact-name grouping is a browsing aid, not a verified person identity;
shared names can refer to different people and spelling changes stay separate.
No pay is annualized and missing reports are not filled in.

## Reproduce the archive and import

The ZIP stays at its original local path and is ignored by Git. Original PDF
members retain the SharePoint folder structure and filenames. The tracked
manifest records the ZIP/member SHA-256 checksums; extracted text is reproducible
and ignored by Git. Requires Python 3 and Poppler (`pdftotext`, `pdfinfo`).

```sh
python3 scripts/ingest_sharepoint.py OneDrive_2026-09-21.zip
python3 scripts/parse_reports.py
python3 scripts/audit_sources.py
./convert_data.sh --require-data
```

Original bytes are never replaced. The parser retains every labelled source
field in `normalized/`, including job status, appointment percent, term of
service, home/pay departments, and source page/row. It rejects unknown layouts.
The independent raw-order extraction check reconciles page counts, personnel
markers, amount sequences, and rate percentages/terms against the normalized
records. This is automated validation with representative visual review, not a
manual check of every record.

## Preview and checks

```sh
./convert_data.sh
python3 -m unittest discover -s tests -p 'test_*.py'
node --test tests/search.test.mjs
python3 scripts/dev_server.py
```

Open **http://127.0.0.1:8085**. The preview binds only to localhost and reloads when
public files change. From the laptop, use an SSH tunnel to this VM:

```sh
ssh -N -L 8085:127.0.0.1:8085 codex@192.168.124.10
```

Use HTTP, not a `file://` URL, so fetch and module workers can operate.
No npm install, backend, database, external fonts, or CDN is required.

Browser smoke checks use the host's installed Playwright:

```sh
NODE_PATH=/home/codex/tools/browser-tests/node_modules node tests/browser.cjs
```

## Add the downloaded reports

Keep PDFs downloaded from UO under a local staging directory until their identities
are checked. To archive one by its catalog ID:

```sh
python3 scripts/archive_reports.py add 2025-census-classified /path/to/uo-report.pdf
./convert_data.sh
```

The PDF becomes available in the source archive but does not become salary data
until parsed and reviewed. See [docs/data-contract.md](docs/data-contract.md) for
the import schema and source-specific parser rules.

To refresh the official index or retry its public report links:

```sh
python3 scripts/archive_reports.py discover
python3 scripts/archive_reports.py download
./convert_data.sh
```

Discovery preserves the original HTML and does not drop older catalog entries.
Downloads never attempt to authenticate. A previously preserved PDF with different
bytes is never overwritten. Failed downloads are recorded as unavailable.

## What is implemented

- OSU's original dashboard, archive, filter, modal, and record-card components,
  with a byte-identical base stylesheet and separate UO color overrides.
- Distinct census salary-rate and fiscal-year actual-pay views; pay-unit filters.
- Unicode/accent-aware browser worker search, structured fields, phrases,
  exclusions, numeric ranges, sorting, and equivalent main-thread fallback.
- Batched exact-name results with all source-linked report entries on expansion.
- Filtered exact-name counts; latest matching entry per name for cards and ranks.
- Medians and pay comparisons require a single pay measure.
- Historical median charts with accessible source tables and measure separation.
- Original report catalog, provenance, checksums, import audit, and explicit
  coverage/error/empty states.

Name groups are not verified headcounts. No automatic identity merging, pay annualization,
FTE multiplication, inflation adjustment, or OSU-specific union assumptions are
used. See [methodology.html](methodology.html).

The **Advanced** area holds the report series, period, pay measure,
classification, pay range, full-time and data-flag filters. The question-mark
button opens the OSU-style About modal and source/methodology links.

## Visual A/B verification

See [docs/visual-comparison/README.md](docs/visual-comparison/README.md).
The comparison runs both actual applications with equivalent test records,
normalizes institution-specific copy, and compares their geometry and pixels.
No test records are written to the public dataset.

```sh
# Requires the OSU reference checkout and its preview on localhost:8084.
NODE_PATH=/home/codex/tools/browser-tests/node_modules node tests/visual/compare.cjs
/home/codex/tools/artifacts/bin/python tests/visual/report.py
```

The generated review page is `test-results/ab/index.html`, with desktop/mobile
A/B boards, overlays, pixel differences, and raw measurements.

## Repository structure

```text
index.html, css/, js/       Static explorer
records.html, records.json Official report catalog and archive
methodology.html           Public definitions and limits
reports/                   Original PDFs and dated catalog captures
normalized/                One source-preserving JSON file per report
report_imports.json        Explicit selection of all 93 normalized reports
scripts/archive_reports.py Source preservation and catalog discovery
scripts/ingest_sharepoint.py ZIP validation, preservation, dates, and inventory
scripts/parse_reports.py   Label-based PDF personnel-block parser
scripts/audit_sources.py   Independent raw-order PDF reconciliation
scripts/build_data.py      Validated, deterministic artifact generator
data/                      Generated summaries, histories and audit
tests/                     Data contract, search and browser checks
```

## Hosting

The public site is [uo.oregonhigheredsalaries.org](https://uo.oregonhigheredsalaries.org/).
GitHub Pages publishes `main` through `.github/workflows/pages.yml`, retaining the
repository's custom domain in `CNAME`. Every push runs pipeline/search tests,
rebuilds the data, checks that committed artifacts match, and packages the public
HTML, CSS, JavaScript, data, and original PDFs.

`scripts/package_site.py` excludes the original ZIP, extracted text, normalized
processing files, tests, and scripts from deployment. Those source and processing
materials remain in the repository or their documented local archive locations.
The public package is checked against the Pages size limit before upload.
CSS and JavaScript entry points, module imports, and workers receive a shared
content-derived version in their URLs so the custom-domain cache cannot mix
files from different releases.

To validate the same package locally, choose a new empty output directory:

```sh
python3 -m unittest discover -s tests -p 'test_*.py'
node --test tests/search.test.mjs
./convert_data.sh --require-data
python3 scripts/package_site.py --output /tmp/uo-public-preview
```

Read [the ingestion report](docs/import-report.md) for source limitations.
Relative paths support both a project subpath and the custom domain.
