// Portal-gated trigger for the naughty-order courier scan. Fires the background worker and
// returns the current scan status. Frontend polls the naughty list + scan status.
const { json, validatePortalUser } = require('./_portal');
const { rest, hasKey } = require('./_appsdb');
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const a = await validatePortalUser(event, 'support');
  if (!a.ok) return json(a.status || 403, { error: a.error });
  if (!hasKey()) return json(500, { error: 'Not configured.' });
  let body = {}; try { body = JSON.parse(event.body || '{}'); } catch (e) {}
  const base = process.env.URL || 'https://team.revive.co.nz';
  fetch(base + '/.netlify/functions/support-naughty-scan-background?days=' + (Number(body.days) || 35), { method: 'POST' }).catch(() => {});
  try { await rest('naughty_scan?id=eq.1', { method:'PATCH', headers:{Prefer:'return=minimal'}, body: JSON.stringify({ status:'running', updated_at:new Date().toISOString() }) }); } catch (e) {}
  let status = null; try { const r = await rest('naughty_scan?id=eq.1&select=*'); status = (r && r[0]) || null; } catch (e) {}
  return json(202, { started: true, status });
};
