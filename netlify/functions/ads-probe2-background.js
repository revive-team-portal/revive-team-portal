// Ads probe, round 2. Round 1 established that /{video_id}?fields=source is
// refused with "(#10) Application does not have permission for this action" —
// so before concluding the video pipeline is impossible, test every other route
// to the pixels: the ad-account video library (/act_X/advideos), per-field
// isolation on the video node, the creative thumbnail, and the ad preview.
// Findings land in ads.probe alongside round 1.

const { authorizeRun } = require('./_adsauth');

const GRAPH = 'https://graph.facebook.com/v21.0';
const TOKEN = process.env.META_ACCESS_TOKEN;
const ACCT = process.env.META_AD_ACCOUNT || 'act_242089740673955';
const APPS_URL = 'https://xcwrawjdfajlmbkdwlbm.supabase.co';
const APPS_KEY = process.env.APPS_SERVICE_ROLE_KEY;

const redact = (u) => {
  if (!u) return null;
  try { const x = new URL(u); return x.origin + x.pathname + (x.search ? '?…(' + (x.search.length - 1) + ' chars stripped)' : ''); }
  catch (e) { return String(u).slice(0, 80) + '…'; }
};

async function graph(path, qs) {
  const url = GRAPH + '/' + path + '?' + (qs || '') + '&access_token=' + encodeURIComponent(TOKEN);
  const res = await fetch(url);
  const j = await res.json().catch(() => ({}));
  return { http: res.status, json: j, err: j.error ? { code: j.error.code, sub: j.error.error_subcode, type: j.error.type, message: String(j.error.message || '').slice(0, 220) } : null };
}

// Ask for one field at a time so we learn exactly which field trips the #10,
// rather than losing the whole call to the strictest one.
async function fieldByField(node, fields) {
  const out = {};
  for (const f of fields) {
    const r = await graph(node, 'fields=' + encodeURIComponent(f));
    out[f] = r.err ? { error: r.err.message, code: r.err.code } : { ok: true, value_type: typeof r.json[f], present: r.json[f] !== undefined, preview: (() => {
      const v = r.json[f];
      if (v == null) return null;
      if (typeof v === 'string') return v.startsWith('http') ? redact(v) : v.slice(0, 120);
      if (typeof v === 'number') return v;
      return JSON.stringify(v).slice(0, 300);
    })() };
    await new Promise(r2 => setTimeout(r2, 150));
  }
  return out;
}

// Can we actually pull bytes down server-side, and is it really media?
async function fetchProbe(url, range) {
  if (!url) return { skipped: 'no url' };
  try {
    const r = await fetch(url, range ? { headers: { Range: 'bytes=0-2047' } } : {});
    const buf = await r.arrayBuffer().catch(() => new ArrayBuffer(0));
    const b = new Uint8Array(buf);
    const magic = [...b.slice(0, 12)].map(x => x.toString(16).padStart(2, '0')).join(' ');
    return {
      http: r.status, content_type: r.headers.get('content-type'), content_length: r.headers.get('content-length'),
      content_range: r.headers.get('content-range'), accept_ranges: r.headers.get('accept-ranges'),
      bytes: b.byteLength, magic_hex: magic,
      looks_jpeg: b[0] === 0xff && b[1] === 0xd8, looks_png: b[0] === 0x89 && b[1] === 0x50,
      looks_mp4: (() => { try { return String.fromCharCode(...b.slice(4, 8)) === 'ftyp'; } catch (e) { return false; } })(),
    };
  } catch (e) { return { error: String(e.message || e).slice(0, 200) }; }
}

