// Add an internal / fulfiller note to a ticket. Portal-gated (support).
const { json, validatePortalUser } = require('./_portal');
const { rest, hasKey } = require('./_appsdb');
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const a = await validatePortalUser(event, 'support');
  if (!a.ok) return json(a.status || 403, { error: a.error });
  if (!hasKey()) return json(500, { error: 'Ticket database not configured.' });
  let body; try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad request body.' }); }
  if (!body.id || !(body.body||'').trim()) return json(400, { error: 'Note text required.' });
  try {
    await rest('notes', { method:'POST', headers:{ Prefer:'return=minimal' }, body: JSON.stringify({
      ticket_id: body.id, author: a.user.email || 'operator', type: body.type === 'fulfiller' ? 'fulfiller' : 'internal', body: body.body.trim(),
    }) });
    return json(200, { ok:true });
  } catch (e) { return json(502, { error: String(e.message || e) }); }
};
