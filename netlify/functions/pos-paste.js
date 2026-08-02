// Receives text pasted on /pos/ (SwiftPOS query results) and stores it in
// scoreboard.pos_paste so Claude can read the full output (no screenshots).
const APPS_URL = 'https://xcwrawjdfajlmbkdwlbm.supabase.co';
const APPS_KEY = process.env.APPS_SERVICE_ROLE_KEY;
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'POST only' };
  if (!APPS_KEY) return { statusCode: 500, body: 'not configured' };
  let b; try { b = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, body: 'bad json' }; }
  const content = String(b.content || '').slice(0, 900000);
  const label = String(b.label || '').slice(0, 200);
  if (!content.trim()) return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'empty' }) };
  const res = await fetch(APPS_URL + '/rest/v1/pos_paste', {
    method: 'POST',
    headers: { apikey: APPS_KEY, Authorization: 'Bearer ' + APPS_KEY, 'Content-Type': 'application/json', 'Content-Profile': 'scoreboard', Prefer: 'return=minimal' },
    body: JSON.stringify([{ label, content }]),
  });
  if (!res.ok) return { statusCode: 502, body: (await res.text()).slice(0, 200) };
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, chars: content.length }) };
};
