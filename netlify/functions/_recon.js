// Shared logic for the payment reconciliation app.
//
// The problem it solves: Shopify records a SALE the instant the customer pays, in the
// store's timezone. The money arrives in the bank days later, batched into a settlement
// that is cut at a fixed instant -- which is NOT NZ midnight -- and net of processing
// fees. Afterpay settles separately and deducts its merchant fee before paying, so the
// bank line never equals the Shopify sale total. Comparing gross NZ-day sales to bank
// deposits therefore never balances, which is what makes this look like missing money.
//
// So we rebuild the expected settlements from transaction-level data, and let the
// cut-off and lag be SOLVED from the actual bank deposits rather than assumed.
const { gql } = require('./_shopify');

const APPS_URL = 'https://xcwrawjdfajlmbkdwlbm.supabase.co';
const APPS_KEY = process.env.APPS_SERVICE_ROLE_KEY;

async function reconDb(path, opts = {}) {
  const headers = {
    apikey: APPS_KEY, Authorization: 'Bearer ' + APPS_KEY, 'Content-Type': 'application/json',
    'Accept-Profile': 'recon', 'Content-Profile': 'recon', ...(opts.headers || {}),
  };
  const res = await fetch(APPS_URL + '/rest/v1/' + path, { ...opts, headers });
  const t = await res.text();
  if (!res.ok) throw new Error('DB ' + res.status + ': ' + t.slice(0, 240));
  return t ? JSON.parse(t) : null;
}

// PostgREST caps every response at db-max-rows (1000 on Supabase) regardless of any
// limit in the query, so a single call silently truncates a busy month. Always page.
async function reconDbAll(path, pageSize = 1000) {
  const sep = path.includes('?') ? '&' : '?';
  let out = [], offset = 0;
  for (let guard = 0; guard < 500; guard++) {
    const page = await reconDb(path + sep + 'limit=' + pageSize + '&offset=' + offset);
    if (!Array.isArray(page) || !page.length) break;
    out = out.concat(page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return out;
}

/* ---------- dates ---------- */
const nzFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit',
});
function nzDate(iso) { return nzFmt.format(new Date(iso)); }
function utcDate(iso) { return new Date(iso).toISOString().slice(0, 10); }
function todayNZ() { return nzFmt.format(new Date()); }
function addDays(ymd, n) {
  const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function dow(ymd) { return new Date(ymd + 'T00:00:00Z').getUTCDay(); } // 0=Sun 6=Sat
// Providers settle on business days only: a batch cut on Friday lands the following week.
function addBusinessDays(ymd, n) {
  let d = ymd, left = n;
  while (left > 0) { d = addDays(d, 1); const w = dow(d); if (w !== 0 && w !== 6) left--; }
  while (dow(d) === 0 || dow(d) === 6) d = addDays(d, 1);
  return d;
}
function money(x) { return Math.round(Number(x || 0) * 100) / 100; }

/* ---------- rails ---------- */
// Shopify reports Afterpay under a couple of gateway spellings; normalise them.
function railOf(gateway) {
  const g = String(gateway || '').toLowerCase();
  if (g.includes('shopify_payments')) return 'card';
  if (g.includes('afterpay')) return 'afterpay';
  return 'other';
}
const RAIL_LABEL = { card: 'Shopify Payments', afterpay: 'Afterpay', other: 'Other / manual' };

/* ---------- ingest from Shopify ---------- */
const ORDERS_Q = `query($q:String!,$after:String){
  orders(first:250, query:$q, after:$after, sortKey: PROCESSED_AT){
    pageInfo{ hasNextPage endCursor }
    nodes{
      id name processedAt cancelledAt test
      transactions{
        id kind status gateway processedAt createdAt paymentId
        amountSet{ shopMoney{ amount } }
        fees{ amount{ amount } }
      }
    }
  }
}`;

// Pulls orders processed in [fromNZ, toNZ] (NZ dates) and upserts their transactions.
// Note: the portal's Shopify app can only see the last 60 days of orders, which is fine
// for a monthly run but means older periods must be backfilled another way.
async function syncTxns(fromNZ, toNZ) {
  const startUTC = addDays(fromNZ, -2) + 'T00:00:00Z';
  const endUTC = addDays(toNZ, 2) + 'T00:00:00Z';
  const q = `processed_at:>='${startUTC}' AND processed_at:<='${endUTC}'`;

  let after = null, rows = [], orders = 0;
  for (let guard = 0; guard < 200; guard++) {
    const d = await gql(ORDERS_Q, { q, after });
    const o = d && d.orders; if (!o) break;
    for (const ord of o.nodes) {
      orders++;
      for (const t of (ord.transactions || [])) {
        if (!t || !t.id) continue;
        const when = t.processedAt || t.createdAt || ord.processedAt;
        const nd = nzDate(when);
        if (nd < fromNZ || nd > toNZ) continue;
        rows.push({
          txn_id: t.id, order_id: ord.id, order_name: ord.name || null,
          order_processed_at: ord.processedAt || null, txn_processed_at: when, nz_date: nd,
          kind: t.kind || 'UNKNOWN', status: t.status || 'UNKNOWN',
          gateway: t.gateway || null, payment_id: t.paymentId || null,
          amount: money(t.amountSet && t.amountSet.shopMoney && t.amountSet.shopMoney.amount),
          fee: money((t.fees || []).reduce((s, f) => s + Number((f.amount && f.amount.amount) || 0), 0)),
          is_test: !!ord.test, order_cancelled: !!ord.cancelledAt,
        });
      }
    }
    if (!o.pageInfo.hasNextPage) break;
    after = o.pageInfo.endCursor;
  }
  for (let i = 0; i < rows.length; i += 500) {
    await reconDb('txn?on_conflict=txn_id', {
      method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(rows.slice(i, i + 500)),
    });
  }
  await reconDb('run', {
    method: 'POST', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ kind: 'sync', period_from: fromNZ, period_to: toNZ, rows_in: rows.length, note: 'orders=' + orders }),
  }).catch(() => {});
  return { orders, txns: rows.length };
}

