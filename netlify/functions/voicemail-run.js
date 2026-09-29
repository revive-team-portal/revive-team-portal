// Synchronous voicemail run for testing / manual backfill. Guarded by run key (?k=).
// Returns the JSON summary (or the error) directly, unlike the -background worker.
const { runVoicemailSync } = require('./_voicemail');
const { guard, DENY } = require('./_runkey');
exports.handler = async (event) => {
  if (!(await guard(event)).ok) return DENY;
  const qs = (event && event.queryStringParameters) || {};
  const lookbackDays = Math.min(Number(qs.days) || 21, 400);
  const max = Math.min(Number(qs.max) || 20, 50);
  try {
    const r = await runVoicemailSync({ lookbackDays, max, doTranscribe: qs.notrans !== '1', onlyId: qs.id || null });
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(r) };
  } catch (e) {
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: String((e && e.message) || e) }) };
  }
};
