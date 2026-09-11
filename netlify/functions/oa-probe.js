// TEMP OpenAI Ads API proxy (used once to fix context hints). Deleted after use.
const KEY = process.env.OPENAI_ADS_API_KEY;
const API = 'https://api.ads.openai.com/v1';
exports.handler = async (event) => {
  const qp = (event && event.queryStringParameters) || {};
  if (qp.k !== 'oa-tmp-9Xw2p') return { statusCode: 403, body: 'nope' };
  const path = qp.p || '/ad_account';
  const method = (event.httpMethod === 'POST' && qp.m) ? qp.m : 'GET';
  try {
    const opts = { method, headers: { Authorization: 'Bearer ' + KEY, Accept: 'application/json' } };
    if (method !== 'GET') { opts.headers['Content-Type'] = 'application/json'; opts.body = event.body; }
    const r = await fetch(API + path, opts);
    const t = await r.text();
    return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify({ status: r.status, body: t.slice(0, 30000) }) };
  } catch (e) { return { statusCode: 500, body: JSON.stringify({ error: String(e.message || e) }) }; }
};
