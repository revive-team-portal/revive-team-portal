// Ads app — capability probe (§7 of the build brief). Read-only, writes nothing to
// Meta. Answers the five unknowns the video pipeline depends on and stores the
// findings in ads.probe on Revive Apps. Background function so it gets 15 min.
//
//   GET /.netlify/functions/ads-probe-background?k=<PORTAL_RUN_KEY>
//
// Returns 202 immediately (Netlify background contract) — read the answer from
// ads.probe, newest row.

const { metaAccountTz } = require('./_metasync');
const { authorizeRun } = require('./_adsauth');

const GRAPH = 'https://graph.facebook.com/v21.0';
const TOKEN = process.env.META_ACCESS_TOKEN;
const ACCT = process.env.META_AD_ACCOUNT || 'act_242089740673955';
const APPS_URL = 'https://xcwrawjdfajlmbkdwlbm.supabase.co';
const APPS_KEY = process.env.APPS_SERVICE_ROLE_KEY;

const ALL_STATUS = ['ACTIVE', 'PAUSED', 'ARCHIVED', 'ADSET_PAUSED', 'CAMPAIGN_PAUSED',
  'PENDING_REVIEW', 'DISAPPROVED', 'PREAPPROVED', 'PENDING_BILLING_INFO', 'IN_PROCESS', 'WITH_ISSUES'];

// Signed Meta CDN URLs carry a short-lived token — never persist one whole.
const redact = (u) => {
  if (!u) return null;
  try { const x = new URL(u); return x.origin + x.pathname + (x.search ? '?…(' + (x.search.length - 1) + ' chars of query stripped)' : ''); }
  catch (e) { return String(u).slice(0, 80) + '…'; }
};

async function graph(path, qs) {
  if (!TOKEN) throw new Error('missing META_ACCESS_TOKEN');
  const url = GRAPH + '/' + path + '?' + (qs || '') + '&access_token=' + encodeURIComponent(TOKEN);
  const res = await fetch(url);
  const j = await res.json().catch(() => ({}));
  return { status: res.status, json: j };
}

// Walk an edge, collecting every page (bounded).
async function graphAll(path, qs, maxPages) {
  if (!TOKEN) throw new Error('missing META_ACCESS_TOKEN');
  let url = GRAPH + '/' + path + '?' + (qs || '') + '&access_token=' + encodeURIComponent(TOKEN);
  const all = []; let pages = 0; let err = null;
  for (let i = 0; i < (maxPages || 20) && url; i++) {
    const res = await fetch(url);
    const j = await res.json().catch(() => ({}));
    if (j.error) { err = String(j.error.message || JSON.stringify(j.error)).slice(0, 300); break; }
    (j.data || []).forEach(d => all.push(d));
    pages++;
    url = (j.paging && j.paging.next) ? j.paging.next : null;
  }
  return { rows: all, pages, error: err, truncated: !!url };
}

// A video id can hide in three places depending on how the ad was built.
function videoIdsOf(creative) {
  const out = [];
  if (!creative) return out;
  if (creative.video_id) out.push(String(creative.video_id));
  const vd = creative.object_story_spec && creative.object_story_spec.video_data;
  if (vd && vd.video_id) out.push(String(vd.video_id));
  const afs = creative.asset_feed_spec;
  if (afs && Array.isArray(afs.videos)) afs.videos.forEach(v => { if (v.video_id) out.push(String(v.video_id)); });
  return [...new Set(out)];
}

