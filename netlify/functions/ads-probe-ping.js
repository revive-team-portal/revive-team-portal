// Diagnostic for the Ads run-key guard. Synchronous (so the body is visible),
// leaks nothing — booleans and counts only.  ?k=<key>
const { authorizeRun, adsDb } = require('./_adsauth');

exports.handler = async (event) => {
  const qp = (event && event.queryStringParameters) || {};
  const out = {
    build: 'ads-probe-ping v1',
    saw_k: !!qp.k,
    k_len: qp.k ? String(qp.k).length : 0,
    env: {
      PORTAL_RUN_KEY: !!process.env.PORTAL_RUN_KEY,
      APPS_SERVICE_ROLE_KEY: !!process.env.APPS_SERVICE_ROLE_KEY,
      META_ACCESS_TOKEN: !!process.env.META_ACCESS_TOKEN,
    },
  };
  try {
    const rows = await adsDb('job?kind=eq.runkey&status=eq.open&select=id,cursor,started_at');
    out.db = { ok: true, open_runkeys: (rows || []).length, cursor_lens: (rows || []).map(r => String(r.cursor || '').length), match: (rows || []).some(r => String(r.cursor || '') === String(qp.k || '')) };
  } catch (e) { out.db = { ok: false, error: String(e.message || e).slice(0, 300) }; }
  try { const a = await authorizeRun(event); out.authorize = { ok: a.ok, how: a.how }; }
  catch (e) { out.authorize = { threw: String(e.message || e).slice(0, 300) }; }
  return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(out, null, 1) };
};
