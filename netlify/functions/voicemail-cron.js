// Scheduled trigger (see netlify.toml) — fires the voicemail background worker over HTTP.
// A *scheduled* function cannot itself be invoked by HTTP, so it kicks the -background worker
// via the internal header (same pattern as sales-xero-cron).
exports.handler = async () => {
  require('./_runkey').internalFetch('voicemail-sync-background?days=21&max=20').catch(() => {});
  return { statusCode: 200, body: 'triggered' };
};
