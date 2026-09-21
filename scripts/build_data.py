#!/usr/bin/env python3
"""Validate reviewed UO observations and build the static browser artifacts.

There is deliberately no guessed PDF parser. See docs/data-contract.md.
"""
import argparse
from collections import defaultdict
from decimal import Decimal, InvalidOperation
import hashlib
import json
from pathlib import Path
import statistics
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))
from archive_reports import sha256, write_json

MEASURES = {
    'fiscal_year_pay': {'label': 'Fiscal-year actual pay', 'unit': 'USD / fiscal year', 'kind': 'fiscal'},
    'annual_rate': {'label': 'Reported annual rate', 'unit': 'USD / year', 'kind': 'census'},
    'academic_year_rate': {'label': 'Reported academic-year rate', 'unit': 'USD / academic year', 'kind': 'census'},
    'monthly_rate': {'label': 'Reported monthly rate', 'unit': 'USD / month', 'kind': 'census'},
    'hourly_rate': {'label': 'Reported hourly rate', 'unit': 'USD / hour', 'kind': 'census'},
}


def money(value):
    if value is None or str(value).strip() in ('', '—', '-', 'N/A'):
        return None
    if isinstance(value, bool):
        raise ValueError('Boolean amount')
    value = str(value).strip().replace('$', '').replace(',', '')
    if value.startswith('(') and value.endswith(')'):
        value = '-' + value[1:-1]
    try:
        number = Decimal(value)
    except InvalidOperation as error:
        raise ValueError(f'Invalid amount: {value!r}') from error
    if not number.is_finite() or abs(number) > Decimal('1e12'):
        raise ValueError('Non-finite or implausibly large amount')
    return float(number)


def public_file(root, value, directory):
    path = (root / value).resolve()
    if not path.is_relative_to((root / directory).resolve()) or not path.is_file():
        raise ValueError(f'Missing file or path outside {directory}: {value}')
    return path


def clean_text(value, field, required=True):
    if value is None and not required:
        return ''
    if not isinstance(value, str) or (required and not value.strip()):
        raise ValueError(f'{field} must be a nonempty string')
    return value.strip()


def load_observations(document, report):
    if document.get('schemaVersion') != 1 or document.get('reportId') != report['id']:
        raise ValueError('Schema version or report ID mismatch')
    measure = document.get('measure')
    if measure not in MEASURES or MEASURES[measure]['kind'] != report['kind']:
        raise ValueError('Report period and pay measure do not agree')
    definition = clean_text(document.get('amountDefinition'), 'amountDefinition')
    review = document.get('review', {})
    if review.get('sourceSha256') != report.get('sha256') or not report.get('sha256'):
        raise ValueError('Review must reference the archived PDF checksum')
    clean_text(review.get('reviewedBy'), 'reviewedBy')
    clean_text(review.get('notes'), 'review notes')
    rows = document.get('records')
    if not isinstance(rows, list) or not rows:
        raise ValueError('An imported report must have reviewed records')
    expected = document.get('review', {}).get('expectedRowCount')
    if isinstance(expected, bool) or not isinstance(expected, int) or expected != len(rows):
        raise ValueError('Reviewed source row count must equal imported record count')
    output, seen = [], set()
    for row in rows:
        name = clean_text(row.get('name'), 'name')
        source_row = row.get('sourceRow')
        page = row.get('sourcePage')
        if any(isinstance(v, bool) or not isinstance(v, int) or v < 1 for v in (source_row, page)):
            raise ValueError('Every record needs positive sourceRow and sourcePage integers')
        if source_row in seen:
            raise ValueError(f'Duplicate source row {source_row}')
        seen.add(source_row)
        amount = money(row.get('amount'))
        flag = 'Amount unavailable' if amount is None else None
        if amount is not None and amount <= 0 and measure != 'fiscal_year_pay':
            flag = 'Non-positive rate; excluded from rate statistics'
        fte = money(row.get('fte'))
        if fte is not None and not 0 <= fte <= 10:
            raise ValueError('FTE must be a nonnegative decimal fraction, not a percentage')
        key = row.get('profileKey')
        if key is not None:
            key = clean_text(key, 'profileKey')
            clean_text(review.get('identityMethod'), 'identityMethod for linked profiles')
        # No name-based joining. Unreviewed identities remain report-row specific.
        identity = 'reviewed:' + key if key else f"row:{report['id']}:{source_row}"
        profile = hashlib.sha256(identity.encode()).hexdigest()[:24]
        record_id = f"{report['id']}:{source_row}"
        output.append(dict(id=record_id, profileId=profile, name=name,
            title=clean_text(row.get('title'), 'title', False),
            department=clean_text(row.get('department'), 'department', False),
            classification=report['classification'], reportId=report['id'], kind=report['kind'],
            date=report['endDate'], startDate=report['startDate'], measure=measure,
            amount=amount, rawAmount=row.get('amount'), usable=flag is None, payNote=flag,
            fte=fte, rawFte=row.get('fte'), sourcePage=page, sourceRow=source_row,
            identityBasis='Reviewed linkage' if key else 'Source row only',
            amountDefinition=definition))
    return output


