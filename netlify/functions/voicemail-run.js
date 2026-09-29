// Synchronous voicemail run for testing / manual backfill. Guarded by run key (?k=).
// Writes the JSON summary (or the error) into the run-key's ads.job note so it can be read
// back via SQL even when the HTTP body isn't visible to the caller.
const { runVoicemailSync } = require('./_voicemail');
const { guard, DENY, adsDb } = require('./_runkey');
exports.handler = async (event) => {
  const g = await guard(event);
  if (!g.ok) return DENY;
  const qs = (event && event.queryStringParameters) || {};
  const lookbackDays = Math.min(Number(qs.days) || 21, 400);
  const max = Math.min(Number(qs.max) || 20, 50);
  let out;
  try {
    out = await runVoicemailSync({ lookbackDays, max, doTranscribe: qs.notrans !== '1', onlyId: qs.id || null });
  } catch (e) {
    out = { error: String((e && e.stack) || (e && e.message) || e).slice(0, 400) };
  }
  try { if (g.job_id) await adsDb('job?id=eq.' + g.job_id, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ note: JSON.stringify(out).slice(0, 900) }) }); } catch (e) {}
  return { statusCode: out.error ? 500 : 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(out) };
};
