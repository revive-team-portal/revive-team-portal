// Daily trigger for the naughty-order courier scan (fires the background worker over HTTP).
exports.handler = async () => {
  const base = process.env.URL || 'https://team.revive.co.nz';
  await fetch(base + '/.netlify/functions/support-naughty-scan-background?days=35', { method: 'POST' }).catch(() => {});
  return { statusCode: 200, body: 'triggered' };
};