async function probeVideo(vid) {
  const out = { video_id: vid };

  // Q2 — the critical one: can an ads_read token read the raw mp4?
  const src = await graph(vid, 'fields=' + encodeURIComponent('source,permalink_url,length,created_time,title,description,updated_time'));
  out.source_call = {
    http: src.status,
    error: src.json.error ? { message: String(src.json.error.message || '').slice(0, 300), type: src.json.error.type, code: src.json.error.code, subcode: src.json.error.error_subcode } : null,
    has_source: !!src.json.source,
    source_host: src.json.source ? redact(src.json.source) : null,
    length_sec: src.json.length != null ? Number(src.json.length) : null,
    permalink_url: src.json.permalink_url || null,
    created_time: src.json.created_time || null,
    fields_returned: Object.keys(src.json || {}),
  };

  // Q5 — is that URL actually fetchable server-side, and does it honour Range?
  if (src.json.source) {
    try {
      const r = await fetch(src.json.source, { headers: { Range: 'bytes=0-1023' } });
      const buf = await r.arrayBuffer().catch(() => new ArrayBuffer(0));
      out.range_fetch = {
        http: r.status,
        content_type: r.headers.get('content-type'),
        content_length: r.headers.get('content-length'),
        content_range: r.headers.get('content-range'),
        accept_ranges: r.headers.get('accept-ranges'),
        bytes_received: buf.byteLength,
        looks_like_mp4: (() => { try { const b = new Uint8Array(buf).slice(4, 8); return String.fromCharCode(...b) === 'ftyp'; } catch (e) { return false; } })(),
      };
    } catch (e) { out.range_fetch = { error: String(e.message || e).slice(0, 200) }; }
  } else {
    out.range_fetch = { skipped: 'no source url' };
  }

  // Q3 — captions.
  const cap = await graph(vid + '/captions', 'limit=25');
  out.captions = {
    http: cap.status,
    error: cap.json.error ? String(cap.json.error.message || '').slice(0, 250) : null,
    count: Array.isArray(cap.json.data) ? cap.json.data.length : null,
    sample: Array.isArray(cap.json.data) ? cap.json.data.slice(0, 3) : null,
  };

  // Fallback path if source is refused — thumbnails across the timeline.
  const th = await graph(vid + '/thumbnails', 'limit=50');
  out.thumbnails = {
    http: th.status,
    error: th.json.error ? String(th.json.error.message || '').slice(0, 250) : null,
    count: Array.isArray(th.json.data) ? th.json.data.length : null,
    sample: Array.isArray(th.json.data) ? th.json.data.slice(0, 3).map(t => ({ id: t.id, width: t.width, height: t.height, is_preferred: t.is_preferred, uri: redact(t.uri) })) : null,
  };

  return out;
}

