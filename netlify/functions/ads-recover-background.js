// Recover the "locked" ads — the ones built from an already-published Facebook
// post, where Meta refuses to release the video to an ads_read token.
//
// The ad still hands us a creative thumbnail, and the ad-account video library
// still hands us every video's poster frame. So instead of asking Meta which
// video an ad uses, we work it out from what the frames look like: a 64-bit
// difference hash of each, matched by Hamming distance.
//
// Naming was tried first and only recovered 2 of 84 — most of the locked ads
// predate the numbering convention.
//
//   ?k=<run key>[&apply=1][&limit=N]
//
// Without apply=1 it only measures itself: the 134 ads whose video we already
// know are used as a labelled set, so accuracy is known before anything is
// written.

const fs = require('fs');
const cp = require('child_process');
const path = require('path');
const { authorizeRun } = require('./_adsauth');
const { pageAll, ACCT } = require('./_adsmeta');
const { db, upsert, log } = require('./_adsdb');

const BIN = '/tmp/adsbin';
const WORK = '/tmp/adsfp';

function findBinSrc() {
  const roots = [
    process.env.LAMBDA_TASK_ROOT && path.join(process.env.LAMBDA_TASK_ROOT, 'bin'),
    path.join(__dirname, 'bin'), path.join(__dirname, '..', 'bin'),
    path.join(__dirname, '..', '..', 'bin'), path.join(__dirname, '..', '..', '..', 'bin'),
    path.join(process.cwd(), 'bin'), '/var/task/bin',
  ].filter(Boolean);
  for (const r of roots) { try { if (fs.existsSync(path.join(r, 'ffmpeg'))) return r; } catch (e) {} }
  return null;
}
function ensureFfmpeg() {
  if (fs.existsSync(BIN + '/ffmpeg')) return true;
  const src = findBinSrc();
  if (!src) throw new Error('ffmpeg not bundled with this function');
  fs.mkdirSync(BIN, { recursive: true });
  fs.copyFileSync(path.join(src, 'ffmpeg'), BIN + '/ffmpeg');
  fs.chmodSync(BIN + '/ffmpeg', 0o755);
  return true;
}

// Squash to 9x8 greyscale and compare each pixel with its right-hand neighbour.
// Squashing (rather than cropping) makes the hash tolerant of the different
// aspect ratios Meta serves the same frame at.
function dhash(jpegBuffer) {
  fs.mkdirSync(WORK, { recursive: true });
  const inp = WORK + '/in.jpg';
  fs.writeFileSync(inp, jpegBuffer);
  let raw;
  try {
    raw = cp.execSync(BIN + '/ffmpeg -hide_banner -loglevel error -nostdin -i ' + JSON.stringify(inp)
      + ' -vf "scale=9:8:flags=area,format=gray" -f rawvideo -pix_fmt gray -', { maxBuffer: 1024 * 1024 });
  } catch (e) { return null; }
  if (!raw || raw.length < 72) return null;
  let bits = '';
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += (raw[y * 9 + x] > raw[y * 9 + x + 1]) ? '1' : '0';
  let hex = '';
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

function hamming(a, b) {
  if (!a || !b || a.length !== b.length) return 64;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) { d += x & 1; x >>= 1; }
  }
  return d;
}

async function grab(url) {
  if (!url) return null;
  try { const r = await fetch(url); if (!r.ok) return null; return Buffer.from(await r.arrayBuffer()); }
  catch (e) { return null; }
}

// --- phase 1: fingerprint the library --------------------------------------
// An ad hands us exactly one thumbnail — whichever frame was chosen as the
// poster. A library video exposes several auto-generated thumbnails from across
// its timeline. Hashing all of them means a match no longer depends on both
// sides having picked the same moment, which is what sank the first attempt.
async function fingerprintLibrary(out, force) {
  const have = await db('video_fp?select=video_id,hashes').catch(() => []);
  const haveSet = new Set((have || []).filter(r => r.hashes && r.hashes.length).map(r => r.video_id));
  const lib = await pageAll(ACCT + '/advideos',
    'fields=' + encodeURIComponent('id,title,length,created_time,picture,thumbnails{uri,is_preferred}'), 25, 60);
  out.library_total = (lib.rows || []).length;
  const todo = (lib.rows || []).filter(v => force || !haveSet.has(String(v.id)));
  out.library_to_fingerprint = todo.length;

  let rows = [];
  let images = 0;
  for (const v of todo) {
    const urls = [];
    if (v.picture) urls.push(v.picture);
    const th = (v.thumbnails && v.thumbnails.data) || [];
    th.slice(0, 10).forEach(t => { if (t.uri) urls.push(t.uri); });
    const hs = [];
    for (const u of [...new Set(urls)].slice(0, 10)) {
      const buf = await grab(u);
      const h = buf ? dhash(buf) : null;
      if (h && !hs.includes(h)) hs.push(h);
      images++;
    }
    rows.push({ video_id: String(v.id), title: v.title || null, length_sec: v.length || null,
      created_time: v.created_time || null, dhash: hs[0] || null, hashes: hs,
      picture_url: v.picture || null, updated_at: new Date().toISOString() });
    if (rows.length >= 40) { await upsert('video_fp', rows, 'video_id'); rows = []; }
  }
  if (rows.length) await upsert('video_fp', rows, 'video_id');
  out.thumbnails_hashed = images;

  const fps = await db('video_fp?select=video_id,title,length_sec,dhash,hashes') || [];
  const usable = fps.filter(f => (f.hashes && f.hashes.length) || f.dhash)
    .map(f => ({ ...f, hashes: (f.hashes && f.hashes.length) ? f.hashes : [f.dhash] }));
  out.library_fingerprinted = usable.length;
  out.avg_hashes_per_video = usable.length ? Math.round(10 * usable.reduce((n, f) => n + f.hashes.length, 0) / usable.length) / 10 : 0;
  return usable;
}

