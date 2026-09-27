// Scheduled trigger for the equipment watch (see netlify.toml): every 3 days, 8am NZDT.
exports.handler = async () => {
  try { await require('./_runkey').internalFetch('equip-watch-background'); } catch (e) { /* next run */ }
  return { statusCode: 200, body: 'kicked' };
};
