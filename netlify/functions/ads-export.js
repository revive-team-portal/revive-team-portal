// Machine-readable export of the tagged ad corpus, for Claude and for other
// portal apps that want to reason over creative alongside performance.
// Guarded by PORTAL_RUN_KEY, or by a single-use run key from ads.job.
//
//   GET /.netlify/functions/ads-export?k=<key>
//     &state=done|pending|all      (default all)
//     &media=video|image|carousel|video_locked
//     &brand=Wopples
//     &since=YYYY-MM-DD            (ad created on or after)
//     &limit=200&offset=0
//     &fields=list|full            (list = list-view fields, full = + transcript)
//
// Shape is documented in AGENTS.md under "Ads app".
const { authorizeRun } = require('./_adsauth');
const { payload } = require('./ads-data');

exports.handler = async (event) => {
  const auth = await authorizeRun(event);
  if (!auth.ok) return { statusCode: 403, body: 'nope' };
  const qp = (event && event.queryStringParameters) || {};
  try {
    const data = await payload();
    let rows = data.ads;
    if (qp.state && qp.state !== 'all') rows = rows.filter(r => r.analysis_state === qp.state);
    if (qp.media) rows = rows.filter(r => r.media_type === qp.media);
    if (qp.brand) rows = rows.filter(r => (r.brand || '').toLowerCase() === qp.brand.toLowerCase());
    if (qp.since) rows = rows.filter(r => (r.created_time || '') >= qp.since);
    const total = rows.length;
    const offset = Math.max(0, Number(qp.offset) || 0);
    const limit = Math.min(Math.max(Number(qp.limit) || 200, 1), 500);
    rows = rows.slice(offset, offset + limit);
    if (qp.fields === 'list') rows = rows.map(r => {
      const { tags, frames, bodies, headlines, ...rest } = r;
      return { ...rest, tags: tags ? { ...tags, transcript: undefined, onscreen_text: undefined } : null };
    });
    return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ ok: true, total, offset, limit, returned: rows.length,
        counts: data.counts, media: data.media, generated_at: data.generated_at, ads: rows }) };
  } catch (e) {
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: String((e && e.message) || e).slice(0, 300) }) };
  }
};
