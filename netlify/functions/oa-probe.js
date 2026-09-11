// TEMP read-only probe for OpenAI Ads API. Deleted after use.
const KEY = process.env.OPENAI_ADS_API_KEY;
const API = 'https://api.ads.openai.com/v1';
exports.handler = async (event) => {
  const qp = (event && event.queryStringParameters) || {};
  if (qp.k !== 'oa-tmp-9Xw2p') return { statusCode: 403, body: 'nope' };
  const path = qp.p || '/ad_account';
  try {
    const r = await fetch(API + path, { headers: { Authorization: 'Bearer ' + KEY, Accept: 'application/json' } });
    const t = await r.text();
    return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify({ status: r.status, body: t.slice(0, 30000) }) };
  } catch (e) { return { statusCode: 500, body: JSON.stringify({ error: String(e.message || e) }) }; }
};
