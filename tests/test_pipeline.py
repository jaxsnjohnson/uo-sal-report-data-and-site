import copy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from archive_reports import parse_catalog, sha256
from build_data import build, load_observations, money


class PipelineTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / 'reports').mkdir()
        (self.root / 'normalized').mkdir()
        # Test-only bytes; never exported into the site's real reports or data.
        source = b'%PDF-1.4\nunit-test-source-only'
        (self.root / 'reports/test.pdf').write_bytes(source)
        self.report = dict(id='2025-census-classified', kind='census', classification='classified',
            startDate='2025-11-01', endDate='2025-11-01', file='reports/test.pdf',
            sha256=sha256(source), status='archived', sourceUrl='https://example.invalid/source')
        self.catalog = dict(indexUrl='https://data.uoregon.edu/employees/salary-reports',
            capturedAt='2026-09-21T00:00:00+00:00', reports=[self.report])
        self.document = dict(schemaVersion=1, reportId=self.report['id'], measure='annual_rate',
            amountDefinition='Test-only annual reported rate, not actual earnings.',
            review=dict(sourceSha256=self.report['sha256'], reviewedBy='Test fixture',
                        notes='Synthetic fixture, not University of Oregon data.', expectedRowCount=1),
            records=[dict(name='Example, Zoë', title='Test role', department='Test library',
                          amount='60,000.00', fte='0.5', sourcePage=1, sourceRow=1)])

    def write(self, document=None):
        (self.root / 'records.json').write_text(json.dumps(self.catalog))
        (self.root / 'normalized/test.json').write_text(json.dumps(document or self.document))
        (self.root / 'report_imports.json').write_text('["normalized/test.json"]')

    def test_catalog_has_all_four_groups_and_dates(self):
        catalog = json.loads((ROOT / 'records.json').read_text())
        rows, archive = parse_catalog((ROOT / catalog['indexFile']).read_text())
        self.assertEqual(len(rows), 12)
        self.assertEqual(len({r['id'] for r in rows}), 12)
        self.assertEqual({(r['kind'],r['classification']) for r in rows},
                         {('census','classified'),('census','unclassified'),('fiscal','classified'),('fiscal','unclassified')})
        self.assertTrue(archive.startswith('https://uoregon.sharepoint.com/'))
        fiscal = next(r for r in rows if r['id'] == '2026-fiscal-classified')
        self.assertEqual((fiscal['startDate'], fiscal['endDate']), ('2025-07-01','2026-06-30'))

    def test_catalog_rejects_empty_and_duplicate(self):
        with self.assertRaises(ValueError): parse_catalog('<html>No salary links</html>')
        link='<a href="https://uoregon.sharepoint.com/test">Classified employees with a record of employment on 11/01/2025</a>'
        with self.assertRaises(ValueError): parse_catalog(link+link)

    def test_preserves_reported_amount_does_not_multiply_fte(self):
        row=load_observations(self.document,self.report)[0]
        self.assertEqual(row['amount'],60000)
        self.assertEqual(row['rawAmount'],'60,000.00')
        self.assertEqual(row['fte'],.5)
        self.assertEqual(row['name'],'Example, Zoë')

    def test_hourly_rate_is_not_annualized(self):
        self.document['measure']='hourly_rate'
        self.document['records'][0]['amount']='25.75'
        self.assertEqual(load_observations(self.document,self.report)[0]['amount'],25.75)

    def test_nonpositive_rates_excluded_and_missing_not_zero(self):
        for value in ['0','-100',None,'—']:
            with self.subTest(value=value):
                self.document['records'][0]['amount']=value
                row=load_observations(self.document,self.report)[0]
                self.assertFalse(row['usable'])
                if value in (None,'—'):self.assertIsNone(row['amount'])

    def test_fiscal_pay_keeps_zero_and_adjustments(self):
        self.report['kind']='fiscal';self.document['measure']='fiscal_year_pay'
        for value,expected in [('0',0),('(50.00)',-50)]:
            self.document['records'][0]['amount']=value
            row=load_observations(self.document,self.report)[0]
            self.assertTrue(row['usable']);self.assertEqual(row['amount'],expected)

    def test_report_kind_prevents_mixed_pay_measures(self):
        self.document['measure']='fiscal_year_pay'
        with self.assertRaises(ValueError):load_observations(self.document,self.report)

    def test_duplicate_names_stay_separate(self):
        self.document['records'].append(dict(self.document['records'][0],sourceRow=2))
        self.document['review']['expectedRowCount']=2
        rows=load_observations(self.document,self.report)
        self.assertNotEqual(rows[0]['profileId'],rows[1]['profileId'])

    def test_linkage_requires_review_and_links_across_reports(self):
        self.document['records'][0]['profileKey']='opaque-test-key'
        with self.assertRaises(ValueError):load_observations(self.document,self.report)
        self.document['review']['identityMethod']='Manual test linkage based on source evidence.'
        first=load_observations(self.document,self.report)[0]
        self.report['id']='2024-census-classified';self.document['reportId']=self.report['id']
        second=load_observations(self.document,self.report)[0]
        self.assertEqual(first['profileId'],second['profileId'])

    def test_duplicate_source_rows_and_count_mismatch_fail(self):
        self.document['records'].append(dict(self.document['records'][0]))
        with self.assertRaises(ValueError):load_observations(self.document,self.report)
        self.document['review']['expectedRowCount']=2
        with self.assertRaises(ValueError):load_observations(self.document,self.report)

    def test_bad_amounts_and_page_numbers_fail(self):
        for value in ['NaN','Infinity',True,'unknown','50 per hour']:
            with self.subTest(value=value),self.assertRaises(ValueError):money(value)
        self.document['records'][0]['sourcePage']=0
        with self.assertRaises(ValueError):load_observations(self.document,self.report)

    def test_source_checksum_enforced(self):
        self.write();(self.root/'reports/test.pdf').write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError,'checksum'):build(self.root)

    def test_review_checksum_enforced(self):
        self.document['review']['sourceSha256']='wrong'
        with self.assertRaises(ValueError):load_observations(self.document,self.report)

    def test_build_is_deterministic_and_has_source_links(self):
        self.write();first=build(self.root)
        artifacts={str(p.relative_to(self.root)):p.read_bytes() for p in (self.root/'data').rglob('*.json')}
        second=build(self.root)
        self.assertEqual(first['version'],second['version'])
        self.assertEqual(artifacts,{str(p.relative_to(self.root)):p.read_bytes() for p in (self.root/'data').rglob('*.json')})
        row=first['records'][0]
        bucket=json.loads((self.root/f"data/people/{row['profileId'][0]}.json").read_text())
        self.assertEqual(bucket['people'][row['profileId']][0]['sourcePage'],1)
        aggregates=json.loads((self.root/'data/aggregates.json').read_text())
        self.assertEqual(aggregates['reports'][0]['median'],60000)

    def test_unimporting_clears_histories(self):
        self.write();build(self.root)
        (self.root/'report_imports.json').write_text('[]')
        result=build(self.root)
        self.assertEqual(result['status'],'awaiting-reports')
        self.assertEqual(result['records'],[])
        self.assertTrue(all(not json.loads(p.read_text())['people'] for p in (self.root/'data/people').glob('*.json')))
        with self.assertRaises(ValueError):build(self.root,strict=True)

    def test_paths_outside_normalized_are_rejected(self):
        self.write();(self.root/'report_imports.json').write_text('["records.json"]')
        with self.assertRaises(ValueError):build(self.root)

    def test_mixed_terms_keep_separate_measures_and_aggregates(self):
        self.document.update(schemaVersion=2, measure='mixed', measures=['academic_year_rate', 'annual_rate'],
                             amountDefinitions={'annual_rate': 'Twelve-month test rate', 'academic_year_rate': 'Nine-month test rate'})
        self.document['records'][0]['measure']='annual_rate'
        self.document['records'].append(dict(self.document['records'][0], sourceRow=2, measure='academic_year_rate', amount='45000'))
        self.document['review']['expectedRowCount']=2
        self.write(); result=build(self.root)
        self.assertEqual({r['measure'] for r in result['records']},{'annual_rate','academic_year_rate'})
        aggregates=json.loads((self.root/'data/aggregates.json').read_text())
        self.assertEqual({r['measure']:r['median'] for r in aggregates['reports']}, {'annual_rate':60000,'academic_year_rate':45000})

    def test_shards_have_versions_source_links_and_stale_cleanup(self):
        self.write(); result=build(self.root, shard_threshold=0)
        self.assertTrue(result['sharded']);self.assertEqual(result['records'],[])
        self.assertEqual(result['recordCount'],1)
        report=result['reports'][0]
        part=json.loads((self.root/report['dataFile']).read_text())
        self.assertEqual(part['version'],result['version'])
        row=part['records'][0]
        history=self.root/f"data/people/{row['profileId'][:2]}.json"
        self.assertEqual(json.loads(history.read_text())['people'][row['profileId']][0]['sourcePage'],1)
        (self.root/'report_imports.json').write_text('[]')
        build(self.root)
        self.assertFalse(history.exists())
        self.assertFalse((self.root/report['dataFile']).exists())


if __name__=='__main__':unittest.main()
