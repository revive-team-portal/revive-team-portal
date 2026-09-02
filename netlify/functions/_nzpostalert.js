const { rest } = require('./_appsdb');
async function runNZPostAlertCheck(){
  let url='https://www.nzpost.co.nz/tools/service-updates';
  try{ const rows=await rest('settings?select=value&key=eq.nzpost_alert_url'); if(rows&&rows[0]&&rows[0].value) url=rows[0].value; }catch(e){}
  let active=false, message='';
  try{
    const res=await fetch(url,{ headers:{ 'User-Agent':'Mozilla/5.0 (compatible; RevivePortal/1.0)' } });
    const html=await res.text();
    const text=html.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/\s+/g,' ');
    const noAlert=/no (current )?(service )?(updates|alerts|disruptions|delays)|operating normally|all services (are )?normal/i.test(text);
    const m=text.match(/[^.!?]*\b(delay|delayed|disruption|affected|unable to deliver|not delivering|weather|flooding|cyclone|cancelled|impact)[^.!?]*[.!?]/i);
    if(!noAlert && m && /(deliver|order|parcel|region|island|area|address|network)/i.test(m[0])){ active=true; message=m[0].trim().slice(0,240); }
  }catch(e){}
  try{ await rest('settings?on_conflict=key',{ method:'POST', headers:{ Prefer:'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ key:'nzpost_alert', value: JSON.stringify({ active, message, checked_at:new Date().toISOString() }) }) }); }catch(e){}
  return { active, message };
}
module.exports = { runNZPostAlertCheck };
