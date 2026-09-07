// Ads probe, round 7 — a different angle on the 84 locked ads.
//
// The earlier fingerprint compared an ad's creative thumbnail against the
// library video's poster frame. Those two images come from different places and
// are processed differently, which is probably why it only managed 22%.
//
// Every AD thumbnail, locked or not, arrives through the same Meta proxy
// (external-*.fbcdn.net/emg1/...). So compare ad thumbnail to ad thumbnail
// instead: if a locked ad is a rerun of a creative that also ran as a readable
// ad, the two thumbnails should be near-identical rather than merely similar.
//
// Validation is built in: readable ads that already share a video id are known
// duplicates, so the method can be scored before it is trusted.
//
// Also tests whether the public Facebook video embed is reachable for a locked
// ad, which would at least let the page play the thing.

const fs = require('fs');
const cp = require('child_process');
const path = require('path');
const { authorizeRun } = require('./_adsauth');
const { db, log } = require('./_adsdb');

const BIN = '/tmp/adsbin';
const WORK = '/tmp/adsfp7';

function findBinSrc() {
  const roots = [process.env.LAMBDA_TASK_ROOT && path.join(process.env.LAMBDA_TASK_ROOT, 'bin'),
    path.join(__dirname, 'bin'), path.join(__dirname, '..', 'bin'), path.join(__dirname, '..', '..', 'bin'),
    path.join(__dirname, '..', '..', '..', 'bin'), path.join(process.cwd(), 'bin'), '/var/task/bin'].filter(Boolean);
  for (const r of roots) { try { if (fs.existsSync(path.join(r, 'ffmpeg'))) return r; } catch (e) {} }
  return null;
}
function ensureFfmpeg() {
  if (fs.existsSync(BIN + '/ffmpeg')) return;
  const src = findBinSrc(); if (!src) throw new Error('ffmpeg not bundled');
  fs.mkdirSync(BIN, { recursive: true });
  fs.copyFileSync(path.join(src, 'ffmpeg'), BIN + '/ffmpeg'); fs.chmodSync(BIN + '/ffmpeg', 0o755);
}

// 16x16 difference hash — 256 bits. Four times the resolution of the first
// attempt, which matters when the candidates are all the same brand shot in the
// same kitchen.
function dhash(buf) {
  fs.mkdirSync(WORK, { recursive: true });
  const inp = WORK + '/i.jpg'; fs.writeFileSync(inp, buf);
  let raw;
  try { raw = cp.execSync(BIN + '/ffmpeg -hide_banner -loglevel error -nostdin -i ' + JSON.stringify(inp)
      + ' -vf "scale=17:16:flags=area,format=gray" -f rawvideo -pix_fmt gray -', { maxBuffer: 1 << 20 }); }
  catch (e) { return null; }
  if (!raw || raw.length < 17 * 16) return null;
  let bits = '';
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) bits += (raw[y * 17 + x] > raw[y * 17 + x + 1]) ? '1' : '0';
  let hex = ''; for (let i = 0; i < 256; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}
function hamming(a, b) {
  if (!a || !b || a.length !== b.length) return 256;
  let d = 0;
  for (let i = 0; i < a.length; i++) { let x = parseInt(a[i], 16) ^ parseInt(b[i], 16); while (x) { d += x & 1; x >>= 1; } }
  return d;
}
async function grab(u) { if (!u) return null; try { const r = await fetch(u); if (!r.ok) return null; return Buffer.from(await r.arrayBuffer()); } catch (e) { return null; } }

