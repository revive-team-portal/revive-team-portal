// Scheduled trigger (see netlify.toml) — fires the background Xero sales sync over HTTP.
// Kept separate from the worker because a *scheduled* background function cannot also be
// invoked by HTTP (Netlify blocks it), and the "Sync sales" button needs HTTP invocation.
exports.handler = async () => {
  const base = process.env.URL || 'https://team.revive.co.nz';
  await fetch(base + '/.netlify/functions/sales-xero-sync-background?full=0', { method: 'POST' }).catch(() => {});
  return { statusCode: 200, body: 'triggered' };
};