/* ---------- batching ---------- */
// cutoff 'nz'  -> batch by NZ calendar day (what a human assumes)
// cutoff 'utc' -> batch by UTC calendar day, i.e. the day rolls at NOON NZ time
function batchDateFor(iso, cutoff) { return cutoff === 'utc' ? utcDate(iso) : nzDate(iso); }

// Turns raw transactions into per-rail settlement batches with an expected deposit date.
function buildBatches(txns, opts) {
  const { cutoff, lag } = opts;
  const map = new Map();
  for (const t of txns) {
    if (t.status !== 'SUCCESS') continue;
    if (t.is_test) continue;
    if (!['SALE', 'CAPTURE', 'REFUND'].includes(t.kind)) continue;
    const rail = railOf(t.gateway);
    if (rail === 'other') continue; // cash/manual never lands as a provider settlement
    const bd = batchDateFor(t.txn_processed_at, cutoff);
    const key = rail + '|' + bd;
    let b = map.get(key);
    if (!b) { b = { rail, batch_date: bd, gross: 0, refunds: 0, fees: 0, n: 0 }; map.set(key, b); }
    if (t.kind === 'REFUND') b.refunds += Number(t.amount);
    else { b.gross += Number(t.amount); b.n++; }
    b.fees += Number(t.fee);
  }
  const out = [...map.values()].map(b => {
    const lagDays = (lag && lag[b.rail] != null) ? lag[b.rail] : 2;
    return {
      ...b,
      gross: money(b.gross), refunds: money(b.refunds), fees: money(b.fees),
      expected_net: money(b.gross - b.refunds - b.fees),
      expected_date: addBusinessDays(b.batch_date, lagDays),
    };
  });
  out.sort((a, b) => (a.batch_date < b.batch_date ? -1 : a.batch_date > b.batch_date ? 1 : a.rail < b.rail ? -1 : 1));
  return out;
}

