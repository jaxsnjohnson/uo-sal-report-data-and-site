#!/usr/bin/env python3
"""Preserve UO's official report catalog and explicitly supplied source PDFs."""
import argparse
from datetime import datetime, timezone
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import urllib.error
import urllib.request
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
INDEX_URL = 'https://data.uoregon.edu/employees/salary-reports'


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def write_json(path, value, compact=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=None if compact else 2,
                                    separators=(',', ':') if compact else None) + '\n')
    temporary.replace(path)


class CatalogParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links = []
        self.current = None

    def handle_starttag(self, tag, attrs):
        if tag == 'a':
            self.current = [dict(attrs).get('href', ''), '']

    def handle_data(self, data):
        if self.current is not None:
            self.current[1] += data

    def handle_endtag(self, tag):
        if tag == 'a' and self.current is not None:
            self.links.append(self.current)
            self.current = None


def parse_catalog(html):
    parser = CatalogParser()
    parser.feed(html)
    reports, archive_url = [], None
    for url, label in parser.links:
        if urlparse(url).hostname != 'uoregon.sharepoint.com':
            continue
        label = ' '.join(label.split())
        if 'archived reports' in label.lower():
            archive_url = url
            continue
        match = re.fullmatch(r'(Unclassified|Classified) employees with a record of employment (.+)', label)
        if not match:
            continue
        classification, period = match.groups()
        dates = re.findall(r'\d{1,2}/\d{1,2}/\d{4}', period)
        dates = [datetime.strptime(date, '%m/%d/%Y').date().isoformat() for date in dates]
        if period.startswith('on ') and len(dates) == 1:
            kind, start, end = 'census', dates[0], dates[0]
            if not end.endswith('-11-01'):
                raise ValueError(f'Unexpected census date: {end}')
        elif period.startswith('during the period ') and len(dates) == 2:
            kind, start, end = 'fiscal', *dates
            if not start.endswith('-07-01') or not end.endswith('-06-30') or int(end[:4]) != int(start[:4]) + 1:
                raise ValueError(f'Unexpected fiscal period: {period}')
        else:
            raise ValueError(f'Unrecognized report period: {period}')
        report_id = f'{end[:4]}-{kind}-{classification.lower()}'
        reports.append(dict(id=report_id, title=label, classification=classification.lower(),
                            kind=kind, startDate=start, endDate=end, sourceUrl=url,
                            status='pending', imported=False))
    if not reports or len({r['id'] for r in reports}) != len(reports):
        raise ValueError('Empty or duplicate report catalog; refusing to replace it')
    return reports, archive_url


def attach(catalog, report_id, content, retrieved_at=None):
    report = next((r for r in catalog['reports'] if r['id'] == report_id), None)
    if report is None:
        raise ValueError(f'Unknown report ID: {report_id}')
    if not content.startswith(b'%PDF-'):
        raise ValueError('Source must be a PDF, not an HTML sign-in page')
    destination = ROOT / 'reports' / f'{report_id}.pdf'
    if destination.exists() and destination.read_bytes() != content:
        raise ValueError(f'{destination.name} already exists with different bytes; preserve revisions separately')
    destination.parent.mkdir(exist_ok=True)
    if not destination.exists():
        destination.write_bytes(content)
    report.update(status='archived', file=str(destination.relative_to(ROOT)),
                  sha256=sha256(content), bytes=len(content), retrievedAt=retrieved_at or now())
    return report


def fetch(url):
    request = urllib.request.Request(url, headers={'User-Agent': 'UO-Salary-Explorer/1.0 (public report archive)'})
    with urllib.request.urlopen(request, timeout=40) as response:
        if urlparse(response.url).hostname == 'login.microsoftonline.com':
            raise ValueError('Microsoft sign-in required')
        return response.read()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    discover = commands.add_parser('discover', help='Archive the official index and catalog its links')
    discover.add_argument('--from-file', type=Path, help='Use an already downloaded official index')
    download = commands.add_parser('download', help='Attempt the listed public PDF links; never sign in')
    download.add_argument('--report', help='Download just this report ID')
    add = commands.add_parser('add', help='Archive a PDF downloaded from UO by the user')
    add.add_argument('report_id')
    add.add_argument('pdf', type=Path)
    args = parser.parse_args()
    catalog_path = ROOT / 'source-records.json'
    catalog = json.loads(catalog_path.read_text()) if catalog_path.exists() else {}
    if args.command == 'discover':
        content = args.from_file.read_bytes() if args.from_file else fetch(INDEX_URL)
        reports, archive_url = parse_catalog(content.decode('utf-8'))
        old = {r['id']: r for r in catalog.get('reports', [])}
        for report in reports:
            if report['id'] in old:
                previous = old.pop(report['id'])
                if previous['sourceUrl'] != report['sourceUrl']:
                    raise ValueError(f"Source URL changed for {report['id']}; review before replacing catalog")
                report.update(previous)
        # Preserve archived entries even when they roll off UO's current page.
        reports.extend(old.values())
        stamp = now()
        saved = ROOT / 'reports' / 'catalog' / f"{stamp.replace(':', '-')}.html"
        saved.parent.mkdir(parents=True, exist_ok=True)
        if saved.exists():
            raise ValueError('A catalog capture already exists at this timestamp')
        saved.write_bytes(content)
        catalog = dict(schemaVersion=1, indexUrl=INDEX_URL, capturedAt=stamp,
                       indexFile=str(saved.relative_to(ROOT)), indexSha256=sha256(content),
                       archiveUrl=archive_url, reports=reports)
    elif args.command == 'add':
        attach(catalog, args.report_id, args.pdf.read_bytes())
    else:
        selected = [r for r in catalog['reports'] if not args.report or r['id'] == args.report]
        if not selected:
            raise ValueError('Unknown report ID')
        for report in selected:
            if report.get('file'):
                continue
            try:
                attach(catalog, report['id'], fetch(report['sourceUrl']))
                print(f"{report['id']}: archived")
            except (urllib.error.URLError, ValueError, TimeoutError) as error:
                reason = f'HTTP {error.code}' if isinstance(error, urllib.error.HTTPError) else type(error).__name__
                report.update(status='unavailable', accessNote=reason, checkedAt=now())
                print(f"{report['id']}: unavailable ({reason})")
            write_json(catalog_path, catalog)
    write_json(catalog_path, catalog)
    print(f"Catalog: {len(catalog['reports'])} reports")


if __name__ == '__main__':
    main()
