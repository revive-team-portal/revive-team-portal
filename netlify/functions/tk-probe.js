// TEMPORARY. ?k=<runkey> — probe TimeKeeper for break/net-hours data.
const { guard } = require('./_runkey');
const TK_KEY=process.env.TIMEKEEPER_API_KEY; const BASE='https://api.timekeeper.co.uk/api/tk/v1';
function tkAuth(){return 'Basic '+Buffer.from(':'+(TK_KEY||'')).toString('base64');}
async function tryGet(path){ try{ const r=await fetch(BASE+path,{headers:{Authorization:tkAuth(),Accept:'application/json'}}); const t=await r.text(); return {path,status:r.status,body:t.slice(0,600)}; }catch(e){return {path,err:String(e.message||e)};} }
exports.handler=async(event)=>{
  if(!(await guard(event)).ok) return {statusCode:403,body:'nope'};
  const s='2026-09-12',e='2026-09-18';
  const out=[];
  out.push(await tryGet(`/time-entries?start_date=${s}&end_date=${e}&include=breaks&page=1`));
  out.push(await tryGet(`/timesheets?start_date=${s}&end_date=${e}`));
  out.push(await tryGet(`/breaks?start_date=${s}&end_date=${e}`));
  out.push(await tryGet(`/shifts?start_date=${s}&end_date=${e}`));
  out.push(await tryGet(`/reports/hours?start_date=${s}&end_date=${e}`));
  return {statusCode:200,headers:{'Content-Type':'application/json','Cache-Control':'no-store'},body:JSON.stringify(out,null,1)};
};
