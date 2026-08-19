/* Revive shared "today" status bar. Include on any portal app with:
     <script src="/today-bar.js" defer></script>
   Self-contained (no framework). Renders a green bar at the top of <body>, pulls
   /.netlify/functions/cafe-today per source, refreshes every 15 min while visible.
   ONE source of truth — edit this file to change the bar everywhere. */
(function () {
  if (window.__reviveTodayBar) return; window.__reviveTodayBar = true;
  var STALE = 20 * 60000, HALF_MIN = 770; // projection cut = 12:50
  var store = {}, stamp = {}, shown = false;
  var SRC = [['shopify', 'Shopify'], ['meta', 'Meta'], ['pos', 'POS'], ['support', 'Support']];
  var tick = { shopify: false, meta: false, pos: false, support: false };
  var LIVE = ['shopify_today', 'shopify_week', 'shopify_today_orders', 'shopify_week_orders', 'meta_today', 'meta_week', 'meta_acq_today', 'meta_cpa_today', 'orders_to_fulfil', 'orders_fulfilled_today', 'outstanding_tickets'];

  var css = '.rtb-bar{background:#16543f;color:#fff;padding:9px 16px;min-height:56px;box-sizing:border-box;border-bottom:1px solid rgba(255,255,255,.10);display:flex;align-items:center;justify-content:center;gap:9px;flex-wrap:wrap;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:1.2}'
    + '.rtb-hidden{display:none!important}'
    + '.rtb-seg{background:rgba(255,255,255,.14);border-radius:9px;padding:5px 13px;display:flex;flex-direction:column;line-height:1.12;min-width:58px}'
    + '.rtb-seg.rtb-stale{opacity:.5}'
    + '.rtb-lab{font-size:9.5px;text-transform:uppercase;letter-spacing:.06em;opacity:.9;font-weight:600}'
    + '.rtb-seg b{font-size:17px;font-weight:800;letter-spacing:-.01em;color:#fff}'
    + '.rtb-tstamp{font-size:11.5px;opacity:.8;margin-left:4px}'
    + '.rtb-rf{cursor:pointer;color:#fff;text-decoration:none;font-size:22px;line-height:1}.rtb-rf:hover{opacity:.75}'
    + '.rtb-load{font-weight:800;font-size:14px;margin-right:6px}'
    + '.rtb-src{font-size:13px;opacity:.82;display:inline-flex;align-items:center;gap:5px}.rtb-src.rtb-done{opacity:1;font-weight:700}';
  var s = document.createElement('style'); s.textContent = css; document.head.appendChild(s);
  var bar = null;

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
    bar.innerHTML = h; bar.classList.remove('rtb-hidden');
  }
  function render() {
    var now = Date.now();
    function caut(f) { return f ? (!stamp[f] || (now - stamp[f] > STALE)) : false; }
    function box(lab, val, f) { var c = caut(f); return '<span class="rtb-seg' + (c ? ' rtb-stale' : '') + '"' + (c ? ' title="Not updating — last good ' + (stamp[f] ? hm(stamp[f]) : 'never') + '"' : '') + '><span class="rtb-lab">' + lab + (c ? ' ⚠️' : '') + '</span><b>' + val + '</b></span>'; }
    var h = '';
    if (store.sales != null) { h += box('Cafe $ today', money0(store.sales), 'sales'); h += box('Covers today', (Math.round(store.covers) || 0).toLocaleString(), 'covers'); }
    var proj = (nzMin() >= HALF_MIN && store.sales_1245 > 0);
    h += box('Halfway / projection', proj ? (money0(store.sales_1245) + ' → ' + money0(store.sales_1245 * 2)) : ' ', proj ? 'sales' : null);
    if (store.shopify_today != null) h += box('Shopify today', money0(store.shopify_today) + (store.shopify_today_orders != null ? ' · ' + Number(store.shopify_today_orders).toLocaleString() : ''), 'shopify_today');
    if (store.shopify_week != null) h += box('Shopify this week', money0(store.shopify_week) + (store.shopify_week_orders != null ? ' · ' + Number(store.shopify_week_orders).toLocaleString() : ''), 'shopify_week');
    if (store.meta_today != null) h += box('Meta spend today', money0(store.meta_today) + (store.meta_today_pct != null ? ' · ' + store.meta_today_pct + '%' : ''), 'meta_today');
    if (store.meta_acq_today != null) h += box('Acq today', (Math.round(store.meta_acq_today) || 0).toLocaleString(), 'meta_acq_today');
    if (store.meta_cpa_today != null) h += box('CPA', money0(store.meta_cpa_today), 'meta_cpa_today');
    if (store.meta_week != null) h += box('Meta spend this week', money0(store.meta_week) + (store.meta_week_pct != null ? ' · ' + store.meta_week_pct + '%' : ''), 'meta_week');
    if (store.orders_to_fulfil != null) h += box('To fulfil', (store.orders_to_fulfil || 0).toLocaleString(), 'orders_to_fulfil');
    if (store.orders_fulfilled_today != null) h += box('Fulfilled today', (store.orders_fulfilled_today || 0).toLocaleString(), 'orders_fulfilled_today');
    if (store.outstanding_tickets != null) h += box('Tickets', (store.outstanding_tickets || 0).toLocaleString(), 'outstanding_tickets');
    if (!h) return;
    h += '<span class="rtb-tstamp">as at ' + hm(now) + '</span><a class="rtb-rf" title="Refresh">↻</a>';
    bar.innerHTML = h; bar.classList.remove('rtb-hidden'); shown = true;
    var rf = bar.querySelector('.rtb-rf'); if (rf) rf.onclick = function () { refreshAll(true); };
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
    Promise.all([get('shopify', false), get('meta', false), get('pos', refresh), get('support', false)])
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
