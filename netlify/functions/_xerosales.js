// Wholesale sales roll-up for the Sales CRM.
//
// Pulls sales invoices (ACCREC) from Xero and attributes each one to a *store*, then
// stores them in sales.xero_orders so the CRM can show, next to each store, how many
// orders it has placed, the total value, the last order date and the usual gap between
// orders.
//
// The wrinkle is Foodstuffs: every New World / Pak'nSave / Four Square order is billed
// to a SINGLE Xero contact ("Foodstuffs North Island"), with the actual store named on a
// $0 "deliver to" line item (e.g. item 423801 = "New World Porirua"). So for a Foodstuffs
// invoice we read that line to find the real store; every other contact is its own store.
const { xeroGet } = require('./_xero');

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

// Normalised match key -- lower-cased, alphanumerics only (spaces, dashes, apostrophes and
// "&"->"and" folded away). Used identically on the browser to line an invoice up with a
// CRM store row. "Four Square - Raumati Beach" and "Four Square Raumati Beach" collapse to
// the same key; "FreshChoice Greytown " (trailing space) matches "FreshChoice Greytown".
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

// Which store does this invoice belong to?
function attribute(inv, imap) {
  const cname = (inv.Contact && inv.Contact.Name) || '';
  const lines = inv.LineItems || [];
  if (/foodstuffs/i.test(cname)) {
    // The store sits on the $0 delivery line.
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
  return { store_name: cname, source: 'direct' };
}

// code -> item name, so a Foodstuffs $0 line's ItemCode resolves to the store name.
async function itemsMap() {
  const map = {};
  try {
    const d = await xeroGet('/api.xro/2.0/Items');
    for (const it of (d && d.Items) || []) if (it.Code) map[it.Code] = it.Name || '';
  } catch (e) { /* items read is best-effort; description parsing is the fallback */ }
  return map;
}

// Page through ACCREC invoices dated on/after `fromYMD`. Xero returns 100 per page WITH
// line items (needed for the Foodstuffs store line).
async function fetchInvoices(fromYMD) {
  const [y, m, d] = fromYMD.split('-').map(Number);
  const where = 'Type=="ACCREC" AND Date>=DateTime(' + y + ',' + m + ',' + d + ')';
  const out = [];
  for (let page = 1; page <= 60; page++) {
    const data = await xeroGet('/api.xro/2.0/Invoices', { where, page: String(page), order: 'Date' });
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

  const imap = await itemsMap();
  const invoices = await fetchInvoices(fromYMD);

  const rows = [];
  for (const inv of invoices) {
    if (!KEEP.has(String(inv.Status || '').toUpperCase())) continue;
    const date = xInvoiceDate(inv);
    if (!date) continue;
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
      order_date: date,
      total: Math.round((Number(inv.Total) || 0) * 100) / 100,
      status: String(inv.Status || '').toUpperCase(),
      synced_at: new Date().toISOString(),
    });
  }

  // Upsert in chunks (merge on invoice_id).
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    await salesDb('xero_orders?on_conflict=invoice_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(chunk),
    });
  }

  // Totals for the status line.
  let orderCount = rows.length, storeCount = new Set(rows.map(r => r.store_key)).size;
  try {
    const all = await salesDb('xero_orders?select=store_key');
    if (Array.isArray(all)) { orderCount = all.length; storeCount = new Set(all.map(r => r.store_key)).size; }
  } catch (e) {}

  const patch = {
    status: 'idle', last_run: new Date().toISOString(),
    order_count: orderCount, store_count: storeCount,
    note: (full ? 'Full 24-month sync' : 'Daily refresh') + ' · ' + rows.length + ' invoices',
    updated_at: new Date().toISOString(),
  };
  if (full) patch.last_full = new Date().toISOString();
  await salesDb('xero_sync?id=eq.1', {
    method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch),
  }).catch(() => {});

  return { upserted: rows.length, order_count: orderCount, store_count: storeCount, from: fromYMD, full };
}

module.exports = { runSync, salesKey, salesDb };
