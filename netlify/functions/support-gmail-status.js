// Reports whether the cafe@ support mailbox is connected. Portal-gated (support).
const { json, validatePortalUser } = require('./_portal');
const { getToken } = require('./_gmail');
exports.handler = async (event) => {
  const a = await validatePortalUser(event, 'support');
  if (!a.ok) return json(a.status || 403, { error: a.error });
  const t = await getToken('cafe');
  return json(200, { connected: !!(t && t.refresh_token), email: t ? t.email : null });
};
