const { json, validatePortalUser } = require('./_portal');
const { rest, hasKey } = require('./_appsdb');
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const a = await validatePortalUser(event, 'support');
  if (!a.ok) return json(a.status || 403, { error: a.error });
  if (!hasKey()) return json(500, { error: 'Not configured.' });
  let body; try { body = JSON.parse(event.body||'{}'); } catch { return json(400,{error:'Bad request.'}); }
  if(!body.id) return json(400,{error:'No id.'});
  try { await rest('naughty_orders?id=eq.'+encodeURIComponent(body.id),{ method:'PATCH', headers:{ Prefer:'return=minimal' }, body: JSON.stringify({ status:'resolved', resolution:body.resolution||'', resolved_at:new Date().toISOString(), updated_at:new Date().toISOString() }) }); return json(200,{ok:true}); }
  catch(e){ return json(502,{error:String(e.message||e)}); }
};
