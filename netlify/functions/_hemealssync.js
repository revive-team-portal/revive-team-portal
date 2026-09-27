// ONE Shopify line-item bulk pass -> weekly heat_eat_sold, muesli_sold, catering_sales,
// online_cogs. A single bulk operation (Shopify allows only one per shop at a time —
// running two syncs concurrently made one read the other's result and write zeros).
// Polls its OWN operation id, never `currentBulkOperation`. Only writes weeks whose full
// Sat–Fri span lies inside the fetched range, so a boundary week is never a partial sum.
// A "meal" = one reheat meal; "(N items)" bundles count as N. Never clobbers an override.
const { gql } = require('./_shopify');
const APPS_URL = 'https://xcwrawjdfajlmbkdwlbm.supabase.co';
const APPS_KEY = process.env.APPS_SERVICE_ROLE_KEY;
async function appsDb(path, opts = {}) {
  const headers = { apikey: APPS_KEY, Authorization: 'Bearer ' + APPS_KEY, 'Content-Type': 'application/json',
    'Accept-Profile': 'scoreboard', 'Content-Profile': 'scoreboard', ...(opts.headers || {}) };
  const res = await fetch(APPS_URL + '/rest/v1/' + path, { ...opts, headers });
  const t = await res.text(); if (!res.ok) throw new Error('DB ' + res.status + ': ' + t.slice(0, 160));
  return t ? JSON.parse(t) : null;
}
function nzDate(iso) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso)); }
function weekEndFri(ymd) { const d = new Date(ymd + 'T00:00:00Z'); const add = (5 - d.getUTCDay() + 7) % 7; d.setUTCDate(d.getUTCDate() + add); return d.toISOString().slice(0, 10); }
function addDays(ymd, n) { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MEAL_TYPES = new Set(['Reheat', 'Heat & Eat Meals']);
const MUESLI_TYPES = new Set(['Mueslis']);
const CATERING_TYPES = new Set(['Catering']);
function mealsPerUnit(title) { const m = /\((\d+)\s*items?/i.exec(title || ''); return m ? Math.max(1, parseInt(m[1], 10)) : 1; }

async function startBulk(start, end) {
  const inner = '{ orders(query: "created_at:>=' + start + ' created_at:<=' + end + '") { edges { node { id createdAt lineItems { edges { node { quantity discountedTotalSet { shopMoney { amount } } product { productType title } variant { inventoryItem { unitCost { amount } } } } } } } } } }';
  const m = 'mutation($q:String!){ bulkOperationRunQuery(query:$q){ bulkOperation{ id status } userErrors{ field message } } }';
  for (let attempt = 0; attempt < 12; attempt++) {
    const d = await gql(m, { q: inner });
    const r = d.bulkOperationRunQuery;
    const errs = (r.userErrors || []).map(e => e.message).join('; ');
    if (!errs && r.bulkOperation && r.bulkOperation.id) return r.bulkOperation.id;
    if (/already in progress|running/i.test(errs)) { await sleep(10000); continue; }   // another op running: wait, don't steal it
    throw new Error('bulk start: ' + errs);
  }
  throw new Error('bulk start: another bulk operation stayed busy');
}
async function pollBulk(id) {
  for (let i = 0; i < 240; i++) {
    const d = await gql('query($id:ID!){ node(id:$id){ ... on BulkOperation { id status errorCode objectCount url } } }', { id });
    const op = (d && d.node) || {};
    if (op.status === 'COMPLETED') return op;
    if (op.status === 'FAILED' || op.status === 'CANCELED') throw new Error('bulk ' + op.status + ' ' + (op.errorCode || ''));
    await sleep(2500);
  }
  throw new Error('bulk timeout');
}

async function syncHeatEat(start, end) {
  const id = await startBulk(start, end);
  const op = await pollBulk(id);
  const meals = {}, muesli = {}, cater = {}, cogs = {}; let orders = 0;
  if (op.url) {
    const text = await (await fetch(op.url)).text();
    const lines = text.split('\n').filter(Boolean);
    const orderWeek = {};
    for (const ln of lines) { let o; try { o = JSON.parse(ln); } catch { continue; } if (o.id && o.createdAt && o.__parentId === undefined) { orderWeek[o.id] = weekEndFri(nzDate(o.createdAt)); orders++; } }
    for (const ln of lines) {
      let o; try { o = JSON.parse(ln); } catch { continue; }
      if (!o.__parentId || !o.product) continue;
      const we = orderWeek[o.__parentId]; if (!we) continue;
      const pt = o.product.productType || ''; const qty = Number(o.quantity) || 0;
      const units = qty * mealsPerUnit(o.product.title);
      if (MEAL_TYPES.has(pt)) meals[we] = (meals[we] || 0) + units;
      if (MUESLI_TYPES.has(pt)) muesli[we] = (muesli[we] || 0) + units;
      if (CATERING_TYPES.has(pt)) cater[we] = (cater[we] || 0) + Number((o.discountedTotalSet && o.discountedTotalSet.shopMoney && o.discountedTotalSet.shopMoney.amount) || 0);
      const uc = o.variant && o.variant.inventoryItem && o.variant.inventoryItem.unitCost && Number(o.variant.inventoryItem.unitCost.amount);
      if (uc) cogs[we] = (cogs[we] || 0) + uc * qty;
    }
  }
  const weekRows = await appsDb('week?select=period_end');
  const exist = new Set((weekRows || []).map(x => x.period_end));
  const today = new Date().toISOString().slice(0, 10);
  const curFri = weekEndFri(today);
  const ov = await appsDb("fact?select=period_end,metric_code&period_type=eq.week&is_override=eq.true&metric_code=in.(heat_eat_sold,muesli_sold,catering_sales,online_cogs)");
  const ovSet = new Set((ov || []).map(r => r.metric_code + '|' + r.period_end));
  const now = new Date().toISOString();
  const rows = []; const written = new Set();
  // Only weeks whose whole Sat–Fri span is inside [start, end] (the current week is allowed
  // in as "preliminary" once its Saturday is inside the range).
  const fullyInside = we => addDays(we, -6) >= start && (we <= end || we === curFri) && we <= curFri;
  const push = (code, we, val) => { if (!ovSet.has(code + '|' + we)) rows.push({ metric_code: code, period_type: 'week', period_end: we, value: val, source: 'shopify', quality: 'ok', entered_at: now }); written.add(we); };
  for (const we of exist) {
    if (!fullyInside(we)) continue;
    push('heat_eat_sold', we, meals[we] || 0);
    push('muesli_sold', we, muesli[we] || 0);
    push('catering_sales', we, Math.round((cater[we] || 0) * 100) / 100);
    if (cogs[we] != null) push('online_cogs', we, Math.round(cogs[we] * 100) / 100);
  }
  for (let i = 0; i < rows.length; i += 400) await appsDb('fact?on_conflict=metric_code,period_type,period_end', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows.slice(i, i + 400)) });
  await appsDb("integration?name=eq.Shopify", { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ note: 'lineitems ' + now + ' orders=' + orders + ' weeks=' + written.size }) }).catch(() => {});
  return { orders, weeks: written.size, facts: rows.length };
}
module.exports = { syncHeatEat, syncCatering: syncHeatEat };
