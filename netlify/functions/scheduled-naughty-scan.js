// Daily trigger for the naughty-order courier scan (fires the background worker over HTTP).
const { runResendScan } = require('./_naughtyscan');
exports.handler = async () => {
  try { await runResendScan(35); } catch (e) { console.log('resend-pass error', String(e && e.message || e)); }
  const base = process.env.URL || 'https://team.revive.co.nz';
  await require('./_runkey').internalFetch('support-naughty-scan-background?days=35').catch(() => {});
  return { statusCode: 200, body: 'triggered' };
};
