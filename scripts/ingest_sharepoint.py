#!/usr/bin/env python3
"""Preserve a user-downloaded UO SharePoint ZIP and catalog PDF header dates.

Requires Poppler's pdftotext and pdfinfo. Originals are never overwritten.
The ZIP is retained at its supplied path; no SharePoint authentication is used.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import json
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import zipfile

from archive_reports import ROOT, now, sha256, write_json

DATE = r'(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}'


def preserve(path, content):
    if path.exists():
        if path.read_bytes() != content:
            raise ValueError(f'Refusing to overwrite different bytes: {path}')
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)


def safe_members(archive):
    members, seen = [], set()
    for info in archive.infolist():
        path = PurePosixPath(info.filename)
        if (path.is_absolute() or '..' in path.parts or '\\' in info.filename
                or stat.S_ISLNK(info.external_attr >> 16)):
            raise ValueError(f'Unsafe ZIP member: {info.filename}')
        if info.is_dir():
            continue
        if path in seen or path.suffix.lower() != '.pdf':
            raise ValueError(f'Duplicate or unexpected ZIP member: {info.filename}')
        if len(path.parts) != 3 or path.parts[0] != 'Salary Reports' or path.parts[1] not in ('Fall', 'FY', 'Other'):
            raise ValueError(f'Unexpected SharePoint folder: {info.filename}')
        seen.add(path)
        members.append(info)
    if not members or sum(i.file_size for i in members) > 2_000_000_000:
        raise ValueError('Empty or unexpectedly large archive')
    return members


def identify(text, member):
    heading = re.search(r'^Employees (?:on Record|with Pay)[^\n]+', text, re.M)
    if not heading:
        raise ValueError(f'No report-period heading: {member}')
    dates = [datetime.strptime(' '.join(d.split()), '%B %d, %Y').date().isoformat()
             for d in re.findall(DATE, heading[0])]
    if len(dates) not in (1, 2):
        raise ValueError(f'Ambiguous report dates: {heading[0]}')
    # A second date in the OA-grade revision note is not a salary observation date.
    start, end = dates[0], dates[-1]
    classification = 'unclassified' if text.lstrip().startswith('UNCLASSIFIED') else 'classified'
    if not text.lstrip().startswith(('UNCLASSIFIED PERSONNEL LIST', 'CLASSIFIED PERSONNEL LIST')):
        raise ValueError(f'Unknown report title: {member}')
    series = PurePosixPath(member).parts[1]
    actual = 'Employees with Pay' in heading[0]
    if series == 'Fall':
        kind, report_id = 'census', f'{end[:4]}-census-{classification}'
    elif series == 'FY':
        kind, report_id = ('fiscal' if actual else 'historical'), f'{end[:4]}-fiscal-{classification}'
    else:
        kind, report_id = 'historical', f'{end}-personnel-{classification}'
    return dict(id=report_id, title=heading[0] + f' ({classification})', classification=classification,
                kind=kind, sourceSeries=series, startDate=start, endDate=end,
                periodHeading=heading[0], payBasis='actual_pay' if actual else 'salary_rate')


def ingest(zip_path, root=ROOT):
    manifest_path = root / 'reports/sharepoint-manifest.json'
    old_manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else None
    digest = sha256(zip_path.read_bytes())
    if old_manifest and old_manifest['archive']['sha256'] != digest:
        raise ValueError('A different ZIP was already ingested; preserve revisions separately')
    stamp = old_manifest['ingestedAt'] if old_manifest else now()
    catalog_path = root / 'source-records.json'
    catalog = json.loads(catalog_path.read_text())
    entries = []
    with zipfile.ZipFile(zip_path) as archive:
        members = safe_members(archive)
        # Validate every member/CRC before any extraction or catalog mutation.
        for info in members:
            if not archive.read(info).startswith(b'%PDF-'):
                raise ValueError(f'Not PDF bytes: {info.filename}')
        for info in members:
            content = archive.read(info)
            destination = root / 'reports/sharepoint' / info.filename
            preserve(destination, content)
            entries.append(dict(archiveMember=info.filename, file=destination.relative_to(root).as_posix(),
                                sha256=sha256(content), bytes=len(content)))

    def extract(entry):
        path = root / entry['file']
        text = subprocess.check_output(['pdftotext', '-layout', str(path), '-']).decode('utf-8')
        info = subprocess.check_output(['pdfinfo', str(path)]).decode('utf-8')
        pages = int(re.search(r'^Pages:\s+(\d+)', info, re.M)[1])
        if text.count('\f') != pages:
            raise ValueError(f'Extracted page count mismatch: {path}')
        report = identify(text, entry['archiveMember'])
        text_path = root / 'reports/text' / (report['id'] + '.txt')
        preserve(text_path, text.encode())
        entry.update(reportId=report['id'], pageCount=pages,
                     textFile=text_path.relative_to(root).as_posix(), textSha256=sha256(text.encode()))
        return report, entry

    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(extract, entries))
    reports = {r['id']: r for r in catalog['reports']}
    seen = set()
    for report, entry in results:
        rid = report['id']
        if rid in seen:
            raise ValueError(f'Duplicate report identity: {rid}')
        seen.add(rid)
        previous = reports.get(rid, {})
        if previous.get('sha256') and previous['sha256'] != entry['sha256']:
            raise ValueError(f'Different PDF already attached to {rid}')
        if previous and (previous['startDate'], previous['endDate']) != (report['startDate'], report['endDate']):
            raise ValueError(f'Catalog and PDF dates disagree: {rid}')
        reports[rid] = dict(previous, **report)
        reports[rid].update({k: v for k, v in entry.items() if k != 'reportId'})
        reports[rid].update(status='archived', imported=previous.get('imported', False), retrievedAt=stamp,
                           sourceUrl=previous.get('sourceUrl', catalog['archiveUrl']),
                           sourceProvenance='User-supplied SharePoint ZIP linked from the UO salary reports website')
        reports[rid].pop('error', None)
    manifest = dict(schemaVersion=1, ingestedAt=stamp,
                    archive=dict(filename=zip_path.name, sha256=digest, bytes=zip_path.stat().st_size),
                    sourceIndex=catalog['indexUrl'], sourceArchive=catalog['archiveUrl'],
                    provenance='User reports downloading this ZIP from the SharePoint link on the UO website.',
                    memberCount=len(entries), members=entries)
    write_json(manifest_path, manifest)
    catalog['reports'] = sorted(reports.values(), key=lambda r: r['id'])
    catalog['sharepointManifest'] = 'reports/sharepoint-manifest.json'
    write_json(catalog_path, catalog)
    print(f'Preserved {len(entries)} original PDFs and {sum(e["pageCount"] for e in entries):,} text pages.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('zip', type=Path)
    ingest(parser.parse_args().zip.resolve())
