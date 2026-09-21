# UO → OSU normalization contract

The browser uses OSU's actual `js/app.js` and `js/search-worker.js`, with the data
adjustments below. `scripts/build_data.py` transforms UO source observations into
the input expected by the copied `split_data.build_artifacts` implementation.

| Preserved UO field | OSU-compatible field | Rule |
| --- | --- | --- |
| Printed name | Person dictionary key | Exact string; no fuzzy identity joins |
| Report period end | `Timeline[].Date` | Date from the PDF heading, not ZIP/download time |
| Classified/unclassified report | `Timeline[].Source` | Report classification, not inferred union status |
| Job/academic title | `Jobs[].Job Title` | Preserve source text |
| Pay/timesheet department | `Jobs[].Job Orgn` | Never substitute Home Department |
| Home department | `Meta.Home Orgn`, `Jobs[].Home Orgn` | Keep separately; latest primary job supplies card metadata |
| Full-time salary rate | `Jobs[].Annual Salary Rate` | Parse currency; retain full reported term |
| Appointment percent | `Jobs[].Appt Percent` | Numeric percent, e.g. 50, not 0.5 |
| Term of service | `Jobs[].Salary Term` | `9 mo` / `12 mo`; no 12/9 adjustment |
| Fiscal-year total pay | `Jobs[].Reported Pay` | Separate actual-pay dataset, no rate or FTE invention |
| PDF/page/row | `SourceUrl`, `Source Url`, `Source Page`, `Source Row` | Link the exact original PDF page |
| Every labeled source value | `Jobs[].Source Fields` | Original strings retained |

Salary snapshots total `sum(rate × percent / 100)`. This is appointment-adjusted
term pay, not actual fiscal-year earnings. Actual-pay snapshots total the reported
amounts, including negative corrections. Neither calculation changes raw values.
Non-positive/missing salary rates and exact duplicate printed blocks are retained
and flagged; affected snapshot totals are excluded from positive-pay statistics.
Dashboard medians and pay distributions follow the OSU convention of using
positive usable totals. Source zero/negative amounts remain available in histories.

One person group has one snapshot per report date, with every source job included.
If an exact printed name appears in both classifications on the same date, the
entire history is split into classification-labeled groups so date-keyed charts
cannot overwrite one snapshot. Multiple jobs in one report remain separate.
This conservative grouping does not establish that identical names are one person.

First Hired and Adjusted Service Date remain empty. A UO job start date does not
establish university tenure. Source-row IDs occupy the internal position-key field
to prevent false per-job raise comparisons between unrelated rows; they are not
presented as persistent UO positions. Person-level pay timelines and peer curves
remain available. Peer grouping uses the latest primary job's pay department and
title, as OSU does. OSU COLA events are not reused.

Both datasets emit the OSU browser contracts:

- `index.json`: dictionary of name groups, metadata, latest job, pay and filter flags.
- `search-index.json`: `{records: [...]}` for the copied worker.
- `people/{a..z,_}.json`: lazy name-group details with `Meta` and `Timeline`.
- `aggregates.json`: all 14 historical chart inputs, including pay distributions,
  concentration, role groups, paired snapshots, and classification transitions.
  Missing tenure produces an empty series and an explicit unavailable state.
- `peer-medians.json`: date → pay-department/title → median calculated pay.

`data/` contains salary rates; `data/fiscal_year_pay/` contains actual earnings.
The Advanced selector changes the dataset root using `?measure=fiscal_year_pay`;
search, sorting, cards, charts, and archive components remain the copied OSU ones.
Original records, catalog captures, normalized transcriptions, extraction audits,
and ZIP checksums remain available for independent verification.