async function run() {
  const result = { probed_at: new Date().toISOString(), account: ACCT, graph_version: 'v21.0' };

  // Account basics + the live NZ->account date offset (never hardcode it).
  const acct = await graph(ACCT, 'fields=' + encodeURIComponent('name,currency,timezone_name,account_status'));
  result.account_info = acct.json.error ? { error: String(acct.json.error.message || '').slice(0, 250) } : acct.json;
  try { result.account_tz_via_metasync = await metaAccountTz(); } catch (e) { result.account_tz_via_metasync = 'error: ' + String(e.message || e); }

  // Q1 — does /ads return archived ads, and what creative fields come back?
  const adFields = [
    'id', 'name', 'status', 'effective_status', 'created_time', 'updated_time',
    'adset_id', 'campaign_id', 'preview_shareable_link',
    'adset{name}', 'campaign{name}',
    'creative{id,name,video_id,thumbnail_url,image_url,object_type,object_story_id,effective_object_story_id,instagram_permalink_url,object_story_spec,asset_feed_spec}',
  ].join(',');

  const qs = 'fields=' + encodeURIComponent(adFields)
    + '&effective_status=' + encodeURIComponent(JSON.stringify(ALL_STATUS))
    + '&limit=100';
  const withArchived = await graphAll(ACCT + '/ads', qs, 20);

  // Control: same call without the status filter, to prove the filter is what surfaces archived.
  const defaultCall = await graphAll(ACCT + '/ads', 'fields=id,effective_status&limit=100', 20);

  const tally = (rows) => rows.reduce((m, a) => { const k = a.effective_status || 'UNKNOWN'; m[k] = (m[k] || 0) + 1; return m; }, {});
  result.q1_ads_listing = {
    with_status_filter: { total: withArchived.rows.length, pages: withArchived.pages, error: withArchived.error, truncated: withArchived.truncated, by_effective_status: tally(withArchived.rows) },
    without_status_filter: { total: defaultCall.rows.length, pages: defaultCall.pages, error: defaultCall.error, by_effective_status: tally(defaultCall.rows) },
    archived_returned: (tally(withArchived.rows).ARCHIVED || 0) > 0,
  };

  const ads = withArchived.rows.slice();
  // Newest first so "the last ~10 ads" means what Jeremy expects.
  ads.sort((a, b) => String(b.created_time || '').localeCompare(String(a.created_time || '')));

  // What creative shape actually comes back — the union of keys seen.
  const creativeKeys = new Set(); const ossKeys = new Set(); const afsKeys = new Set();
  ads.forEach(a => {
    const c = a.creative; if (!c) return;
    Object.keys(c).forEach(k => creativeKeys.add(k));
    if (c.object_story_spec) Object.keys(c.object_story_spec).forEach(k => ossKeys.add(k));
    if (c.asset_feed_spec) Object.keys(c.asset_feed_spec).forEach(k => afsKeys.add(k));
  });
  const withVideo = ads.filter(a => videoIdsOf(a.creative).length);
  result.q1_creative_shape = {
    ads_with_creative: ads.filter(a => a.creative).length,
    ads_with_a_video_id: withVideo.length,
    ads_without_video_id: ads.length - withVideo.length,
    creative_fields_seen: [...creativeKeys].sort(),
    object_story_spec_keys_seen: [...ossKeys].sort(),
    asset_feed_spec_keys_seen: [...afsKeys].sort(),
    ads_with_preview_shareable_link: ads.filter(a => a.preview_shareable_link).length,
  };
  result.newest_10_ads = ads.slice(0, 10).map(a => ({
    ad_id: a.id, name: a.name, effective_status: a.effective_status, created_time: a.created_time,
    campaign: a.campaign && a.campaign.name, adset: a.adset && a.adset.name,
    creative_id: a.creative && a.creative.id,
    video_ids: videoIdsOf(a.creative),
    object_type: a.creative && a.creative.object_type,
    thumb: a.creative ? redact(a.creative.thumbnail_url) : null,
    has_preview_link: !!a.preview_shareable_link,
  }));

  // Pick up to 3 video ads to probe deeply — spread across statuses so we learn
  // whether archived behaves differently from active.
  const picks = []; const seenStatus = new Set();
  for (const a of withVideo) {
    const s = a.effective_status || 'UNKNOWN';
    if (!seenStatus.has(s)) { seenStatus.add(s); picks.push(a); }
    if (picks.length >= 3) break;
  }
  for (const a of withVideo) { if (picks.length >= 3) break; if (!picks.includes(a)) picks.push(a); }

  result.q2_q3_q5_video_probes = [];
  for (const a of picks) {
    const vid = videoIdsOf(a.creative)[0];
    let v;
    try { v = await probeVideo(vid); } catch (e) { v = { video_id: vid, error: String(e.message || e).slice(0, 250) }; }
    v.ad_id = a.id; v.ad_name = a.name; v.effective_status = a.effective_status; v.created_time = a.created_time;

    // Q4 — embeddable preview for this ad.
    const pv = await graph(a.id + '/previews', 'ad_format=MOBILE_FEED_STANDARD');
    const body = (pv.json.data && pv.json.data[0] && pv.json.data[0].body) || null;
    v.preview = {
      http: pv.status,
      error: pv.json.error ? String(pv.json.error.message || '').slice(0, 250) : null,
      returned: !!body,
      iframe_src: body ? redact((body.match(/src="([^"]+)"/) || [])[1] || null) : null,
      body_len: body ? body.length : 0,
    };
    v.permalink_shareable = a.preview_shareable_link ? redact(a.preview_shareable_link) : null;
    result.q2_q3_q5_video_probes.push(v);
    await new Promise(r => setTimeout(r, 400)); // be polite to the API
  }

  // Headline verdict, so the row is readable at a glance.
  const anySource = result.q2_q3_q5_video_probes.some(p => p.source_call && p.source_call.has_source);
  const anyFetch = result.q2_q3_q5_video_probes.some(p => p.range_fetch && p.range_fetch.http && p.range_fetch.http < 400);
  const anyCaps = result.q2_q3_q5_video_probes.some(p => p.captions && p.captions.count > 0);
  const anyPrev = result.q2_q3_q5_video_probes.some(p => p.preview && p.preview.returned);
  const anyThumbs = result.q2_q3_q5_video_probes.some(p => p.thumbnails && p.thumbnails.count > 0);
  result.verdict = {
    q1_archived_ads_returned: result.q1_ads_listing.archived_returned,
    q2_can_read_video_source: anySource,
    q3_captions_available: anyCaps,
    q4_previews_embeddable: anyPrev,
    q5_source_fetchable_server_side: anyFetch,
    thumbnails_fallback_available: anyThumbs,
    pipeline_viable_as_designed: anySource && anyFetch,
  };
  return result;
}

async function writeProbe(result) {
  if (!APPS_KEY) return { written: false, why: 'missing APPS_SERVICE_ROLE_KEY' };
  const res = await fetch(APPS_URL + '/rest/v1/probe', {
    method: 'POST',
    headers: {
      apikey: APPS_KEY, Authorization: 'Bearer ' + APPS_KEY, 'Content-Type': 'application/json',
      'Accept-Profile': 'ads', 'Content-Profile': 'ads', Prefer: 'return=representation',
    },
    body: JSON.stringify([{ result }]),
  });
  const t = await res.text();
  return { written: res.ok, status: res.status, detail: t.slice(0, 300) };
}

exports.handler = async (event) => {
  const auth = await authorizeRun(event);
  if (!auth.ok) return { statusCode: 403, body: 'nope' };
  let result;
  try { result = await run(); }
  catch (e) { result = { probed_at: new Date().toISOString(), fatal: String((e && e.stack) || e).slice(0, 1500) }; }
  result.authorized_via = auth.how;
  const w = await writeProbe(result).catch(e => ({ written: false, why: String(e.message || e) }));
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, db: w }) };
};
