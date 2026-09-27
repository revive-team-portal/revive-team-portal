// TEMPORARY (27 Sep) helper: load latest WhatsApp checksheets + TimeKeeper check. Delete after use.
// TEMPORARY backfill helper for the Production app — OCR historical CHK001 photos and store scan images.
// Guarded by a one-off key; to be deleted after the WhatsApp backlog import.
const GUARD = 'ebfbe936042af08d1cdde471';
const TK_KEY = process.env.TIMEKEEPER_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const APPS_URL = 'https://xcwrawjdfajlmbkdwlbm.supabase.co';
const SR = process.env.APPS_SERVICE_ROLE_KEY;
const json = (s, b) => ({ statusCode: s, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  let body; try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'bad body' }); }
  if (body.k !== GUARD) return json(401, { error: 'nope' });

  if (body.action === 'ocr') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: body.model || 'claude-sonnet-4-6', max_tokens: body.max_tokens || 1200,
        messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: body.image_b64 } }, { type: 'text', text: body.prompt }] }] }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return json(502, { error: (data.error && data.error.message) || 'AI failed' });
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    return json(200, { text, stop_reason: data.stop_reason, usage: data.usage });
  }

  if (body.action === 'photo') {
    const buf = Buffer.from(body.image_b64, 'base64');
    const res = await fetch(APPS_URL + '/storage/v1/object/production-photos/' + body.path, {
      method: 'POST', headers: { apikey: SR, Authorization: 'Bearer ' + SR, 'Content-Type': 'image/jpeg', 'x-upsert': 'true' }, body: buf,
    });
    const t = await res.text();
    return json(res.ok ? 200 : 502, { ok: res.ok, status: res.status, body: t.slice(0, 300) });
  }

  if (body.action === 'insert_runs') {
    const res = await fetch(APPS_URL + '/rest/v1/production_run', {
      method: 'POST', headers: { apikey: SR, Authorization: 'Bearer ' + SR, 'Content-Type': 'application/json', 'Content-Profile': 'production', Prefer: 'return=representation' },
      body: JSON.stringify(body.rows),
    });
    const t = await res.text();
    return json(res.ok ? 200 : 502, { ok: res.ok, status: res.status, body: t.slice(0, 20000) });
  }
  if (body.action === 'insert_photos') {
    const res = await fetch(APPS_URL + '/rest/v1/run_photo', {
      method: 'POST', headers: { apikey: SR, Authorization: 'Bearer ' + SR, 'Content-Type': 'application/json', 'Content-Profile': 'production', Prefer: 'return=minimal' },
      body: JSON.stringify(body.rows),
    });
    const t = await res.text();
    return json(res.ok ? 200 : 502, { ok: res.ok, status: res.status, body: t.slice(0, 2000) });
  }
  if (body.action === 'tk') {
    const auth = 'Basic ' + Buffer.from(':' + TK_KEY).toString('base64');
    let page = 1, total = 1, all = [];
    do {
      const r = await fetch(`https://api.timekeeper.co.uk/api/tk/v1/time-entries?start_date=${body.start}&end_date=${body.end}&page=${page}`, { headers: { Authorization: auth, Accept: 'application/json' } });
      if (!r.ok) return json(502, { error: 'TK ' + r.status });
      const box = (await r.json()).time_entries || {}; total = box.total_pages || 1; all = all.concat(box.time_entries || []); page++;
    } while (page <= total);
    const nz = (iso, o) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland', ...o }).format(new Date(iso));
    return json(200, { entries: all.filter(e => Number(e.job_id) === 134388).map(e => ({ date: nz(e.start_time, { year: 'numeric', month: '2-digit', day: '2-digit' }), start: nz(e.start_time, { hour: '2-digit', minute: '2-digit', hour12: false }), end: e.end_time ? nz(e.end_time, { hour: '2-digit', minute: '2-digit', hour12: false }) : null, hours: Number(e.duration_in_hours_raw) || 0, staff: e.employee_id })) });
  }
  return json(400, { error: 'unknown action' });
};
