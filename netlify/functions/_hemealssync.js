// Heat & Eat meals SOLD on Shopify -> weekly heat_eat_sold (count of meals), via the
// Bulk Operations API so we can scan every order's line items. A "meal" = one reheat
// meal unit; bundles/boxes titled "(N items)" count as N meals. Products counted are
// those with productType 'Reheat' or 'Heat & Eat Meals'. Buckets by NZ Sat-Fri week on
// order created date. Never clobbers a manual override.
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
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MEAL_TYPES = new Set(['Reheat', 'Heat & Eat Meals']);
const MUESLI_TYPES = new Set(['Mueslis']);
// meals represented by one unit of this product: bundles/boxes titled "(N items)" = N, else 1
function mealsPerUnit(title) { const m = /\((\d+)\s*items?/i.exec(title || ''); return m ? Math.max(1, parseInt(m[1], 10)) : 1; }

async function startBulk(start, end) {
  const inner = '{ orders(query: "created_at:>=' + start + ' created_at:<=' + end + '") { edges { node { id createdAt lineItems { edges { node { quantity product { productType title } variant { inventoryItem { unitCost { amount } } } } } } } } } }';
  const m = 'mutation($q:String!){ bulkOperationRunQuery(query:$q){ bulkOperation{ id status } userErrors{ field message } } }';
  const d = await gql(m, { q: inner });
  const r = d.bulkOperationRunQuery;
  if (r.userErrors && r.userErrors.length) throw new Error('bulk start: ' + JSON.stringify(r.userErrors).slice(0, 200));
  return r.bulkOperation;
}
async function pollBulk() {
  for (let i = 0; i < 240; i++) {
    const d = await gql('{ currentBulkOperation(type: QUERY){ id status errorCode objectCount url } }');
    const op = d.currentBulkOperation || {};
    if (op.status === 'COMPLETED') return op;
    if (op.status === 'FAILED' || op.status === 'CANCELED') throw new Error('bulk ' + op.status + ' ' + (op.errorCode || ''));
    await sleep(2500);
  }
  throw new Error('bulk timeout');
}
async function syncHeatEat(start, end) {
  await startBulk(start, end);
  const op = await pollBulk();
  const wk = {}; const mu = {}; const cogsWk = {}; let orders = 0;
  if (op.url) {
    const text = await (await fetch(op.url)).text();
    const lines = text.split('\n').filter(Boolean);
    const orderWeek = {};
    for (const ln of lines) { let o; try { o = JSON.parse(ln); } catch { continue; } if (o.id && o.createdAt && o.__parentId === undefined) { orderWeek[o.id] = weekEndFri(nzDate(o.createdAt)); orders++; } }
    for (const ln of lines) { let o; try { o = JSON.parse(ln); } catch { continue; } if (!o.__parentId || !o.product) continue; const we = orderWeek[o.__parentId]; if (!we) continue; const pt = o.product.productType || ''; const qty = Number(o.quantity) || 0; const units = qty * mealsPerUnit(o.product.title); if (MEAL_TYPES.has(pt)) wk[we] = (wk[we] || 0) + units; if (MUESLI_TYPES.has(pt)) mu[we] = (mu[we] || 0) + units; const uc = o.variant && o.variant.inventoryItem && o.variant.inventoryItem.unitCost && Number(o.variant.inventoryItem.unitCost.amount); if (uc) cogsWk[we] = (cogsWk[we] || 0) + uc * qty; }
  }
  const weekRows = await appsDb('week?select=period_end');
  const exist = new Set((weekRows || []).map(x => x.period_end));
  const today = new Date().toISOString().slice(0, 10);
  const ov = await appsDb("fact?select=period_end,metric_code&period_type=eq.week&is_override=eq.true&metric_code=in.(heat_eat_sold,muesli_sold,online_cogs)");
  const ovSet = new Set((ov || []).map(r => r.metric_code + '|' + r.period_end));
  const rows = []; const written = [];
  for (const we of Object.keys(wk)) {
    if (!exist.has(we) || we > today || we < start) continue;
    if (!ovSet.has('heat_eat_sold|' + we)) rows.push({ metric_code: 'heat_eat_sold', period_type: 'week', period_end: we, value: wk[we], source: 'shopify', quality: 'ok', entered_at: new Date().toISOString() });
    written.push(we);
  }
  for (const we of Object.keys(mu)) {
    if (!exist.has(we) || we > today || we < start) continue;
    if (!ovSet.has('muesli_sold|' + we)) rows.push({ metric_code: 'muesli_sold', period_type: 'week', period_end: we, value: mu[we], source: 'shopify', quality: 'ok', entered_at: new Date().toISOString() });
  }
  for (const we of Object.keys(cogsWk)) {
    if (!exist.has(we) || we > today || we < start) continue;
    if (!ovSet.has('online_cogs|' + we)) rows.push({ metric_code: 'online_cogs', period_type: 'week', period_end: we, value: Math.round(cogsWk[we] * 100) / 100, source: 'shopify', quality: 'ok', entered_at: new Date().toISOString() });
  }
  for (let i = 0; i < rows.length; i += 400) await appsDb('fact?on_conflict=metric_code,period_type,period_end', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows.slice(i, i + 400)) });
  return { orders, weeks: written.length, sample: wk[weekEndFri(end)] };
}
module.exports = { syncHeatEat };
