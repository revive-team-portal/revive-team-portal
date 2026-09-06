// Ads sync — everything about an ad that isn't the video itself.
//
// Runs nightly and on demand. Pulls every ad (active, paused AND archived),
// its creative shape, copy, headline, landing page and thumbnail, plus
// performance in three windows, and writes it all to ads.ad / ads.ad_perf.
// Video analysis is a separate, slower job — this one just marks which ads are
// waiting for it, so the list is fully populated long before the tagging runs.

const { authorizeRun } = require('./_adsauth');
const { extractCreative, codeOf } = require('./_adscreative');
const { graph, pageAll, multiGet, insights, shapePerf, nzToMetaOffsetDays, nzToday, ACCT } = require('./_adsmeta');
const { db, upsert, log } = require('./_adsdb');

const ALL_STATUS = ['ACTIVE', 'PAUSED', 'ARCHIVED', 'ADSET_PAUSED', 'CAMPAIGN_PAUSED',
  'PENDING_REVIEW', 'DISAPPROVED', 'PREAPPROVED', 'PENDING_BILLING_INFO', 'IN_PROCESS', 'WITH_ISSUES'];

const DETAIL_FIELDS = 'id,name,status,effective_status,created_time,updated_time,'
  + 'adset{id,name},campaign{id,name},preview_shareable_link,'
  + 'creative{id,name,object_type,video_id,image_hash,image_url,thumbnail_url,body,title,'
  + 'object_story_id,effective_object_story_id,instagram_permalink_url,object_story_spec,asset_feed_spec}';

// Brand is inferred from the ad name — it is how the team already labels them,
// and it is what the "Wopples only" filter needs.
function brandOf(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('wopple')) return 'Wopples';
  if (n.includes('waffle')) return 'Wopples';
  if (n.includes('cashew') || n.includes('nut butter')) return 'Nut Butter';
  if (n.includes('muesli')) return 'Muesli';
  if (n.includes('meal') || n.includes('hotpot') || n.includes('reheat')) return 'Meals';
  if (n.includes('cafe')) return 'Cafe';
  return 'Other';
}

function splitUrl(u) {
  if (!u) return { landing_page: null, utm: null };
  try {
    const x = new URL(u);
    const utm = [x.searchParams.get('utm_source'), x.searchParams.get('utm_medium'), x.searchParams.get('utm_campaign')].filter(Boolean).join('|') || null;
    return { landing_page: x.hostname.replace(/^www\./, '') + (x.pathname.replace(/\/$/, '') || '/'), utm };
  } catch (e) { return { landing_page: null, utm: null }; }
}

