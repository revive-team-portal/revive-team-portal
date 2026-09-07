// Wholesale sales roll-up for the Sales CRM.
//
// Pulls sales invoices (ACCREC) from Xero and attributes each one to a *store*, then
// stores them in sales.xero_orders so the CRM can show, next to each store, how many
// orders it has placed, the total value, the last order date and the usual gap between
// orders.
//
// Multi-org: the one Xero connection can see several organisations (Revivealicious Foods,
// Revive Cafes, ...). We enumerate them from /connections at sync time and pull invoices
// from each, tagging every order with the org it came from.
//
// The Foodstuffs wrinkle: every New World / Pak'nSave / Four Square order is billed to a
// SINGLE Xero contact ("Foodstuffs North Island"), with the actual store named on a $0
// "deliver to" line item (e.g. item 423801 = "New World Porirua"). So for a Foodstuffs
// invoice we read that line to find the real store; every other contact is its own store.
const X = require('./_xero');

const API = 'https://api.xero.com';
const APPS_URL = 'https://xcwrawjdfajlmbkdwlbm.supabase.co';
const APPS_KEY = process.env.APPS_SERVICE_ROLE_KEY;

async function salesDb(path, opts = {}) {
  const headers = {
    apikey: APPS_KEY, Authorization: 'Bearer ' + APPS_KEY, 'Content-Type': 'application/json',
    'Accept-Profile': 'sales', 'Content-Profile': 'sales', ...(opts.headers || {}),
  };
  const res = await fetch(APPS_URL + '/rest/v1/' + path, { ...opts, headers });
  const t = await res.text();
  if (!res.ok) throw new Error('DB ' + res.status + ': ' + t.slice(0, 240));
  return t ? JSON.parse(t) : null;
}

function salesKey(n) {
  return String(n || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’.]/g, '')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

