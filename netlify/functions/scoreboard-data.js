// Data API for the Revive Scoreboard. The scoreboard schema has RLS enabled with
// ZERO policies for `authenticated`, so the browser can read nothing directly —
// every read and write goes through here, gated on a portal user + access level,
// using the apps-project service-role key.
//
// Access levels (per Jeremy's brief):
//   manager    – admin, or user_app_access.role='manager'  → sees everything
//   supervisor – role='supervisor'                          → team board + data entry
//   team        – any granted user (role null/'team')       → public board only

const { json, validatePortalUser } = require('./_portal');
const { runSync } = require('./_tksync');

const APPS_URL   = 'https://xcwrawjdfajlmbkdwlbm.supabase.co';
const APPS_KEY   = process.env.APPS_SERVICE_ROLE_KEY;
const PORTAL_URL = 'https://zpcbtfdjcsbdeqnizrpr.supabase.co';
const PORTAL_KEY = process.env.PORTAL_SERVICE_ROLE_KEY;

async function appsDb(path, opts = {}) {
  const headers = {
    apikey: APPS_KEY, Authorization: 'Bearer ' + APPS_KEY, 'Content-Type': 'application/json',
    'Accept-Profile': 'scoreboard', 'Content-Profile': 'scoreboard', ...(opts.headers || {}),
  };
  const res = await fetch(APPS_URL + '/rest/v1/' + path, { ...opts, headers });
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error('DB ' + res.status + ': ' + (typeof data === 'string' ? data : JSON.stringify(data)).slice(0, 300));
  return data;
}

// Resolve the caller's scoreboard access level.
async function accessLevel(userId) {
  const p = await fetch(PORTAL_URL + '/rest/v1/profiles?id=eq.' + userId + '&select=is_admin',
    { headers: { apikey: PORTAL_KEY, Authorization: 'Bearer ' + PORTAL_KEY } }).then(r => r.json()).catch(() => []);
  if (p && p[0] && p[0].is_admin) return 'manager';
  const a = await fetch(PORTAL_URL + '/rest/v1/user_app_access?user_id=eq.' + userId + '&app_id=eq.scoreboard&select=role',
    { headers: { apikey: PORTAL_KEY, Authorization: 'Bearer ' + PORTAL_KEY } }).then(r => r.json()).catch(() => []);
  const role = a && a[0] ? (a[0].role || 'team') : null;
  if (role === 'manager') return 'manager';
  if (role === 'supervisor') return 'supervisor';
  if (role) return 'team';
  return null; // no access row
}

// Codes a Team-level (kiosk) session is allowed to see: only what the six public
// tiles need to render, including the inputs to the public derived metrics.
const TEAM_CODES = [
  'cafe_customers', 'online_orders', 'hours_fulfilment', 'cafe_sales', 'online_sales',
  'orders_missed_cutoff', 'support_first_response', 'orders_not_sent',
];

