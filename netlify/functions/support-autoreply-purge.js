const { json, validatePortalUser } = require('./_portal');
const { getAccessToken } = require('./_gmail');
const { runAutoReplyPurge } = require('./_autoreply');
exports.handler = async (event) => {
  const a = await validatePortalUser(event, 'support');
  if (!a.ok) return json(a.status || 403, { error: a.error });
  const at = await getAccessToken('cafe');
  if (!at.ok) return json(400, { error: at.error });
  try { const r=await runAutoReplyPurge(at.access_token); return json(200, r); }
  catch(e){ return json(502, { error: String(e.message||e) }); }
};
