# UO Salary Transparency

A University of Oregon salary explorer in the style of
[OSU Salary Transparency](https://github.com/jaxsnjohnson/osu-sal-report-data-and-site).
Vanilla HTML/CSS/JavaScript, browser-side search, and a Python static data build.
GPL-3.0; see [ATTRIBUTION.md](ATTRIBUTION.md) and [LICENSE](LICENSE).

## Current status

The UO interface and data pipeline foundation are implemented. The archived
[official UO catalog](https://data.uoregon.edu/employees/salary-reports) lists 12
reports: classified and unclassified fall census 2023–2025, plus fiscal years
2024–2026. Its SharePoint PDFs returned HTTP 403 in this environment. **No real
salary rows have been imported.** The site displays an explicit pending state,
never demonstration people or invented statistics.

The PDF parser will be implemented after the actual UO files are provided and
their layouts and pay definitions can be checked. The existing build accepts
reviewed normalized observations; it is not a claim that UO PDFs already parse.

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
the reviewed import schema and remaining parser work.

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
- Batched results and lazy-loaded, source-linked histories.
- Filtered row counts, medians, classification split, department and title ranks.
- Historical median charts with accessible source tables and measure separation.
- Original report catalog, provenance, checksums, import audit, and explicit
  coverage/error/empty states.

Rows are not verified headcounts. No automatic name merging, pay annualization,
FTE multiplication, inflation adjustment, or OSU-specific union assumptions are
used. See [methodology.html](methodology.html).

The **Advanced** area holds the report period, pay measure, fiscal-year toggle,
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
normalized/                Reviewed source transcriptions, when available
report_imports.json        Explicit import selection (currently empty)
scripts/archive_reports.py Source preservation and catalog discovery
scripts/build_data.py      Validated, deterministic artifact generator
data/                      Generated summaries, histories and audit
tests/                     Data contract, search and browser checks
```

## Hosting

This is a static repository suitable for GitHub Pages or another static host.
`.nojekyll` is included. No custom domain, analytics, or deployment is configured
yet. Before publishing salary data, import and verify the real reports,
run `./convert_data.sh --require-data`, and run the tests. Relative paths support
both a project subpath and a custom domain.