def build(root=ROOT, strict=False):
    catalog = json.loads((root / 'records.json').read_text())
    imports = json.loads((root / 'report_imports.json').read_text())
    if not isinstance(imports, list) or len(set(imports)) != len(imports):
        raise ValueError('report_imports.json must be a list of unique normalized JSON paths')
    derived = {'imported', 'rowCount', 'measure', 'amountDefinition'}
    reports = {r['id']: dict({k: v for k, v in r.items() if k not in derived}, imported=False)
               for r in catalog['reports']}
    observations, imported = [], set()
    for name in imports:
        document = json.loads(public_file(root, name, 'normalized').read_text())
        report_id = document.get('reportId')
        if report_id not in reports or report_id in imported:
            raise ValueError(f'Unknown or duplicate report import: {report_id}')
        report = reports[report_id]
        source = public_file(root, report.get('file', ''), 'reports')
        if sha256(source.read_bytes()) != report.get('sha256'):
            raise ValueError(f'Source checksum mismatch: {report_id}')
        rows = load_observations(document, report)
        observations.extend(rows)
        report.update(imported=True, rowCount=len(rows), measure=document['measure'],
                      amountDefinition=document['amountDefinition'])
        imported.add(report_id)
    if strict and not observations:
        raise ValueError('No salary observations imported; production data readiness check failed')
    people = defaultdict(list)
    for row in observations:
        people[row['profileId']].append(row)
    buckets = {letter: {} for letter in '0123456789abcdef'}
    for profile_id, rows in people.items():
        buckets[profile_id[0]][profile_id] = sorted(rows, key=lambda r: (r['date'], r['id']))
    summary = [{k: v for k, v in row.items() if k not in ('rawAmount', 'rawFte', 'amountDefinition')}
               for row in observations]
    summary.sort(key=lambda r: (r['name'].casefold(), r['date'], r['id']))
    aggregates = []
    for report in reports.values():
        if not report['imported']:
            continue
        rows = [r for r in observations if r['reportId'] == report['id']]
        amounts = [r['amount'] for r in rows if r['usable']]
        aggregates.append(dict(reportId=report['id'], date=report['endDate'], kind=report['kind'],
            classification=report['classification'], measure=report['measure'], recordCount=len(rows),
            usableCount=len(amounts), median=statistics.median(amounts) if amounts else None,
            total=round(sum(amounts), 2) if amounts else None))
    catalog['reports'] = list(reports.values())
    # Hash all observations and catalog metadata so changes invalidate history caches too.
    version = sha256(json.dumps([catalog, observations], sort_keys=True, ensure_ascii=False).encode())[:16]
    data = dict(schemaVersion=1, version=version, status='ready' if observations else 'awaiting-reports',
                sourceIndex=catalog['indexUrl'], capturedAt=catalog['capturedAt'],
                measures=MEASURES, reports=list(reports.values()), records=summary)
    write_json(root / 'data/index.json', data)
    write_json(root / 'data/search-index.json', dict(version=version, records=summary))
    write_json(root / 'data/aggregates.json', dict(version=version, reports=aggregates))
    write_json(root / 'data/import-audit.json', dict(version=version, importedReports=sorted(imported),
        observationCount=len(observations), profileCount=len(people),
        unavailablePayCount=sum(not r['usable'] for r in observations),
        identityRule='No automatic name matching; profiles link only through explicitly reviewed keys.',
        sourceChecksums={r['id']: r.get('sha256') for r in reports.values() if r['imported']}))
    for bucket, profiles in buckets.items():
        write_json(root / f'data/people/{bucket}.json', dict(version=version, people=profiles))
    catalog['reports'] = list(reports.values())
    write_json(root / 'records.json', catalog)
    return data


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--require-data', action='store_true', help='Fail if reports have not been imported')
    args = parser.parse_args()
    data = build(strict=args.require_data)
    print(f"Built {len(data['records']):,} salary observations; {data['status']}")


if __name__ == '__main__':
    main()
