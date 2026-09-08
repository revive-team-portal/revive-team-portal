// Manual "run now" / preview for the holding-reply engine. Portal-gated (support).
const { json, validatePortalUser } = require('./_portal');
const { hasKey } = require('./_appsdb');
const { runHoldingReplies } = require('./_holdingreply');
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const a = await validatePortalUser(event, 'support');
  if (!a.ok) return json(a.status || 403, { error: a.error });
  if (!hasKey()) return json(500, { error: 'Ticket database not configured.' });
  let body = {}; try { body = JSON.parse(event.body || '{}'); } catch {}
  try { return json(200, await runHoldingReplies({ dryRun: !!body.dryRun, force: !!body.force })); }
  catch (e) { return json(502, { error: String(e.message || e) }); }
};
