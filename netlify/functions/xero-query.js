// Read-only Xero query endpoint for Claude / other portal apps.
//
// Uses the portal's existing Xero OAuth connection (_xero.js, token row in recon.oauth),
// which was granted against BOTH Revive Cafes Limited and Revivealicious Foods Limited.
// This is what lets a chat session query either company without touching the
// claude.ai Xero connector (which is single-tenant and has to be reconnected to switch).
//
//   GET /.netlify/functions/xero-query?k=<run key>&org=foods|cafes
//       &path=/api.xro/2.0/Invoices            (any GET path under /api.xro/2.0/)
//       &where=Type=="ACCREC"&&Date>=DateTime(2026,07,20)
//       &page=1 | &pages=all                    (pages=all walks page=1.. until empty)
//       &<any other query param is passed straight through to Xero>
//   GET ...?k=<run key>&org=list                (which tenants the token can see)
//
// Guard: _adsauth.authorizeRun — PORTAL_RUN_KEY env, or a single-use key minted into
// ads.job (kind='runkey', status='open', cursor=<key>). GET only. Nothing is written.
const X = require('./_xero');
const { authorizeRun } = require('./_adsauth');

const API = 'https://api.xero.com';
const RESERVED = new Set(['k', 'org', 'path', 'pages']);

function json(code, body) {
  return { statusCode: code, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) };
}

async function connections(token) {
  const res = await fetch(API + '/connections', { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
  if (!res.ok) throw new Error('Xero /connections ' + res.status);
  const d = await res.json();
  return (Array.isArray(d) ? d : []).filter(c => c.tenantType === 'ORGANISATION')
    .map(c => ({ tenant_id: c.tenantId, tenant_name: c.tenantName }));
}

function pickTenant(orgs, want) {
  const w = String(want || '').toLowerCase();
  const alias = { foods: 'revivealicious', wopples: 'revivealicious', cafes: 'revive cafes', cafe: 'revive cafes' };
  const needle = alias[w] || w;
  return orgs.find(o => o.tenant_id === want)
      || orgs.find(o => o.tenant_name.toLowerCase().includes(needle));
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return json(405, { error: 'GET only' });
  const auth = await authorizeRun(event);
  if (!auth.ok) return { statusCode: 403, body: 'nope' };
  if (!X.configured()) return json(500, { error: 'Xero not configured' });

  const qp = event.queryStringParameters || {};
  try {
    // ?connect=1 — mint a fresh OAuth state (validated by xero-callback) and return the
    // consent link for Jeremy to click. Needed whenever the refresh token has died.
    if (qp.connect) {
      const state = require('crypto').randomBytes(24).toString('hex');
      await X.saveRow({ state, state_at: new Date().toISOString() });
      return json(200, { ok: true, url: X.authorizeUrl(state), expires_in_minutes: 15 });
    }
    const token = await X.accessToken();
    const orgs = await connections(token);
    if (!qp.org || qp.org === 'list') return json(200, { ok: true, orgs });

    const tenant = pickTenant(orgs, qp.org);
    if (!tenant) return json(404, { error: 'org not found', orgs });

    const path = String(qp.path || '');
    if (!/^\/api\.xro\/2\.0\/[A-Za-z0-9/._-]+$/.test(path)) return json(400, { error: 'path must be /api.xro/2.0/<Resource>' });

    const params = {};
    for (const [key, val] of Object.entries(qp)) if (!RESERVED.has(key)) params[key] = val;

    const headers = { Authorization: 'Bearer ' + token, 'xero-tenant-id': tenant.tenant_id, Accept: 'application/json' };
    const one = async (page) => {
      const p = { ...params }; if (page) p.page = page;
      const url = API + path + '?' + new URLSearchParams(p).toString();
      const res = await fetch(url, { headers });
      const text = await res.text();
      if (!res.ok) throw new Error('Xero ' + res.status + ': ' + text.slice(0, 300));
      return text ? JSON.parse(text) : {};
    };

    if (qp.pages === 'all') {
      // Xero list endpoints page at 100; merge the first array-valued key across pages.
      let page = 1, merged = null, listKey = null;
      for (; page <= 50; page++) {
        const d = await one(page);
        if (!listKey) listKey = Object.keys(d).find(k => Array.isArray(d[k]));
        if (!listKey) { merged = d; break; }
        if (!merged) merged = { ...d, [listKey]: [] };
        merged[listKey].push(...d[listKey]);
        if (d[listKey].length < 100) break;
      }
      return json(200, { ok: true, org: tenant, pages: page, ...merged });
    }
    const d = await one(qp.page ? Number(qp.page) : undefined);
    return json(200, { ok: true, org: tenant, ...d });
  } catch (e) {
    return json(502, { error: String(e.message || e).slice(0, 400) });
  }
};
