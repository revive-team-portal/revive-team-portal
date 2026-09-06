// Read endpoint for the Ads page. Gated on a logged-in portal user with `ads`
// access — the browser never touches the database directly.
const { json, validatePortalUser } = require('./_portal');
const { db } = require('./_adsdb');

// Everything the list needs, shaped once here so the page stays dumb.
async function payload() {
  const [ads, tags, perf, frames, cfg] = await Promise.all([
    db('ad?select=ad_id,ad_name,adset_name,campaign_name,status,effective_status,created_time,'
      + 'media_type,object_type,brand,creative_code,duration_sec,permalink,preview_url,thumb_url,image_url,'
      + 'body,headline,description_text,cta,landing_url,landing_page,utm,body_variants,headline_variants,'
      + 'body_key,headline_key,analysis_state,analysis_note,analysis_at,from_published_post,carousel_cards,'
      + 'readable_video_id,video_match_method,video_match_note,first_seen,last_seen&order=created_time.desc'),
    db('ad_tags?select=*'),
    db('ad_perf?select=*'),
    db('ad_frame?select=ad_id,kind,t_sec,public_url'),
    db('config?select=key,value'),
  ]);

  const tagBy = {}; (tags || []).forEach(t => { tagBy[t.ad_id] = t; });
  const frameBy = {}; (frames || []).forEach(f => { (frameBy[f.ad_id] = frameBy[f.ad_id] || []).push(f); });
  const perfBy = {}; (perf || []).forEach(p => { (perfBy[p.ad_id] = perfBy[p.ad_id] || {})[p.win] = p; });

  // How many ads share each piece of copy — the "same words, different creative"
  // grouping Jeremy asked for.
  const bodyCount = {}, headCount = {};
  (ads || []).forEach(a => { if (a.body_key) bodyCount[a.body_key] = (bodyCount[a.body_key] || 0) + 1;
    if (a.headline_key) headCount[a.headline_key] = (headCount[a.headline_key] || 0) + 1; });

  const rows = (ads || []).map(a => {
    const t = tagBy[a.ad_id] || null;
    const p = perfBy[a.ad_id] || {};
    const fr = (frameBy[a.ad_id] || []).sort((x, y) => (x.t_sec || 0) - (y.t_sec || 0));
    const life = p.lifetime || {}, l7 = p.last7 || {};
    return {
      ...a,
      body_shared: a.body_key ? bodyCount[a.body_key] : 0,
      headline_shared: a.headline_key ? headCount[a.headline_key] : 0,
      frames: fr,
      thumb: (fr.find(f => f.kind === 'opening') || {}).public_url || a.image_url || a.thumb_url || null,
      spend: life.spend || 0,
      impressions: life.impressions || 0,
      purchases_1d_click: life.purchases_1d_click || 0,
      purchases_7d_click: life.purchases_7d_click || 0,
      purchases_1d_view: life.purchases_1d_view || 0,
      value_7d_click: life.value_7d_click || 0,
      ctr: life.ctr, cpm: life.cpm, cpc: life.cpc,
      roas: life.roas, cpa: life.cpa,
      hook_rate: life.hook_rate, hook_rate_basis: life.hook_rate_basis,
      hold_rate: life.hold_rate, thruplay_rate: life.thruplay_rate,
      completion_rate: life.completion_rate, avg_watch_sec: life.avg_watch_sec,
      video_3s: life.video_3s, video_plays: life.video_plays, thruplays: life.thruplays,
      spend_7: l7.spend || 0, active_days_7: l7.active_days || 0,
      active_last_7: (l7.impressions || 0) > 0,
      tags: t ? {
        format: t.format, lighting: t.lighting, shoot_type: t.shoot_type,
        time_to_first_cut: t.time_to_first_cut, total_cuts: t.total_cuts, length_sec: t.length_sec,
        product_in_first_3s: t.product_in_first_3s, first_product_at: t.first_product_at,
        toaster_or_plate: t.toaster_or_plate, eating_on_camera: t.eating_on_camera,
        visible_claims: t.visible_claims, subtitles_present: t.subtitles_present,
        hook_words: t.hook_words, transcript: t.transcript, transcript_source: t.transcript_source,
        onscreen_text: t.onscreen_text, spoken_words: t.spoken_words, still_analysis: t.still_analysis,
        scores: t.scores, score_notes: t.score_notes, observations: t.observations,
        recommendation: t.recommendation,
        summary: (t.raw && t.raw.summary) || null,
        verdict: (t.raw && t.raw.verdict) || null,
        tagged_at: t.tagged_at,
      } : null,
    };
  });

  const conf = {}; (cfg || []).forEach(c => { conf[c.key] = c.value; });
  return {
    ads: rows,
    counts: rows.reduce((m, r) => { m[r.analysis_state] = (m[r.analysis_state] || 0) + 1; return m; }, {}),
    media: rows.reduce((m, r) => { m[r.media_type] = (m[r.media_type] || 0) + 1; return m; }, {}),
    brands: [...new Set(rows.map(r => r.brand).filter(Boolean))].sort(),
    campaigns: [...new Set(rows.map(r => r.campaign_name).filter(Boolean))].sort(),
    config: conf,
    generated_at: new Date().toISOString(),
  };
}

exports.handler = async (event) => {
  const auth = await validatePortalUser(event, 'ads');
  if (!auth.ok) return json(auth.status || 403, { error: auth.error });
  try { return json(200, await payload()); }
  catch (e) { return json(500, { error: String((e && e.message) || e).slice(0, 300) }); }
};
module.exports.payload = payload;
