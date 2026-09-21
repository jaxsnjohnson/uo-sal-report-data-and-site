#!/usr/bin/env python3
"""Normalize preserved UO reports into the OSU person/snapshot/job contract."""
import argparse
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path
import re
import shutil
import sys
import tempfile
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.validate_sources import load_observations, money, public_file
import split_data

DATASETS = {'salary_rate': 'Appointment-adjusted salary', 'fiscal_year_pay': 'Fiscal-year actual pay'}
MEASURES = {'annual_rate': 'salary_rate', 'academic_year_rate': 'salary_rate', 'fiscal_year_pay': 'fiscal_year_pay'}


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False) + '\n')


def job_from_row(row, report, duplicate=False):
    raw = row['rawFields']
    actual = row['measure'] == 'fiscal_year_pay'
    amount = money(row['amount'])
    job = {
        'Job Title': row['title'], 'Job Orgn': row['department'],
        'Home Orgn': raw.get('HOME DEPARTMENT', ''),
        'Job Type': raw.get('JOB TYPE', ''), 'Job Status': raw.get('JOB STATUS', ''),
        # A source-row key prevents false per-position deltas: UO provides no persistent job ID.
        'Posn-Suff': f"{report['id']}:{row['sourceRow']}",
        'Annual Salary Rate': '' if actual else amount,
        'Reported Pay': amount if actual else None,
        'Reported Salary Rate': row['amount'],
        'Appt Percent': (money(str(row['appointmentPercent']).rstrip('%')) if row.get('appointmentPercent') is not None and not actual else None),
        'Salary Term': 'fiscal year' if actual else f"{row.get('termOfService', '')} mo",
        'Pay Measure': row['measure'],
        'Source Row': row['sourceRow'], 'Source Page': row['sourcePage'],
        'Source Url': quote(report['file'], safe='/') + f"#page={row['sourcePage']}",
        'Source Fields': raw,
    }
    if amount is None or (not actual and (amount <= 0 or job['Appt Percent'] is None)):
        job['Pay Review Reason'] = 'Missing or non-positive salary rate or missing appointment percent.'
    if duplicate:
        job['Pay Review Reason'] = 'Identical source blocks repeat; retained but excluded from pay totals pending review.'
    return job


def add_report(model, document, report, dataset):
    by_name = defaultdict(list)
    for row in document['records']:
        if MEASURES[row['measure']] == dataset:
            by_name[row['name']].append(row)
    for name, rows in by_name.items():
        person = model.setdefault(name, {'Meta': {}, 'Timeline': []})
        signatures = Counter(json.dumps(r['rawFields'], sort_keys=True) for r in rows)
        rows.sort(key=lambda r: (r['rawFields'].get('JOB TYPE') != 'Primary', r['sourceRow']))
        jobs = [job_from_row(r, report, signatures[json.dumps(r['rawFields'], sort_keys=True)] > 1) for r in rows]
        person['Timeline'].append({
            'Date': report['endDate'], 'Source': report['classification'],
            'SourceUrl': quote(report['file'], safe='/'), 'ReportId': report['id'],
            'PeriodStart': report['startDate'], 'PayMeasure': dataset, 'Jobs': jobs,
        })


def finalize_model(model):
    # Exact printed names are browsing groups, never verified identities.
    # Simultaneous appearances in both classifications must not overwrite each other.
    for name, person in list(model.items()):
        dates = Counter(s['Date'] for s in person['Timeline'])
        if any(n > 1 for n in dates.values()):
            del model[name]
            for classification in ('classified', 'unclassified'):
                timeline = [s for s in person['Timeline'] if s['Source'] == classification]
                if timeline:
                    key = f'{name} [{classification}]'
                    if key in model:
                        raise ValueError(f'Name-group key collision: {key}')
                    model[key] = {'Meta': {}, 'Timeline': timeline, 'SourceName': name}
    for name, person in model.items():
        person['Timeline'].sort(key=lambda s: s['Date'])
        if len({s['Date'] for s in person['Timeline']}) != len(person['Timeline']):
            raise ValueError(f'Multiple reports on the same date for {name}')
        last_job = person['Timeline'][-1]['Jobs'][0]
        person['Meta'] = {
            'First Hired': '', 'Adj Service Date': '',
            'Home Orgn': re.sub(r'^\d+\s+', '', last_job['Home Orgn']),
            'Identity Basis': 'Exact printed name; identity not verified',
        }


