// NZ Post / CourierPost service-code reference (editable). Portal-gated (support).
const { json, validatePortalUser } = require('./_portal');
const { rest, hasKey } = require('./_appsdb');
exports.handler = async (event) => {
  const a = await validatePortalUser(event, 'support');
  if (!a.ok) return json(a.status || 403, { error: a.error });
  if (!hasKey()) return json(500, { error: 'Not configured.' });
  try {
    let body={}; try { body = JSON.parse(event.body || '{}'); } catch {}
    if (body.upsert && body.upsert.code) {
      const u = body.upsert;
      const row = { code:String(u.code).toUpperCase().trim(), updated_at:new Date().toISOString(), updated_by:a.user.email||'operator' };
      if (u.meaning !== undefined) row.meaning = String(u.meaning||'');
      if (u.category !== undefined) row.category = u.category||'service';
      if (u.perishable !== undefined) row.perishable = !!u.perishable;
      await rest('nzpost_codes?on_conflict=code', { method:'POST', headers:{ Prefer:'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(row) });
    }
    if (body.remove) await rest('nzpost_codes?code=eq.'+encodeURIComponent(String(body.remove).toUpperCase()), { method:'DELETE', headers:{ Prefer:'return=minimal' } });
    const rows = await rest('nzpost_codes?select=code,meaning,category,perishable&order=code.asc');
    return json(200, { codes: rows || [] });
  } catch (e) { return json(502, { error: String(e.message || e) }); }
};
