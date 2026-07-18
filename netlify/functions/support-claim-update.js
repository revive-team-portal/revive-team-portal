// Update a resend/claim: cause and/or status. Portal-gated (support).
const { json, validatePortalUser } = require('./_portal');
const { rest, hasKey } = require('./_appsdb');
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const a = await validatePortalUser(event, 'support');
  if (!a.ok) return json(a.status || 403, { error: a.error });
  if (!hasKey()) return json(500, { error: 'Not configured.' });
  let body; try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad request.' }); }
  if (!body.id) return json(400, { error: 'No id.' });
  const patch = {};
  if (body.cause !== undefined) patch.cause = body.cause || null;
  if (body.status !== undefined) patch.status = body.status;
  if (body.value !== undefined) patch.value = body.value;
  if (!Object.keys(patch).length) return json(400, { error: 'Nothing to update.' });
  try { await rest('claims?id=eq.'+encodeURIComponent(body.id), { method:'PATCH', headers:{ Prefer:'return=minimal' }, body: JSON.stringify(patch) }); return json(200, { ok:true }); }
  catch (e) { return json(502, { error: String(e.message || e) }); }
};
