"""Synthetic UO-layout fixtures; no invented people enter the public dataset."""
import io
import sys
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from ingest_sharepoint import identify, safe_members
from parse_reports import parse_page


def page(name='Example, Alex', title='Example title', term='9', percent='50%', amount='$60,000'):
    pairs = [('JOB TYPE', 'Primary', 'JOB STATUS', 'Active'),
             ('JOB START DATE', '1/1/2020', 'JOB END DATE', ''),
             ('HOME DEPARTMENT', 'Different home department', 'APPT STATUS', 'Fixed Term'),
             ('RANK', 'Instructor', 'RANK DATE', ''),
             ('ACADEMIC TITLE', title, 'TERM OF SVC', term),
             ('PAY DEPARTMENT', '123456 Actual pay department', 'PRIMARY ACTIVITY', 'Instructional'),
             ('ANNUAL SALARY RATE', amount, 'EEO CATEGORY', 'Faculty'),
             ('APPT PERCENT', percent, 'OA SALARY GRADE', 'n/a')]
    return ('UNCLASSIFIED PERSONNEL LIST\nUNIVERSITY OF OREGON\n' + name + '\n' +
            '\n'.join(f'{a:<24}{b:<50}{c:<20}{d}' for a, b, c, d in pairs) +
            '\nUO Office of Institutional Research\nSource: fixture only\n')


class IngestionTests(unittest.TestCase):
    def test_zip_traversal_and_duplicates_rejected(self):
        for filename in ('../outside.pdf', '/outside.pdf', 'Salary Reports/Fall/../../outside.pdf', 'Salary Reports/Fall/page.txt'):
            content = io.BytesIO()
            with zipfile.ZipFile(content, 'w') as archive:
                archive.writestr(filename, b'%PDF-test')
            with zipfile.ZipFile(content) as archive, self.assertRaises(ValueError):
                safe_members(archive)

    def test_header_dates_override_typo_in_filename(self):
        text = 'CLASSIFIED PERSONNEL LIST\nEmployees on Record for the Period: July 1, 2013 - September 30, 2013\n'
        report = identify(text, 'Salary Reports/Other/Classified 070113 to 093313.pdf')
        self.assertEqual(report['endDate'], '2013-09-30')
        self.assertEqual(report['kind'], 'historical')

    def test_fiscal_folder_does_not_imply_actual_pay(self):
        rate = 'CLASSIFIED PERSONNEL LIST\nEmployees on Record for the Period: July 1, 2014 - June 30, 2015\n'
        pay = 'CLASSIFIED PERSONNEL LIST\nEmployees with Pay July 1, 2025 through June 30, 2026\n'
        self.assertEqual(identify(rate, 'Salary Reports/FY/test.pdf')['kind'], 'historical')
        self.assertEqual(identify(pay, 'Salary Reports/FY/test.pdf')['kind'], 'fiscal')

    def test_rate_preserves_pay_and_converts_only_percentage(self):
        rows, audit = parse_page(page(), 3, 11, False)
        row = rows[0]
        self.assertEqual((row['amount'], row['fte'], row['measure']), ('$60,000', '0.5', 'academic_year_rate'))
        self.assertEqual(row['department'], 'Actual pay department')
        self.assertEqual(row['rawFields']['HOME DEPARTMENT'], 'Different home department')
        self.assertEqual((row['sourcePage'], row['sourceRow'], audit['rowCount']), (3, 11, 1))

    def test_wrapped_title_and_single_name(self):
        text = page(name='Mononym', title='Long title')
        lines = text.splitlines()
        index = next(i for i, line in enumerate(lines) if line.startswith('ACADEMIC TITLE'))
        lines.insert(index + 1, ' ' * 24 + 'continued title')
        row = parse_page('\n'.join(lines), 2, 1, False)[0][0]
        self.assertEqual(row['name'], 'Mononym')
        self.assertEqual(row['title'], 'Long title continued title')
        self.assertIn('\n', row['rawFields']['ACADEMIC TITLE'])

    def test_unknown_layout_does_not_silently_drop_text(self):
        text = page().replace('UO Office', 'Unexpected unlabelled text\nUO Office')
        with self.assertRaisesRegex(ValueError, 'unexpected line'):
            parse_page(text, 2, 1, False)

    def test_missing_term_retained_without_assuming_annual(self):
        row = parse_page(page(term=''), 2, 1, False)[0][0]
        self.assertEqual(row['measure'], 'other_term_rate')

    def test_duplicate_names_keep_distinct_source_rows(self):
        text = page().split('UO Office')[0] + page().split('UNIVERSITY OF OREGON\n')[1]
        rows, audit = parse_page(text, 4, 20, False)
        self.assertEqual([r['sourceRow'] for r in rows], [20, 21])
        self.assertEqual(audit['payFieldCount'], 2)


if __name__ == '__main__':
    unittest.main()
