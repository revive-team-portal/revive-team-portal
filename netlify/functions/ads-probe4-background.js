// Ads probe, round 4 — per-ad coverage (the number that actually matters).
// Round 3 showed each video ad carries TWO video ids: the ad-account library
// copy (readable, has `source`) and the published Page post's copy (refused
// with #10). Per-video coverage therefore understates reality — what counts is
// whether each AD has at least one readable video. Also: what are the 274 ads
// with no video id at all, and is there any route into the post-only ones?

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
  for (let i = 0; i < (maxPages || 80) && url; i++) {
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
const bump = (m, k) => { m[k || 'none'] = (m[k || 'none'] || 0) + 1; };

async function run() {
  const out = { probed_at: new Date().toISOString(), round: 4, account: ACCT };

  const lib = await pageAll(ACCT + '/advideos', 'fields=id,title,length,created_time', 100, 60);
  const libIds = new Set(lib.rows.map(v => String(v.id)));
  const libById = {}; lib.rows.forEach(v => { libById[String(v.id)] = v; });
  out.library_total = lib.rows.length;

  const F = 'id,name,effective_status,created_time,'
    + 'creative{id,object_type,video_id,thumbnail_url,image_url,object_story_id,effective_object_story_id,object_story_spec{video_data{video_id}},asset_feed_spec{videos}}';
  let ads = await pageAll(ACCT + '/ads', 'fields=' + encodeURIComponent(F) + '&effective_status=' + encodeURIComponent(JSON.stringify(ALL_STATUS)), 25, 80);
  if (ads.err && /reduce the amount of data/i.test(ads.err)) ads = await pageAll(ACCT + '/ads', 'fields=' + encodeURIComponent(F) + '&effective_status=' + encodeURIComponent(JSON.stringify(ALL_STATUS)), 10, 120);
  out.ads_total = ads.rows.length; out.ads_error = ads.err;

  const objTypeAll = {}, objTypeNoLib = {}, objTypeNoVideo = {};
  const rows = ads.rows.map(a => {
    const c = a.creative || {};
    const ids = videoIdsOf(c);
    const libHit = ids.find(v => libIds.has(v)) || null;
    bump(objTypeAll, c.object_type);
    if (!ids.length) bump(objTypeNoVideo, c.object_type);
    else if (!libHit) bump(objTypeNoLib, c.object_type);
    return { ad_id: a.id, name: a.name, status: a.effective_status, created: a.created_time,
      object_type: c.object_type || null, ids, lib_video: libHit,
      has_thumb: !!c.thumbnail_url, post_id: c.effective_object_story_id || c.object_story_id || null };
  });

  const withVideo = rows.filter(r => r.ids.length);
  const covered = rows.filter(r => r.lib_video);
  const videoNoLib = withVideo.filter(r => !r.lib_video);

  const recent = rows.filter(r => r.created >= '2025-09-01');
  const recentCovered = recent.filter(r => r.lib_video);

  out.per_ad_coverage = {
    ads_total: rows.length,
    ads_with_any_video_id: withVideo.length,
    ads_with_a_READABLE_library_video: covered.length,
    ads_with_video_but_none_readable: videoNoLib.length,
    ads_with_no_video_id_at_all: rows.length - withVideo.length,
    pct_of_video_ads_readable: withVideo.length ? Math.round(1000 * covered.length / withVideo.length) / 10 : null,
    last_12_months: { ads: recent.length, readable: recentCovered.length,
      pct: recent.length ? Math.round(1000 * recentCovered.length / recent.length) / 10 : null },
  };
  out.object_type_distribution = { all: objTypeAll, ads_with_video_but_not_readable: objTypeNoLib, ads_with_no_video_id: objTypeNoVideo };

  // The 20 newest ads — the real v1 target — with the exact id the pipeline would use.
  const newest = rows.slice().sort((a, b) => String(b.created).localeCompare(String(a.created))).slice(0, 20);
  out.newest_20 = newest.map(r => ({ ad_id: r.ad_id, name: r.name, status: r.status, created: r.created,
    object_type: r.object_type, readable_video: r.lib_video,
    length_sec: r.lib_video && libById[r.lib_video] ? libById[r.lib_video].length : null,
    ids_seen: r.ids.length, has_thumb: r.has_thumb }));
  out.newest_20_readable = newest.filter(r => r.lib_video).length;
  out.newest_10_readable = newest.slice(0, 10).filter(r => r.lib_video).length;

  // Is there any way into the post-only ads? Try the published post's attachments.
  out.post_route_attempts = [];
  for (const r of videoNoLib.filter(x => x.post_id).slice(0, 3)) {
    const p = await graph(r.post_id, 'fields=' + encodeURIComponent('id,attachments{media,media_type,type,target,url,subattachments}'));
    out.post_route_attempts.push({ ad_id: r.ad_id, name: r.name, post_id: r.post_id, http: p.http, error: p.err,
      keys: p.json && !p.err ? Object.keys(p.json) : null,
      attachments: p.json && p.json.attachments ? JSON.stringify(p.json.attachments).slice(0, 500) : null });
    await new Promise(x => setTimeout(x, 250));
  }
  // Sample of ads that showed no video id at all, so we know what they are.
  out.no_video_sample = rows.filter(r => !r.ids.length).slice(0, 8)
    .map(r => ({ ad_id: r.ad_id, name: r.name, object_type: r.object_type, created: r.created, has_thumb: r.has_thumb, has_post: !!r.post_id }));

  return out;
}

exports.handler = async (event) => {
  const auth = await authorizeRun(event);
  if (!auth.ok) return { statusCode: 403, body: 'nope' };
  let result;
  try { result = await run(); }
  catch (e) { result = { round: 4, probed_at: new Date().toISOString(), fatal: String((e && e.stack) || e).slice(0, 1500) }; }
  const res = await fetch(APPS_URL + '/rest/v1/probe', { method: 'POST',
    headers: { apikey: APPS_KEY, Authorization: 'Bearer ' + APPS_KEY, 'Content-Type': 'application/json', 'Accept-Profile': 'ads', 'Content-Profile': 'ads', Prefer: 'return=minimal' },
    body: JSON.stringify([{ result }]) });
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, db: res.status }) };
};
