#!/usr/bin/env python3
"""Validate UO normalized observations and build versioned static artifacts."""
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
    'other_term_rate': {'label': 'Rate with unverified term', 'unit': 'USD / unverified term', 'kind': 'census'},
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
    if document.get('schemaVersion') not in (1, 2) or document.get('reportId') != report['id']:
        raise ValueError('Schema version or report ID mismatch')
    per_row = document['schemaVersion'] == 2
    clean_text(document.get('amountDefinition'), 'amountDefinition')
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
        measure = row.get('measure') if per_row else document.get('measure')
        expected_kind = 'census' if report['kind'] == 'historical' else report['kind']
        if measure not in MEASURES or MEASURES[measure]['kind'] != expected_kind:
            raise ValueError('Report period and pay measure do not agree')
        definition = clean_text(document.get('amountDefinitions', {}).get(measure) if per_row
                                else document['amountDefinition'], 'amount definition')
        name = clean_text(row.get('name'), 'name')
        source_row = row.get('sourceRow')
        page = row.get('sourcePage')
        if any(isinstance(v, bool) or not isinstance(v, int) or v < 1 for v in (source_row, page)):
            raise ValueError('Every record needs positive sourceRow and sourcePage integers')
        if report.get('pageCount') and page > report['pageCount']:
            raise ValueError('Source page exceeds the archived PDF page count')
        if source_row in seen:
            raise ValueError(f'Duplicate source row {source_row}')
        seen.add(source_row)
        amount = money(row.get('amount'))
        flag = 'Amount unavailable' if amount is None else None
        if amount is not None and amount <= 0 and measure != 'fiscal_year_pay':
            flag = 'Non-positive rate; excluded from rate statistics'
        if measure == 'other_term_rate':
            flag = 'Term of service not verified as 9 or 12 months; excluded from rate statistics'
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
            amountDefinition=definition,
            **({k: row[k] for k in ('termOfService', 'appointmentPercent', 'sourceLine') if k in row})))
    if per_row and sorted({r['measure'] for r in output}) != document.get('measures'):
        raise ValueError('Declared measures do not match per-row measures')
    if per_row and document.get('measure') != (document['measures'][0] if len(document['measures']) == 1 else 'mixed'):
        raise ValueError('Report measure does not match declared per-row measures')
    return output
