// Browser-facing trigger for the Xero sales sync. Portal-gated to `sales`; kicks off the
// background worker (fire-and-forget) and returns the current sync status row.
const { json, validatePortalUser } = require('./_portal');
const { salesDb } = require('./_xerosales');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const auth = await validatePortalUser(event, 'sales');
  if (!auth.ok) return json(auth.status || 403, { error: auth.error });

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) {}
  const full = !!body.full;

  const base = process.env.URL || 'https://team.revive.co.nz';
  // Fire-and-forget: the background function returns 202 immediately; the browser polls
  // sales.xero_orders / sales.xero_sync for completion.
  fetch(base + '/.netlify/functions/sales-xero-sync-background?full=' + (full ? '1' : '0'), { method: 'POST' }).catch(() => {});

  let status = null;
  try {
    await salesDb('xero_sync?id=eq.1', { method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'running', updated_at: new Date().toISOString() }) });
    const rows = await salesDb('xero_sync?id=eq.1&select=*');
    status = (rows && rows[0]) || null;
  } catch (e) {}

  return json(202, { started: true, full, status });
};