def build(root=ROOT):
    catalog = json.loads((root / 'source-records.json').read_text())
    reports = {r['id']: r for r in catalog['reports']}
    imports = json.loads((root / 'report_imports.json').read_text())
    if not isinstance(imports, list) or len(imports) != len(set(imports)):
        raise ValueError('Imports must be a unique list of normalized source paths')
    models = {dataset: {} for dataset in DATASETS}
    counts, report_audit, imported = Counter(), [], set()
    digest = hashlib.sha256((root / 'source-records.json').read_bytes())
    for code_path in (Path(__file__), ROOT / 'split_data.py', ROOT / 'scripts/validate_sources.py'):
        digest.update(code_path.read_bytes())
    for filename in imports:
        path = public_file(root, filename, 'normalized')
        content = path.read_bytes()
        document = json.loads(content)
        report_id = document['reportId']
        if report_id not in reports or report_id in imported:
            raise ValueError(f'Unknown or repeated report: {report_id}')
        imported.add(report_id)
        report = reports[report_id]
        source = public_file(root, report['file'], 'reports')
        if hashlib.sha256(source.read_bytes()).hexdigest() != report['sha256']:
            raise ValueError(f'Source checksum mismatch: {report_id}')
        load_observations(document, report)
        digest.update(content)
        report_counts = Counter(r['measure'] for r in document['records'])
        if set(report_counts) - MEASURES.keys():
            raise ValueError(f'Unsupported pay measures: {report_id}')
        counts.update(report_counts)
        for dataset in {MEASURES[m] for m in report_counts}:
            add_report(models[dataset], document, report, dataset)
        report_audit.append({'reportId': report_id, 'sourceSha256': report['sha256'],
                             'rowCount': len(document['records']), 'measures': dict(report_counts)})
    if not counts:
        raise ValueError('No UO salary observations imported')
    manifest = {'schemaVersion': 1, 'version': digest.hexdigest()[:16],
                'recordCount': sum(counts.values()), 'reportCount': len(imported),
                'datasets': {}, 'reports': report_audit}
    with tempfile.TemporaryDirectory(prefix='.uo-build-', dir=root) as temporary:
        stage = Path(temporary)
        for dataset, model in models.items():
            finalize_model(model)
            artifacts = split_data.build_artifacts(model)
            prefix = 'data' if dataset == 'salary_rate' else f'data/{dataset}'
            target = stage if dataset == 'salary_rate' else stage / dataset
            record_count = sum(counts[m] for m in MEASURES if MEASURES[m] == dataset)
            for record in artifacts['searchIndex']:
                record['payMissing'] = artifacts['index'][record['name']]['_payMissing']
            for entry in artifacts['index'].values():
                entry['_lastJob'] = {k: v for k, v in entry['_lastJob'].items() if k != 'Source Fields'}
            artifacts['aggregates'].update(
                peerMedianUrl=f'{prefix}/peer-medians.json',
                sourceContext={'measure': dataset, 'label': DATASETS[dataset],
                               'recordCount': record_count, 'identityBasis': 'exact printed name'})
            # Missing hire dates produce the original chart's unavailable state.
            artifacts['aggregates']['tenureMix']['points'] = []
            write_json(target / 'index.json', artifacts['index'])
            write_json(target / 'aggregates.json', artifacts['aggregates'])
            write_json(target / 'search-index.json', {'records': artifacts['searchIndex']})
            write_json(target / 'peer-medians.json', artifacts['peerMedianMap'])
            for bucket, people in artifacts['buckets'].items():
                write_json(target / 'people' / f'{bucket}.json', people)
            manifest['datasets'][dataset] = {'label': DATASETS[dataset], 'path': prefix,
                'recordCount': record_count, 'nameGroups': len(model),
                'latestClassDate': artifacts['aggregates']['latestClassDate'],
                'latestUnclassDate': artifacts['aggregates']['latestUnclassDate']}
        write_json(stage / 'import-audit.json', manifest)
        write_json(stage / 'manifest.json', {k: v for k, v in manifest.items() if k != 'reports'})
        destination = root / 'data'
        if destination.exists():
            shutil.rmtree(destination)
        shutil.copytree(stage, destination)
    archive = [{
        'title': r['title'], 'date': r['endDate'], 'year': int(r['endDate'][:4]),
        'quarter': r['sourceSeries'], 'type': r['classification'].title(),
        'author': 'UO Institutional Research', 'source': 'University of Oregon',
        'filename': r['file'].removeprefix('reports/'), 'format': 'PDF',
        'explorerImported': r['id'] in imported, 'rowCount': r.get('rowCount'),
        'pageCount': r['pageCount'], 'sha256': r['sha256'], 'id': r['id'],
    } for r in catalog['reports']]
    write_json(root / 'records.json', archive)
    print(json.dumps({k: v for k, v in manifest.items() if k != 'reports'}, indent=2))
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--require-data', action='store_true', help='Require observations (always enforced).')
    parser.parse_args()
    build()
