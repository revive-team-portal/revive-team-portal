// Ads probe, round 6 — two open questions.
//
// (a) Hook rate came out at 85.8%, which is not a hook rate. video_play_actions
//     counts autoplay starts, so on feed placements it approaches impressions.
//     Find which video metrics this account actually returns and what each is
//     worth on the same ads, so the ratio can be built from the right numerator.
//
// (b) 84 ads are locked because they point at a published post. Their names
//     carry a code ("102a", "S509") and the ad-account library video titles
//     start with the same code. Measure how many locked ads that recovers.

const { authorizeRun } = require('./_adsauth');
const { pageAll, graph, ACCT } = require('./_adsmeta');
const { db } = require('./_adsdb');

const APPS_URL = 'https://xcwrawjdfajlmbkdwlbm.supabase.co';
const APPS_KEY = process.env.APPS_SERVICE_ROLE_KEY;

// Every video metric worth asking for. Some are deprecated on v21 and will
// error, so they are probed one at a time rather than in one doomed call.
const VIDEO_METRICS = [
  'video_play_actions',
  'video_3_sec_watched_actions',
  'video_thruplay_watched_actions',
  'video_p25_watched_actions', 'video_p50_watched_actions',
  'video_p75_watched_actions', 'video_p95_watched_actions', 'video_p100_watched_actions',
  'video_avg_time_watched_actions',
  'video_continuous_2_sec_watched_actions',
  'video_15_sec_watched_actions',
];

const first = (v) => Array.isArray(v) && v[0] ? Number(v[0].value) || 0 : (v == null ? null : Number(v) || 0);

// "102a Waffles without the guilt (rested)" -> "102A"
// "165a Meals Holly Sick of Shopping Hook.mov" -> "165A"
function codeOf(s) {
  if (!s) return null;
  const t = String(s).trim().split(/[\s_\-–—]+/)[0].replace(/\.(mov|mp4|m4v|avi)$/i, '');
  const m = t.match(/^([A-Za-z]{0,3}\d{1,4}[A-Za-z]?)$/);
  return m ? m[1].toUpperCase() : null;
}

async function run() {
  const out = { probed_at: new Date().toISOString(), round: 6 };

  // ---------- (a) which video metrics exist, and what are they worth ----------
  out.metric_availability = {};
  for (const m of VIDEO_METRICS) {
    const r = await pageAll(ACCT + '/insights', 'level=account&fields=impressions,' + m + '&date_preset=last_90d', 50, 2);
    out.metric_availability[m] = r.error ? { ok: false, error: r.error } : { ok: true, value: first((r.rows[0] || {})[m]), impressions: Number((r.rows[0] || {}).impressions) || 0 };
    await new Promise(x => setTimeout(x, 150));
  }
  const good = Object.keys(out.metric_availability).filter(k => out.metric_availability[k].ok);

  // Same metrics, per ad, on the ads we have already analysed — so the ratios
  // can be compared against what Ads Manager shows.
  const known = await db('ad?analysis_state=eq.done&select=ad_id,ad_name&limit=5').catch(() => []);
  const ids = (known || []).map(a => a.ad_id);
  out.per_ad = [];
  if (ids.length) {
    const r = await pageAll(ACCT + '/insights',
      'level=ad&fields=' + encodeURIComponent(['ad_id', 'ad_name', 'impressions', 'reach', ...good].join(',')) + '&date_preset=maximum', 100, 5);
    for (const row of (r.rows || [])) {
      if (!ids.includes(row.ad_id)) continue;
      const imp = Number(row.impressions) || 0;
      const rec = { ad_name: row.ad_name, impressions: imp };
      good.forEach(m => { rec[m] = first(row[m]); });
      rec.ratios_over_impressions = {};
      good.forEach(m => { if (imp && rec[m] != null) rec.ratios_over_impressions[m] = Math.round(1000 * rec[m] / imp) / 10 + '%'; });
      out.per_ad.push(rec);
    }
  }

  // ---------- (b) can the locked ads be matched to a library video? ----------
  const lib = await pageAll(ACCT + '/advideos', 'fields=id,title,length,created_time', 100, 60);
  const byCode = {};
  (lib.rows || []).forEach(v => { const c = codeOf(v.title); if (c) (byCode[c] = byCode[c] || []).push({ id: v.id, title: v.title, length: v.length }); });
  out.library = { total: (lib.rows || []).length, titled_with_a_code: Object.values(byCode).reduce((n, a) => n + a.length, 0), distinct_codes: Object.keys(byCode).length };

  const locked = await db('ad?media_type=eq.video_locked&select=ad_id,ad_name,created_time,video_ids').catch(() => []);
  const matched = [], unmatched = [];
  for (const a of (locked || [])) {
    const c = codeOf(a.ad_name);
    const cands = c ? (byCode[c] || []) : [];
    if (cands.length) matched.push({ ad_id: a.ad_id, ad_name: a.ad_name, code: c, candidates: cands.length, pick: cands[0] });
    else unmatched.push({ ad_id: a.ad_id, ad_name: a.ad_name, code: c });
  }
  out.locked_recovery = {
    locked_total: (locked || []).length,
    matched_by_code: matched.length,
    unmatched: unmatched.length,
    pct: (locked || []).length ? Math.round(1000 * matched.length / locked.length) / 10 : null,
    matched_sample: matched.slice(0, 12),
    unmatched_sample: unmatched.slice(0, 12),
  };

  // Prove a matched video really is readable before trusting the mapping.
  out.match_verification = [];
  for (const m of matched.slice(0, 4)) {
    const v = await graph(m.pick.id, 'fields=id,length,source');
    out.match_verification.push({ ad_name: m.ad_name, video_title: m.pick.title, readable: !!(v.json && v.json.source), length: v.json && v.json.length, error: v.err });
    await new Promise(x => setTimeout(x, 200));
  }

  // Do sibling ads with the same code agree on which video to use? A second,
  // independent route to the same answer.
  const all = await db('ad?select=ad_id,ad_name,media_type,readable_video_id').catch(() => []);
  const sibling = {};
  (all || []).forEach(a => { const c = codeOf(a.ad_name); if (c && a.readable_video_id) (sibling[c] = sibling[c] || new Set()).add(a.readable_video_id); });
  let viaSibling = 0;
  (locked || []).forEach(a => { const c = codeOf(a.ad_name); if (c && sibling[c] && sibling[c].size) viaSibling++; });
  out.locked_recovery.also_matchable_via_a_sibling_ad = viaSibling;

  return out;
}

exports.handler = async (event) => {
  const auth = await authorizeRun(event);
  if (!auth.ok) return { statusCode: 403, body: 'nope' };
  let result;
  try { result = await run(); }
  catch (e) { result = { round: 6, fatal: String((e && e.stack) || e).slice(0, 1500) }; }
  await fetch(APPS_URL + '/rest/v1/probe', { method: 'POST',
    headers: { apikey: APPS_KEY, Authorization: 'Bearer ' + APPS_KEY, 'Content-Type': 'application/json', 'Accept-Profile': 'ads', 'Content-Profile': 'ads', Prefer: 'return=minimal' },
    body: JSON.stringify([{ result }]) });
  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
