// Scheduled trigger — fires the background monthly report (which self-guards to send once).
exports.handler = async () => {
  const base = process.env.URL || 'https://team.revive.co.nz';
  await fetch(base + '/.netlify/functions/monthly-pos-report-background').catch(() => {});
  return { statusCode: 200, body: 'triggered' };
};
