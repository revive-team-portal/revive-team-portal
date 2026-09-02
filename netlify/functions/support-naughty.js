const { json, validatePortalUser } = require('./_portal');
const { rest, hasKey } = require('./_appsdb');
exports.handler = async (event) => {
  const a = await validatePortalUser(event, 'support');
  if (!a.ok) return json(a.status || 403, { error: a.error });
  if (!hasKey()) return json(500, { error: 'Not configured.' });
  let body; try { body = JSON.parse(event.body||'{}'); } catch { body={}; }
  let path='naughty_orders?select=*&order=created_at.desc&limit=500';
  if (!body.all) path += '&status=neq.resolved';
  try { const rows=await rest(path); return json(200, { orders: rows||[] }); }
  catch(e){ return json(502, { error:String(e.message||e) }); }
};
