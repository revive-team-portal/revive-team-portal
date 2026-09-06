// Nightly trigger for the video worker. Scheduled functions get a short budget,
// so this only kicks the background worker and returns.
const SITE = process.env.URL || 'https://team.revive.co.nz';
exports.handler = async () => {
  try {
    await fetch(SITE + '/.netlify/functions/ads-video-background', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ next_run: new Date().toISOString(), source: 'ads-video-cron' }),
    });
  } catch (e) { /* the nightly sync will re-queue anything missed */ }
  return { statusCode: 200, body: 'kicked' };
};
