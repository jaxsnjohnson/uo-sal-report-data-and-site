import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

from scripts.archive_salary_reports import SalaryTableParser, archive_report


HEADERS = ["Name", "Home Org", "Date of First Hire", "Annual Salary Rate", "Appointment Percentage"]


def page(rows, next_page=None, last_page=None):
    headings = ''.join(f'<th>{h}</th>' for h in HEADERS)
    body = ''.join('<tr>' + ''.join(f'<td>{value}</td>' for value in row) + '</tr>' for row in rows)
    links = ''
    if next_page is not None:
        links += f'<a rel="next" href="?items_per_page=200&amp;page={next_page}">Next</a>'
    if last_page is not None:
        links += f'<a title="Go to last page" href="?items_per_page=200&amp;page={last_page}">Last</a>'
    return f'<table class="views-view-bootstrap-table"><tr>{headings}</tr>{body}</table>{links}'


class SalaryArchiveTests(unittest.TestCase):
    def test_preserves_source_units_names_and_entities(self):
        parser = SalaryTableParser()
        parser.feed(page([["Given Surname", "Research &amp; Teaching", "09/01/2026", "22.83", "100"]]))
        parser.validate()
        self.assertEqual(parser.rows[0], ["Given Surname", "Research & Teaching", "09/01/2026", "22.83", "100"])

    def test_rejects_malformed_rows(self):
        parser = SalaryTableParser()
        parser.feed(page([["Only a name"]]))
        with self.assertRaisesRegex(ValueError, "header width"):
            parser.validate()

    def fake_download(self, content_by_page):
        def download(url, destination):
            if 'salary-report-view?' in url:
                number = int(parse_qs(urlsplit(url).query)['page'][0])
                content = content_by_page[number]
            else:
                content = '<html>Source description</html>'
            raw = content.encode()
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(raw)
            return content, {'url': url, 'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw)}
        return download

    def test_archives_every_page_and_refuses_overwrite(self):
        first = [[f'Person {i}', 'Org', '09/01/2026', '22.83', '100'] for i in range(200)]
        last = [['Final Person', 'Org', '09/01/2026', '100,000.00', '50']]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch('scripts.archive_salary_reports.download', self.fake_download({0: page(first, 1, 1), 1: page(last)})):
                manifest = archive_report('classified', '2026-09-18', root)
                self.assertEqual(manifest['row_count'], 201)
                self.assertEqual(manifest['page_count'], 2)
                self.assertEqual(manifest['annual_salary_values_between_zero_and_1000'], 200)
                target = root / '2026-09-18-classified'
                saved = json.loads((target / 'data.json').read_text())
                self.assertEqual(saved['records'][-1]['fields']['Name'], 'Final Person')
                self.assertEqual(saved['records'][-1]['source_page'], 'pages/page-002.html')
                for record in manifest['pages'] + manifest['context_pages'] + manifest['derived_files']:
                    self.assertEqual(hashlib.sha256((target / record['file']).read_bytes()).hexdigest(), record['sha256'])
                with self.assertRaises(FileExistsError):
                    archive_report('classified', '2026-09-18', root)

    def test_rejects_incomplete_capture_without_leaving_archive(self):
        rows = [['Name', 'Org', '', '10000', '100']]
        with tempfile.TemporaryDirectory() as directory:
            with patch('scripts.archive_salary_reports.download', self.fake_download({0: page(rows, last_page=1)})):
                with self.assertRaisesRegex(ValueError, 'advertised last page'):
                    archive_report('classified', '2026-09-18', Path(directory))
            self.assertEqual(list(Path(directory).iterdir()), [])


if __name__ == '__main__':
    unittest.main()
