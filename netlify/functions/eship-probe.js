// TEMP guarded probe of the Starshipit/eShip API to discover available fields (esp. cost).
const API_KEY = process.env.ESHIP_API_KEY;
const SUB_KEY = process.env.ESHIP_SUBSCRIPTION_KEY;
const GUARD = 'rvp-tk-7Kq3';
async function hit(path) {
  try {
    const res = await fetch('https://api.starshipit.com' + path, { headers: { 'StarShipIT-Api-Key': API_KEY, 'Ocp-Apim-Subscription-Key': SUB_KEY, 'Content-Type': 'application/json' } });
    const t = await res.text(); let j = null; try { j = JSON.parse(t); } catch {}
    let firstList = null, listKey = null;
    if (j) for (const k of Object.keys(j)) { if (Array.isArray(j[k]) && j[k].length) { firstList = j[k]; listKey = k; break; } }
    return { path, status: res.status, topKeys: j ? Object.keys(j) : null, listKey,
      count: firstList ? firstList.length : 0,
      itemKeys: firstList && firstList[0] ? Object.keys(firstList[0]) : null,
      sample: firstList ? firstList[0] : (t.slice(0, 200)) };
  } catch (e) { return { path, error: String(e.message || e).slice(0, 120) }; }
}
exports.handler = async (event) => {
  if (((event.queryStringParameters) || {}).k !== GUARD) return { statusCode: 403, body: 'nope' };
  if (!API_KEY || !SUB_KEY) return { statusCode: 200, body: JSON.stringify({ error: 'eShip not configured' }) };
  const out = [];
  for (const p of ['/api/orders?limit=3', '/api/orders/shipped?limit=3', '/api/deliveries?limit=3&since_order_date=2026-07-01']) out.push(await hit(p));
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(out, null, 1) };
};
