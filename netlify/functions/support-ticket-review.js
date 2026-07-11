// Mark a Non-Order ticket reviewed / un-reviewed. Portal-gated (support).
const { json, validatePortalUser } = require('./_portal');
const { rest, hasKey } = require('./_appsdb');
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const a = await validatePortalUser(event, 'support');
  if (!a.ok) return json(a.status || 403, { error: a.error });
  if (!hasKey()) return json(500, { error: 'Ticket database not configured yet.' });
  let body; try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad request body.' }); }
  if (!body.id) return json(400, { error: 'No ticket id.' });
  const reviewed = body.reviewed !== false;
  const patch = { reviewed, reviewed_by: reviewed ? (a.user.email || 'operator') : null, reviewed_at: reviewed ? new Date().toISOString() : null };
  try { await rest('tickets?id=eq.' + encodeURIComponent(body.id), { method:'PATCH', headers:{ Prefer:'return=minimal' }, body: JSON.stringify(patch) }); return json(200, { ok:true }); }
  catch (e) { return json(502, { error: String(e.message || e) }); }
};