async function run() {
  const out = { probed_at: new Date().toISOString(), round: 2, account: ACCT };

  // --- What is this token actually allowed to do? ---
  out.token = {};
  out.token.me = await graph('me', 'fields=id,name').then(r => r.err ? { error: r.err } : r.json);
  out.token.permissions = await graph('me/permissions', '').then(r => r.err ? { error: r.err } : (r.json.data || []).map(p => p.permission + ':' + p.status));
  out.token.accounts_pages = await graph('me/accounts', 'fields=id,name,tasks&limit=25').then(r => r.err ? { error: r.err } : (r.json.data || []).map(p => ({ id: p.id, name: p.name, tasks: p.tasks })));

  // --- Route A: the ad account's own video library. This edge is governed by
  //     ads_read, not by Page permissions, so it may hand over what the video
  //     node refuses. ---
  const adv = await graph(ACCT + '/advideos', 'fields=id,title,created_time&limit=10');
  out.route_a_advideos_listing = adv.err ? { error: adv.err } : { count: (adv.json.data || []).length, sample: (adv.json.data || []).slice(0, 5) };

  const advIds = adv.err ? [] : (adv.json.data || []).map(v => v.id);
  const VIDEO_FIELDS = ['id', 'title', 'description', 'length', 'created_time', 'updated_time', 'source', 'picture', 'permalink_url', 'thumbnails', 'captions', 'format', 'status'];

  out.route_a_advideos_fields = {};
  if (advIds.length) {
    out.route_a_advideos_fields[advIds[0]] = await fieldByField(advIds[0], VIDEO_FIELDS);
    // If source came back, prove the bytes are reachable.
    const s = await graph(advIds[0], 'fields=source');
    if (s.json && s.json.source) {
      out.route_a_source_fetch = await fetchProbe(s.json.source, true);
      out.route_a_source_host = redact(s.json.source);
    }
  }

  // --- Route B: the video ids that the ads themselves reference, field by field. ---
  const ads = await graph(ACCT + '/ads', 'fields=' + encodeURIComponent('id,name,effective_status,created_time,preview_shareable_link,creative{id,video_id,thumbnail_url,image_url,object_story_spec}')
    + '&effective_status=' + encodeURIComponent(JSON.stringify(['ACTIVE', 'PAUSED', 'ARCHIVED', 'ADSET_PAUSED', 'CAMPAIGN_PAUSED', 'WITH_ISSUES'])) + '&limit=10');
  const adRows = ads.err ? [] : (ads.json.data || []);
  out.route_b_sample_ads = adRows.length;

  const first = adRows.find(a => a.creative && (a.creative.video_id || (a.creative.object_story_spec && a.creative.object_story_spec.video_data)));
  if (first) {
    const c = first.creative;
    const vd = (c.object_story_spec && c.object_story_spec.video_data) || null;
    const vid = c.video_id || (vd && vd.video_id);
    out.route_b = { ad_id: first.id, ad_name: first.name, video_id: vid,
      video_data_keys: vd ? Object.keys(vd) : null,
      video_data_image_url: vd && vd.image_url ? redact(vd.image_url) : null,
      creative_thumbnail_url: redact(c.thumbnail_url), creative_image_url: redact(c.image_url) };
    out.route_b.video_node_fields = await fieldByField(vid, VIDEO_FIELDS);

    // --- Route C: is the creative thumbnail a real, downloadable image? ---
    out.route_c_thumbnail_fetch = await fetchProbe(c.thumbnail_url, false);
    if (vd && vd.image_url) out.route_c_video_data_image_fetch = await fetchProbe(vd.image_url, false);

    // --- Route D: previews. Which formats render, and is the iframe public? ---
    out.route_d_previews = {};
    for (const fmt of ['MOBILE_FEED_STANDARD', 'INSTAGRAM_STORY', 'INSTAGRAM_REELS', 'FACEBOOK_STORY_MOBILE']) {
      const p = await graph(first.id + '/previews', 'ad_format=' + fmt);
      const body = (p.json.data && p.json.data[0] && p.json.data[0].body) || null;
      const src = body ? (body.match(/src="([^"]+)"/) || [])[1] : null;
      let iframe = null;
      if (src) {
        const clean = src.replace(/&amp;/g, '&');
        try { const r = await fetch(clean); const t = await r.text(); iframe = { http: r.status, len: t.length, has_video_tag: /<video/i.test(t), mentions_login: /login|checkpoint/i.test(t.slice(0, 4000)) }; }
        catch (e) { iframe = { error: String(e.message || e).slice(0, 150) }; }
      }
      out.route_d_previews[fmt] = { error: p.err ? p.err.message : null, returned: !!body, iframe_reachable: iframe };
      await new Promise(r => setTimeout(r, 200));
    }
    out.route_d_shareable_link = first.preview_shareable_link || null;
  }

  // --- What the pixels question comes down to ---
  const aSrc = out.route_a_advideos_fields && advIds.length && out.route_a_advideos_fields[advIds[0]] && out.route_a_advideos_fields[advIds[0]].source;
  const bSrc = out.route_b && out.route_b.video_node_fields && out.route_b.video_node_fields.source;
  out.verdict = {
    advideos_edge_readable: !(adv.err),
    advideos_source_readable: !!(aSrc && aSrc.ok && aSrc.present),
    ad_video_source_readable: !!(bSrc && bSrc.ok && bSrc.present),
    mp4_bytes_fetchable: !!(out.route_a_source_fetch && out.route_a_source_fetch.looks_mp4),
    thumbnail_downloadable: !!(out.route_c_thumbnail_fetch && (out.route_c_thumbnail_fetch.looks_jpeg || out.route_c_thumbnail_fetch.looks_png)),
    preview_iframe_public: !!(out.route_d_previews && out.route_d_previews.MOBILE_FEED_STANDARD && out.route_d_previews.MOBILE_FEED_STANDARD.iframe_reachable && out.route_d_previews.MOBILE_FEED_STANDARD.iframe_reachable.http === 200),
  };
  return out;
}

exports.handler = async (event) => {
  const auth = await authorizeRun(event);
  if (!auth.ok) return { statusCode: 403, body: 'nope' };
  let result;
  try { result = await run(); }
  catch (e) { result = { round: 2, probed_at: new Date().toISOString(), fatal: String((e && e.stack) || e).slice(0, 1500) }; }
  const res = await fetch(APPS_URL + '/rest/v1/probe', {
    method: 'POST',
    headers: { apikey: APPS_KEY, Authorization: 'Bearer ' + APPS_KEY, 'Content-Type': 'application/json', 'Accept-Profile': 'ads', 'Content-Profile': 'ads', Prefer: 'return=minimal' },
    body: JSON.stringify([{ result }]),
  });
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, db: res.status }) };
};
