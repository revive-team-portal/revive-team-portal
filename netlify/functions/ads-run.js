// Kick a sync or an analysis batch from the Ads page. Admin/ads users only.
// Mints a short-lived single-use key for the background worker rather than
// exposing any long-lived secret to the browser.
const { json, validatePortalUser } = require('./_portal');
const { db } = require('./_adsdb');

const SITE = process.env.URL || 'https://team.revive.co.nz';
const rand = () => [...require('crypto').randomBytes(24)].map(b => b.toString(16).padStart(2, '0')).join('');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const auth = await validatePortalUser(event, 'ads');
  if (!auth.ok) return json(auth.status || 403, { error: auth.error });

  let body; try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad request body.' }); }
  const action = body.action === 'analyse' ? 'analyse' : 'sync';
  const limit = Math.min(Math.max(Number(body.limit) || 5, 1), 25);

  const key = rand();
  await db('job', { method: 'POST', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify([{ kind: 'runkey', status: 'open', cursor: key, note: 'ads-run ' + action + ' by ' + (auth.user && auth.user.email), started_at: new Date().toISOString() }]) });

  const fn = action === 'analyse'
    ? '/.netlify/functions/ads-video-background?k=' + key + '&limit=' + limit
    : '/.netlify/functions/ads-sync-background?k=' + key;
  try { await fetch(SITE + fn, { method: 'POST' }); }
  catch (e) { return json(502, { error: 'Could not start the job: ' + String(e.message || e).slice(0, 120) }); }

  return json(200, { ok: true, action, limit,
    message: action === 'analyse'
      ? 'Analysing the ' + limit + ' newest untagged ads. This runs in the background — refresh in a few minutes.'
      : 'Refreshing every ad from Meta. This runs in the background — refresh in a minute or two.' });
};
