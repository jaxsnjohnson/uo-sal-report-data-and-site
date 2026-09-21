#!/usr/bin/env python3
"""Package only public website assets for GitHub Pages, retaining source PDFs."""
import argparse
import json
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]
FILES = ('index.html', 'records.html', 'methodology.html', 'records.json',
         '.nojekyll', 'LICENSE', 'ATTRIBUTION.md')
DIRECTORIES = ('css', 'icons', 'js', 'data', 'reports/catalog', 'reports/sharepoint')


def package(root, destination):
    root, destination = root.resolve(), destination.resolve()
    if destination == root or root.is_relative_to(destination):
        raise ValueError('Output must not replace the source checkout or its parent')
    if destination.exists() and any(destination.iterdir()):
        raise ValueError('Output directory must be empty; refusing to overwrite files')
    data = json.loads((root / 'data/index.json').read_text())
    if data.get('status') != 'ready' or data.get('recordCount', len(data.get('records', []))) < 1:
        raise ValueError('Cannot publish an empty salary dataset')
    files = [root / name for name in FILES]
    files.extend(root / name for name in ('CNAME', 'reports/sharepoint-manifest.json') if (root / name).is_file())
    for name in DIRECTORIES:
        directory = root / name
        if directory.is_symlink():
            raise ValueError(f'Symlink cannot be published: {directory}')
        if directory.is_dir():
            files.extend(path for path in directory.rglob('*') if path.is_file() or path.is_symlink())
    for path in files:
        if path.is_symlink() or not path.is_file():
            raise ValueError(f'Missing or linked public asset: {path}')
    total = sum(path.stat().st_size for path in files)
    if total >= 1_000_000_000:
        raise ValueError(f'Public package exceeds the 1 GB Pages limit: {total:,} bytes')
    relative = {path.relative_to(root).as_posix() for path in files}
    for report in data['reports']:
        for key in ('file', 'dataFile'):
            if report.get(key) and report[key] not in relative:
                raise ValueError(f'Missing published report asset: {report[key]}')
    for path in files:
        target = destination / path.relative_to(root)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)
    result = dict(files=len(files), bytes=total, version=data['version'],
                  recordCount=data.get('recordCount', len(data.get('records', []))))
    print(json.dumps(result, indent=2))
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    package(ROOT, parser.parse_args().output)
