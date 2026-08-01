// Starshipit/eShip -> per-order shipping cost store (scoreboard.order_shipping).
// Actual courier cost lives only on the order detail, so we list shipped orders then
// fetch each detail. sale_week (order_date) matches revenue; ship_week (shipped_date)
// is operational. Buckets by NZ week.
const ES_KEY = process.env.ESHIP_API_KEY;
const ES_SUB = process.env.ESHIP_SUBSCRIPTION_KEY;
const APPS_URL = 'https://xcwrawjdfajlmbkdwlbm.supabase.co';
const APPS_KEY = process.env.APPS_SERVICE_ROLE_KEY;

async function appsDb(path, opts = {}) {
  const headers = { apikey: APPS_KEY, Authorization: 'Bearer ' + APPS_KEY, 'Content-Type': 'application/json',
    'Accept-Profile': 'scoreboard', 'Content-Profile': 'scoreboard', ...(opts.headers || {}) };
  const res = await fetch(APPS_URL + '/rest/v1/' + path, { ...opts, headers });
  const t = await res.text(); if (!res.ok) throw new Error('DB ' + res.status + ': ' + t.slice(0, 160));
  return t ? JSON.parse(t) : null;
}
let _lastEs = 0;
async function esGet(path) {
  const wait = 1100 - (Date.now() - _lastEs); if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastEs = Date.now();
  const res = await fetch('https://api.starshipit.com' + path, { headers: { 'StarShipIT-Api-Key': ES_KEY, 'Ocp-Apim-Subscription-Key': ES_SUB, 'Content-Type': 'application/json' } });
  const t = await res.text(); if (!res.ok) throw new Error('eShip ' + res.status + ': ' + t.slice(0, 120));
  return t ? JSON.parse(t) : {};
}
const num = v => (v == null || v === '' || isNaN(Number(v))) ? null : Number(v);
function nzDate(iso) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso)); }
function weekEndFri(ymd) { const d = new Date(ymd + 'T00:00:00Z'); const add = (5 - d.getUTCDay() + 7) % 7; d.setUTCDate(d.getUTCDate() + add); return d.toISOString().slice(0, 10); }

async function syncShipping(sinceShipDate, maxOrders) {
  const rows = []; let page = 1;
  while (rows.length < maxOrders && page <= 60) {
    const list = await esGet('/api/orders/shipped?limit=50&page=' + page);
    const orders = list.orders || [];
    if (!orders.length) break;
    let allOld = true;
    for (const o of orders) {
      const shipNz = o.shipped_date ? nzDate(o.shipped_date) : null;
      if (sinceShipDate && shipNz && shipNz < sinceShipDate) continue;
      allOld = false;
      const det = (await esGet('/api/orders?order_id=' + o.order_id)).order || {};
      const pkg = (det.packages && det.packages[0]) || {};
      const cost = num(det.total_shipping_price);
      const freight = num(det.shipping_freight_value);
      rows.push({
        order_id: o.order_id, order_number: o.order_number, order_date: o.order_date, shipped_date: o.shipped_date,
        sale_week: o.order_date ? weekEndFri(nzDate(o.order_date)) : null,
        ship_week: o.shipped_date ? weekEndFri(nzDate(o.shipped_date)) : null,
        actual_cost: cost, freight_charged: freight, subsidy: (cost != null ? cost - (freight || 0) : null),
        carrier: o.carrier || null, carrier_service: o.carrier_service_name || null, service_code: o.carrier_service_code || null,
        weight: num(pkg.weight), destination_city: (det.destination && det.destination.city) || null, destination_state: o.state || null,
        delivered: (o.tracking_short_status === 'Delivered'), delivery_status: o.tracking_short_status || null, updated_at: new Date().toISOString(),
      });
      if (rows.length >= maxOrders) break;
    }
    if (sinceShipDate && allOld) break;   // page fully older than window
    if (orders.length < 50) break;
    page++;
  }
  for (let i = 0; i < rows.length; i += 200) {
    await appsDb('order_shipping?on_conflict=order_id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows.slice(i, i + 200)) });
  }
  const rolled = await rollupWeeks();
  const withCost = rows.filter(r => r.actual_cost != null);
  return { processed: rows.length, withCost: withCost.length, rolledFacts: rolled, sample: rows[0] || null };
}

// Aggregate order_shipping -> weekly facts. Cost & subsidy attributed to the SALE
// week (matches revenue); parcels to the SHIP week (operational). Skips overrides.
async function rollupWeeks() {
  const rows = await appsDb('order_shipping?select=sale_week,ship_week,actual_cost,subsidy&limit=100000');
  const bySale = {}, byShip = {};
  for (const r of (rows || [])) {
    if (r.sale_week) { const b = bySale[r.sale_week] || (bySale[r.sale_week] = { cost: 0, sub: 0 }); b.cost += Number(r.actual_cost || 0); b.sub += Number(r.subsidy || 0); }
    if (r.ship_week) byShip[r.ship_week] = (byShip[r.ship_week] || 0) + 1;
  }
  const wkRows = await appsDb('week?select=period_end');
  const exist = new Set((wkRows || []).map(w => w.period_end));
  const ov = await appsDb("fact?select=period_end,metric_code&period_type=eq.week&is_override=eq.true&metric_code=in.(shipping_cost,shipping_subsidy,parcels_sent)");
  const ovSet = new Set((ov || []).map(r => r.metric_code + '|' + r.period_end));
  const now = new Date().toISOString(); const facts = [];
  const push = (code, wk, val) => { if (exist.has(wk) && !ovSet.has(code + '|' + wk)) facts.push({ metric_code: code, period_type: 'week', period_end: wk, value: val, source: 'eship', quality: 'ok', entered_at: now }); };
  for (const wk in bySale) { push('shipping_cost', wk, Math.round(bySale[wk].cost * 100) / 100); push('shipping_subsidy', wk, Math.round(bySale[wk].sub * 100) / 100); }
  for (const wk in byShip) push('parcels_sent', wk, byShip[wk]);
  for (let i = 0; i < facts.length; i += 400) await appsDb('fact?on_conflict=metric_code,period_type,period_end', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(facts.slice(i, i + 400)) });
  return facts.length;
}
module.exports = { syncShipping, rollupWeeks };
