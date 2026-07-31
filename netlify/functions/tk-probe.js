// TEMPORARY manual probe — delete after discovery. Guarded.
const TK_KEY = process.env.TIMEKEEPER_API_KEY;
const H = 'https://api.timekeeper.co.uk';
const GUARD = 'rvp-tk-7Kq3';
function auth(){ return 'Basic ' + Buffer.from(':' + (TK_KEY||'')).toString('base64'); }
exports.handler = async (event) => {
  if ((event.queryStringParameters||{}).k !== GUARD) return { statusCode: 403, body: 'nope' };
  const urls = [ '/api/tk/v1/jobs?page=1', '/api/tk/v1/jobs?page=2' ];
  const out=[];
  for (const u of urls) {
    try {
      const r = await fetch(H+u, { headers: { Authorization: auth(), Accept:'application/json' } });
      const t = await r.text();
      out.push({ u, status: r.status, body: t.slice(0, 4000) });
    } catch (err) { out.push({ u, status:'ERR', body:String(err.message||err).slice(0,120) }); }
  }
  return { statusCode: 200, headers:{'Content-Type':'application/json'}, body: JSON.stringify(out, null, 1) };
};
