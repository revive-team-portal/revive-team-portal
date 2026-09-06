// Ads probe, round 5 — what IS every ad, and what does it say?
//
// Answers three things the earlier rounds left open:
//   1. The 274 ads with no video id — are they statics?
//   2. Body copy and headline for every ad, from whichever creative shape holds it.
//   3. Which ads reuse the same copy as each other.
//
// The listing is fetched light and creative detail is filled in via batched
// multi-get, because the ads edge 500s once the per-page payload gets fat.

const { authorizeRun } = require('./_adsauth');
const { extractCreative, textKey } = require('./_adscreative');

const GRAPH = 'https://graph.facebook.com/v21.0';
const TOKEN = process.env.META_ACCESS_TOKEN;
const ACCT = process.env.META_AD_ACCOUNT || 'act_242089740673955';
const APPS_URL = 'https://xcwrawjdfajlmbkdwlbm.supabase.co';
const APPS_KEY = process.env.APPS_SERVICE_ROLE_KEY;
const ALL_STATUS = ['ACTIVE', 'PAUSED', 'ARCHIVED', 'ADSET_PAUSED', 'CAMPAIGN_PAUSED',
  'PENDING_REVIEW', 'DISAPPROVED', 'PREAPPROVED', 'PENDING_BILLING_INFO', 'IN_PROCESS', 'WITH_ISSUES'];

const CREATIVE_ONLY = 'id,name,effective_status,created_time,adset_id,campaign_id,preview_shareable_link,'
  + 'creative{id,name,object_type,video_id,image_hash,image_url,thumbnail_url,body,title,'
  + 'object_story_id,effective_object_story_id,instagram_permalink_url,object_story_spec,asset_feed_spec}';

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

// Multi-get: /?ids=a,b,c&fields=... Falls back to smaller chunks, then to
// single reads, so one awkward ad can't cost us the other 382.
async function multiGet(ids, fields, chunk) {
  const out = {}; const failed = [];
  for (let i = 0; i < ids.length; i += chunk) {
    const slice = ids.slice(i, i + chunk);
    const url = GRAPH + '/?ids=' + encodeURIComponent(slice.join(',')) + '&fields=' + encodeURIComponent(fields)
      + '&access_token=' + encodeURIComponent(TOKEN);
    const r = await fetch(url); const j = await r.json().catch(() => ({}));
    if (j.error) {
      if (chunk > 1) {
        const sub = await multiGet(slice, fields, Math.max(1, Math.floor(chunk / 5)));
        Object.assign(out, sub.map); sub.failed.forEach(f => failed.push(f));
      } else failed.push({ id: slice[0], error: String(j.error.message || '').slice(0, 160) });
    } else {
      Object.keys(j).forEach(k => { out[k] = j[k]; });
    }
    await new Promise(x => setTimeout(x, 120));
  }
  return { map: out, failed };
}

