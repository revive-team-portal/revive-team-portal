const { json, validatePortalUser } = require('./_portal');
const { rest, upsert, hasKey } = require('./_appsdb');
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const a = await validatePortalUser(event, 'support');
  if (!a.ok) return json(a.status || 403, { error: a.error });
  if (!hasKey()) return json(500, { error: 'Not configured.' });
  let body; try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad request.' }); }
  const name = (body.name||'').trim(); const email = (body.email||'').trim().toLowerCase();
  const note = (body.note||'').trim(); const type = ['order','enquiry','misc','unknown'].includes(body.type)?body.type:'enquiry';
  const subject = (body.subject||note||'Manual ticket').slice(0,200);
  if (!name && !email) return json(400, { error: 'Enter a name or email.' });
  try {
    const custEmail = email || ('manual+'+Date.now()+'@no-email.local');
    const crows = await upsert('customers', { email: custEmail, name: name||null }, 'email');
    const customerId = crows && crows[0] && crows[0].id;
    const trows = await rest('tickets', { method:'POST', headers:{ Prefer:'return=representation' }, body: JSON.stringify({
      customer_id: customerId, subject, status:'Open', ticket_type: type, source:'manual', matched_order: body.orderName||null,
      snippet: note.slice(0,180), updated_at: new Date().toISOString() }) });
    const ticketId = trows && trows[0] && trows[0].id;
    if (note) await rest('interactions', { method:'POST', headers:{ Prefer:'return=minimal' }, body: JSON.stringify({
      customer_id: customerId, ticket_id: ticketId, channel: body.channel||'phone', direction: body.direction||'in',
      operator: a.user.email||'operator', note, occurred_at: new Date().toISOString() }) });
    return json(200, { ok:true, id: ticketId });
  } catch (e) { return json(502, { error: String(e.message || e) }); }
};
