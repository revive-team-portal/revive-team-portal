// Scheduled trigger for the daily Meta ads email (see netlify.toml).
exports.handler = async () => {
  try { await require('./_runkey').internalFetch('ads-daily-report'); } catch (e) { /* next day */ }
  return { statusCode: 200, body: 'kicked' };
};
