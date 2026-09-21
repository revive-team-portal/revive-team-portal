// Kick a sync or an analysis batch from the Ads page. Admin/ads users only.
// Starts the worker with the internal header (_runkey) — no secret reaches the browser.
const { json, validatePortalUser } = require('./_portal');
const { internalFetch } = require('./_runkey');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const auth = await validatePortalUser(event, 'ads');
  if (!auth.ok) return json(auth.status || 403, { error: auth.error });

  let body; try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad request body.' }); }
  const action = body.action === 'analyse' ? 'analyse' : 'sync';
  const limit = Math.min(Math.max(Number(body.limit) || 5, 1), 25);

  const fn = action === 'analyse' ? 'ads-video-background?limit=' + limit : 'ads-sync-background';
  try { await internalFetch(fn, { body: JSON.stringify({ by: auth.user && auth.user.email }) }); }
  catch (e) { return json(502, { error: 'Could not start the job: ' + String(e.message || e).slice(0, 120) }); }

  return json(200, { ok: true, action, limit,
    message: action === 'analyse'
      ? 'Analysing the ' + limit + ' newest untagged ads. This runs in the background — refresh in a few minutes.'
      : 'Refreshing every ad from Meta. This runs in the background — refresh in a minute or two.' });
};
