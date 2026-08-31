// Xero Accounting API helper for the recon app.
//
// Standard OAuth 2.0 authorisation-code flow with offline_access. Xero ROTATES the
// refresh token on every use: the old one dies the moment a new one is issued, so the
// new value must be persisted before anything else can fail. A refresh token also
// expires outright after 60 days of no use, which is why the monthly job matters --
// if nothing calls Xero for two months the connection must be re-authorised by hand.
const { reconDb } = require('./_recon');

const CID = process.env.XERO_CLIENT_ID;
const SECRET = process.env.XERO_CLIENT_SECRET;
const REDIRECT = 'https://team.revive.co.nz/.netlify/functions/xero-callback';
const IDENTITY = 'https://identity.xero.com/connect/token';
const AUTHORIZE = 'https://login.xero.com/identity/connect/authorize';
const API = 'https://api.xero.com';

// accounting.reports.read is what the BankStatement report needs; settings gets the
// bank account list; transactions is the cross-check against entered transactions.
const SCOPES = 'openid profile email offline_access accounting.settings.read accounting.reports.read accounting.transactions.read';

let _access = null; // { token, exp } cached in warm-container scope only

function configured() { return !!(CID && SECRET); }

function basicAuth() {
  return 'Basic ' + Buffer.from(CID + ':' + SECRET).toString('base64');
}

async function getRow() {
  const rows = await reconDb('oauth?provider=eq.xero&select=*');
  return (rows && rows[0]) || null;
}

async function saveRow(patch) {
  const existing = await getRow();
  const body = JSON.stringify({ provider: 'xero', ...patch, updated_at: new Date().toISOString() });
  if (existing) {
    await reconDb('oauth?provider=eq.xero', { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body });
  } else {
    await reconDb('oauth', { method: 'POST', headers: { Prefer: 'return=minimal' }, body });
  }
}

/* ---------- connect ---------- */

function authorizeUrl(state) {
  const p = new URLSearchParams({
    response_type: 'code', client_id: CID, redirect_uri: REDIRECT, scope: SCOPES, state,
  });
  return AUTHORIZE + '?' + p.toString();
}

