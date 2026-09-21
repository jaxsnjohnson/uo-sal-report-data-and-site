"""Generate synthetic browser fixtures in a temporary directory, never public data."""
import copy
import json
import sys
from test_pipeline import PipelineTests
from build_data import build

fixture = PipelineTests()
fixture.setUp()
try:
    document = fixture.document
    document['records'] = [dict(document['records'][0], name=f'Test, Person {i:03}',
                               sourceRow=i+1, amount=str(45000+i*1000)) for i in range(60)]
    document['records'][0].update(name='Test, Zoë 李', profileKey='test-reviewed-key', amount='60000')
    document['records'][1].update(name='<script>Example</script>', amount=None)
    document['review'].update(expectedRowCount=60, identityMethod='Synthetic browser fixture only.')
    fixture.write(document)
    paths = ['normalized/test.json']
    for report_id, kind, classification, measure, start, end, amount in [
        ('2024-census-classified','census','classified','annual_rate','2024-11-01','2024-11-01','55000'),
        ('2025-census-unclassified','census','unclassified','annual_rate','2025-11-01','2025-11-01','120000'),
        ('2026-fiscal-classified','fiscal','classified','fiscal_year_pay','2025-07-01','2026-06-30','0')]:
        report=dict(fixture.report,id=report_id,kind=kind,classification=classification,startDate=start,endDate=end)
        fixture.catalog['reports'].append(report)
        other=copy.deepcopy(document)
        other.update(reportId=report_id,measure=measure)
        other['records']=[dict(document['records'][0],sourceRow=1,amount=amount)]
        other['review']['expectedRowCount']=1
        path=f'normalized/{report_id}.json';paths.append(path)
        (fixture.root/path).write_text(json.dumps(other))
    (fixture.root/'records.json').write_text(json.dumps(fixture.catalog))
    (fixture.root/'report_imports.json').write_text(json.dumps(paths))
    build(fixture.root, shard_threshold=0 if "--sharded" in sys.argv else 10000)
    artifacts={str(path.relative_to(fixture.root)):json.loads(path.read_text())
               for path in (fixture.root/'data').rglob('*.json')}
    artifacts['records.json']=json.loads((fixture.root/'records.json').read_text())
    print(json.dumps(artifacts))
finally:
    fixture.temporary.cleanup()