async function run() {
  const out = { probed_at: new Date().toISOString(), round: 5, account: ACCT };

  // 1. Readable video library.
  const lib = await pageAll(ACCT + '/advideos', 'fields=id,title,length,created_time', 100, 60);
  const libIds = new Set(lib.rows.map(v => String(v.id)));
  const libById = {}; lib.rows.forEach(v => { libById[String(v.id)] = v; });
  out.library = { total: lib.rows.length, error: lib.err };

  // 2. Every ad, light.
  const light = await pageAll(ACCT + '/ads', 'fields=id,name,effective_status,created_time'
    + '&effective_status=' + encodeURIComponent(JSON.stringify(ALL_STATUS)), 50, 80);
  out.listing = { total: light.rows.length, pages: light.pages, error: light.err, truncated: light.truncated };

  // 3. Creative detail, batched.
  const ids = light.rows.map(a => a.id);
  const det = await multiGet(ids, CREATIVE_ONLY, 25);
  out.detail = { resolved: Object.keys(det.map).length, failed: det.failed.length, failed_sample: det.failed.slice(0, 5) };

  const rows = light.rows.map(a => {
    const full = det.map[a.id] || a;
    const x = extractCreative(full);
    const readable = x.video_ids.find(v => libIds.has(v)) || null;
    let kind = x.media_type;
    if (kind === 'video') kind = readable ? 'video_readable' : 'video_locked';
    return {
      ad_id: a.id, name: full.name || a.name, status: a.effective_status, created: a.created_time,
      kind, object_type: x.object_type, from_post: x.from_published_post, post_id: x.post_id,
      carousel_cards: x.carousel_cards, has_image: !!(x.image_hash || x.image_url),
      readable_video: readable, length_sec: readable && libById[readable] ? libById[readable].length : null,
      video_ids_seen: x.video_ids.length,
      body: x.body, headline: x.headline, description: x.description,
      body_variants: x.body_variants, headline_variants: x.headline_variants,
      cta: x.cta, body_key: x.body_key, headline_key: x.headline_key,
      detail_missing: !det.map[a.id],
    };
  });

  // --- Q1: what are they? ---
  const byKind = {}; const byObjType = {};
  rows.forEach(r => { byKind[r.kind] = (byKind[r.kind] || 0) + 1; byObjType[r.object_type || 'none'] = (byObjType[r.object_type || 'none'] || 0) + 1; });
  out.media_breakdown = byKind;
  out.object_type_breakdown = byObjType;

  const notVideo = rows.filter(r => !r.kind.startsWith('video'));
  out.non_video_ads = {
    count: notVideo.length,
    with_an_image: notVideo.filter(r => r.has_image).length,
    carousels: notVideo.filter(r => r.carousel_cards > 1).length,
    from_a_published_post: notVideo.filter(r => r.from_post).length,
    object_types: notVideo.reduce((m, r) => { m[r.object_type || 'none'] = (m[r.object_type || 'none'] || 0) + 1; return m; }, {}),
    sample: notVideo.slice(0, 10).map(r => ({ ad_id: r.ad_id, name: r.name, object_type: r.object_type, kind: r.kind, has_image: r.has_image, cards: r.carousel_cards, headline: r.headline, body: (r.body || '').slice(0, 100) })),
  };
  const locked = rows.filter(r => r.kind === 'video_locked');
  out.locked_videos = {
    count: locked.length,
    from_a_published_post: locked.filter(r => r.from_post).length,
    sample: locked.slice(0, 10).map(r => ({ ad_id: r.ad_id, name: r.name, created: r.created, from_post: r.from_post, ids: r.video_ids_seen })),
  };

  // --- Q2/Q3: copy, and who shares it ---
  const group = (keyField, textField) => {
    const m = new Map();
    rows.forEach(r => { const k = r[keyField]; if (!k) return;
      if (!m.has(k)) m.set(k, { key: k, text: r[textField], ads: [] });
      m.get(k).ads.push({ ad_id: r.ad_id, name: r.name, kind: r.kind }); });
    const arr = [...m.values()].sort((a, b) => b.ads.length - a.ads.length);
    return { unique: arr.length, reused_groups: arr.filter(g => g.ads.length > 1).length,
      ads_sharing_copy: arr.filter(g => g.ads.length > 1).reduce((n, g) => n + g.ads.length, 0),
      top: arr.slice(0, 12).map(g => ({ key: g.key, count: g.ads.length, text: (g.text || '').slice(0, 220), ads: g.ads.slice(0, 8).map(a => a.name) })) };
  };
  out.body_copy = { ads_with_body: rows.filter(r => r.body).length, ...group('body_key', 'body') };
  out.headlines = { ads_with_headline: rows.filter(r => r.headline).length, ...group('headline_key', 'headline') };
  out.dynamic_creative = {
    ads_with_multiple_bodies: rows.filter(r => r.body_variants > 1).length,
    ads_with_multiple_headlines: rows.filter(r => r.headline_variants > 1).length,
    max_bodies: Math.max(0, ...rows.map(r => r.body_variants)),
    max_headlines: Math.max(0, ...rows.map(r => r.headline_variants)),
  };

  // --- the newest 20, as the list will actually render them ---
  out.newest_20 = rows.slice().sort((a, b) => String(b.created).localeCompare(String(a.created))).slice(0, 20)
    .map(r => ({ name: r.name, kind: r.kind, created: r.created, len: r.length_sec,
      headline: r.headline, body: (r.body || '').slice(0, 120), cta: r.cta,
      body_shared: rows.filter(x => x.body_key && x.body_key === r.body_key).length }));

  out.text_coverage = {
    ads_total: rows.length,
    with_body: rows.filter(r => r.body).length,
    with_headline: rows.filter(r => r.headline).length,
    with_neither: rows.filter(r => !r.body && !r.headline).length,
    detail_missing: rows.filter(r => r.detail_missing).length,
  };
  return out;
}

exports.handler = async (event) => {
  const auth = await authorizeRun(event);
  if (!auth.ok) return { statusCode: 403, body: 'nope' };
  let result;
  try { result = await run(); }
  catch (e) { result = { round: 5, probed_at: new Date().toISOString(), fatal: String((e && e.stack) || e).slice(0, 1500) }; }
  const res = await fetch(APPS_URL + '/rest/v1/probe', { method: 'POST',
    headers: { apikey: APPS_KEY, Authorization: 'Bearer ' + APPS_KEY, 'Content-Type': 'application/json', 'Accept-Profile': 'ads', 'Content-Profile': 'ads', Prefer: 'return=minimal' },
    body: JSON.stringify([{ result }]) });
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, db: res.status }) };
};
