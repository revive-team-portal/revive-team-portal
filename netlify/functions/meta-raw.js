// TEMPORARY read-only Meta Graph proxy for ad-hoc analysis. ?k=<guard>&path=..&q=..
// Restricted to the Revive ad account subtree. Delete when the analysis is done.
const GRAPH = 'https://graph.facebook.com/v21.0';
const TOKEN = process.env.META_ACCESS_TOKEN;
const ACCT = process.env.META_AD_ACCOUNT || 'act_242089740673955';
const GUARD = '54e584d50fb4cbf90f6c0fb88e0d8e72';

exports.handler = async (event) => {
  const qp = (event && event.queryStringParameters) || {};
  if (qp.k !== GUARD) return { statusCode: 403, body: 'nope' };
  if (!TOKEN) return { statusCode: 500, body: JSON.stringify({ error: 'missing META_ACCESS_TOKEN' }) };
  const path = String(qp.path || ACCT);
  if (!/^(act_\d+|\d+)(\/[a-z_]+)?$/.test(path)) return { statusCode: 400, body: JSON.stringify({ error: 'bad path' }) };
  let url = GRAPH + '/' + path + '?' + String(qp.q || '') + '&limit=' + (qp.limit || '200') + '&access_token=' + encodeURIComponent(TOKEN);
  const all = []; let meta = null;
  try {
    for (let i = 0; i < 15 && url; i++) {
      const r = await fetch(url); const j = await r.json().catch(() => ({}));
      if (j.error) return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: j.error.message, code: j.error.code, type: j.error.type }) };
      if (!j.data) { meta = j; break; }
      j.data.forEach(x => all.push(x));
      url = (qp.page === '0') ? null : ((j.paging && j.paging.next) ? j.paging.next : null);
    }
  } catch (e) { return { statusCode: 500, body: JSON.stringify({ error: String(e.message || e) }) }; }
  return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(meta || { n: all.length, data: all }) };
};