/* ---------- matching ---------- */
// Compare expected settlements to real bank deposits, per rail, per expected date.
function matchBatches(batches, bank) {
  const bankByRailDate = new Map();
  for (const b of bank) {
    const rail = b.provider || 'card';
    const k = rail + '|' + b.bank_date;
    if (!bankByRailDate.has(k)) bankByRailDate.set(k, []);
    bankByRailDate.get(k).push(b);
  }
  const used = new Set();
  const rows = batches.map(b => {
    const k = b.rail + '|' + b.expected_date;
    const cands = bankByRailDate.get(k) || [];
    let hit = null;
    // Prefer an exact-cent match, then the closest deposit on that day.
    for (const c of cands) {
      if (used.has(c.id)) continue;
      if (Math.abs(Number(c.amount) - b.expected_net) < 0.005) { hit = c; break; }
    }
    if (!hit) {
      let best = null, bestDiff = Infinity;
      for (const c of cands) {
        if (used.has(c.id)) continue;
        const d = Math.abs(Number(c.amount) - b.expected_net);
        if (d < bestDiff) { best = c; bestDiff = d; }
      }
      hit = best;
    }
    if (hit) used.add(hit.id);
    return {
      ...b,
      bank_amount: hit ? money(hit.amount) : null,
      bank_reference: hit ? (hit.reference || '') : null,
      variance: hit ? money(Number(hit.amount) - b.expected_net) : null,
      status: !hit ? 'no deposit found'
        : Math.abs(Number(hit.amount) - b.expected_net) < 0.005 ? 'matched'
        : 'variance',
    };
  });
  const unmatchedBank = bank.filter(b => !used.has(b.id))
    .map(b => ({ id: b.id, bank_date: b.bank_date, amount: money(b.amount), reference: b.reference, provider: b.provider }));
  return { rows, unmatchedBank };
}

// Search cut-off x lag for the combination that best explains the actual deposits.
// This is how we answer "is the cut-off midnight?" with evidence instead of a guess.
function solve(txns, bank) {
  if (!bank.length) return null;
  const results = [];
  for (const cutoff of ['nz', 'utc']) {
    for (let lagCard = 0; lagCard <= 6; lagCard++) {
      for (let lagAp = 0; lagAp <= 6; lagAp++) {
        const batches = buildBatches(txns, { cutoff, lag: { card: lagCard, afterpay: lagAp } });
        const { rows } = matchBatches(batches, bank);
        let exact = 0, absErr = 0, missing = 0;
        for (const r of rows) {
          if (r.bank_amount == null) { missing++; absErr += Math.abs(r.expected_net); continue; }
          absErr += Math.abs(r.variance);
          if (r.status === 'matched') exact++;
        }
        results.push({ cutoff, lag_card: lagCard, lag_afterpay: lagAp, exact_matches: exact, missing, abs_error: money(absErr) });
      }
    }
  }
  results.sort((a, b) => (b.exact_matches - a.exact_matches) || (a.abs_error - b.abs_error));
  return { best: results[0], top: results.slice(0, 8) };
}

/* ---------- how much the cut-off assumption is worth ---------- */
// Quantifies the money that changes calendar day depending on the cut-off used.
function cutoffImpact(txns) {
  let swing = 0, total = 0, n = 0;
  for (const t of txns) {
    if (t.status !== 'SUCCESS' || t.kind === 'REFUND' || t.is_test) continue;
    if (railOf(t.gateway) === 'other') continue;
    total += Number(t.amount);
    if (nzDate(t.txn_processed_at) !== utcDate(t.txn_processed_at)) { swing += Number(t.amount); n++; }
  }
  return { swing: money(swing), total: money(total), txns: n, pct: total ? Math.round(1000 * swing / total) / 10 : 0 };
}

module.exports = {
  reconDb, reconDbAll, nzDate, utcDate, todayNZ, addDays, addBusinessDays, money,
  railOf, RAIL_LABEL, syncTxns, buildBatches, matchBatches, solve, cutoffImpact,
};
