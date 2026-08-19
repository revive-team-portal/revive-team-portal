// Job queue for the SwiftPOS probe agent. The agent on the till PC polls ?action=next
// for a pending read-only query, runs it locally, and POSTs ?action=result back.
// Jobs are only ever queued by us (via the DB), so the agent only runs our SELECTs.
const APPS_URL = 'https://xcwrawjdfajlmbkdwlbm.supabase.co';
const APPS_KEY = process.env.APPS_SERVICE_ROLE_KEY;
const GUARD = process.env.POS_AGENT_KEY || 'rvp-pos-9Qz4Kt';
const { ingest } = require('./_posqueries');
async function db(path, opts = {}) {
  const headers = { apikey: APPS_KEY, Authorization: 'Bearer ' + APPS_KEY, 'Content-Type': 'application/json',
    'Accept-Profile': 'scoreboard', 'Content-Profile': 'scoreboard', ...(opts.headers || {}) };
  const res = await fetch(APPS_URL + '/rest/v1/' + path, { ...opts, headers });
  const t = await res.text(); if (!res.ok) throw new Error('DB ' + res.status + ': ' + t.slice(0, 160));
  return t ? JSON.parse(t) : null;
}
const json = (o) => ({ statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
exports.handler = async (event) => {
  const qp = event.queryStringParameters || {};
  if (!GUARD || qp.k !== GUARD) return { statusCode: 403, body: 'nope' };
  if (!APPS_KEY) return { statusCode: 500, body: 'not configured' };
  try {
    if (qp.action === 'next') {
      const rows = await db('pos_jobs?status=eq.pending&order=created_at.asc&limit=1&select=id,sql');
      if (!rows || !rows.length) return json({ job: null });
      const job = rows[0];
      await db('pos_jobs?id=eq.' + job.id, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'running', claimed_at: new Date().toISOString() }) });
      return json({ job });
    }
    if (qp.action === 'result') {
      const b = JSON.parse(event.body || '{}');
      if (!b.id) return json({ error: 'no id' });
      const jr = await db('pos_jobs?id=eq.' + b.id + '&select=note');
      const note = (jr && jr[0] && jr[0].note) || '';
      const patch = b.error
        ? { status: 'error', error: String(b.error).slice(0, 4000), done_at: new Date().toISOString() }
        : { status: 'done', result: String(b.result || '').slice(0, 900000), error: null, done_at: new Date().toISOString() };
      await db('pos_jobs?id=eq.' + b.id, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch) });
      if (!b.error) { try { await ingest(note, b.result); } catch (e) { /* ingest best-effort */ } }
      return json({ ok: true });
    }
    return json({ error: 'unknown action' });
  } catch (e) { return { statusCode: 500, body: String(e.message || e) }; }
};