async function loadFacts(codes) {
  // codes: array or null (=all). Returns { code: [[period_end, value, quality], ...] }
  // Page through the result. PostgREST caps a single response (Supabase max-rows),
  // and with ~3800+ fact rows an un-paged read (ordered period_end.asc) silently
  // drops the most RECENT weeks — which is exactly what the board renders — leaving
  // it blank. Loop with limit/offset until we get a short page.
  let base = 'fact?select=metric_code,period_end,value,quality&period_type=eq.week&order=period_end.asc';
  if (codes) base += '&metric_code=in.(' + codes.join(',') + ')';
  const out = {};
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const rows = await appsDb(base + '&limit=' + PAGE + '&offset=' + offset);
    (rows || []).forEach(r => {
      (out[r.metric_code] = out[r.metric_code] || []).push([r.period_end, r.value == null ? null : Number(r.value), r.quality]);
    });
    if (!rows || rows.length < PAGE) break;
  }
  return out;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  if (!APPS_KEY || !PORTAL_KEY) return json(500, { error: 'Server not configured.' });

  const auth = await validatePortalUser(event, 'scoreboard');
  if (!auth.ok) return json(auth.status || 403, { error: auth.error });

  const level = await accessLevel(auth.user.id);
  if (!level) return json(403, { error: 'You do not have access to the Scoreboard.' });

  let body; try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad request.' }); }
  const action = body.action || 'board';

  try {
    if (action === 'board') {
      const isMgr = level === 'manager' || level === 'supervisor';
      const [metrics, weeks, targets, rates] = await Promise.all([
        appsDb('metric?select=code,name,category,grain,unit,higher_better,source_type,source_system,formula,is_public,public_order,is_hero,active,sort_order&order=sort_order.asc'),
        appsDb('week?select=period_end,trading_days,cafe_closed,cutoff_at,days_note,holiday,email_offer,email_offer_detail,promo_comments,npd,wages_exceptions,other_comments,status&order=period_end.asc'),
        appsDb('metric_target?select=metric_code,effective_from,target_value,amber_pct,amber_abs,red_abs,note&order=effective_from.asc'),
        appsDb('rate_setting?select=key,value,effective_from&order=key.asc'),
      ]);
      const facts = await loadFacts(isMgr ? null : TEAM_CODES);
      const pubMetrics = isMgr ? metrics : (metrics || []).filter(m => m.is_public);
      const dept = isMgr ? (await appsDb('pos_dept_week?select=week_end,grp,sales,qty&order=week_end.asc')) : [];
      return json(200, {
        level, email: auth.user.email,
        metrics: pubMetrics, weeks, facts, targets, rates, dept,
      });
    }

    // ---- writes (supervisor + manager) ----
    if (action === 'save_week') {
      if (level === 'team') return json(403, { error: 'Data entry needs Supervisor access.' });
      const { period_end, values, notes } = body;
      if (!period_end) return json(400, { error: 'Missing week.' });

      // 1) upsert notes on the week row
      if (notes && typeof notes === 'object') {
        const allowed = {};
        ['trading_days', 'cafe_closed', 'days_note', 'holiday', 'email_offer', 'email_offer_detail',
         'promo_comments', 'npd', 'wages_exceptions', 'other_comments'].forEach(k => { if (k in notes) allowed[k] = notes[k]; });
        if (Object.keys(allowed).length) {
          await appsDb('week?period_end=eq.' + period_end, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(allowed) });
        }
      }

      // 2) upsert each supplied fact. Track overrides: if a stored value already
      // exists from an automated source and the human types a different number,
      // keep the original and record who/why.
      if (values && typeof values === 'object') {
        const codes = Object.keys(values);
        let existing = [];
        if (codes.length) {
          existing = await appsDb('fact?select=metric_code,value,source,is_override,original_value&period_type=eq.week&period_end=eq.' +
            period_end + '&metric_code=in.(' + codes.join(',') + ')');
        }
        const exByCode = {}; (existing || []).forEach(r => { exByCode[r.metric_code] = r; });
        const rows = [];
        for (const code of codes) {
          const v = values[code];
          const val = (v === '' || v == null) ? null : Number(v);
          const prev = exByCode[code];
          const row = { metric_code: code, period_type: 'week', period_end, value: val, source: 'manual', quality: 'ok', entered_by: auth.user.id, entered_at: new Date().toISOString() };
          if (prev && prev.source && prev.source !== 'manual' && Number(prev.value) !== val && val != null) {
            row.is_override = true;
            row.original_value = prev.original_value != null ? prev.original_value : prev.value;
            row.override_reason = body.reason || 'Manually corrected';
          }
          rows.push(row);
        }
        if (rows.length) {
          await appsDb('fact', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows) });
        }
      }
      return json(200, { ok: true });
    }

    if (action === 'save_target') {
      if (level !== 'manager') return json(403, { error: 'Targets are set by Managers.' });
      const list = Array.isArray(body.targets) ? body.targets : [body];
      const rows = list.filter(t => t.metric_code && t.target_value != null && t.target_value !== '').map(t => ({
        metric_code: t.metric_code,
        effective_from: t.effective_from || new Date().toISOString().slice(0, 10),
        target_value: Number(t.target_value),
        amber_pct: t.amber_pct == null || t.amber_pct === '' ? 5 : Number(t.amber_pct),
        amber_abs: t.amber_abs === '' || t.amber_abs == null ? null : Number(t.amber_abs),
        red_abs: t.red_abs === '' || t.red_abs == null ? null : Number(t.red_abs),
        note: t.note || null,
      }));
      if (!rows.length) return json(400, { error: 'No valid targets.' });
      await appsDb('metric_target', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows) });
      return json(200, { ok: true, saved: rows.length });
    }

    if (action === 'set_cutoff') {
      if (level !== 'manager') return json(403, { error: 'Managers only.' });
      if (!body.period_end || !body.cutoff_at) return json(400, { error: 'Missing week or cutoff.' });
      await appsDb('week?period_end=eq.' + body.period_end, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ cutoff_at: body.cutoff_at }) });
      return json(200, { ok: true });
    }

    if (action === 'new_week') {
      if (level === 'team') return json(403, { error: 'Adding a week needs Supervisor access.' });
      const nzToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      const latest = await appsDb('week?select=period_end&order=period_end.desc&limit=1');
      let next;
      if (latest && latest[0]) { const d = new Date(latest[0].period_end + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 7); next = d.toISOString().slice(0, 10); }
      else next = nzToday;
      // Only add a week once it has finished — never a future / in-progress week.
      if (next >= nzToday) return json(400, { error: 'The week ending ' + next + " hasn't finished yet — you can add it once it's past (this Friday's week becomes available on the Saturday)." });
      await appsDb('week', { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify([{ period_end: next, status: 'open' }]) });
      return json(200, { ok: true, period_end: next });
    }

    if (action === 'get_feeds') {
      if (level === 'team') return json(403, { error: 'Pulling feeds needs Supervisor access.' });
      const { syncShopify } = require('./_shopifysync');
      const { syncMeta } = require('./_metasync');
      const { WEEKLY_SQL, DEPT_SQL, UBER_SQL, queueJob } = require('./_posqueries');
      const today = new Date().toISOString().slice(0, 10);
      const sd = new Date(); sd.setUTCDate(sd.getUTCDate() - 42); const shopStart = sd.toISOString().slice(0, 10);
      const [tk, sh, mt] = await Promise.allSettled([runSync(6), syncShopify(shopStart, today), syncMeta(shopStart, today)]);
      await queueJob('weekly-feed', WEEKLY_SQL).catch(() => {});
      await queueJob('dept-feed', DEPT_SQL).catch(() => {});
      await queueJob('uber-feed', UBER_SQL).catch(() => {});
      const base = process.env.URL || 'https://team.revive.co.nz';
      await fetch(base + '/.netlify/functions/catering-sync-background').catch(() => {});
      await appsDb('rpc/rollup_pulse', { method: 'POST', headers: { 'Content-Profile': 'scoreboard' }, body: '{}' }).catch(() => {});
      return json(200, { ok: true,
        timekeeper: tk.status === 'fulfilled' ? tk.value : String(tk.reason).slice(0, 160),
        shopify: sh.status === 'fulfilled' ? sh.value : String(sh.reason).slice(0, 160),
        meta: mt.status === 'fulfilled' ? mt.value : String(mt.reason).slice(0, 160),
        uber: 'queued (till agent)', catering: 'running (bulk)' });
    }

    if (action === 'pos_report') {
      if (level === 'team') return json(403, { error: 'Reports need Supervisor access.' });
      const ok = d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
      if (!ok(body.start) || !ok(body.end)) return json(400, { error: 'Bad date range.' });
      const start = body.start;
      const en = new Date(body.end + 'T00:00:00Z'); en.setUTCDate(en.getUTCDate() + 1); const endNext = en.toISOString().slice(0, 10);
      const W = "t.Receipt_Date_Time >= '" + start + "' AND t.Receipt_Date_Time < '" + endNext + "'";
      const sql =
        "SELECT 'dept' AS section, CAST(p.Product_Group AS varchar(10)) AS code, CAST(NULL AS varchar(64)) AS label, CAST(SUM(i.Sales) AS decimal(18,2)) AS amount, CAST(SUM(i.Qty) AS int) AS qty, CAST(NULL AS int) AS txns" +
        " FROM EJItemsTable i JOIN EJTable t ON t.Transaction_Number=i.Transaction_Number LEFT JOIN ProductTable p ON p.Inventory_Code=i.InventoryCode WHERE " + W + " GROUP BY p.Product_Group" +
        " UNION ALL SELECT 'cover', NULL, NULL, NULL, CAST(SUM(CASE WHEN p.Product_Group IN (1,2) THEN i.Qty ELSE 0 END) AS int), NULL" +
        " FROM EJItemsTable i JOIN EJTable t ON t.Transaction_Number=i.Transaction_Number LEFT JOIN ProductTable p ON p.Inventory_Code=i.InventoryCode WHERE " + W +
        " UNION ALL SELECT 'txn', NULL, NULL, NULL, NULL, CAST(COUNT(DISTINCT t.Transaction_Number) AS int)" +
        " FROM EJItemsTable i JOIN EJTable t ON t.Transaction_Number=i.Transaction_Number WHERE " + W +
        " UNION ALL SELECT 'media', CAST(m.MediaType AS varchar(10)), CAST(MAX(md.MediaDescription) AS varchar(64)), CAST(SUM(m.MediaAmount) AS decimal(18,2)), NULL, CAST(COUNT(DISTINCT m.Transaction_Number) AS int)" +
        " FROM EJMediaTable m JOIN EJTable t ON t.Transaction_Number=m.Transaction_Number LEFT JOIN MediaDescriptionTable md ON md.MediaNumber=m.MediaType WHERE " + W + " AND m.MediaType < 100 GROUP BY m.MediaType HAVING SUM(m.MediaAmount) <> 0" +
        " ORDER BY 1, 4 DESC;";
      const ins = await appsDb('pos_jobs', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify([{ sql, note: 'report' }]) });
      return json(200, { id: ins && ins[0] ? ins[0].id : null });
    }
    if (action === 'pos_report_result') {
      const id = Number(body.id); if (!id) return json(400, { error: 'no id' });
      const rows = await appsDb('pos_jobs?id=eq.' + id + '&select=status,result,error');
      const r = (rows && rows[0]) || {};
      return json(200, { status: r.status, result: r.result, error: r.error });
    }
    return json(400, { error: 'Unknown action.' });
  } catch (e) {
    return json(502, { error: String(e.message || e).slice(0, 300) });
  }
};
