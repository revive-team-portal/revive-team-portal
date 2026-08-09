// TEMPORARY read-only probe: lists TimeKeeper employees + jobs. Deleted after use.
const TK_KEY = process.env.TIMEKEEPER_API_KEY;
const BASE = 'https://api.timekeeper.co.uk/api/tk/v1/';
const GUARD = 'rvp-tk-7Kq3';
function tkAuth() { return 'Basic ' + Buffer.from(':' + (TK_KEY || '')).toString('base64'); }
async function tryGet(path) {
  try {
    const res = await fetch(BASE + path, { headers: { Authorization: tkAuth(), Accept: 'application/json' } });
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch { body = text.slice(0, 300); }
    return { path, status: res.status, body };
  } catch (e) { return { path, error: String(e.message || e) }; }
}
exports.handler = async (event) => {
  const qp = (event && event.queryStringParameters) || {};
  if (qp.k !== GUARD) return { statusCode: 403, body: 'nope' };
  if (!TK_KEY) return { statusCode: 500, body: 'no TIMEKEEPER_API_KEY' };
  const candidates = qp.paths
    ? qp.paths.split(',')
    : ['employees','employees?page=1','jobs','jobs?page=1','departments','staff','users','projects'];
  const out = await Promise.all(candidates.map(tryGet));
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(out, null, 1) };
};
