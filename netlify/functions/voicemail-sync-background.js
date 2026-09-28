// Voicemail worker (background function, up to 15 min). Guarded: internal calls (cron /
// voicemail-refresh) or a single-use run key (?k=). Downloads + transcribes + matches + files.
const { runVoicemailSync } = require('./_voicemail');
const { guard, DENY } = require('./_runkey');

exports.handler = async (event) => {
  if (!(await guard(event)).ok) return DENY;
  const qs = (event && event.queryStringParameters) || {};
  const lookbackDays = Math.min(Number(qs.days) || 21, 400);
  const max = Math.min(Number(qs.max) || 20, 50);
  try {
    const r = await runVoicemailSync({ lookbackDays, max });
    console.log('voicemail-sync', JSON.stringify(r));
    return { statusCode: 200, body: JSON.stringify(r) };
  } catch (e) {
    console.log('voicemail-sync error', String((e && e.message) || e));
    return { statusCode: 500, body: String((e && e.message) || e) };
  }
};
