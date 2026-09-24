// TEMPORARY. ?k=<runkey>&we=YYYY-MM-DD&mc=hours_foh_cafe — list entries for a metric.
const { guard } = require('./_runkey');
const APPS_URL='https://xcwrawjdfajlmbkdwlbm.supabase.co'; const APPS_KEY=process.env.APPS_SERVICE_ROLE_KEY;
const TK_KEY=process.env.TIMEKEEPER_API_KEY; const TK='https://api.timekeeper.co.uk/api/tk/v1/time-entries';
function tkAuth(){return 'Basic '+Buffer.from(':'+(TK_KEY||'')).toString('base64');}
function addDays(y,n){const d=new Date(y+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);}
function nzDate(iso){return new Intl.DateTimeFormat('en-CA',{timeZone:'Pacific/Auckland',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(iso));}
async function appsDb(p){const r=await fetch(APPS_URL+'/rest/v1/'+p,{headers:{apikey:APPS_KEY,Authorization:'Bearer '+APPS_KEY,'Accept-Profile':'scoreboard'}});return r.ok?r.json():[];}
exports.handler=async(event)=>{
  if(!(await guard(event)).ok) return {statusCode:403,body:'nope'};
  const qp=(event&&event.queryStringParameters)||{}; const F=qp.we||'2026-09-18'; const start=addDays(F,-6); const MC=qp.mc||'hours_foh_cafe';
  const maps=await appsDb('tk_job_map?select=job_id,metric_code,active');
  const jm={}; const jobsFor=[]; (maps||[]).forEach(m=>{if(m.active&&m.metric_code){jm[m.job_id]=m.metric_code; if(m.metric_code===MC)jobsFor.push(m.job_id);}});
  let page=1,total=1,all=[];
  do{ const res=await fetch(`${TK}?start_date=${start}&end_date=${F}&page=${page}`,{headers:{Authorization:tkAuth(),Accept:'application/json'}});
      const box=(await res.json()).time_entries||{}; total=box.total_pages||1; all=all.concat(box.time_entries||[]); page++; }while(page<=total);
  const rows=all.filter(e=>jm[e.job_id]===MC && nzDate(e.start_time)>=start && nzDate(e.start_time)<=F)
    .map(e=>({d:nzDate(e.start_time),emp:e.employee_id,job:e.job_id,raw:e.duration_in_hours_raw,label:e.duration_in_hours}))
    .sort((a,b)=>a.d.localeCompare(b.d));
  const byDay={}; rows.forEach(r=>byDay[r.d]=(byDay[r.d]||0)+Number(r.raw||0));
  const byEmp={}; rows.forEach(r=>byEmp[r.emp]=(byEmp[r.emp]||0)+Number(r.raw||0));
  const totalRaw=rows.reduce((a,r)=>a+Number(r.raw||0),0);
  return {statusCode:200,headers:{'Content-Type':'application/json','Cache-Control':'no-store'},
    body:JSON.stringify({metric:MC,week:F,jobs:jobsFor,count:rows.length,totalRaw:Math.round(totalRaw*100)/100,byDay,byEmp,rows},null,1)};
};
