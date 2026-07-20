const { json, validatePortalUser } = require('./_portal');
const { hasKey } = require('./_appsdb');
const { runInboxSync } = require('./_ingest');
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const a = await validatePortalUser(event, 'support');
  if (!a.ok) return json(a.status || 403, { error: a.error });
  if (!hasKey()) return json(500, { error: 'Ticket database not configured yet (APPS_SERVICE_ROLE_KEY missing in Netlify).' });
  let body; try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }
  try { const r = await runInboxSync(body); if (r.ok === false) return json(400, r); return json(200, r); }
  catch (e) { return json(502, { error: 'Sync error: ' + String(e && e.message || e) }); }
};
