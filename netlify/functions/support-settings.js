// Read/write support module settings (tone prompt, footer, …). Portal-gated (support).
const { json, validatePortalUser } = require('./_portal');
const { rest, hasKey } = require('./_appsdb');
async function readAll(){ const rows=await rest('settings?select=key,value'); const map={}; (rows||[]).forEach(r=>map[r.key]=r.value); return map; }
exports.handler = async (event) => {
  const a = await validatePortalUser(event, 'support');
  if (!a.ok) return json(a.status || 403, { error: a.error });
  if (!hasKey()) return json(500, { error: 'Not configured.' });
  try {
    let body={}; try { body = JSON.parse(event.body || '{}'); } catch {}
    if (body.updates && typeof body.updates === 'object') {
      const rows = Object.keys(body.updates).map(k => ({ key:k, value:String(body.updates[k] ?? ''), updated_at:new Date().toISOString(), updated_by:a.user.email||'operator' }));
      if (rows.length) await rest('settings?on_conflict=key', { method:'POST', headers:{ Prefer:'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows) });
      return json(200, { ok:true, settings: await readAll() });
    }
    return json(200, { settings: await readAll() });
  } catch (e) { return json(502, { error: String(e.message || e) }); }
};
