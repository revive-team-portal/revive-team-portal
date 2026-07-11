// Returns a single ticket with its customer + messages. Portal-gated (support).
const { json, validatePortalUser } = require('./_portal');
const { rest, hasKey } = require('./_appsdb');
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const a = await validatePortalUser(event, 'support');
  if (!a.ok) return json(a.status || 403, { error: a.error });
  if (!hasKey()) return json(500, { error: 'Ticket database not configured yet (APPS_SERVICE_ROLE_KEY missing in Netlify).' });
  let body; try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad request body.' }); }
  if (!body.id) return json(400, { error: 'No ticket id.' });
  try {
    const t = await rest('tickets?id=eq.' + encodeURIComponent(body.id) + '&select=*,customer:customers(*)&limit=1');
    if (!t || !t.length) return json(404, { error: 'Ticket not found.' });
    const msgs = await rest('messages?ticket_id=eq.' + encodeURIComponent(body.id) + '&select=*&order=sent_at.asc');
    return json(200, { ticket: t[0], messages: msgs || [] });
  } catch (e) { return json(502, { error: String(e.message || e) }); }
};
