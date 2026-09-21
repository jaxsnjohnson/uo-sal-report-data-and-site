#!/usr/bin/env python3
"""Extract UO personnel blocks, retain every field, and reconcile every data page.

Input: checksum-verified originals/text from ingest_sharepoint.py.
Output: normalized JSON, per-page extraction audit, and explicit import selection.
Unexpected layouts fail closed; no records are silently discarded.
"""
import argparse
from collections import Counter
from decimal import Decimal
import json
import re

from archive_reports import ROOT, sha256, write_json

LABELS = ('ANNUAL SALARY RATE', 'HOME DEPARTMENT', 'TMSHT DEPARTMENT', 'PAY DEPARTMENT',
          'POSITION CLASS', 'POSITION TITLE', 'ACADEMIC TITLE', 'OA SALARY GRADE',
          'JOB START DATE', 'JOB END DATE', 'PRIMARY ACTIVITY', 'EEO CATEGORY',
          'APPT PERCENT', 'APPT STATUS', 'TERM OF SVC', 'JOB STATUS', 'JOB TITLE',
          'TOTAL PAY', 'RANK DATE', 'JOB TYPE', 'RANK', 'TITLE')
FIELD = re.compile(r'^\s*(' + '|'.join(LABELS) + r')(?:\s{2,}(.*)|\s*)$')
RIGHT = re.compile(r'\s{2,}(' + '|'.join(LABELS) + r')(?:\s{2,}|\s*$)')
DEFINITIONS = {
    'annual_rate': 'UO ANNUAL SALARY RATE for a 12-month term: full-time rate for the entire term of service, not actual earnings; not multiplied by appointment percent.',
    'academic_year_rate': 'UO ANNUAL SALARY RATE for a 9-month academic-year term: full-time rate for that term, not 12-month earnings; not multiplied by appointment percent.',
    'other_term_rate': 'UO ANNUAL SALARY RATE with a term of service other than a verified 9 or 12 months. Original amount retained; excluded from rate comparisons.',
    'fiscal_year_pay': 'UO TOTAL PAY: actual pay for each position and home/timesheet department combination during the stated fiscal year; not a salary rate or a unique-person total.'
}


def parse_page(page, page_number, first_row, actual):
    lines = page.splitlines()
    markers = [i for i, line in enumerate(lines) if re.match(r'^\s*JOB TYPE\s{2,}', line)]
    if not markers:
        # Covers contain definitions with colons, never actual labelled amounts.
        if re.search(r'^\s*(?:ANNUAL SALARY RATE|TOTAL PAY)\s+\$', page, re.M):
            raise ValueError(f'Page {page_number}: pay without personnel blocks')
        return [], dict(page=page_number, rowCount=0, role='definitions')
    starts = []
    for i in markers:
        name_index = i - 1
        while name_index >= 0 and not lines[name_index].strip():
            name_index -= 1
        if (name_index < 0 or not lines[name_index].strip() or FIELD.match(lines[name_index])
                or lines[name_index].strip().startswith(('NOTE:', 'Employees ', 'UNIVERSITY ', 'Source:'))):
            raise ValueError(f'Page {page_number}: missing/unrecognized name before JOB TYPE')
        starts.append(name_index)
    rows = []
    for offset, marker in enumerate(markers):
        stop = starts[offset + 1] if offset + 1 < len(starts) else len(lines)
        fields, raw_lines, last_right, last_left = {}, [], None, None
        value_column = None
        for line in lines[marker:stop]:
            if not line.strip():
                continue
            if re.match(r'^(?:UO )?Office of Institutional Research', line.strip()):
                break
            raw_lines.append(line)
            match = FIELD.match(line)
            if not match:
                # UO wraps long titles onto another line aligned to the left value.
                if (last_left in ('JOB TITLE', 'ACADEMIC TITLE', 'POSITION TITLE', 'TITLE')
                        and len(line) - len(line.lstrip()) == value_column):
                    fields[last_left] += '\n' + line.strip()
                    continue
                raise ValueError(f'Page {page_number}, row {first_row + offset}: unexpected line {line!r}')
            label, value = match[1], match[2] or ''
            if value_column is None and match[2]:
                value_column = match.start(2)
            right = RIGHT.search(value)
            if right:
                left_value = value[:right.start()].strip()
                right_label, right_value = right[1], value[right.end():].strip()
                if right_label in fields:
                    raise ValueError(f'Page {page_number}: duplicate field {right_label}')
                fields[right_label] = right_value
                last_right = right_label
            else:
                dated_status = re.search(r'\s{2,}(as of \d+/\d+/\d{4})\s{2,}(.*)$', value)
                if dated_status:
                    left_value = value[:dated_status.start()].strip()
                    if fields.get('JOB STATUS') or last_right != 'JOB STATUS':
                        raise ValueError(f'Page {page_number}: ambiguous dated job status')
                    fields['JOB STATUS'] = dated_status[2].strip()
                    fields['JOB STATUS AS OF'] = dated_status[1].removeprefix('as of ')
                else:
                    left_value = value.strip()
            if label in fields:
                raise ValueError(f'Page {page_number}: duplicate field {label}')
            fields[label] = left_value
            last_left = label
        amount_label = 'TOTAL PAY' if actual else 'ANNUAL SALARY RATE'
        required = {'JOB TYPE', 'HOME DEPARTMENT', 'JOB STATUS', 'TERM OF SVC', amount_label}
        if not required <= fields.keys():
            raise ValueError(f'Page {page_number}: missing fields {required - fields.keys()}')
        if not any(label in fields for label in ('JOB TITLE', 'ACADEMIC TITLE', 'POSITION TITLE', 'TITLE')):
            raise ValueError(f'Page {page_number}: missing title label')
        amount = fields[amount_label]
        if amount and not re.fullmatch(r'-?\$[\d,]+(?:\.\d+)?|\(\$[\d,]+(?:\.\d+)?\)', amount):
            raise ValueError(f'Page {page_number}: invalid money text {amount!r}')
        term = fields['TERM OF SVC']
        measure = 'fiscal_year_pay' if actual else {'9': 'academic_year_rate', '12': 'annual_rate'}.get(term, 'other_term_rate')
        percent = fields.get('APPT PERCENT', '')
        if not actual and 'APPT PERCENT' not in fields:
            raise ValueError(f'Page {page_number}: missing appointment percent label')
        if percent and not re.fullmatch(r'\d+(?:\.\d+)?%', percent):
            raise ValueError(f'Page {page_number}: invalid percent {percent!r}')
        if 'TMSHT DEPARTMENT' not in fields and 'PAY DEPARTMENT' not in fields:
            raise ValueError(f'Page {page_number}: missing pay/timesheet department')
        department = fields.get('TMSHT DEPARTMENT', fields.get('PAY DEPARTMENT'))
        # Old reports include a six-digit org code; retain the complete field as well.
        department = re.sub(r'^\d{6}\s+', '', department)
        rows.append(dict(name=lines[starts[offset]].strip(),
                         title=' '.join(next(fields[k] for k in ('JOB TITLE', 'ACADEMIC TITLE', 'POSITION TITLE', 'TITLE') if k in fields).split()),
                         department=' '.join(department.split()), amount=amount or None,
                         fte=str(Decimal(percent[:-1]) / 100) if percent else None,
                         measure=measure, termOfService=term, appointmentPercent=percent or None,
                         sourcePage=page_number, sourceRow=first_row + offset,
                         sourceLine=starts[offset] + 1, rawFields=fields))
    amount_count = len(re.findall(r'^.*\b' + ('TOTAL PAY' if actual else 'ANNUAL SALARY RATE') + r'\s+(?:\$|-\$|\(\$)', page, re.M))
    # Blank amounts also count via the field-level check above.
    if amount_count != sum(r['amount'] is not None for r in rows):
        raise ValueError(f'Page {page_number}: amount count differs from extracted records')
    return rows, dict(page=page_number, rowCount=len(rows), payFieldCount=amount_count, role='data')


