// TEMPORARY: list TimeKeeper Wopple Production (job 134388) entries per NZ date. Delete after use.
const GUARD = '7d1f0c9a2be44c6e8a0f';
const TK_KEY = process.env.TIMEKEEPER_API_KEY;
const TK = 'https://api.timekeeper.co.uk/api/tk/v1/time-entries';
function nz(iso, opt) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland', ...opt }).format(new Date(iso)); }
exports.handler = async (event) => {
  const qp = event.queryStringParameters || {};
  if (qp.k !== GUARD) return { statusCode: 403, body: 'nope' };
  const auth = 'Basic ' + Buffer.from(':' + TK_KEY).toString('base64');
  let page = 1, total = 1, all = [];
  do {
    const r = await fetch(`${TK}?start_date=${qp.start}&end_date=${qp.end}&page=${page}`, { headers: { Authorization: auth, Accept: 'application/json' } });
    if (!r.ok) return { statusCode: 502, body: 'TK ' + r.status + ' ' + (await r.text()).slice(0, 200) };
    const box = (await r.json()).time_entries || {}; total = box.total_pages || 1; all = all.concat(box.time_entries || []); page++;
  } while (page <= total);
  const jobs = (qp.jobs || '134388').split(',').map(Number);
  const out = all.filter(e => jobs.includes(Number(e.job_id))).map(e => ({
    date: nz(e.start_time, { year: 'numeric', month: '2-digit', day: '2-digit' }),
    start: nz(e.start_time, { hour: '2-digit', minute: '2-digit', hour12: false }),
    end: e.end_time ? nz(e.end_time, { hour: '2-digit', minute: '2-digit', hour12: false }) : null,
    hours: Number(e.duration_in_hours_raw) || 0, job: e.job_id, staff: e.employee_id,
  })).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ n: all.length, sample: all[0], entries: out }) };
};