async function run(qp) {
  ensureFfmpeg();
  const out = { probed_at: new Date().toISOString(), round: 7 };

  const ads = await db('ad?select=ad_id,ad_name,media_type,readable_video_id,thumb_url,created_time,analysis_state') || [];
  out.ads = ads.length;

  // Fingerprint every ad's own thumbnail — one image each, same proxy for all.
  const fp = {};
  let got = 0;
  for (const a of ads) {
    if (!a.thumb_url) continue;
    const b = await grab(a.thumb_url);
    const h = b ? dhash(b) : null;
    if (h) { fp[a.ad_id] = h; got++; }
  }
  out.thumbnails_hashed = got;

  const readable = ads.filter(a => a.media_type === 'video' && a.readable_video_id && fp[a.ad_id]);
  const locked = ads.filter(a => a.media_type === 'video_locked' && fp[a.ad_id]);
  out.readable_with_hash = readable.length;
  out.locked_with_hash = locked.length;

  // --- validation: readable ads that already share a video id are the same film
  const byVid = {};
  readable.forEach(a => { (byVid[a.readable_video_id] = byVid[a.readable_video_id] || []).push(a); });
  const dupGroups = Object.values(byVid).filter(g => g.length > 1);
  let tested = 0, hit = 0; const trueDists = [], falseDists = [];
  for (const g of dupGroups) {
    for (const a of g) {
      const others = readable.filter(x => x.ad_id !== a.ad_id);
      if (!others.length) continue;
      tested++;
      const ranked = others.map(x => ({ ad: x, d: hamming(fp[a.ad_id], fp[x.ad_id]) })).sort((p, q) => p.d - q.d);
      const best = ranked[0];
      if (best.ad.readable_video_id === a.readable_video_id) { hit++; trueDists.push(best.d); }
      else falseDists.push(best.d);
    }
  }
  trueDists.sort((x, y) => x - y); falseDists.sort((x, y) => x - y);
  out.validation = {
    duplicate_groups: dupGroups.length, tested, top1_correct: hit,
    accuracy_pct: tested ? Math.round(1000 * hit / tested) / 10 : null,
    true_match_distance_median: trueDists.length ? trueDists[Math.floor(trueDists.length / 2)] : null,
    true_match_distance_p90: trueDists.length ? trueDists[Math.floor(trueDists.length * 0.9)] : null,
    wrong_match_distance_median: falseDists.length ? falseDists[Math.floor(falseDists.length / 2)] : null,
  };

  // --- locked ads against readable ads
  const results = [];
  for (const a of locked) {
    const ranked = readable.map(x => ({ ad_id: x.ad_id, name: x.ad_name, vid: x.readable_video_id, d: hamming(fp[a.ad_id], fp[x.ad_id]) }))
      .sort((p, q) => p.d - q.d);
    const best = ranked[0], second = ranked[1];
    results.push({ locked: a.ad_name, locked_id: a.ad_id,
      best_match: best && best.name, video_id: best && best.vid,
      distance: best && best.d, margin: second ? second.d - best.d : 256 });
  }
  results.sort((x, y) => x.distance - y.distance);
  out.locked_matches = { total: results.length, closest: results.slice(0, 15),
    within_20_bits: results.filter(r => r.distance <= 20).length,
    within_40_bits: results.filter(r => r.distance <= 40).length };

  // --- can we at least PLAY a locked ad? Facebook's public video embed is a
  //     supported surface, unlike scraping the post itself.
  const lockedWithPost = await db('ad?media_type=eq.video_locked&post_id=not.is.null&select=ad_id,ad_name,post_id,permalink&limit=3') || [];
  out.embed_test = [];
  for (const a of lockedWithPost) {
    const [page, post] = String(a.post_id).split('_');
    const href = 'https://www.facebook.com/' + page + '/posts/' + post;
    const url = 'https://www.facebook.com/plugins/video.php?href=' + encodeURIComponent(href) + '&show_text=false';
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ReviveAdsBot/1.0)' } });
      const t = await r.text();
      out.embed_test.push({ ad: a.ad_name, http: r.status, bytes: t.length,
        has_video_tag: /<video/i.test(t), mentions_login: /log in|login|checkpoint/i.test(t.slice(0, 3000)),
        has_mp4_url: /\.mp4/i.test(t), permalink: a.permalink });
    } catch (e) { out.embed_test.push({ ad: a.ad_name, error: String(e.message || e).slice(0, 120) }); }
    await new Promise(r => setTimeout(r, 400));
  }
  return out;
}

exports.handler = async (event) => {
  const qp = (event && event.queryStringParameters) || {};
  const auth = await authorizeRun(event);
  if (!auth.ok) return { statusCode: 403, body: 'nope' };
  let out, ok = true;
  try { out = await run(qp); }
  catch (e) { ok = false; out = { round: 7, error: String((e && e.message) || e).slice(0, 300), stack: String((e && e.stack) || '').slice(0, 600) }; }
  await log('ads-probe7', ok, out);
  return { statusCode: 200, body: JSON.stringify({ ok }) };
};