async function run(opts) {
  const started = Date.now();
  const out = { started_at: new Date().toISOString(), nz_date: nzToday() };
  out.tz = await nzToMetaOffsetDays();

  // 1. Which videos can we actually read? (the ad-account library)
  const lib = await pageAll(ACCT + '/advideos', 'fields=id,title,length,created_time', 100, 60);
  const libById = {}; (lib.rows || []).forEach(v => { libById[String(v.id)] = v; });
  out.library = { total: (lib.rows || []).length, error: lib.error };

  // 2. Every ad, light listing first (heavy fields blow the per-page payload).
  const listing = await pageAll(ACCT + '/ads',
    'fields=id,created_time&effective_status=' + encodeURIComponent(JSON.stringify(ALL_STATUS)), 50, 120);
  if (listing.error && !listing.rows.length) throw new Error('ad listing failed: ' + listing.error);
  out.listing = { total: listing.rows.length, error: listing.error };

  // 3. Creative detail, batched multi-get.
  const ids = listing.rows.map(a => a.id);
  const det = await multiGet(ids, DETAIL_FIELDS, 25);
  out.detail = { resolved: Object.keys(det.map).length, failed: det.failed.length };

  // 4. Performance, three windows. time_increment=1 on the 7-day window gives
  //    us active_days for free.
  const [life, last7d, last28] = await Promise.all([
    insights('maximum', null),
    insights('last_7d', 1),
    insights('last_28d', null),
  ]);
  out.insights = { lifetime: life.rows.length, last7_daily: last7d.rows.length, last28: last28.rows.length,
    errors: [life.error, last7d.error, last28.error].filter(Boolean) };

  // Roll the daily 7-day rows up per ad, counting the days that actually ran.
  const last7 = {};
  for (const r of last7d.rows) {
    const k = r.ad_id;
    if (!last7[k]) last7[k] = { ad_id: k, spend: 0, impressions: 0, reach: 0, clicks: 0, inline_link_clicks: 0,
      actions: [], action_values: [], video_play_actions: [], video_thruplay_watched_actions: [], _days: 0 };
    const t = last7[k];
    t.spend += Number(r.spend) || 0; t.impressions += Number(r.impressions) || 0;
    t.reach += Number(r.reach) || 0; t.clicks += Number(r.clicks) || 0;
    t.inline_link_clicks += Number(r.inline_link_clicks) || 0;
    if ((Number(r.impressions) || 0) > 0) t._days++;
    // Merge action arrays, summing each attribution window.
    const merge = (dst, src) => {
      for (const a of (src || [])) {
        let e = dst.find(x => x.action_type === a.action_type);
        if (!e) { e = { action_type: a.action_type }; dst.push(e); }
        for (const k2 of ['value', '1d_click', '7d_click', '1d_view']) if (a[k2] != null) e[k2] = String((Number(e[k2]) || 0) + Number(a[k2]));
      }
    };
    merge(t.actions, r.actions); merge(t.action_values, r.action_values);
    merge(t.video_play_actions, r.video_play_actions); merge(t.video_thruplay_watched_actions, r.video_thruplay_watched_actions);
  }

  const perfBy = (rows) => { const m = {}; rows.forEach(r => { m[r.ad_id] = r; }); return m; };
  const lifeBy = perfBy(life.rows), l28By = perfBy(last28.rows);

  // 5. What is already analysed — never downgrade a finished ad back to pending.
  const existing = await db('ad?select=ad_id,analysis_state,analysis_attempts').catch(() => []);
  const stateBy = {}; (existing || []).forEach(r => { stateBy[r.ad_id] = r; });

  const adRows = [], perfRows = [];
  for (const a of listing.rows) {
    const full = det.map[a.id];
    if (!full) continue;
    const x = extractCreative(full);
    const readable = x.video_ids.find(v => libById[v]) || null;
    const lp = splitUrl(x.link);
    const prev = stateBy[a.id];

    let media_type = x.media_type;
    if (media_type === 'video') media_type = readable ? 'video' : 'video_locked';

    // Analysis state: only ever move an ad forward.
    let analysis_state, analysis_note = null;
    if (prev && prev.analysis_state === 'done') analysis_state = 'done';
    else if (media_type === 'video_locked') { analysis_state = 'unavailable';
      analysis_note = 'Ad points at an already-published Facebook post, so Meta will not release the video to an ads_read token.'; }
    else if (media_type === 'video' || media_type === 'image' || media_type === 'carousel') analysis_state = 'pending';
    else { analysis_state = 'not_applicable'; analysis_note = 'No image or video creative found on this ad.'; }

    const l7 = last7[a.id];
    adRows.push({
      ad_id: a.id, ad_name: full.name || null,
      adset_id: full.adset ? full.adset.id : null, adset_name: full.adset ? full.adset.name : null,
      campaign_id: full.campaign ? full.campaign.id : null, campaign_name: full.campaign ? full.campaign.name : null,
      status: full.status || null, effective_status: full.effective_status || null,
      created_time: full.created_time || a.created_time || null,
      creative_id: x.creative_id, video_id: readable || (x.video_ids[0] || null),
      readable_video_id: readable, video_ids: x.video_ids,
      media_type, object_type: x.object_type,
      from_published_post: x.from_published_post, post_id: x.post_id, carousel_cards: x.carousel_cards,
      permalink: full.preview_shareable_link || null,
      preview_url: x.instagram_permalink || null,
      thumb_url: x.thumbnail_url || null, image_url: x.image_url || null,
      brand: brandOf(full.name), creative_code: codeOf(full.name),
      duration_sec: readable && libById[readable] ? libById[readable].length : null,
      body: x.body, headline: x.headline, description_text: x.description,
      bodies: x.bodies, headlines: x.headlines,
      body_variants: x.body_variants, headline_variants: x.headline_variants,
      body_key: x.body_key, headline_key: x.headline_key,
      cta: x.cta, landing_url: x.link, landing_page: lp.landing_page, utm: lp.utm,
      analysis_state, analysis_note,
      last_seen: nzToday(), updated_at: new Date().toISOString(),
    });

    if (lifeBy[a.id]) perfRows.push({ ...shapePerf(lifeBy[a.id], 'lifetime'), active_days: null });
    if (l7) perfRows.push({ ...shapePerf(l7, 'last7'), active_days: l7._days });
    if (l28By[a.id]) perfRows.push({ ...shapePerf(l28By[a.id], 'last28'), active_days: null });
  }

  out.wrote_ads = await upsert('ad', adRows, 'ad_id');
  out.wrote_perf = await upsert('ad_perf', perfRows, 'ad_id,win');

  // first_seen only on the way in, never overwritten.
  await db('ad?first_seen=is.null', { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ first_seen: nzToday() }) }).catch(() => {});

  out.pending_analysis = adRows.filter(r => r.analysis_state === 'pending').length;
  out.unavailable = adRows.filter(r => r.analysis_state === 'unavailable').length;
  out.by_media_type = adRows.reduce((m, r) => { m[r.media_type] = (m[r.media_type] || 0) + 1; return m; }, {});
  out.seconds = Math.round((Date.now() - started) / 1000);
  return out;
}

exports.handler = async (event) => {
  const auth = await authorizeRun(event);
  if (!auth.ok) {
    // Netlify's scheduler invokes with no query string; allow that path through.
    const isSchedule = !!(event && event.body && String(event.body).includes('next_run'));
    if (!isSchedule) return { statusCode: 403, body: 'nope' };
  }
  let out, ok = true;
  try { out = await run({}); }
  catch (e) { ok = false; out = { error: String((e && e.message) || e).slice(0, 500), stack: String((e && e.stack) || '').slice(0, 800) }; }
  await log('ads-sync', ok, out);
  return { statusCode: ok ? 200 : 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(out) };
};
