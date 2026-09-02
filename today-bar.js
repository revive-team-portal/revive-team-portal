/* Revive shared "today" status bar. Include on any portal app with:
     <script src="/today-bar.js" defer></script>
   Self-contained (no framework). Renders a green bar at the top of <body>, pulls
   /.netlify/functions/cafe-today per source, refreshes every 15 min while visible.
   ONE source of truth — edit this file to change the bar everywhere. */
(function () {
  if (window.__reviveTodayBar) return; window.__reviveTodayBar = true;
  var STALE = 20 * 60000, HALF_MIN = 770; // projection cut = 12:50
  var store = {}, stamp = {}, shown = false;
  var SRC = [['shopify', 'Shopify'], ['meta', 'Meta'], ['pos', 'POS'], ['support', 'Support'], ['jobs', 'Jobs']];
  var tick = { shopify: false, meta: false, pos: false, support: false };
  var LIVE = ['shopify_today', 'shopify_week', 'shopify_today_orders', 'shopify_week_orders', 'meta_today', 'meta_week', 'meta_acq_today', 'meta_cpa_today', 'meta_acq_week', 'meta_cpa_week', 'shopify_yest', 'shopify_yest_orders', 'meta_yest', 'meta_acq_yest', 'meta_cpa_yest', 'cafe_sales_y', 'cafe_covers_y', 'cafe_sales_w', 'cafe_covers_w', 'orders_to_fulfil', 'orders_fulfilled_today', 'orders_fulfilled_yest', 'orders_fulfilled_week', 'outstanding_tickets', 'new_job_apps', 'new_job_apps_yest', 'new_job_apps_week'];

  var css = '.rtb-bar{background:#16543f;color:#fff;padding:6px 16px;min-height:56px;box-sizing:border-box;border-bottom:1px solid rgba(255,255,255,.10);display:flex;flex-direction:column;align-items:stretch;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:1.2}'
    + '.rtb-hidden{display:none!important}'
    + '.rtb-seg{background:rgba(255,255,255,.14);border-radius:9px;padding:5px 13px;display:flex;flex-direction:column;line-height:1.12;min-width:58px}'
    + '.rtb-seg.rtb-stale{opacity:.5}'
    + '.rtb-lab{font-size:9.5px;text-transform:uppercase;letter-spacing:.06em;opacity:.9;font-weight:600}'
    + '.rtb-seg b{font-size:17px;font-weight:800;letter-spacing:-.01em;color:#fff}'
    + '.rtb-tstamp{font-size:11.5px;opacity:.8;margin-left:4px}'
    + '.rtb-rf{cursor:pointer;color:#fff;text-decoration:none;font-size:22px;line-height:1}.rtb-rf:hover{opacity:.75}'
    + '.rtb-load{font-weight:800;font-size:14px;margin-right:6px}'
    + '.rtb-src{font-size:13px;opacity:.82;display:inline-flex;align-items:center;gap:5px}.rtb-src.rtb-done{opacity:1;font-weight:700}'
    + '.rtb-main{display:flex;align-items:center;justify-content:center;gap:9px;flex-wrap:wrap;min-height:44px}'
    + '.rtb-flexwrap{display:flex;align-items:flex-start;justify-content:center;gap:12px;flex-wrap:wrap;width:100%}'
    + '.rtb-tbl{display:table;border-collapse:separate;border-spacing:6px 4px}'
    + '.rtb-trow{display:table-row}.rtb-cell{display:table-cell;vertical-align:middle}'
    + '.rtb-rlab{display:table-cell;vertical-align:middle;text-align:right;padding-right:6px;font-size:10px;text-transform:uppercase;letter-spacing:.05em;font-weight:700;opacity:.85;white-space:nowrap}'
    + '.rtb-bar:not(.rtb-open) .rtb-exprow{display:none}'
    + '.rtb-extra{display:flex;align-items:center;gap:9px;flex-wrap:wrap;padding-top:2px}'
    + '.rtb-plus{cursor:pointer;color:#fff;background:rgba(255,255,255,.14);border:none;border-radius:8px;width:24px;height:24px;font-size:16px;line-height:1;display:inline-flex;align-items:center;justify-content:center}.rtb-plus:hover{background:rgba(255,255,255,.24)}';
  var s = document.createElement('style'); s.textContent = css; document.head.appendChild(s);
  var bar = null;
  function isOpen() { try { return localStorage.getItem('rtbOpen') === '1'; } catch (e) { return false; } }
  function setOpen(v) { try { localStorage.setItem('rtbOpen', v ? '1' : '0'); } catch (e) {} }

  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function hm(ms) { var d = new Date(ms); return DOW[d.getDay()] + ' ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }
  function nzMin() { var p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Pacific/Auckland', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date()); var h = 0, m = 0; p.forEach(function (x) { if (x.type === 'hour') h = +x.value; if (x.type === 'minute') m = +x.value; }); return h * 60 + m; }
  function money0(n) { return '$' + Math.round(Number(n) || 0).toLocaleString(); }
  function get(only, refresh) { return fetch('/.netlify/functions/cafe-today?only=' + only + (refresh ? '&refresh=1' : '')).then(function (r) { return r.json(); }); }
  function ingest(j) {
    if (!j || j.error) return; var now = Date.now(), tillMs = j.updated_at ? Date.parse(j.updated_at) : null;
    if (j.sales != null) { store.sales = j.sales; stamp.sales = tillMs || now; }
    if (j.covers != null) { store.covers = j.covers; stamp.covers = tillMs || now; }
    if (j.sales_1245 != null) store.sales_1245 = j.sales_1245;
    LIVE.forEach(function (f) { if (j[f] != null) { store[f] = j[f]; stamp[f] = now; } });
  }
  function pct() {
    store.meta_today_pct = (store.meta_today != null && store.shopify_today > 0) ? Math.round(store.meta_today / store.shopify_today * 100) : null;
    store.meta_week_pct = (store.meta_week != null && store.shopify_week > 0) ? Math.round(store.meta_week / store.shopify_week * 100) : null;
  }
  function placeholder() {
    if (shown) return; var h = '<span class="rtb-load">Loading</span>';
    SRC.forEach(function (a) { h += '<span class="rtb-src' + (tick[a[0]] ? ' rtb-done' : '') + '">' + a[1] + ' ' + (tick[a[0]] ? '✓' : '○') + '</span>'; });
    bar.innerHTML = '<div class="rtb-main">' + h + '</div>'; bar.classList.remove('rtb-hidden');
  }
  function render() {
    var now = Date.now();
    function caut(f) { return f ? (!stamp[f] || (now - stamp[f] > STALE)) : false; }
    function box(lab, val, f) { var c = caut(f); return '<span class="rtb-seg' + (c ? ' rtb-stale' : '') + '"' + (c ? ' title="Not updating"' : '') + '><span class="rtb-lab">' + lab + (c ? ' ⚠️' : '') + '</span><b>' + val + '</b></span>'; }
    function cell(inner) { return '<span class="rtb-cell">' + inner + '</span>'; }
    function metaVal(spend, pctv, acq, cpa) { return spend != null ? money0(spend) + (pctv != null ? ' · ' + pctv + '%' : '') + ' · ' + (acq != null ? Number(acq).toLocaleString() : '—') + ' / ' + (cpa != null ? money0(cpa) : '—') : '—'; }
    function periodCells(P) {
      var out = '';
      out += cell(box('Cafe $', P.sales != null ? money0(P.sales) : '—', P.salesF));
      var cov = Number(P.covers) || 0, avg = (cov > 0 && P.sales != null) ? (P.sales / cov) : null;
      out += cell(box('Covers/avg', P.covers != null ? (Math.round(cov).toLocaleString() + (avg != null ? ' · $' + avg.toFixed(2) : '')) : '—', P.coversF));
      out += cell(box('Shopify', P.shopify != null ? money0(P.shopify) + (P.shopifyOrders != null ? ' · ' + Number(P.shopifyOrders).toLocaleString() : '') : '—', P.shopifyF));
      out += cell(box('Meta', metaVal(P.metaSpend, P.metaPct, P.metaAcq, P.metaCpa), P.metaF));
      out += cell(box('Fulfilled', P.fulfilled != null ? Number(P.fulfilled).toLocaleString() : '—', P.fulfilledF));
      out += cell(box('New jobs', P.newjobs != null ? Number(P.newjobs).toLocaleString() : '—', P.newjobsF));
      return out;
    }
    if (store.sales == null && store.shopify_today == null && store.meta_today == null && store.new_job_apps == null) return;
    var today = { sales: store.sales, salesF: 'sales', covers: store.covers, coversF: 'covers', shopify: store.shopify_today, shopifyOrders: store.shopify_today_orders, shopifyF: 'shopify_today', metaSpend: store.meta_today, metaPct: store.meta_today_pct, metaAcq: store.meta_acq_today, metaCpa: store.meta_cpa_today, metaF: 'meta_today', fulfilled: store.orders_fulfilled_today, fulfilledF: 'orders_fulfilled_today', newjobs: store.new_job_apps, newjobsF: 'new_job_apps' };
    var yPct = (store.meta_yest != null && store.shopify_yest > 0) ? Math.round(store.meta_yest / store.shopify_yest * 100) : null;
    var yest = { sales: store.cafe_sales_y, covers: store.cafe_covers_y, shopify: store.shopify_yest, shopifyOrders: store.shopify_yest_orders, metaSpend: store.meta_yest, metaPct: yPct, metaAcq: store.meta_acq_yest, metaCpa: store.meta_cpa_yest, fulfilled: store.orders_fulfilled_yest, newjobs: store.new_job_apps_yest };
    var week = { sales: store.cafe_sales_w, covers: store.cafe_covers_w, shopify: store.shopify_week, shopifyOrders: store.shopify_week_orders, metaSpend: store.meta_week, metaPct: store.meta_week_pct, metaAcq: store.meta_acq_week, metaCpa: store.meta_cpa_week, fulfilled: store.orders_fulfilled_week, newjobs: store.new_job_apps_week };
    var proj = (nzMin() >= HALF_MIN && store.sales_1245 > 0);
    var extra = box('Halfway / projection', proj ? (money0(store.sales_1245) + ' → ' + money0(store.sales_1245 * 2)) : ' ', proj ? 'sales' : null);
    if (store.orders_to_fulfil != null) extra += box('To fulfil', (store.orders_to_fulfil || 0).toLocaleString(), 'orders_to_fulfil');
    if (store.outstanding_tickets != null) extra += box('Tickets', (store.outstanding_tickets || 0).toLocaleString(), 'outstanding_tickets');
    var tbl = '<div class="rtb-tbl">'
      + '<div class="rtb-trow"><span class="rtb-rlab">Today</span>' + periodCells(today) + '</div>'
      + '<div class="rtb-trow rtb-exprow"><span class="rtb-rlab">Yesterday</span>' + periodCells(yest) + '</div>'
      + '<div class="rtb-trow rtb-exprow"><span class="rtb-rlab">Week to date</span>' + periodCells(week) + '</div>'
      + '</div>';
    var ctrl = '<div class="rtb-extra">' + extra + '<span class="rtb-tstamp">as at ' + hm(now) + '</span><a class="rtb-rf" title="Refresh">↻</a><button class="rtb-plus" title="Yesterday & week to date">' + (isOpen() ? '−' : '+') + '</button></div>';
    bar.innerHTML = '<div class="rtb-flexwrap">' + tbl + ctrl + '</div>';
    bar.classList.toggle('rtb-open', isOpen());
    bar.classList.remove('rtb-hidden'); shown = true;
    var rf = bar.querySelector('.rtb-rf'); if (rf) rf.onclick = function () { refreshAll(true); };
    var pl = bar.querySelector('.rtb-plus'); if (pl) pl.onclick = function () { var v = !isOpen(); setOpen(v); bar.classList.toggle('rtb-open', v); pl.textContent = v ? '−' : '+'; };
  }
  function allTicked() { return SRC.every(function (a) { return tick[a[0]]; }); }
  function loadSource(k) {
    var p;
    if (k === 'pos') {
      p = get('pos', true).then(function (j) {
        ingest(j); var fresh = j && j.updated_at && (Date.now() - Date.parse(j.updated_at) < 3 * 60000);
        if (fresh) return; return new Promise(function (r) { setTimeout(r, 7000); }).then(function () { return get('pos', false).then(ingest).catch(function () {}); });
      });
    } else { p = get(k, false).then(ingest); }
    return p.catch(function () {}).then(function () { tick[k] = true; if (!shown) { placeholder(); if (allTicked()) { pct(); render(); } } });
  }
  function init() {
    SRC.forEach(function (a) { tick[a[0]] = false; }); placeholder();
    SRC.forEach(function (a) { loadSource(a[0]); });
    setTimeout(function () { if (!shown) { pct(); render(); } }, 13000);
  }
  function refreshAll(refresh) {
    Promise.all([get('shopify', false), get('meta', false), get('pos', refresh), get('support', false), get('jobs', false)])
      .then(function (parts) { parts.forEach(ingest); pct(); render(); if (refresh) setTimeout(function () { get('pos', false).then(function (j) { ingest(j); pct(); render(); }).catch(function () {}); }, 7000); })
      .catch(function () { if (shown) render(); });
  }
  var started = false;
  function start(mountEl) {
    if (started) return; started = true;
    bar = document.createElement('div'); bar.className = 'rtb-bar rtb-hidden';
    var host = mountEl || document.body; host.insertBefore(bar, host.firstChild);
    init();
    setInterval(function () { if (!document.hidden) refreshAll(false); }, 900000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) refreshAll(true); });
  }
  window.reviveTodayBar = { start: start, refresh: function () { refreshAll(true); } };
  // Auto-mount at top of <body> unless the page opts into manual mounting.
  if (!window.__reviveTodayBarManual) {
    if (document.body) start(); else document.addEventListener('DOMContentLoaded', function () { start(); });
  }
})();
