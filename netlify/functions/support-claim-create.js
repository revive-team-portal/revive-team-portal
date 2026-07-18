const { json, validatePortalUser } = require('./_portal');
const { rest, hasKey } = require('./_appsdb');
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const a = await validatePortalUser(event, 'support');
  if (!a.ok) return json(a.status || 403, { error: a.error });
  if (!hasKey()) return json(500, { error: 'Not configured.' });
  let body; try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad request.' }); }
  try {
    await rest('claims', { method:'POST', headers:{ Prefer:'return=minimal' }, body: JSON.stringify({
      ticket_id: body.ticketId || null, order_name: body.orderName || '', customer_name: body.customerName || '',
      customer_email: body.customerEmail || '', tracking_number: body.trackingNumber || '', value: body.value || null,
      reason: body.reason || '', status: 'To lodge' }) });
    return json(200, { ok:true });
  } catch (e) { return json(502, { error: String(e.message || e) }); }
};
