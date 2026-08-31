// TEMPORARY backfill: pulls a Shopify bulk-operation JSONL of orders+transactions and
// loads it into recon.txn. Guarded by a SHA-256 hash of a one-time operator key.
// DELETE once the Apr-Aug backfill is loaded; ongoing sync is recon-sync.js.
const crypto = require('crypto');

const KEY_HASH = '7f10988a658d5af94698b56ab5dd927e728633f18336fa9fe3bc12707246f85a';
const APPS_URL = 'https://xcwrawjdfajlmbkdwlbm.supabase.co';
const APPS_KEY = process.env.APPS_SERVICE_ROLE_KEY;

async function reconDb(path, opts = {}) {
  const headers = {
    apikey: APPS_KEY, Authorization: 'Bearer ' + APPS_KEY, 'Content-Type': 'application/json',
    'Accept-Profile': 'recon', 'Content-Profile': 'recon', ...(opts.headers || {}),
  };
  const res = await fetch(APPS_URL + '/rest/v1/' + path, { ...opts, headers });
  const t = await res.text();
  if (!res.ok) throw new Error('DB ' + res.status + ': ' + t.slice(0, 300));
  return t ? JSON.parse(t) : null;
}

const nzFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit',
});
function nzDate(iso) { return nzFmt.format(new Date(iso)); }
function num(x) { return Number(x || 0); }

exports.handler = async (event) => {
  const hdr = (event.headers || {})['x-recon-key'] || '';
  if (!hdr || crypto.createHash('sha256').update(hdr).digest('hex') !== KEY_HASH) {
    return { statusCode: 403, body: 'nope' };
  }
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) { /* noop */ }
  const url = body.url;
  if (!url) return { statusCode: 400, body: 'need url' };

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('bulk fetch HTTP ' + res.status);
    const text = await res.text();
    const lines = text.split('\n').filter(Boolean);

    const rows = [];
    let orders = 0, skipped = 0;
    for (const line of lines) {
      let o;
      try { o = JSON.parse(line); } catch (e) { continue; }
      // Bulk output inlines non-connection list fields, so each order line carries
      // its own transactions. Anything without an order id is a stray child record.
      if (!o.id || !String(o.id).includes('/Order/')) { skipped++; continue; }
      orders++;
      const txs = o.transactions || [];
      for (const t of txs) {
        if (!t || !t.id) continue;
        const feeTotal = (t.fees || []).reduce((s, f) => s + num(f.amount && f.amount.amount), 0);
        const when = t.processedAt || t.createdAt || o.processedAt;
        rows.push({
          txn_id: t.id,
          order_id: o.id,
          order_name: o.name || null,
          order_processed_at: o.processedAt || null,
          txn_processed_at: when,
          nz_date: nzDate(when),
          kind: t.kind || 'UNKNOWN',
          status: t.status || 'UNKNOWN',
          gateway: t.gateway || null,
          payment_id: t.paymentId || null,
          amount: num(t.amountSet && t.amountSet.shopMoney && t.amountSet.shopMoney.amount),
          fee: feeTotal,
          is_test: !!o.test,
          order_cancelled: !!o.cancelledAt,
        });
      }
    }

    let written = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      await reconDb('txn?on_conflict=txn_id', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(chunk),
      });
      written += chunk.length;
    }

    await reconDb('run', {
      method: 'POST', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        kind: 'bulk_backfill', rows_in: written,
        note: 'orders=' + orders + ' txns=' + rows.length + ' skipped=' + skipped + ' lines=' + lines.length,
      }),
    });
    return { statusCode: 200, body: JSON.stringify({ orders, txns: rows.length, written }) };
  } catch (e) {
    await reconDb('run', {
      method: 'POST', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ kind: 'bulk_backfill_error', note: String(e.message || e).slice(0, 400) }),
    }).catch(() => {});
    return { statusCode: 500, body: String(e.message || e) };
  }
};
