# Normalized UO reports

This directory contains one schema-version-2 JSON file for each of the 93 PDFs
in the supplied SharePoint archive (353,333 job records in total).

Each record retains its original labelled fields, printed pay amount, appointment
percent, term of service, and PDF page/row. Derived FTE is appointment percent
divided by 100. Rates retain their 9-month or 12-month term; actual pay is separate.
Names are not merged. Read `docs/data-contract.md` and `docs/import-report.md`.

Regenerate with `python3 scripts/parse_reports.py`, after extracting sources.
