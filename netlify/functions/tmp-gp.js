// TEMPORARY read-only Graph passthrough. Deleted immediately after use.
const KEY = 'zq7Xr2Lm9TnP4vKd';
exports.handler = async (event) => {
  const qp = (event && event.queryStringParameters) || {};
  if (qp.k !== KEY) return { statusCode: 403, body: 'nope' };
  const t = process.env.META_ACCESS_TOKEN;
  if (!t) return { statusCode: 500, body: 'no token' };
  const p = String(qp.p || '').replace(/^\/+/, '');
  if (!/^[A-Za-z0-9_\/.]+$/.test(p)) return { statusCode: 400, body: 'bad path' };
  const url = 'https://graph.facebook.com/v21.0/' + p + '?' + (qp.q || '') + '&access_token=' + encodeURIComponent(t);
  const r = await fetch(url);
  const j = await r.json().catch(() => ({ parse_error: true }));
  return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(j, null, 1) };
};
