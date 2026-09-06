// Ads probe, round 3 — coverage.
// Round 2 found that /act_X/advideos hands over `source` (real mp4 bytes) even
// though a bare /{video_id} read is refused for some videos. That split decides
// how much of the app actually works, so: enumerate the whole ad-account video
// library, enumerate every video id referenced by an ad, and measure the overlap.

const { authorizeRun } = require('./_adsauth');

const GRAPH = 'https://graph.facebook.com/v21.0';
const TOKEN = process.env.META_ACCESS_TOKEN;
const ACCT = process.env.META_AD_ACCOUNT || 'act_242089740673955';
const APPS_URL = 'https://xcwrawjdfajlmbkdwlbm.supabase.co';
const APPS_KEY = process.env.APPS_SERVICE_ROLE_KEY;
const ALL_STATUS = ['ACTIVE', 'PAUSED', 'ARCHIVED', 'ADSET_PAUSED', 'CAMPAIGN_PAUSED',
  'PENDING_REVIEW', 'DISAPPROVED', 'PREAPPROVED', 'PENDING_BILLING_INFO', 'IN_PROCESS', 'WITH_ISSUES'];

async function graph(path, qs) {
  const res = await fetch(GRAPH + '/' + path + '?' + (qs || '') + '&access_token=' + encodeURIComponent(TOKEN));
  const j = await res.json().catch(() => ({}));
  return { http: res.status, json: j, err: j.error ? String(j.error.message || '').slice(0, 200) : null };
}

async function pageAll(path, qs, limit, maxPages) {
  let url = GRAPH + '/' + path + '?' + qs + '&limit=' + limit + '&access_token=' + encodeURIComponent(TOKEN);
  const all = []; let err = null; let pages = 0;
  for (let i = 0; i < (maxPages || 60) && url; i++) {
    const r = await fetch(url); const j = await r.json().catch(() => ({}));
    if (j.error) { err = String(j.error.message || '').slice(0, 200); break; }
    (j.data || []).forEach(d => all.push(d)); pages++;
    url = (j.paging && j.paging.next) ? j.paging.next : null;
  }
  return { rows: all, err, pages, truncated: !!url };
}

function videoIdsOf(c) {
  const out = [];
  if (!c) return out;
  if (c.video_id) out.push(String(c.video_id));
  const vd = c.object_story_spec && c.object_story_spec.video_data;
  if (vd && vd.video_id) out.push(String(vd.video_id));
  const afs = c.asset_feed_spec;
  if (afs && Array.isArray(afs.videos)) afs.videos.forEach(v => { if (v.video_id) out.push(String(v.video_id)); });
  return [...new Set(out)];
}

async function run() {
  const out = { probed_at: new Date().toISOString(), round: 3, account: ACCT };

  // 1. The whole ad-account video library.
  const lib = await pageAll(ACCT + '/advideos', 'fields=' + encodeURIComponent('id,title,length,created_time'), 100, 60);
  out.library = { total: lib.rows.length, pages: lib.pages, error: lib.err, truncated: lib.truncated,
    oldest: lib.rows.length ? lib.rows.map(v => v.created_time).sort()[0] : null,
    newest: lib.rows.length ? lib.rows.map(v => v.created_time).sort().slice(-1)[0] : null };
  const libIds = new Set(lib.rows.map(v => String(v.id)));
  const libById = {}; lib.rows.forEach(v => { libById[String(v.id)] = v; });

  // 2. Every ad, with just enough creative to find its video.
  const adQs = 'fields=' + encodeURIComponent('id,name,effective_status,created_time,creative{id,video_id,object_story_id,object_story_spec{video_data{video_id}},thumbnail_url}')
    + '&effective_status=' + encodeURIComponent(JSON.stringify(ALL_STATUS));
  let ads = await pageAll(ACCT + '/ads', adQs, 25, 60);
  if (ads.err && /reduce the amount of data/i.test(ads.err)) ads = await pageAll(ACCT + '/ads', adQs, 10, 100);
  out.ads = { total: ads.rows.length, pages: ads.pages, error: ads.err, truncated: ads.truncated };

  const refs = new Map(); // video_id -> [ad ids]
  let adsWithVideo = 0;
  for (const a of ads.rows) {
    const ids = videoIdsOf(a.creative);
    if (ids.length) adsWithVideo++;
    ids.forEach(v => { if (!refs.has(v)) refs.set(v, []); refs.get(v).push(a.id); });
  }
  const referenced = [...refs.keys()];
  const inLib = referenced.filter(v => libIds.has(v));
  const notInLib = referenced.filter(v => !libIds.has(v));

  out.coverage = {
    ads_total: ads.rows.length,
    ads_with_a_video: adsWithVideo,
    ads_without_a_video: ads.rows.length - adsWithVideo,
    unique_videos_referenced: referenced.length,
    referenced_and_in_library: inLib.length,
    referenced_but_missing_from_library: notInLib.length,
    library_videos_never_used_in_an_ad: lib.rows.filter(v => !refs.has(String(v.id))).length,
    pct_referenced_videos_covered: referenced.length ? Math.round(1000 * inLib.length / referenced.length) / 10 : null,
    ads_covered: referenced.filter(v => libIds.has(v)).reduce((n, v) => n + refs.get(v).length, 0),
    ads_not_covered: notInLib.reduce((n, v) => n + refs.get(v).length, 0),
  };

  // 3. Confirm the split is real: sample both sides and try to read `source`.
  const sample = async (ids, label) => {
    const res = [];
    for (const v of ids.slice(0, 5)) {
      const r = await graph(v, 'fields=' + encodeURIComponent('id,length,source,picture,permalink_url,captions'));
      res.push({ video_id: v, side: label, http: r.http, error: r.err,
        has_source: !!(r.json && r.json.source), length_sec: r.json && r.json.length,
        has_captions: !!(r.json && r.json.captions), example_ad: (refs.get(v) || [])[0],
        title: libById[v] ? libById[v].title : null });
      await new Promise(x => setTimeout(x, 200));
    }
    return res;
  };
  out.sample_in_library = await sample(inLib, 'in_library');
  out.sample_missing = await sample(notInLib, 'missing');

  // 4. The 10 newest ads — the ones the first backfill will actually touch.
  const newest = ads.rows.slice().sort((a, b) => String(b.created_time || '').localeCompare(String(a.created_time || ''))).slice(0, 10);
  out.newest_10 = newest.map(a => {
    const ids = videoIdsOf(a.creative);
    return { ad_id: a.id, name: a.name, effective_status: a.effective_status, created_time: a.created_time,
      video_ids: ids, in_library: ids.map(v => libIds.has(v)),
      length_sec: ids.map(v => libById[v] ? libById[v].length : null) };
  });
  out.newest_10_all_covered = out.newest_10.every(a => a.video_ids.length && a.in_library.every(Boolean));

  return out;
}

exports.handler = async (event) => {
  const auth = await authorizeRun(event);
  if (!auth.ok) return { statusCode: 403, body: 'nope' };
  let result;
  try { result = await run(); }
  catch (e) { result = { round: 3, probed_at: new Date().toISOString(), fatal: String((e && e.stack) || e).slice(0, 1500) }; }
  const res = await fetch(APPS_URL + '/rest/v1/probe', {
    method: 'POST',
    headers: { apikey: APPS_KEY, Authorization: 'Bearer ' + APPS_KEY, 'Content-Type': 'application/json', 'Accept-Profile': 'ads', 'Content-Profile': 'ads', Prefer: 'return=minimal' },
    body: JSON.stringify([{ result }]),
  });
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, db: res.status }) };
};
