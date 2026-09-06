// Creative extraction for the Ads app.
//
// A Meta ad hides its media and its copy in a different place depending on how
// it was built: object_story_spec.video_data (video uploaded to the ad account),
// .link_data (image/link ad, possibly a carousel), .photo_data (plain image),
// asset_feed_spec (Advantage+ / dynamic creative, where Meta holds several
// bodies and titles and picks between them), or nowhere at all when the ad just
// points at an already-published Page post.
//
// Everything downstream — the list, the tagging, the copy-reuse grouping —
// reads through here so there is exactly one place that knows those shapes.

// --- text helpers -----------------------------------------------------------

// Normalise for COMPARISON only. Never store this — store the original.
function normText(s) {
  if (s == null) return '';
  return String(s)
    .replace(/ /g, ' ')            // nbsp
    .replace(/[​-‍﻿]/g, '') // zero-width junk
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Short stable hash (FNV-1a, 32-bit) — enough to group a few hundred strings.
function textKey(s) {
  const n = normText(s);
  if (!n) return null;
  let h = 0x811c9dc5;
  for (let i = 0; i < n.length; i++) { h ^= n.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

const push = (arr, v) => { if (v != null && String(v).trim()) arr.push(String(v).trim()); };
const uniq = (a) => [...new Set(a)];

// --- extraction -------------------------------------------------------------

function extractCreative(ad) {
  const c = (ad && ad.creative) || {};
  const oss = c.object_story_spec || {};
  const afs = c.asset_feed_spec || {};
  const vd = oss.video_data || null;
  const ld = oss.link_data || null;
  const pd = oss.photo_data || null;

  const bodies = [], headlines = [], descriptions = [], ctas = [], links = [], images = [];
  const videoIds = [];

  // --- video ids, in the order we prefer them. The ad-account library copy
  //     (video_data.video_id) is the one we can actually read the mp4 for;
  //     creative.video_id is usually the published Page post's copy, which the
  //     ads_read token is refused on.
  if (vd && vd.video_id) videoIds.push(String(vd.video_id));
  if (Array.isArray(afs.videos)) afs.videos.forEach(v => { if (v.video_id) videoIds.push(String(v.video_id)); });
  if (c.video_id) videoIds.push(String(c.video_id));

  // --- copy
  if (vd) { push(bodies, vd.message); push(headlines, vd.title); push(descriptions, vd.link_description);
    if (vd.call_to_action) { push(ctas, vd.call_to_action.type); push(links, vd.call_to_action.value && vd.call_to_action.value.link); }
    push(images, vd.image_url); }
  if (ld) { push(bodies, ld.message); push(headlines, ld.name); push(descriptions, ld.description);
    push(links, ld.link); push(images, ld.picture);
    if (ld.call_to_action) push(ctas, ld.call_to_action.type);
    // Carousel cards each carry their own headline/description.
    (ld.child_attachments || []).forEach(k => { push(headlines, k.name); push(descriptions, k.description); push(links, k.link); push(images, k.picture); if (k.video_id) videoIds.push(String(k.video_id)); }); }
  if (pd) { push(bodies, pd.message); push(images, pd.url); }

  // Dynamic creative: Meta stores a pool it chooses between.
  (afs.bodies || []).forEach(b => push(bodies, b.text));
  (afs.titles || []).forEach(t => push(headlines, t.text));
  (afs.descriptions || []).forEach(d => push(descriptions, d.text));
  (afs.call_to_action_types || []).forEach(t => push(ctas, t));
  (afs.link_urls || []).forEach(l => push(links, l.website_url || l.display_url));
  (afs.images || []).forEach(i => push(images, i.url));

  // Legacy flat fields — older ads still populate these and nothing else.
  push(bodies, c.body); push(headlines, c.title);
  push(images, c.image_url); push(images, c.thumbnail_url);

  const carouselCards = ld && Array.isArray(ld.child_attachments) ? ld.child_attachments.length : 0;
  const hasVideo = videoIds.length > 0;
  // A still is a still whether it arrived as a photo post, a link ad, a boosted
  // status, or nothing but a creative thumbnail — if there are pixels, we can tag it.
  const hasImage = !!(c.image_hash || c.image_url || c.thumbnail_url || pd
    || (ld && !ld.child_attachments) || (afs.images || []).length || images.length);

  // --- media type. object_type is Meta's own label but it lies often enough
  //     (SHARE covers both a boosted photo post and a boosted video post), so
  //     decide from what is actually present and keep object_type alongside.
  let media_type;
  if (hasVideo) media_type = 'video';
  else if (carouselCards > 1) media_type = 'carousel';
  else if (c.object_type === 'VIDEO') media_type = 'video_unresolved';
  else if (hasImage || ['PHOTO', 'SHARE', 'STATUS'].includes(c.object_type)) media_type = 'image';
  else media_type = 'unknown';

  const body = bodies[0] || null;
  const headline = headlines[0] || null;

  return {
    media_type,
    object_type: c.object_type || null,
    creative_id: c.id || null,
    video_ids: uniq(videoIds),
    // The published-post id — present when the ad points at an existing post,
    // which is exactly the case where we cannot reach the video.
    post_id: c.effective_object_story_id || c.object_story_id || null,
    from_published_post: !!(c.effective_object_story_id || c.object_story_id) && !(vd || pd || (ld && ld.message)),
    carousel_cards: carouselCards,
    image_hash: c.image_hash || null,
    image_url: images[0] || null,
    thumbnail_url: c.thumbnail_url || null,
    // Copy. `body`/`headline` are what the list shows; the arrays keep every
    // variant so a dynamic-creative ad isn't misrepresented as having one.
    body, headline,
    description: descriptions[0] || null,
    bodies: uniq(bodies), headlines: uniq(headlines), descriptions: uniq(descriptions),
    body_variants: uniq(bodies).length, headline_variants: uniq(headlines).length,
    cta: uniq(ctas)[0] || null,
    link: uniq(links)[0] || null,
    body_key: textKey(body), headline_key: textKey(headline),
    instagram_permalink: c.instagram_permalink_url || null,
  };
}

// The team numbers every creative ("102a", "165a", "S509") and reuses that
// number wherever the creative runs, so it is the most reliable way to tell
// that two ads are the same film in different ad sets.
function codeOf(name) {
  if (!name) return null;
  const t = String(name).trim().split(/[\s_\-–—]+/)[0].replace(/\.(mov|mp4|m4v|avi)$/i, '');
  const m = t.match(/^([A-Za-z]{0,3}\d{1,4}[A-Za-z]?)$/);
  return m ? m[1].toUpperCase() : null;
}

// The field list to request for an ad so extractCreative has everything.
const AD_FIELDS = [
  'id', 'name', 'status', 'effective_status', 'created_time', 'updated_time',
  'adset_id', 'campaign_id', 'preview_shareable_link',
  'creative{id,name,object_type,video_id,image_hash,image_url,thumbnail_url,body,title,'
  + 'object_story_id,effective_object_story_id,instagram_permalink_url,object_story_spec,asset_feed_spec}',
].join(',');

module.exports = { extractCreative, normText, textKey, codeOf, AD_FIELDS };
