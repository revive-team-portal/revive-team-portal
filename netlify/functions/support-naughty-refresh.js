const { json, validatePortalUser } = require('./_portal');
const { rest, hasKey } = require('./_appsdb');
const { track } = require('./_eship');
exports.handler = async (event) => {
  const a = await validatePortalUser(event, 'support');
  if (!a.ok) return json(a.status || 403, { error: a.error });
  if (!hasKey()) return json(500, { error: 'Not configured.' });
  try {
    const open = await rest('naughty_orders?status=eq.open&tracking_number=not.is.null&select=id,tracking_number&limit=40');
    let checked=0, delivered=0;
    for (const o of (open||[])) {
      checked++;
      const t = await track({ trackingNumber: o.tracking_number });
      if (t.ok) { const patch={ courier_status: t.status, updated_at:new Date().toISOString() }; if(/deliver/i.test(t.status||'')){ patch.status='delivered'; delivered++; }
        await rest('naughty_orders?id=eq.'+o.id,{ method:'PATCH', headers:{ Prefer:'return=minimal' }, body: JSON.stringify(patch) }); }
      await new Promise(r=>setTimeout(r,300));
    }
    return json(200, { checked, delivered });
  } catch (e) { return json(502, { error: String(e.message||e) }); }
};
