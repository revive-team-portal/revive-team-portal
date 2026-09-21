// Nightly trigger for the ads metadata sync. Netlify blocks direct HTTP calls to
// a scheduled function, so the schedule lives here and the worker stays callable
// from the Ads page — the same split the Xero sync already uses.
const SITE = process.env.URL || 'https://team.revive.co.nz';
exports.handler = async () => {
  try {
    await require('./_runkey').internalFetch('ads-sync-background', { body: JSON.stringify({ next_run: new Date().toISOString(), source: 'ads-sync-cron' }) });
  } catch (e) { /* tomorrow's run picks it up */ }
  return { statusCode: 200, body: 'kicked' };
};
