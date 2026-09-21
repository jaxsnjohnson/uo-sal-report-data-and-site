// Synthetic records for visual comparisons only. Never written to public data/.
const date='2025-11-01';
const roles=['Professor','Analyst','Research Assistant','Librarian','Specialist'];
const departments=['College of Science','Information Services','Research Office','University Libraries','Facilities Services'];
const rows=[];
for(let group=0;group<5;group++)for(let j=0;j<5-group;j++){
  const i=rows.length,classification=i%2?'unclassified':'classified';
  rows.push({id:`visual-${i}`,profileId:`a${String(i).padStart(23,'0')}`,name:`Example, Person ${String(i+1).padStart(2,'0')}`,
    title:roles[group],department:departments[group],classification,reportId:`2025-census-${classification}`,
    date,startDate:date,kind:'census',measure:'annual_rate',amount:50000+i*2500,usable:true,fte:1,
    sourcePage:1,sourceRow:i+1,identityBasis:'Reviewed linkage'});
}
const reports=['classified','unclassified'].map(classification=>({id:`2025-census-${classification}`,classification,kind:'census',
  startDate:date,endDate:date,imported:true,measure:'annual_rate',file:`reports/2025-census-${classification}.pdf`}));
const uo={schemaVersion:1,version:'visual-only',status:'ready',capturedAt:'2026-09-21T00:00:00Z',reports,
  measures:{annual_rate:{label:'Reported annual rate',unit:'USD / year',kind:'census'},fiscal_year_pay:{label:'Fiscal-year actual pay',unit:'USD / fiscal year',kind:'fiscal'}},records:rows};
const osu=Object.fromEntries(rows.map(row=>[row.name,{Meta:{'Home Orgn':row.department},_hasTimeline:true,_lastDate:date,
  _lastJob:{'Job Orgn':row.department,'Job Title':row.title,'Annual Salary Rate':String(row.amount),'Appt Percent':'100','Job Type':'P'},
  _totalPay:row.amount,_payMissing:false,_isUnclass:row.classification==='unclassified',_isFullTime:true,
  _roleStr:row.title.toLowerCase(),_searchStr:`${row.name} ${row.department} ${row.title}`.toLowerCase(),
  _colaReceived:true,_colaChecked:0,_colaMissedLabels:[],_colaMissing:false,_wasExcluded:false} ]));
module.exports={uo,osu,uoAggregates:{version:'visual-only',reports:[]},osuAggregates:{latestClassDate:date,latestUnclassDate:date,snapshotDates:[date],allRoles:roles}};
