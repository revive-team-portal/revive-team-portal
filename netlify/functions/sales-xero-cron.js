// Scheduled trigger (see netlify.toml) — fires the background Xero sales sync over HTTP.
// Kept separate from the worker because a *scheduled* background function cannot also be
// invoked by HTTP (Netlify blocks it), and the "Sync sales" button needs HTTP invocation.
exports.handler = async () => {
  const base = process.env.URL || 'https://team.revive.co.nz';
  await require('./_runkey').internalFetch('sales-xero-sync-background?full=0').catch(() => {});
  return { statusCode: 200, body: 'triggered' };
};
