// Shared SwiftPOS feed logic: the standard queries, a job queuer, and the ingest
// that runs when the agent returns a result (weekly-feed -> facts, cafe-today -> pos_today).
const APPS_URL = 'https://xcwrawjdfajlmbkdwlbm.supabase.co';
const APPS_KEY = process.env.APPS_SERVICE_ROLE_KEY;
async function db(path, opts = {}) {
  const headers = { apikey: APPS_KEY, Authorization: 'Bearer ' + APPS_KEY, 'Content-Type': 'application/json',
    'Accept-Profile': 'scoreboard', 'Content-Profile': 'scoreboard', ...(opts.headers || {}) };
  const res = await fetch(APPS_URL + '/rest/v1/' + path, { ...opts, headers });
  const t = await res.text(); if (!res.ok) throw new Error('DB ' + res.status + ': ' + t.slice(0, 160));
  return t ? JSON.parse(t) : null;
}
const WEEK_END = "DATEADD(day,((7-(DATEDIFF(day,'1900-01-05',CAST(t.Receipt_Date_Time AS date))%7))%7),CAST(t.Receipt_Date_Time AS date))";
const WEEKLY_SQL =
  "SELECT CONVERT(varchar(10)," + WEEK_END + ",23) AS week_end, SUM(i.Sales) AS cafe_sales," +
  " SUM(CASE WHEN p.Product_Group IN (1,2) THEN i.Qty ELSE 0 END) AS customers," +
  " SUM(CASE WHEN p.Product_Group=4 THEN i.Qty ELSE 0 END) AS sweets," +
  " SUM(CASE WHEN p.Product_Group=5 THEN i.Qty ELSE 0 END) AS drinks," +
  " SUM(CASE WHEN p.Product_Group=6 THEN i.Qty ELSE 0 END) AS shop" +
  " FROM EJItemsTable i JOIN EJTable t ON t.Transaction_Number=i.Transaction_Number" +
  " LEFT JOIN ProductTable p ON p.Inventory_Code=i.InventoryCode" +
  " WHERE t.Receipt_Date_Time >= DATEADD(week,-10,GETDATE()) GROUP BY " + WEEK_END + " ORDER BY 1;";
const TODAY_SQL =
  "SELECT SUM(i.Sales) AS sales, SUM(CASE WHEN p.Product_Group IN (1,2) THEN i.Qty ELSE 0 END) AS covers" +
  " FROM EJItemsTable i JOIN EJTable t ON t.Transaction_Number=i.Transaction_Number" +
  " LEFT JOIN ProductTable p ON p.Inventory_Code=i.InventoryCode" +
  " WHERE CAST(t.Receipt_Date_Time AS date)=CAST(GETDATE() AS date);";

const DEPT_SQL =
  "SELECT CONVERT(varchar(10)," + WEEK_END + ",23) AS week_end, p.Product_Group AS grp," +
  " SUM(i.Sales) AS sales, SUM(i.Qty) AS qty" +
  " FROM EJItemsTable i JOIN EJTable t ON t.Transaction_Number=i.Transaction_Number" +
  " LEFT JOIN ProductTable p ON p.Inventory_Code=i.InventoryCode" +
  " WHERE t.Receipt_Date_Time >= DATEADD(week,-10,GETDATE())" +
  " GROUP BY " + WEEK_END + ", p.Product_Group ORDER BY 1,2;";
async function queueJob(note, sql) {
  const ex = await db('pos_jobs?status=eq.pending&note=eq.' + encodeURIComponent(note) + '&select=id');
  if (ex && ex.length) return { queued: false };
  await db('pos_jobs', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify([{ sql, note }]) });
  return { queued: true };
}
function parseTSV(text) {
  const lines = String(text || '').replace(/\r/g, '').trim().split('\n');
  if (!lines[0]) return { cols: [], rows: [] };
  return { cols: lines[0].split('\t'), rows: lines.slice(1).map(l => l.split('\t')) };
}
async function ingest(note, result) {
  if (!note) return;
  if (note.indexOf('cafe-today') === 0) {
    const { cols, rows } = parseTSV(result); const r = rows[0] || []; const ix = c => cols.indexOf(c);
    const sales = Number(r[ix('sales')] || 0), covers = Number(r[ix('covers')] || 0);
    await db('pos_today?id=eq.1', { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ sales, covers, updated_at: new Date().toISOString() }) });
    return;
  }
  if (note.indexOf('weekly-feed') === 0) {
    const { cols, rows } = parseTSV(result); const ix = c => cols.indexOf(c);
    const weeks = await db('week?select=period_end'); const exist = new Set((weeks || []).map(w => w.period_end));
    const ov = await db("fact?select=period_end,metric_code&period_type=eq.week&is_override=eq.true&metric_code=in.(cafe_sales,cafe_customers,sweets_sold,drinks_sold,shop_sold)");
    const ovSet = new Set((ov || []).map(r => r.metric_code + '|' + r.period_end));
    const today = new Date().toISOString().slice(0, 10); const now = new Date().toISOString();
    const map = { cafe_sales: 'cafe_sales', cafe_customers: 'customers', sweets_sold: 'sweets', drinks_sold: 'drinks', shop_sold: 'shop' };
    const facts = [];
    for (const r of rows) {
      const wk = r[ix('week_end')]; if (!wk || !exist.has(wk) || wk > today) continue;
      for (const metric in map) {
        const v = Number(r[ix(map[metric])] || 0);
        if (!ovSet.has(metric + '|' + wk)) facts.push({ metric_code: metric, period_type: 'week', period_end: wk, value: metric === 'cafe_sales' ? Math.round(v * 100) / 100 : v, source: 'swiftpos', quality: 'ok', entered_at: now });
      }
    }
    for (let i = 0; i < facts.length; i += 400) await db('fact?on_conflict=metric_code,period_type,period_end', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(facts.slice(i, i + 400)) });
    return;
  }
  if (note.indexOf('dept-feed') === 0) {
    const { cols, rows } = parseTSV(result); const ix = c => cols.indexOf(c);
    const weeks = await db('week?select=period_end'); const exist = new Set((weeks || []).map(w => w.period_end));
    const now = new Date().toISOString(); const out = [];
    for (const r of rows) {
      const wk = r[ix('week_end')]; if (!wk || !exist.has(wk)) continue;
      out.push({ week_end: wk, grp: Number(r[ix('grp')] || 0), sales: Math.round((Number(r[ix('sales')] || 0)) * 100) / 100, qty: Math.round(Number(r[ix('qty')] || 0)), updated_at: now });
    }
    for (let i = 0; i < out.length; i += 400) await db('pos_dept_week?on_conflict=week_end,grp', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(out.slice(i, i + 400)) });
    return;
  }
}
module.exports = { WEEKLY_SQL, TODAY_SQL, DEPT_SQL, queueJob, ingest, db };
