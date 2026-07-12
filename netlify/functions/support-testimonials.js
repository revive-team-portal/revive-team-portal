// Lists saved testimonials. Portal-gated (support).
const { json, validatePortalUser } = require('./_portal');
const { rest, hasKey } = require('./_appsdb');
exports.handler = async (event) => {
  const a = await validatePortalUser(event, 'support');
  if (!a.ok) return json(a.status || 403, { error: a.error });
  if (!hasKey()) return json(500, { error: 'Not configured.' });
  try { const rows = await rest('testimonials?select=*&order=created_at.desc&limit=200'); return json(200, { testimonials: rows || [] }); }
  catch (e) { return json(502, { error: String(e.message || e) }); }
};
