import copy
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.build_data import job_from_row, add_report, finalize_model
import split_data

REPORT = {'id': 'example-classified', 'classification': 'classified', 'endDate': '2025-11-01',
          'startDate': '2025-11-01', 'file': 'reports/sharepoint/Example report.pdf'}


def row(measure='annual_rate', amount='$60,000', percent='50%', term='12'):
    return dict(name='Example, Alex', title='Researcher', department='Pay Department', amount=amount,
                measure=measure, termOfService=term, appointmentPercent=percent, sourceRow=1,
                sourcePage=3, rawFields={'HOME DEPARTMENT':'Different Home Department', 'JOB TYPE':'Primary',
                                        'ANNUAL SALARY RATE':amount})


class UONormalizationTests(unittest.TestCase):
    def test_nine_month_rate_uses_osu_fte_math_without_twelve_month_conversion(self):
        record = row('academic_year_rate', term='9')
        job = job_from_row(record, REPORT)
        self.assertEqual(job['Annual Salary Rate'], 60000)
        self.assertEqual(job['Salary Term'], '9 mo')
        self.assertEqual(job['Appt Percent'], 50)
        self.assertEqual(split_data.calculate_snapshot_pay({'Jobs':[job]}), 30000)
        self.assertEqual(job['Job Orgn'], 'Pay Department')
        self.assertEqual(job['Home Orgn'], 'Different Home Department')
        self.assertEqual(job['Source Url'], 'reports/sharepoint/Example%20report.pdf#page=3')

    def test_actual_pay_is_not_annualized_and_negative_adjustment_survives(self):
        first=job_from_row(row('fiscal_year_pay', '$40,000', None), REPORT)
        correction=job_from_row(row('fiscal_year_pay', '-$3,394', None), REPORT)
        self.assertIsNone(first['Appt Percent'])
        self.assertEqual(first['Annual Salary Rate'], '')
        self.assertEqual(split_data.calculate_snapshot_pay({'PayMeasure':'fiscal_year_pay','Jobs':[first,correction]}),36606)

    def test_multiple_appointments_sum_but_duplicate_blocks_are_retained_and_flagged(self):
        a=row();b=row(amount='$80,000');b['sourceRow']=2
        model={};add_report(model,{'records':[a,b]},REPORT,'salary_rate')
        self.assertEqual(split_data.calculate_snapshot_pay(model[a['name']]['Timeline'][0]),70000)
        b=copy.deepcopy(a);b['sourceRow']=2
        model={};add_report(model,{'records':[a,b]},REPORT,'salary_rate')
        jobs=model[a['name']]['Timeline'][0]['Jobs']
        self.assertEqual(len(jobs),2)
        self.assertTrue(all(j.get('Pay Review Reason') for j in jobs))
        self.assertEqual(split_data.calculate_snapshot_pay({'Jobs':jobs}),0)

    def test_simultaneous_classifications_are_not_overwritten_and_hire_is_not_invented(self):
        model={};doc={'records':[row()]}
        add_report(model,doc,REPORT,'salary_rate')
        other={**REPORT,'id':'example-unclassified','classification':'unclassified'}
        add_report(model,doc,other,'salary_rate');finalize_model(model)
        self.assertEqual(len(model),2)
        for person in model.values():
            self.assertEqual(len(person['Timeline']),1)
            self.assertEqual(person['Meta']['First Hired'],'')
        artifacts=split_data.build_artifacts(model)
        self.assertEqual(len(artifacts['index']),2)
        self.assertTrue(all(not p['_colaChecked'] for p in artifacts['index'].values()))

    def test_generated_artifact_contract_and_source_row_coverage(self):
        manifest=json.loads((ROOT/'data/manifest.json').read_text())
        self.assertEqual(manifest['reportCount'],93)
        self.assertEqual(manifest['recordCount'],353333)
        total=0
        for dataset, details in manifest['datasets'].items():
            directory=ROOT/details['path']
            index=json.loads((directory/'index.json').read_text())
            search=json.loads((directory/'search-index.json').read_text())['records']
            aggregates=json.loads((directory/'aggregates.json').read_text())
            self.assertEqual(set(index),{r['name'] for r in search})
            self.assertTrue(all(r['payMissing'] == index[r['name']]['_payMissing'] for r in search))
            self.assertTrue((ROOT/aggregates['peerMedianUrl']).is_file())
            self.assertEqual(aggregates['tenureMix']['points'],[])
            count=0;seen=set()
            for file in (directory/'people').glob('*.json'):
                people=json.loads(file.read_text())
                for name,person in people.items():
                    self.assertIn(name,index)
                    for snap in person['Timeline']:
                        self.assertEqual(snap['PayMeasure'],dataset)
                        for job in snap['Jobs']:
                            key=(snap['ReportId'],job['Source Row'])
                            self.assertNotIn(key,seen);seen.add(key)
                            self.assertTrue(job['Source Fields'])
                            count+=1
                    self.assertAlmostEqual(index[name]['_totalPay'],split_data.calculate_snapshot_pay(person['Timeline'][-1]))
            self.assertEqual(count,details['recordCount']);total+=count
        self.assertEqual(total,353333)


if __name__=='__main__': unittest.main()