def parse_report(report, root=ROOT):
    text_bytes = (root / report['textFile']).read_bytes()
    if sha256(text_bytes) != report['textSha256'] or sha256((root / report['file']).read_bytes()) != report['sha256']:
        raise ValueError('Source PDF/text checksum changed')
    pages = text_bytes.decode().split('\f')
    if pages[-1].strip() or len(pages) - 1 != report['pageCount']:
        raise ValueError('Source page count changed')
    rows, audit = [], []
    for n, page in enumerate(pages[:-1], 1):
        extracted, check = parse_page(page, n, len(rows) + 1, report['payBasis'] == 'actual_pay')
        rows.extend(extracted)
        audit.append(check)
    if not rows:
        raise ValueError('No personnel rows found')
    measures = sorted({r['measure'] for r in rows})
    return dict(schemaVersion=2, reportId=report['id'], measure=measures[0] if len(measures) == 1 else 'mixed',
                measures=measures, amountDefinition='Amounts retain the PDF units; see the per-measure definitions.',
                amountDefinitions={m: DEFINITIONS[m] for m in measures},
                review=dict(sourceSha256=report['sha256'], textSha256=report['textSha256'],
                            reviewedBy='Codex automated extraction with source-layout review',
                            notes='Labelled personnel blocks reconciled to JOB TYPE markers and amount fields on every page. '
                                  'Representative layouts visually reviewed; individual rows have not all been manually verified. '
                                  'APPT PERCENT divided by 100 for FTE; amounts unchanged. PAY/TMSHT department used, never HOME substituted. '
                                  'Nine- and twelve-month rates kept separate. No cross-report identity matching.',
                            expectedRowCount=len(rows), pageReconciliation=audit), records=rows)


def process(root=ROOT):
    catalog = json.loads((root / 'source-records.json').read_text())
    imports, audits = [], []
    for report in catalog['reports']:
        if not report.get('textFile'):
            continue
        rid = report['id']
        try:
            document = parse_report(report, root)
            destination = f'normalized/{rid}.json'
            write_json(root / destination, document)
            imports.append(destination)
            rows = document['records']
            name_counts = Counter(r['name'] for r in rows)
            audit = dict(reportId=rid, status='parsed', rowCount=len(rows), pageCount=report['pageCount'],
                         measures=dict(Counter(r['measure'] for r in rows)),
                         terms=dict(Counter(r['termOfService'] for r in rows)),
                         missingAmountCount=sum(r['amount'] is None for r in rows),
                         missingFteCount=sum(r['fte'] is None for r in rows),
                         duplicateNameRows=sum(n for n in name_counts.values() if n > 1),
                         pageReconciliation=document['review']['pageReconciliation'])
            print(f'{rid}: {len(rows):,} rows', flush=True)
        except ValueError as error:
            audit = dict(reportId=rid, status='needs-review', error=str(error))
            print(f'{rid}: NEEDS REVIEW: {error}', flush=True)
        audits.append(audit)
    write_json(root / 'data/extraction-audit.json', dict(schemaVersion=1, reports=audits,
               parsedReports=len(imports), heldReports=len(audits) - len(imports),
               rowCount=sum(a.get('rowCount', 0) for a in audits)))
    write_json(root / 'report_imports.json', imports)
    return audits


if __name__ == '__main__':
    argparse.ArgumentParser(description=__doc__).parse_args()
    if any(r['status'] != 'parsed' for r in process()):
        raise SystemExit('Some reports need review; see data/extraction-audit.json before rebuilding.')
