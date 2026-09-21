#!/usr/bin/env python3
"""Independently reconcile Poppler raw-order PDF text against normalized pages."""
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal
import json
import re
import subprocess

from archive_reports import ROOT, sha256, write_json


def check(report):
    document = json.loads((ROOT / f'normalized/{report["id"]}.json').read_text())
    assert sha256((ROOT / report['file']).read_bytes()) == document['review']['sourceSha256']
    raw = subprocess.check_output(['pdftotext', '-raw', str(ROOT / report['file']), '-']).decode()
    by_page = defaultdict(list)
    for row in document['records']:
        by_page[row['sourcePage']].append(row)
    assert raw.count('\f') == report['pageCount'], report['id']
    for page_number, page in enumerate(raw.split('\f')[:-1], 1):
        rows = by_page[page_number]
        markers = re.findall(r'^JOB TYPE(?:\s|$)', page, re.M)
        assert len(markers) == len(rows), (report['id'], page_number, 'personnel count', len(markers), len(rows))
        label = 'TOTAL PAY' if report['payBasis'] == 'actual_pay' else 'ANNUAL SALARY RATE'
        amounts = re.findall(r'\b' + label + r'\s+(-?\$[\d,]+(?:\.\d+)?|\(\$[\d,]+(?:\.\d+)?\))\s*$', page, re.M)
        assert amounts == [r['amount'] for r in rows if r['amount']], (report['id'], page_number, 'amount sequence')
        if report['payBasis'] == 'salary_rate':
            percentages = re.findall(r'\bAPPT PERCENT\s+(\d+(?:\.\d+)?%)\s*$', page, re.M)
            assert percentages == [r['appointmentPercent'] for r in rows if r['appointmentPercent']], (report['id'], page_number, 'percent sequence')
            terms = re.findall(r'\bTERM OF SVC\s+(\d+)\s*$', page, re.M)
            assert terms == [r['termOfService'] for r in rows if r['termOfService']], (report['id'], page_number, 'term sequence')
    values = [Decimal(r['amount'].replace('$', '').replace(',', '').replace('(', '-').replace(')', ''))
              for r in document['records'] if r['amount']]
    exact = Counter(json.dumps(r['rawFields'], sort_keys=True) + r['name'] for r in document['records'])
    return dict(reportId=report['id'], rowCount=len(document['records']), pageCount=report['pageCount'],
                independentRawExtraction='passed', zeroAmountCount=sum(v == 0 for v in values),
                negativeAmountCount=sum(v < 0 for v in values),
                missingAmountCount=len(document['records']) - len(values),
                missingFteCount=sum(r['fte'] is None for r in document['records']),
                exactDuplicateExcess=sum(n - 1 for n in exact.values() if n > 1),
                minimumAmount=str(min(values)) if values else None,
                maximumAmount=str(max(values)) if values else None)


def main():
    catalog = json.loads((ROOT / 'records.json').read_text())
    reports = [r for r in catalog['reports'] if r.get('textFile')]
    with ThreadPoolExecutor(max_workers=4) as pool:
        audits = list(pool.map(check, reports))
    result = dict(schemaVersion=1, source='reports/sharepoint-manifest.json',
                  method='Independent pdftotext -raw extraction: every PDF page, job marker, amount sequence, and rate appointment percent/term sequence reconciled to normalized data. Same Poppler engine, separate extraction order; not independent manual verification.',
                  reportCount=len(audits), rowCount=sum(r['rowCount'] for r in audits),
                  pageCount=sum(r['pageCount'] for r in audits),
                  totals={key: sum(r[key] for r in audits) for key in
                          ('zeroAmountCount', 'negativeAmountCount', 'missingAmountCount', 'missingFteCount', 'exactDuplicateExcess')},
                  reports=audits)
    write_json(ROOT / 'data/source-audit.json', result)
    print(json.dumps({k: v for k, v in result.items() if k not in ('reports', 'method')}, indent=2))


if __name__ == '__main__':
    main()
