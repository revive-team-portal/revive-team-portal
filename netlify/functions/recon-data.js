// Endpoint for the payment reconciliation app (/recon/).
// Gated on a logged-in portal user with access to 'recon'. Financial data, so no
// unauthenticated path and no CORS wildcard.
const crypto = require('crypto');
const { json, validatePortalUser } = require('./_portal');
const R = require('./_recon');
const X = require('./_xero');

function csvSplit(line) {
  // Handles quoted fields with embedded commas, as exported by banks and Xero.
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function parseDate(s) {
  const t = String(s || '').trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  m = t.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/); // NZ day-first
  if (m) {
    let y = m[3]; if (y.length === 2) y = '20' + y;
    return y + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[1]).padStart(2, '0');
  }
  return null;
}

function parseAmount(s) {
  const n = Number(String(s == null ? '' : s).replace(/[$,\s]/g, ''));
  return isFinite(n) ? n : null;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'POST only' };

  const gate = await validatePortalUser(event, 'recon');
  if (!gate.ok) return json(gate.status, { error: gate.error });

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Bad JSON.' }); }
  const action = body.action || 'summary';

  try {
    /* ---- pull the latest Shopify transactions for a period ---- */
    if (action === 'sync') {
      const from = body.from, to = body.to || R.todayNZ();
      if (!from) return json(400, { error: 'Need a start date.' });
      const res = await R.syncTxns(from, to);
      return json(200, res);
    }

    /* ---- import bank deposit lines (pasted CSV) ---- */
    if (action === 'import_bank') {
      const text = String(body.csv || '');
      const provider = body.provider || 'card';
      const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      if (!lines.length) return json(400, { error: 'Nothing to import.' });

      // Work out which columns hold the date, amount and reference.
      let di = 0, ai = 1, ri = 2, start = 0;
      const head = csvSplit(lines[0]).map(h => h.toLowerCase().trim());
      if (head.some(h => /date/.test(h)) && !parseDate(head[0])) {
        start = 1;
        head.forEach((h, i) => {
          if (/date/.test(h)) di = i;
          else if (/amount|credit|value|paid in/.test(h)) ai = i;
          else if (/ref|desc|particular|payee|details|narrat/.test(h) && ri === 2) ri = i;
        });
      }

      const rows = [], bad = [];
      for (let i = start; i < lines.length; i++) {
        const f = csvSplit(lines[i]);
        const d = parseDate(f[di]);
        const a = parseAmount(f[ai]);
        if (!d || a == null) { bad.push(lines[i].slice(0, 80)); continue; }
        if (a <= 0) continue; // deposits only; ignore fees/withdrawals
        const ref = (f[ri] || '').trim();
        rows.push({
          bank_date: d, amount: Math.round(a * 100) / 100, reference: ref.slice(0, 200),
          description: lines[i].slice(0, 300), source: 'import', provider,
          external_id: provider + '|' + d + '|' + a.toFixed(2) + '|' + ref.slice(0, 40),
        });
      }
      let written = 0;
      for (let i = 0; i < rows.length; i += 300) {
        await R.reconDb('bank?on_conflict=external_id', {
          method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(rows.slice(i, i + 300)),
        });
        written += Math.min(300, rows.length - i);
      }
      return json(200, { imported: written, skipped: bad.length, examples: bad.slice(0, 3) });
    }

    /* ---- Xero: connection status ---- */
    if (action === 'xero_status') {
      if (!X.configured()) return json(200, { configured: false, connected: false });
      const row = await X.getRow();
      if (!row || !row.refresh_token) return json(200, { configured: true, connected: false });
      let accounts = null, error = null;
      try { accounts = await X.bankAccounts(); }
      catch (e) { error = String(e.message || e).slice(0, 200); }
      return json(200, {
        configured: true, connected: !error, tenant_name: row.tenant_name,
        connected_at: row.connected_at, accounts, error,
      });
    }

    /* ---- Xero: start the consent flow ---- */
    if (action === 'xero_auth_url') {
      if (!X.configured()) return json(400, { error: 'Xero client ID and secret are not set in Netlify yet.' });
      const state = crypto.randomBytes(24).toString('hex');
      await X.saveRow({ state, state_at: new Date().toISOString() });
      return json(200, { url: X.authorizeUrl(state) });
    }

    if (action === 'xero_disconnect') {
      await X.saveRow({ refresh_token: null, tenant_id: null, tenant_name: null, state: null, connected_at: null });
      return json(200, { disconnected: true });
    }

    /* ---- Xero: pull real bank statement lines ---- */
    if (action === 'xero_pull') {
      const acct = body.account_id;
      if (!acct) return json(400, { error: 'Pick a bank account first.' });
      const f = body.from, t = body.to;
      if (!f || !t) return json(400, { error: 'Need a date range.' });

      const lines = await X.bankStatement(acct, f, t);
      const rows = [], unclassified = [];
      for (const l of lines) {
        const provider = X.classify(l);
        if (!provider) { unclassified.push(l); continue; }
        rows.push({
          bank_date: l.bank_date, amount: l.amount, reference: l.reference,
          description: l.description, source: 'xero', provider,
          reconciled: l.reconciled, bank_account_id: acct,
          external_id: 'xero|' + acct + '|' + l.bank_date + '|' + l.amount.toFixed(2) + '|' + (l.reference || '').slice(0, 40),
        });
      }
      for (let i = 0; i < rows.length; i += 300) {
        await R.reconDb('bank?on_conflict=external_id', {
          method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(rows.slice(i, i + 300)),
        });
      }
      await R.reconDb('run', {
        method: 'POST', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ kind: 'xero_pull', period_from: f, period_to: t, rows_in: rows.length,
          note: 'lines=' + lines.length + ' unclassified=' + unclassified.length }),
      }).catch(() => {});

      return json(200, {
        deposits_found: lines.length, imported: rows.length,
        unclassified: unclassified.length,
        unclassified_examples: unclassified.slice(0, 8).map(u => ({ date: u.bank_date, amount: u.amount, ref: u.reference })),
      });
    }

    if (action === 'clear_bank') {
      await R.reconDb('bank?bank_date=gte.' + encodeURIComponent(body.from || '1900-01-01') +
        '&bank_date=lte.' + encodeURIComponent(body.to || '2999-01-01'), { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      return json(200, { cleared: true });
    }

    /* ---- the reconciliation itself ---- */
    const from = body.from || R.todayNZ().slice(0, 8) + '01';
    const to = body.to || R.todayNZ();
    const cutoff = body.cutoff === 'nz' ? 'nz' : 'utc';
    const lag = { card: Number(body.lag_card != null ? body.lag_card : 2), afterpay: Number(body.lag_afterpay != null ? body.lag_afterpay : 2) };

    // Pull a couple of days either side so batches at the period edges are whole.
    const txns = await R.reconDbAll('txn?select=txn_id,txn_processed_at,nz_date,kind,status,gateway,amount,fee,is_test,order_name' +
      '&nz_date=gte.' + R.addDays(from, -2) + '&nz_date=lte.' + R.addDays(to, 2) + '&order=txn_id');
    const inPeriod = txns.filter(t => t.nz_date >= from && t.nz_date <= to);

    const bank = await R.reconDbAll('bank?select=id,bank_date,amount,reference,provider' +
      '&bank_date=gte.' + from + '&bank_date=lte.' + R.addDays(to, 10) + '&order=id') || [];

    const batches = R.buildBatches(inPeriod, { cutoff, lag });
    const { rows, unmatchedBank } = R.matchBatches(batches, bank);

    // Headline totals per rail.
    const byRail = {};
    for (const t of inPeriod) {
      if (t.status !== 'SUCCESS' || t.is_test) continue;
      if (!['SALE', 'CAPTURE', 'REFUND'].includes(t.kind)) continue;
      const rail = R.railOf(t.gateway);
      const b = byRail[rail] || (byRail[rail] = { rail, label: R.RAIL_LABEL[rail], gross: 0, refunds: 0, fees: 0, n: 0 });
      if (t.kind === 'REFUND') b.refunds += Number(t.amount);
      else { b.gross += Number(t.amount); b.n++; }
      b.fees += Number(t.fee);
    }
    const rails = Object.values(byRail).map(b => ({
      ...b, gross: R.money(b.gross), refunds: R.money(b.refunds), fees: R.money(b.fees),
      expected_net: R.money(b.gross - b.refunds - b.fees),
    })).sort((a, b) => b.gross - a.gross);

    // Money actually banked, per rail, over the same window.
    const banked = {};
    for (const b of bank) banked[b.provider || 'card'] = R.money((banked[b.provider || 'card'] || 0) + Number(b.amount));

    return json(200, {
      period: { from, to }, cutoff, lag,
      rails, banked,
      cutoff_impact: R.cutoffImpact(inPeriod),
      batches: rows,
      unmatched_bank: unmatchedBank,
      solver: R.solve(inPeriod, bank),
      totals: {
        gross: R.money(rails.reduce((s, r) => s + r.gross, 0)),
        refunds: R.money(rails.reduce((s, r) => s + r.refunds, 0)),
        fees: R.money(rails.reduce((s, r) => s + r.fees, 0)),
        expected_net: R.money(rails.reduce((s, r) => s + r.expected_net, 0)),
        banked: R.money(Object.values(banked).reduce((s, v) => s + v, 0)),
      },
      has_bank: bank.length > 0,
    });
  } catch (e) {
    return json(500, { error: String(e.message || e).slice(0, 400) });
  }
};
