// Daily trigger for the naughty-order courier scan (fires the background worker over HTTP).
exports.handler = async () => {
  const base = process.env.URL || 'https://team.revive.co.nz';
  await require('./_runkey').internalFetch('support-naughty-scan-background?days=35').catch(() => {});
  return { statusCode: 200, body: 'triggered' };
};
