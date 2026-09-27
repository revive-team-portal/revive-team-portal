// TEMPORARY. ?k=<runkey>&pages=30,45,60 — how far back does /api/orders/shipped page?
const { guard } = require('./_runkey');
const ES_KEY = process.env.ESHIP_API_KEY, ES_SUB = process.env.ESHIP_SUBSCRIPTION_KEY;
async function esGet(path){ const r=await fetch('https://api.starshipit.com'+path,{headers:{'StarShipIT-Api-Key':ES_KEY,'Ocp-Apim-Subscription-Key':ES_SUB}}); const t=await r.text(); return {status:r.status, body:t}; }
exports.handler=async(event)=>{
  if(!(await guard(event)).ok) return {statusCode:403,body:'nope'};
  const qp=(event&&event.queryStringParameters)||{}; const pages=(qp.pages||'1,30,45,60').split(',').map(Number);
  const out=[];
  for(const p of pages){
    const r=await esGet('/api/orders/shipped?limit=50&page='+p+(qp.since?'&since_last_updated='+encodeURIComponent(qp.since):''));
    let j={}; try{ j=JSON.parse(r.body);}catch{}
    const os=(j.orders||[]); const ds=os.map(o=>o.shipped_date).filter(Boolean).sort();
    out.push({page:p,status:r.status,count:os.length,minShipped:ds[0]||null,maxShipped:ds[ds.length-1]||null, keys: os[0]?Object.keys(os[0]).slice(0,12):null, err: os.length?undefined:r.body.slice(0,200)});
    await new Promise(r=>setTimeout(r,1100));
  }
  return {statusCode:200,headers:{'Content-Type':'application/json','Cache-Control':'no-store'},body:JSON.stringify(out,null,1)};
};
