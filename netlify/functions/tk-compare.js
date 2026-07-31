// READ-ONLY comparison: TimeKeeper actuals vs the stored (spreadsheet) hours for
// historical weeks. Writes nothing. Guarded. ?k=..&offset=N&weeks=M
const { runSync } = require('./_tksync'); // reuse env/consts indirectly? no—self-contained below
const APPS_URL = 'https://xcwrawjdfajlmbkdwlbm.supabase.co';
const APPS_KEY = process.env.APPS_SERVICE_ROLE_KEY;
const TK_KEY   = process.env.TIMEKEEPER_API_KEY;
const TK = 'https://api.timekeeper.co.uk/api/tk/v1/time-entries';
const GUARD = 'rvp-tk-7Kq3';
async function db(path){ const r=await fetch(APPS_URL+'/rest/v1/'+path,{headers:{apikey:APPS_KEY,Authorization:'Bearer '+APPS_KEY,'Accept-Profile':'scoreboard'}}); const t=await r.text(); if(!r.ok) throw new Error('DB '+r.status+' '+t.slice(0,120)); return t?JSON.parse(t):null; }
function auth(){ return 'Basic '+Buffer.from(':'+(TK_KEY||'')).toString('base64'); }
function addDays(ymd,n){ const d=new Date(ymd+'T00:00:00Z'); d.setUTCDate(d.getUTCDate()+n); return d.toISOString().slice(0,10); }
function nzDate(iso){ return new Intl.DateTimeFormat('en-CA',{timeZone:'Pacific/Auckland',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(iso)); }
async function weekEntries(start,end){ let p=1,tot=1,all=[]; do { const r=await fetch(`${TK}?start_date=${start}&end_date=${end}&page=${p}`,{headers:{Authorization:auth(),Accept:'application/json'}}); if(!r.ok) throw new Error('TK '+r.status); const b=(await r.json()).time_entries||{}; tot=b.total_pages||1; all=all.concat(b.time_entries||[]); p++; } while(p<=tot); return all; }
exports.handler = async (event) => {
  const qp=(event&&event.queryStringParameters)||{};
  if(qp.k!==GUARD) return {statusCode:403,body:'nope'};
  if(!APPS_KEY||!TK_KEY) return {statusCode:500,body:'missing keys'};
  const offset=Math.max(parseInt(qp.offset||6,10)||6,0);
  const count=Math.min(Math.max(parseInt(qp.weeks||6,10)||6,1),8);
  try{
    const maps=await db('tk_job_map?select=job_id,metric_code,active');
    const jm={}; maps.forEach(m=>{ if(m.active&&m.metric_code) jm[m.job_id]=m.metric_code; });
    const allWeeks=await db('week?select=period_end&order=period_end.desc&limit='+(offset+count));
    const target=allWeeks.slice(offset, offset+count).map(w=>w.period_end);
    const fetched=await Promise.all(target.map(async F=>{ const start=addDays(F,-6); try{ return {F,start,entries:await weekEntries(start,F)}; }catch(e){ return {F,start,error:String(e.message||e)}; } }));
    const CORE=['hours_kitchen_prep','hours_kitchen_ingred','hours_kitchen_sweets','hours_muesli','hours_fulfilment','hours_foh_cafe','hours_nut_butter','hours_heat_eat'];
    const out=[];
    for(const w of fetched){
      if(w.error){ out.push({week:w.F,error:w.error}); continue; }
      const tk={}; for(const e of w.entries){ const mc=jm[e.job_id]; if(!mc)continue; const nz=nzDate(e.start_time); if(nz<w.start||nz>w.F)continue; tk[mc]=(tk[mc]||0)+(Number(e.duration_in_hours_raw)||0); }
      const dbrows=await db(`fact?select=metric_code,value,source&period_type=eq.week&period_end=eq.${w.F}&metric_code=in.(${CORE.join(',')})`);
      const dbv={},src={}; (dbrows||[]).forEach(r=>{ dbv[r.metric_code]=r.value==null?null:Number(r.value); src[r.metric_code]=r.source; });
      const per={}; let tkTot=0, dbTot=0;
      CORE.forEach(c=>{ const t=Math.round((tk[c]||0)*10)/10; const dd=dbv[c]==null?null:Math.round(dbv[c]*10)/10; per[c]={tk:t,db:dd}; tkTot+=t; if(dd!=null)dbTot+=dd; });
      out.push({week:w.F, source:(src[CORE[0]]||Object.values(src)[0]||'?'), tkTotal:Math.round(tkTot*10)/10, dbTotal:Math.round(dbTot*10)/10, diff:Math.round((dbTot-tkTot)*10)/10, per});
    }
    return {statusCode:200,headers:{'Content-Type':'application/json'},body:JSON.stringify(out,null,1)};
  }catch(e){ return {statusCode:500,body:String(e.message||e)}; }
};
