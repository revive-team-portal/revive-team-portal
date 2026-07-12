// Saves a testimonial to the database. Portal-gated (support).
const { json, validatePortalUser } = require('./_portal');
const { rest, hasKey } = require('./_appsdb');
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const a = await validatePortalUser(event, 'support');
  if (!a.ok) return json(a.status || 403, { error: a.error });
  if (!hasKey()) return json(500, { error: 'Not configured.' });
  let body; try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad request.' }); }
  if (!(body.excerpt||'').trim()) return json(400, { error: 'Nothing to save.' });
  try {
    await rest('testimonials', { method:'POST', headers:{ Prefer:'return=minimal' }, body: JSON.stringify({
      customer_id: body.customerId||null, ticket_id: body.ticketId||null,
      name: body.name||'', email: body.email||'', excerpt: body.excerpt.trim(),
      product: body.product||'', source_date: body.date||null, saved_by: a.user.email||'operator',
    }) });
    return json(200, { ok:true });
  } catch (e) { return json(502, { error: String(e.message || e) }); }
};
