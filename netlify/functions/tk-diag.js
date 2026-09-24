// TEMPORARY. ?k=<runkey>&we=YYYY-MM-DD — dump TK entry fields + per-metric totals by
// different duration fields, to explain the portal-vs-TK hours gap.
const { guard } = require('./_runkey');
const APPS_URL='https://xcwrawjdfajlmbkdwlbm.supabase.co'; const APPS_KEY=process.env.APPS_SERVICE_ROLE_KEY;
const TK_KEY=process.env.TIMEKEEPER_API_KEY; const TK='https://api.timekeeper.co.uk/api/tk/v1/time-entries';
function tkAuth(){return 'Basic '+Buffer.from(':'+(TK_KEY||'')).toString('base64');}
function addDays(y,n){const d=new Date(y+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);}
function nzDate(iso){return new Intl.DateTimeFormat('en-CA',{timeZone:'Pacific/Auckland',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(iso));}
async function appsDb(p){const r=await fetch(APPS_URL+'/rest/v1/'+p,{headers:{apikey:APPS_KEY,Authorization:'Bearer '+APPS_KEY,'Accept-Profile':'scoreboard'}});return r.ok?r.json():[];}
exports.handler=async(event)=>{
  if(!(await guard(event)).ok) return {statusCode:403,body:'nope'};
  const qp=(event&&event.queryStringParameters)||{}; const F=qp.we||'2026-09-18'; const start=addDays(F,-6);
  const maps=await appsDb('tk_job_map?select=job_id,metric_code,active');
  const jm={}; (maps||[]).forEach(m=>{if(m.active&&m.metric_code)jm[m.job_id]=m.metric_code;});
  let page=1,total=1,all=[];
  do{ const res=await fetch(`${TK}?start_date=${start}&end_date=${F}&page=${page}`,{headers:{Authorization:tkAuth(),Accept:'application/json'}});
      if(!res.ok) return {statusCode:200,body:'TK '+res.status+': '+(await res.text()).slice(0,200)};
      const box=(await res.json()).time_entries||{}; total=box.total_pages||1; all=all.concat(box.time_entries||[]); page++; }while(page<=total);
  const fields=all.length?Object.keys(all[0]):[];
  const durFields=fields.filter(f=>/dur|hour|break|worked|paid|net|minute/i.test(f));
  const tot={}; // metric -> {field: sum}
  for(const e of all){ const mc=jm[e.job_id]; if(!mc) continue; const nz=nzDate(e.start_time); if(nz<start||nz>F) continue;
    tot[mc]=tot[mc]||{}; durFields.forEach(df=>{ tot[mc][df]=(tot[mc][df]||0)+(Number(e[df])||0); }); }
  const sample=all.find(e=>jm[e.job_id]==='hours_foh_cafe')||all[0];
  return {statusCode:200,headers:{'Content-Type':'application/json','Cache-Control':'no-store'},
    body:JSON.stringify({week:F,entries:all.length,durFields,foh:tot['hours_foh_cafe'],kitchen_prep:tot['hours_kitchen_prep'],sample},null,1)};
};
