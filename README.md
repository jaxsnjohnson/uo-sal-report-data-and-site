# UO Salary Transparency

A direct copy of the [OSU Salary Transparency explorer](https://github.com/jaxsnjohnson/osu-sal-report-data-and-site),
with UO green/yellow branding and UO data normalized into the same data contract.
The dashboard, search worker, result cards, lazy histories, historical charts,
inflation controls, keyboard navigation, archive, and responsive stylesheet come
from the OSU checkout. This replaces the previous separate UO implementation.

## Data

All **93 original UO PDFs** and **353,333 source job rows** are preserved.
`OneDrive_2026-09-21.zip`, `reports/`, `normalized/`, and `CNAME` were retained.
The pre-replacement working tree, including uncommitted work, was backed up to
`/tmp/uo-osu-rebuild-backup/working-tree.tar` on this development host.

- **Salary view:** 294,588 source rows, 2009–2025. Full-time rates for nine- and
  twelve-month appointments are normalized to OSU's `Annual Salary Rate`,
  `Appt Percent`, and `Salary Term` fields. Totals use rate × appointment percent,
  summed across jobs. Nine-month rates are never multiplied by 12/9. These are
  appointment-adjusted term amounts, not actual earnings.
- **Actual-pay view:** 58,745 source rows, FY 2020–21 through FY 2025–26. Select
  **Advanced → Fiscal-year actual pay**. Actual pay is summed as reported, with
  no invented FTE or salary rate. Negative source adjustments remain intact.
- Exact printed names group histories; this is not verified identity matching or
  a verified employee headcount. Names appearing in both classifications on the
  same date remain in separate classification-labeled groups.
- First Hired, Adjusted Service Date, and persistent job identifiers are absent.
  Job start dates are not substituted. Tenure displays unavailable data. Source
  classification changes remain available, with no claim about union exclusions.
- No OSU COLA events are applied to UO records. Repeated identical source blocks
  remain visible but are flagged and excluded from snapshot pay comparisons.
- Original pay, appointment percentages, job fields, report dates, and PDF page
  links remain in expanded histories. Source archives retain their original bytes.

The default view uses the latest salary-rate reports (November 1, 2025); the latest
actual-pay reports end June 30, 2026. **Show Earlier Records** includes names absent
from the latest report; it does not establish that someone left UO.

## Rebuild

Python 3 and Poppler are used for source extraction; the artifact build itself
uses Python's standard library.

```sh
# Rebuild from the preserved, validated normalized records:
./convert_data.sh --require-data
# Equivalent compatibility entry point:
python3 split_data.py --from-reports
```

To repeat source extraction from the preserved ZIP:

```sh
python3 scripts/ingest_sharepoint.py OneDrive_2026-09-21.zip
python3 scripts/parse_reports.py
python3 scripts/audit_sources.py
./convert_data.sh --require-data
```

`source-records.json` holds UO source metadata; `report_imports.json` allowlists
normalized files. The adapter verifies PDF checksums, reviewed row counts, source
pages, pay units, and classification before generating any public data. It builds
in a temporary directory before replacing output, removing stale shards.

The original metadata and audits at the time of replacement are also preserved in
`reports/provenance/`. Those historical documents describe the previous importer;
this README and `docs/data-contract.md` describe the new adapter.

## OSU-compatible artifacts

Both series emit `index.json`, `search-index.json`, `aggregates.json`,
`peer-medians.json`, and `people/{a..z,_}.json`. The default series is in `data/`;
actual pay is in `data/fiscal_year_pay/`. No OSU personnel records are copied.
`data/manifest.json` and `data/import-audit.json` reconcile all imported source rows.

Chart.js 4.5.1 is bundled locally with its MIT license; charts do not depend on a live CDN.
No analytics provider is configured for the UO copy.

The copied CPI file has sparse observations beginning in October 2014. The copied
inflation lookup uses the latest prior observation within 24 months; uncovered
dates are gaps rather than falsely labeled adjusted values.

## Preview and verify

```sh
python3 scripts/dev_server.py  # http://127.0.0.1:8085
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -p 'test_*.py' -v
node --test tests/search.test.mjs
node tests/browser.cjs
node tests/visual/compare.cjs  # requires the OSU reference checkout
```

Browser checks use the VM's Playwright installation. They cover Chromium,
Firefox, WebKit, worker/fallback search, 14 historical chart panels, personal
histories, actual pay, original source links, archive filtering, and mobile layout.
Screenshots are written under `test-results/copy-verification/`.

The Pages workflow validates and rebuilds data, then packages only public assets:

```sh
python3 scripts/package_site.py --output /tmp/uo-site-package
```

Git metadata, credentials, the ZIP, extracted text caches, and normalized build
inputs are excluded from the website package. This task changes the local checkout;
publication uses the repository's existing workflow after the changes are pushed.

GPL-3.0. See LICENSE and ATTRIBUTION.md.