async function exchangeCode(code) {
  const res = await fetch(IDENTITY, {
    method: 'POST',
    headers: { Authorization: basicAuth(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT }),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || !d.access_token) {
    throw new Error('Xero token exchange failed: ' + (d.error_description || d.error || ('HTTP ' + res.status)));
  }
  // Which organisations did the user actually grant? Pick the one they consented to.
  const conns = await fetch(API + '/connections', {
    headers: { Authorization: 'Bearer ' + d.access_token, 'Content-Type': 'application/json' },
  }).then(r => r.json()).catch(() => []);
  const tenant = Array.isArray(conns) ? conns.find(c => c.tenantType === 'ORGANISATION') || conns[0] : null;
  if (!tenant) throw new Error('Xero returned no organisation for this login.');

  await saveRow({
    refresh_token: d.refresh_token, tenant_id: tenant.tenantId,
    tenant_name: tenant.tenantName, scopes: SCOPES, state: null,
    connected_at: new Date().toISOString(),
  });
  _access = { token: d.access_token, exp: Date.now() + (Number(d.expires_in || 1800) * 1000) };
  return { tenant_name: tenant.tenantName, tenant_id: tenant.tenantId };
}

/* ---------- use ---------- */

async function accessToken() {
  if (_access && Date.now() < _access.exp - 60000) return _access.token;
  if (!configured()) throw new Error('Xero is not configured (XERO_CLIENT_ID / XERO_CLIENT_SECRET).');
  const row = await getRow();
  if (!row || !row.refresh_token) throw new Error('Xero is not connected yet. Use Connect Xero first.');

  const res = await fetch(IDENTITY, {
    method: 'POST',
    headers: { Authorization: basicAuth(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: row.refresh_token }),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || !d.access_token) {
    throw new Error('Xero sign-in expired (' + (d.error || ('HTTP ' + res.status)) + '). Reconnect Xero.');
  }
  // Persist the rotated refresh token FIRST -- if this write is skipped the connection
  // is dead on the next run, because Xero has already invalidated the old one.
  if (d.refresh_token && d.refresh_token !== row.refresh_token) {
    await saveRow({ refresh_token: d.refresh_token });
  }
  _access = { token: d.access_token, exp: Date.now() + (Number(d.expires_in || 1800) * 1000) };
  return _access.token;
}

async function xeroGet(path, params) {
  const row = await getRow();
  const token = await accessToken();
  const url = API + path + (params ? '?' + new URLSearchParams(params).toString() : '');
  const res = await fetch(url, {
    headers: {
      Authorization: 'Bearer ' + token,
      'xero-tenant-id': row.tenant_id,
      Accept: 'application/json',
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error('Xero ' + res.status + ': ' + text.slice(0, 240));
  return text ? JSON.parse(text) : null;
}

async function bankAccounts() {
  const d = await xeroGet('/api.xro/2.0/Accounts', { where: 'Type=="BANK"' });
  return (d.Accounts || []).map(a => ({
    account_id: a.AccountID, name: a.Name, code: a.Code,
    number: a.BankAccountNumber, currency: a.CurrencyCode, status: a.Status,
  }));
}

// The BankStatement report returns real statement lines -- what the bank actually did --
// rather than BankTransactions, which only shows what has been entered into Xero.
async function bankStatement(accountId, fromDate, toDate) {
  const d = await xeroGet('/api.xro/2.0/Reports/BankStatement', {
    bankAccountID: accountId, fromDate, toDate,
  });
  const rep = (d.Reports || [])[0];
  if (!rep) return [];

  // Column order varies by org, so read the header row instead of assuming positions.
  const idx = {};
  const header = (rep.Rows || []).find(r => r.RowType === 'Header');
  ((header && header.Cells) || []).forEach((c, i) => {
    const v = String(c.Value || '').toLowerCase().trim();
    if (v === 'date') idx.date = i;
    else if (v === 'description') idx.desc = i;
    else if (v === 'reference') idx.ref = i;
    else if (v === 'reconciled') idx.rec = i;
    else if (v.startsWith('received') || v === 'credit') idx.received = i;
    else if (v.startsWith('spent') || v === 'debit') idx.spent = i;
    else if (v === 'source') idx.source = i;
  });
  if (idx.date == null) idx.date = 0;

  const out = [];
  for (const section of (rep.Rows || [])) {
    if (section.RowType !== 'Section') continue;
    for (const row of (section.Rows || [])) {
      if (row.RowType !== 'Row') continue;
      const cell = i => (i == null ? '' : String(((row.Cells || [])[i] || {}).Value || '').trim());
      const received = Number(String(cell(idx.received)).replace(/[$,]/g, '')) || 0;
      if (received <= 0) continue; // deposits only
      const raw = cell(idx.date);
      const date = /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : isoFromXeroDate(raw);
      if (!date) continue;
      out.push({
        bank_date: date,
        amount: Math.round(received * 100) / 100,
        reference: (cell(idx.ref) || cell(idx.desc)).slice(0, 200),
        description: [cell(idx.desc), cell(idx.ref), cell(idx.source)].filter(Boolean).join(' | ').slice(0, 300),
        reconciled: /yes|true/i.test(cell(idx.rec)) || null,
      });
    }
  }
  return out;
}

function isoFromXeroDate(s) {
  if (!s) return null;
  let m = String(s).match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/); // "4 Aug 2026"
  const MON = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
                jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
  if (m) return m[3] + '-' + MON[m[2].toLowerCase()] + '-' + String(m[1]).padStart(2, '0');
  m = String(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); // NZ day-first
  if (m) return m[3] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[1]).padStart(2, '0');
  const d = new Date(s);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

// Work out which rail a deposit belongs to from what the bank wrote on it.
function classify(line) {
  const s = (line.description + ' ' + line.reference).toLowerCase();
  if (/afterpay|clearpay/.test(s)) return 'afterpay';
  if (/shopify|stripe/.test(s)) return 'card';
  return null;
}

module.exports = {
  configured, authorizeUrl, exchangeCode, accessToken, xeroGet,
  bankAccounts, bankStatement, classify, getRow, saveRow, REDIRECT, SCOPES,
};