// Distance to the closest frame we hold for that video.
function bestDistance(h, fp) {
  let best = 64;
  for (const x of fp.hashes) { const d = hamming(h, x); if (d < best) best = d; }
  return best;
}

// --- phase 2: how good is this, on ads whose answer we already know? --------
async function validate(fps, out, sampleSize) {
  const known = await db('ad?media_type=eq.video&readable_video_id=not.is.null&thumb_url=not.is.null'
    + '&select=ad_id,ad_name,readable_video_id,thumb_url&limit=' + (sampleSize || 40)) || [];
  let hit = 0, near = 0, tested = 0;
  const dists = [];
  const misses = [];
  for (const a of known) {
    const buf = await grab(a.thumb_url);
    const h = buf ? dhash(buf) : null;
    if (!h) continue;
    tested++;
    const ranked = fps.map(f => ({ id: f.video_id, title: f.title, d: bestDistance(h, f) })).sort((x, y) => x.d - y.d);
    const best = ranked[0];
    const correct = ranked.find(r => r.id === String(a.readable_video_id));
    if (best && best.id === String(a.readable_video_id)) { hit++; dists.push(best.d); }
    else {
      if (correct && correct.d <= 10) near++;
      misses.push({ ad: a.ad_name, best_title: best && best.title, best_d: best && best.d,
        correct_d: correct ? correct.d : null, runner_up_d: ranked[1] ? ranked[1].d : null });
    }
  }
  dists.sort((a, b) => a - b);
  out.validation = {
    tested, top1_correct: hit,
    accuracy_pct: tested ? Math.round(1000 * hit / tested) / 10 : null,
    correct_within_10_bits_but_not_top1: near,
    median_distance_when_correct: dists.length ? dists[Math.floor(dists.length / 2)] : null,
    max_distance_when_correct: dists.length ? dists[dists.length - 1] : null,
    miss_sample: misses.slice(0, 6),
  };
  return out.validation;
}

// --- phase 3: apply to the locked ads --------------------------------------
async function recover(fps, out, apply, maxDist, limit) {
  const locked = await db('ad?media_type=eq.video_locked&select=ad_id,ad_name,thumb_url,image_url,created_time'
    + '&limit=' + (limit || 200)) || [];
  out.locked_total = locked.length;
  const results = [];
  for (const a of locked) {
    const buf = await grab(a.thumb_url || a.image_url);
    const h = buf ? dhash(buf) : null;
    if (!h) { results.push({ ad_id: a.ad_id, ad_name: a.ad_name, matched: false, why: 'no usable thumbnail' }); continue; }
    const ranked = fps.map(f => ({ id: f.video_id, title: f.title, len: f.length_sec, d: bestDistance(h, f) })).sort((x, y) => x.d - y.d);
    const best = ranked[0], second = ranked[1];
    // Require both a close match AND clear separation from the runner-up, so a
    // generic frame (a plain plate shot, say) cannot be confidently mis-assigned.
    const margin = second ? second.d - best.d : 64;
    const confident = best && best.d <= maxDist && (margin >= 4 || best.d <= 4);
    results.push({ ad_id: a.ad_id, ad_name: a.ad_name, matched: !!confident,
      video_id: best && best.id, video_title: best && best.title, distance: best && best.d, margin,
      length_sec: best && best.len });
    if (confident && apply) {
      await db('ad?ad_id=eq.' + encodeURIComponent(a.ad_id), { method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ readable_video_id: best.id, media_type: 'video', analysis_state: 'pending',
          duration_sec: best.len || null, video_match_method: 'thumbnail_dhash',
          video_match_confidence: Math.round(100 * (1 - best.d / 64)) / 100,
          video_match_note: 'Matched to library video "' + (best.title || best.id) + '" by image fingerprint (distance ' + best.d + ', margin ' + margin + ').',
          analysis_note: null }) }).catch(() => {});
    }
  }
  out.recovered = results.filter(r => r.matched).length;
  out.not_recovered = results.filter(r => !r.matched).length;
  out.applied = !!apply;
  out.matches = results.filter(r => r.matched).slice(0, 25);
  out.no_match_sample = results.filter(r => !r.matched).slice(0, 10);
  return out;
}

exports.handler = async (event) => {
  const qp = (event && event.queryStringParameters) || {};
  const auth = await authorizeRun(event);
  if (!auth.ok) return { statusCode: 403, body: 'nope' };
  const out = { started_at: new Date().toISOString() };
  let ok = true;
  try {
    ensureFfmpeg();
    const fps = await fingerprintLibrary(out, !!qp.refingerprint);
    const v = await validate(fps, out, Number(qp.validate) || 40);
    // Only write anything if the method demonstrably works on the labelled set.
    const allowed = v.accuracy_pct != null && v.accuracy_pct >= 85;
    out.apply_allowed = allowed;
    const maxDist = Number(qp.max_distance) || Math.max(8, (v.max_distance_when_correct || 6) + 2);
    out.max_distance_used = maxDist;
    await recover(fps, out, !!qp.apply && allowed, maxDist, Number(qp.limit) || 200);
    if (qp.apply && !allowed) out.note = 'Not applied: fingerprint accuracy on the labelled set was too low to trust.';
  } catch (e) { ok = false; out.error = String((e && e.message) || e).slice(0, 400); out.stack = String((e && e.stack) || '').slice(0, 700); }
  await log('ads-recover', ok, out);
  return { statusCode: ok ? 200 : 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(out) };
};