function xInvoiceDate(inv) {
  if (inv.DateString) return String(inv.DateString).slice(0, 10);
  const m = String(inv.Date || '').match(/\/Date\((\d+)/);
  if (m) return new Date(Number(m[1])).toISOString().slice(0, 10);
  return null;
}

function firstDescLine(desc) {
  return String(desc || '')
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(s => s && !/^deliver\s*to:?$/i.test(s))[0] || '';
}

const BANNER_RE = /new world|pak\s*'?\s*n\s*save|paknsave|four\s*square|fresh\s*choice|raeward|gilmours|trents/i;

function titleCase(s){ return String(s||'').toLowerCase().split(/\s+/).filter(Boolean).map(w=>w.charAt(0).toUpperCase()+w.slice(1)).join(' '); }

function isBookLine(l){ return String(l.AccountCode||'')==='200' || /cookbook|cook:?\s*30|isbn|revive cafe cookbook/i.test(l.Description||''); }
function productTotal(inv){ let t=0; for(const l of (inv.LineItems||[])){ if(isBookLine(l)) continue; const net=Number(l.LineAmount)||0, tax=Number(l.TaxAmount)||0; t+=net+tax; } return Math.round(t*100)/100; }

function attribute(inv, imap) {
  const cname = (inv.Contact && inv.Contact.Name) || '';
  const lines = inv.LineItems || [];
  if (/foodstuffs/i.test(cname)) {
    let sl = lines.find(l => Number(l.LineAmount || 0) === 0 && (l.ItemCode || l.Description));
    let sname = '';
    if (sl) sname = (sl.ItemCode && imap[sl.ItemCode]) || firstDescLine(sl.Description) || '';
    if (!sname) {
      for (const l of lines) {
        const nm = l.ItemCode && imap[l.ItemCode];
        if (nm && BANNER_RE.test(nm)) { sname = nm; break; }
      }
    }
    if (!sname) sname = firstDescLine((lines[0] || {}).Description);
    return { store_name: sname || cname, source: 'foodstuffs' };
  }
  if (/farro/i.test(cname)) {
    const sl = lines.find(l => !l.ItemCode && (l.Description || '').trim());
    const raw = firstDescLine(sl ? sl.Description : (lines[0] || {}).Description);
    const loc = raw.replace(/^farro\s+/i, '').trim();
    if (!loc || /wopples/i.test(loc)) return { store_name: cname, source: 'farro' };
    return { store_name: 'Farro ' + titleCase(loc), source: 'farro' };
  }
  return { store_name: cname, source: 'direct' };
}

// ---- Xero calls against a specific organisation (tenant) ----
async function xeroGetT(path, params, token, tenantId) {
  const url = API + path + (params ? '?' + new URLSearchParams(params).toString() : '');
  const res = await fetch(url, {
    headers: { Authorization: 'Bearer ' + token, 'xero-tenant-id': tenantId, Accept: 'application/json' },
  });
  const text = await res.text();
  if (!res.ok) throw new Error('Xero ' + res.status + ': ' + text.slice(0, 200));
  return text ? JSON.parse(text) : null;
}

async function connections(token) {
  const res = await fetch(API + '/connections', {
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
  });
  const arr = await res.json().catch(() => []);
  return (Array.isArray(arr) ? arr : []).filter(c => c.tenantType === 'ORGANISATION');
}

async function itemsMap(token, tenantId) {
  const map = {};
  try {
    const d = await xeroGetT('/api.xro/2.0/Items', null, token, tenantId);
    for (const it of (d && d.Items) || []) if (it.Code) map[it.Code] = it.Name || '';
  } catch (e) { /* items read best-effort; description parsing is the fallback */ }
  return map;
}

async function fetchInvoices(fromYMD, token, tenantId) {
  const [y, m, d] = fromYMD.split('-').map(Number);
  const where = 'Type=="ACCREC" AND Date>=DateTime(' + y + ',' + m + ',' + d + ')';
  const out = [];
  for (let page = 1; page <= 60; page++) {
    const data = await xeroGetT('/api.xro/2.0/Invoices', { where, page: String(page), order: 'Date' }, token, tenantId);
    const inv = (data && data.Invoices) || [];
    if (!inv.length) break;
    out.push(...inv);
    if (inv.length < 100) break;
  }
  return out;
}

const KEEP = new Set(['AUTHORISED', 'PAID', 'SUBMITTED']);

async function runSync(opts = {}) {
  const full = !!opts.full;
  const now = new Date();
  const start = new Date(now);
  if (full) start.setUTCMonth(start.getUTCMonth() - 24);
  else start.setUTCDate(start.getUTCDate() - 40);
  const fromYMD = start.toISOString().slice(0, 10);

  await salesDb('xero_sync?id=eq.1', {
    method: 'PATCH', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ status: 'running', updated_at: new Date().toISOString() }),
  }).catch(() => {});

  const token = await X.accessToken();               // throws clear message if not configured/connected
  const orgs = await connections(token);
  if (!orgs.length) throw new Error('Xero is connected but no organisation was granted. Reconnect in the Recon app.');

  const rows = [];
  const orgNames = [];
  for (const org of orgs) {
    orgNames.push(org.tenantName);
    const imap = await itemsMap(token, org.tenantId);
    const invoices = await fetchInvoices(fromYMD, token, org.tenantId);
    for (const inv of invoices) {
      if (!KEEP.has(String(inv.Status || '').toUpperCase())) continue;
      const date = xInvoiceDate(inv);
      if (!date) continue;
      const pt = productTotal(inv);
      if (pt <= 0) continue;                 // cookbook-only / no Wopples value -> excluded
      const a = attribute(inv, imap);
      rows.push({
        invoice_id: inv.InvoiceID,
        invoice_number: inv.InvoiceNumber || '',
        reference: inv.Reference || '',
        contact_id: (inv.Contact && inv.Contact.ContactID) || '',
        contact_name: (inv.Contact && inv.Contact.Name) || '',
        store_key: salesKey(a.store_name),
        store_name: a.store_name,
        source: a.source,
        org: org.tenantName,
        tenant_id: org.tenantId,
        order_date: date,
        total: pt,
        status: String(inv.Status || '').toUpperCase(),
        synced_at: new Date().toISOString(),
      });
    }
  }

  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    await salesDb('xero_orders?on_conflict=invoice_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(chunk),
    });
  }

  let orderCount = rows.length, storeCount = new Set(rows.map(r => r.store_key)).size;
  try {
    const all = await salesDb('xero_orders?select=store_key');
    if (Array.isArray(all)) { orderCount = all.length; storeCount = new Set(all.map(r => r.store_key)).size; }
  } catch (e) {}

  const patch = {
    status: 'idle', last_run: new Date().toISOString(),
    order_count: orderCount, store_count: storeCount,
    note: (full ? 'Full 24-month sync' : 'Daily refresh') + ' · ' + rows.length + ' invoices · ' + orgNames.join(' + '),
    updated_at: new Date().toISOString(),
  };
  if (full) patch.last_full = new Date().toISOString();
  await salesDb('xero_sync?id=eq.1', {
    method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch),
  }).catch(() => {});

  return { upserted: rows.length, order_count: orderCount, store_count: storeCount, orgs: orgNames, from: fromYMD, full };
}

module.exports = { runSync, salesKey, salesDb };
