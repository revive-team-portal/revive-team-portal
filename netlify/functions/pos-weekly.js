// Daily (18:30). Ensures every COMPLETED Sat–Fri week row exists (so the auto feeds
// have somewhere to land — previously a new week stayed blank until someone clicked
// "+ New week"), then queues the till feeds.
const { WEEKLY_SQL, DEPT_SQL, UBER_SQL, queueJob, db } = require('./_posqueries');
function nzToday() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
async function ensureWeeks() {
  const today = nzToday();
  const latest = await db('week?select=period_end&order=period_end.desc&limit=1');
  if (!latest || !latest[0]) return [];
  let cur = latest[0].period_end; const rows = [];
  for (let i = 0; i < 10; i++) {
    const d = new Date(cur + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 7); cur = d.toISOString().slice(0, 10);
    if (cur >= today) break;            // only weeks that have finished
    rows.push({ period_end: cur, status: 'open' });
  }
  if (rows.length) await db('week', { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify(rows) });
  return rows.map(r => r.period_end);
}
exports.handler = async () => {
  try {
    const created = await ensureWeeks();
    const a = await queueJob('weekly-feed', WEEKLY_SQL);
    const b = await queueJob('dept-feed', DEPT_SQL);
    const c = await queueJob('uber-feed', UBER_SQL);
    return { statusCode: 200, body: JSON.stringify({ created, weekly: a, dept: b, uber: c }) };
  } catch (e) { return { statusCode: 500, body: String(e) }; }
};
