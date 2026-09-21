import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from package_site import FILES, package


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / 'source'
        self.output = Path(self.temporary.name) / 'public'
        self.root.mkdir()
        for name in FILES:
            (self.root / name).write_text('Public test asset')
        (self.root / 'data').mkdir()
        (self.root / 'data/index.json').write_text(json.dumps(dict(
            status='ready', recordCount=1, version='test', reports=[])))

    def test_excludes_source_zip_normalized_text_and_secrets(self):
        for name in ('OneDrive_test.zip', '.env', 'normalized/report.json',
                     'reports/text/report.txt', 'scripts/test.py'):
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('Local-only fixture')
        result = package(self.root, self.output)
        self.assertEqual(result['recordCount'], 1)
        self.assertTrue((self.output / 'index.html').exists())
        self.assertFalse((self.output / '.env').exists())
        self.assertFalse((self.output / 'OneDrive_test.zip').exists())
        self.assertFalse((self.output / 'reports/text').exists())
        self.assertFalse((self.output / 'normalized').exists())
        self.assertFalse((self.output / 'scripts').exists())

    def test_missing_source_pdf_prevents_release(self):
        data = json.loads((self.root / 'data/index.json').read_text())
        data['reports'] = [dict(file='reports/missing.pdf')]
        (self.root / 'data/index.json').write_text(json.dumps(data))
        with self.assertRaisesRegex(ValueError, 'Missing published report asset'):
            package(self.root, self.output)
        self.assertFalse(self.output.exists())

    def test_existing_output_and_symlinks_are_rejected(self):
        self.output.mkdir()
        (self.output / 'keep.txt').write_text('Preserve')
        with self.assertRaisesRegex(ValueError, 'must be empty'):
            package(self.root, self.output)
        self.assertEqual((self.output / 'keep.txt').read_text(), 'Preserve')
        (self.root / 'data/link.json').symlink_to(self.root / 'records.json')
        with self.assertRaisesRegex(ValueError, 'Missing or linked'):
            package(self.root, self.output.parent / 'another-output')
