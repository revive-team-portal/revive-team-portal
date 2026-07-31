// TEMPORARY manual probe — delete after discovering the TimeKeeper API shape.
// Guarded by a throwaway token. Returns diagnostics inline so we can iterate fast.
const TK_KEY = process.env.TIMEKEEPER_API_KEY;
const BASE = 'https://api.timekeeper.co.uk/api/tk/v1/time-entries';
const GUARD = 'rvp-tk-7Kq3';
function auth(){ return 'Basic ' + Buffer.from(':' + (TK_KEY||'')).toString('base64'); }
exports.handler = async (event) => {
  if ((event.queryStringParameters||{}).k !== GUARD) return { statusCode: 403, body: 'nope' };
  if (!TK_KEY) return { statusCode: 200, body: JSON.stringify({error:'no TIMEKEEPER_API_KEY'}) };
  const today = new Date();
  const dOff = n => { const x=new Date(today); x.setUTCDate(today.getUTCDate()-n); return x.toISOString().slice(0,10); };
  const s=dOff(8), e=dOff(1);
  const sISO=s+'T00:00:00Z', eISO=e+'T23:59:59Z';
  const qs = [
    `?start_date=${s}&end_date=${e}`,
    `?start_date=${s}T00:00:00&end_date=${e}T23:59:59`,
    `?start_date=${sISO}&end_date=${eISO}`,
    `?start_date=${s}&end_date=${e}&limit=100`,
  ];
  const out=[];
  for (const q of qs) {
    try {
      const r = await fetch(BASE+q, { headers: { Authorization: auth(), Accept:'application/json' } });
      const t = await r.text();
      out.push({ q, status: r.status, body: t.slice(0, 300) });
    } catch (err) { out.push({ q, status:'ERR', body:String(err.message||err).slice(0,120) }); }
  }
  return { statusCode: 200, headers:{'Content-Type':'application/json'}, body: JSON.stringify(out, null, 1) };
};
