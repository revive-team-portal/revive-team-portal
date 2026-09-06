// Heavy Xero -> sales.xero_orders sync. Background function (up to 15 min) because a full
// 24-month backfill pages through every ACCREC invoice with line items. Called by the
// daily schedule (netlify.toml) and by sales-xero-refresh when a user hits "Sync sales".
// No auth: server-side only, writes to our own DB, returns no customer data to the caller.
const { runSync } = require('./_xerosales');
exports.handler = async (event) => {
  const qs = (event && event.queryStringParameters) || {};
  const full = qs.full === '1' || qs.full === 'true';
  try {
    const r = await runSync({ full });
    console.log('sales-xero-sync', JSON.stringify(r));
    return { statusCode: 200, body: JSON.stringify(r) };
  } catch (e) {
    console.log('sales-xero-sync error', String((e && e.message) || e));
    try {
      const { salesDb } = require('./_xerosales');
      await salesDb('xero_sync?id=eq.1', { method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'error', note: String((e && e.message) || e).slice(0, 240), updated_at: new Date().toISOString() }) });
    } catch (e2) {}
    return { statusCode: 500, body: String((e && e.message) || e) };
  }
};
