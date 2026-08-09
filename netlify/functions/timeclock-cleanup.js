// Scheduled: enforce selfie retention. Nulls the selfie on any punch older than
// the configured retention window (default 90 days). Punch record itself is kept.
const APPS_URL = 'https://xcwrawjdfajlmbkdwlbm.supabase.co';
const APPS_KEY = process.env.APPS_SERVICE_ROLE_KEY;

async function db(path, opts = {}) {
  const headers = { apikey: APPS_KEY, Authorization: 'Bearer ' + APPS_KEY, 'Content-Type': 'application/json',
    'Accept-Profile': 'timeclock', 'Content-Profile': 'timeclock', ...(opts.headers || {}) };
  const res = await fetch(APPS_URL + '/rest/v1/' + path, { ...opts, headers });
  const text = await res.text();
  if (!res.ok) throw new Error('DB ' + res.status + ': ' + String(text).slice(0, 160));
  return text ? JSON.parse(text) : null;
}

exports.handler = async () => {
  if (!APPS_KEY) return { statusCode: 500, body: 'no key' };
  try {
    const s = await db('setting?key=eq.selfie_retention_days&select=value');
    const days = parseInt((s && s[0] && s[0].value) || '90', 10) || 90;
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    await db('punch?punched_at=lt.' + cutoff + '&selfie=not.is.null', {
      method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ selfie: null }),
    });
    return { statusCode: 200, body: JSON.stringify({ ok: true, cutoff, days }) };
  } catch (e) {
    return { statusCode: 500, body: String(e.message || e) };
  }
};
