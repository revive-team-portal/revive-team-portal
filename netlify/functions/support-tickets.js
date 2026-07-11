// Lists tickets (DB-backed). Portal-gated (support).
const { json, validatePortalUser } = require('./_portal');
const { rest, hasKey } = require('./_appsdb');
exports.handler = async (event) => {
  const a = await validatePortalUser(event, 'support');
  if (!a.ok) return json(a.status || 403, { error: a.error });
  if (!hasKey()) return json(500, { error: 'Ticket database not configured yet (APPS_SERVICE_ROLE_KEY missing in Netlify).' });
  let body; try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }
  const status = body.status;
  let path = 'tickets?select=id,subject,status,priority,updated_at,created_at,gmail_thread_id,customer:customers(email,name)&order=updated_at.desc&limit=200';
  if (status && status !== 'all') path += '&status=eq.' + encodeURIComponent(status);
  try { const rows = await rest(path); return json(200, { tickets: rows || [] }); }
  catch (e) { return json(502, { error: String(e.message || e) }); }
};
