// TEMPORARY diagnostic for the Xero OAuth invalid_scope issue. No secrets returned
// (client_id is public — it appears in the OAuth URL). Remove after diagnosis.
const X = require('./_xero');
function j(o){ return { statusCode:200, headers:{'Content-Type':'application/json','Cache-Control':'no-store'}, body: JSON.stringify(o) }; }
exports.handler = async (event) => {
  const qs = (event && event.queryStringParameters) || {};
  if (!X.configured()) return j({ configured:false });
  const url = X.authorizeUrl('DIAG' + Date.now());
  const u = new URL(url);
  const out = {
    configured: true,
    scope_sent: u.searchParams.get('scope'),
    raw_query_has_plus: /scope=[^&]*\+/.test(url),
    client_id_prefix: (u.searchParams.get('client_id')||'').slice(0,8),
    redirect_uri: u.searchParams.get('redirect_uri'),
  };
  if (qs.probe) {
    if (qs.scope) u.searchParams.set('scope', qs.scope);
    if (qs.scope20) u.search = u.search; // no-op placeholder
    let testUrl = u.toString();
    if (qs.enc === '20') testUrl = testUrl.replace(/scope=[^&]*/, m => m.replace(/\+/g,'%20'));
    try {
      const r = await fetch(testUrl, { redirect: 'manual' });
      const body = await r.text();
      out.probe = { status: r.status, location: r.headers.get('location'), snippet: body.replace(/\s+/g,' ').slice(0,300) };
      out.probe.tested_scope = new URL(testUrl).searchParams.get('scope');
    } catch (e) { out.probe = { error: String(e.message||e) }; }
  }
  return j(out);
};
