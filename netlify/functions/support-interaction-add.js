// Log a manual interaction (phone in/out, SMS, in-store, social). Portal-gated (support).
const { json, validatePortalUser } = require('./_portal');
const { rest, hasKey } = require('./_appsdb');
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const a = await validatePortalUser(event, 'support');
  if (!a.ok) return json(a.status || 403, { error: a.error });
  if (!hasKey()) return json(500, { error: 'Not configured.' });
  let body; try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad request body.' }); }
  if (!body.customerId) return json(400, { error: 'No customer.' });
  try {
    await rest('interactions', { method:'POST', headers:{ Prefer:'return=minimal' }, body: JSON.stringify({
      customer_id: body.customerId, ticket_id: body.ticketId || null,
      channel: body.channel || 'phone', direction: body.direction || 'in',
      operator: a.user.email || 'operator', note: (body.note||'').trim(), occurred_at: new Date().toISOString(),
    }) });
    return json(200, { ok:true });
  } catch (e) { return json(502, { error: String(e.message || e) }); }
};
