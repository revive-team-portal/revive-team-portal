// Ads video/still analyser. Background function so it gets 15 minutes.
//
//   /.netlify/functions/ads-video-background?k=<run key>&limit=5[&ad_id=...][&force=1]
//
// One ad at a time, start to finish, then the media is deleted before the next
// one begins — nothing accumulates in /tmp and nothing large is ever held in
// memory twice. Source URLs from Meta are short-lived, so each is fetched and
// consumed inside the same iteration and never stored.
//
// ffmpeg and whisper.cpp ride along as committed binaries (see bin/ and the
// included_files entry in netlify.toml); the repo deliberately has no
// package.json, and child_process is a Node builtin, so neither is a dependency.

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { authorizeRun } = require('./_adsauth');
const { graph } = require('./_adsmeta');
const { db, upsert, log, config, putObject, getObject } = require('./_adsdb');
const ai = require('./_adsai');

// Where included_files land depends on how Netlify bundled the function, so
// look in every plausible place rather than assuming one.
function findBinSrc() {
  const roots = [
    process.env.LAMBDA_TASK_ROOT && path.join(process.env.LAMBDA_TASK_ROOT, 'bin'),
    path.join(__dirname, 'bin'),
    path.join(__dirname, '..', 'bin'),
    path.join(__dirname, '..', '..', 'bin'),
    path.join(__dirname, '..', '..', '..', 'bin'),
    path.join(process.cwd(), 'bin'),
    '/var/task/bin',
  ].filter(Boolean);
  for (const r of roots) {
    try { if (fs.existsSync(path.join(r, 'ffmpeg'))) return r; } catch (e) {}
  }
  return null;
}
const BIN = '/tmp/adsbin';
const WORK = '/tmp/adswork';
const MODEL_URLS = (name) => ([
  // Hugging Face is the upstream home of the ggml weights and costs us nothing.
  'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-' + name + '.bin',
]);
const TAXONOMY_VERSION = 1;

const sh = (cmd, opts) => cp.execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, ...(opts || {}) });
// ffmpeg writes everything useful to stderr and exits non-zero on -f null.
function ffmpeg(args) {
  try { return sh(BIN + '/ffmpeg -hide_banner -nostdin ' + args + ' 2>&1', { env: { ...process.env, LD_LIBRARY_PATH: BIN } }); }
  catch (e) { return String((e.stdout || '') + (e.stderr || '') + (e.message || '')); }
}

function ensureBins() {
  if (fs.existsSync(BIN + '/ffmpeg') && fs.existsSync(BIN + '/whisper-cli')) return fs.readdirSync(BIN).length;
  const BIN_SRC = findBinSrc();
  if (!BIN_SRC) throw new Error('bundled binaries not found; looked for bin/ffmpeg near ' + __dirname);
  fs.mkdirSync(BIN, { recursive: true });
  const wanted = fs.readdirSync(BIN_SRC);
  for (const f of wanted) {
    const dst = path.join(BIN, f);
    if (!fs.existsSync(dst)) fs.copyFileSync(path.join(BIN_SRC, f), dst);
    // The execute bit does not always survive bundling.
    if (f === 'ffmpeg' || f === 'whisper-cli') fs.chmodSync(dst, 0o755);
  }
  return wanted.length;
}

// The ggml weights are ~148 MB and barely compress, so they are pulled once per
// cold start into /tmp (512 MB) and reused by every warm invocation. A copy is
// kept in the ad-frames bucket as a fallback if the upstream host is down.
async function ensureModel(name) {
  const local = BIN + '/ggml-' + name + '.bin';
  if (fs.existsSync(local) && fs.statSync(local).size > 1000000) return { path: local, from: 'tmp_cache' };
  const cacheKey = 'models/ggml-' + name + '.bin';

  // Upstream FIRST, deliberately. A long backfill is many cold starts and the
  // weights are ~148 MB; pulling them from the Supabase bucket every time would
  // burn several GB of a 5 GB monthly egress allowance. Hugging Face serves the
  // same file at no cost to us. The bucket copy is the fallback for when it is
  // unreachable, not the default path.
  for (const url of MODEL_URLS(name)) {
    try {
      const r = await fetch(url, { redirect: 'follow' });
      if (!r.ok) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 1000000) continue;
      fs.writeFileSync(local, buf);
      getObject(cacheKey).then(existing => { if (!existing) putObject(cacheKey, buf, 'application/octet-stream').catch(() => {}); }).catch(() => {});
      return { path: local, from: 'upstream', bytes: buf.length };
    } catch (e) { /* fall through to the bucket */ }
  }
  const cached = await getObject(cacheKey).catch(() => null);
  if (cached && cached.length > 1000000) { fs.writeFileSync(local, cached); return { path: local, from: 'bucket_fallback' }; }
  throw new Error('could not obtain whisper model ' + name);
}

const rmrf = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) {} };
const b64 = (p) => fs.readFileSync(p).toString('base64');

// --- ffmpeg readers ---------------------------------------------------------

function probeDuration(file) {
  const out = ffmpeg('-i ' + JSON.stringify(file));
  const m = out.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
  if (!m) return null;
  return Math.round((Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000) / 1000;
}

function sceneCuts(file) {
  const out = ffmpeg('-i ' + JSON.stringify(file) + ' -filter:v "select=\'gt(scene,0.3)\',showinfo" -f null -');
  const cuts = [];
  const re = /pts_time:([0-9.]+)/g; let m;
  while ((m = re.exec(out)) !== null) cuts.push(Math.round(Number(m[1]) * 100) / 100);
  return cuts.filter((t, i) => i === 0 || t - cuts[i - 1] > 0.25);
}

function extractFrames(file, dir, filter, prefix) {
  fs.mkdirSync(dir, { recursive: true });
  ffmpeg('-i ' + JSON.stringify(file) + ' -vf "' + filter + '" -q:v 5 ' + JSON.stringify(path.join(dir, prefix + '_%04d.jpg')));
  return fs.readdirSync(dir).filter(f => f.startsWith(prefix + '_')).sort().map(f => path.join(dir, f));
}

function extractOne(file, t, out, width) {
  ffmpeg('-ss ' + t + ' -i ' + JSON.stringify(file) + ' -frames:v 1 -q:v 3 -vf scale=' + (width || 640) + ':-2 -y ' + JSON.stringify(out));
  return fs.existsSync(out) ? out : null;
}

function transcribe(wav, modelPath, glossary) {
  const prompt = (glossary || []).join(', ');
  const base = WORK + '/tr';
  try {
    sh(BIN + '/whisper-cli -m ' + JSON.stringify(modelPath) + ' -f ' + JSON.stringify(wav)
      + ' -t 2 -oj -of ' + JSON.stringify(base) + ' -nt --prompt ' + JSON.stringify(prompt) + ' 2>&1',
      { env: { ...process.env, LD_LIBRARY_PATH: BIN }, timeout: 240000 });
  } catch (e) { return { error: String(e.message || e).slice(0, 200) }; }
  const jf = base + '.json';
  if (!fs.existsSync(jf)) return { error: 'no whisper output' };
  let j; try { j = JSON.parse(fs.readFileSync(jf, 'utf8')); } catch (e) { return { error: 'bad whisper json' }; }
  const segs = (j.transcription || []).map(s => ({
    from: s.offsets ? s.offsets.from / 1000 : null,
    to: s.offsets ? s.offsets.to / 1000 : null,
    text: (s.text || '').trim(),
  })).filter(s => s.text);
  return { text: segs.map(s => s.text).join(' ').replace(/\s+/g, ' ').trim(), segments: segs };
}

// Pick n items spread evenly across an array, always keeping first and last.
function spread(arr, n) {
  if (arr.length <= n) return arr.map((v, i) => ({ v, i }));
  const out = [];
  for (let k = 0; k < n; k++) { const i = Math.round(k * (arr.length - 1) / (n - 1)); out.push({ v: arr[i], i }); }
  return out;
}

// --- one ad -----------------------------------------------------------------

async function doVideo(ad, cfg, modelPath) {
  rmrf(WORK); fs.mkdirSync(WORK, { recursive: true });
  const note = {};
  const v = await graph(ad.readable_video_id, 'fields=source,length,permalink_url');
  if (!v.json || !v.json.source) throw new Error('no source url: ' + (v.err || 'unknown'));

  // Fetch once, work locally, delete. Never keep the URL — it expires.
  const mp4 = WORK + '/v.mp4';
  const r = await fetch(v.json.source);
  if (!r.ok) throw new Error('video fetch ' + r.status);
  fs.writeFileSync(mp4, Buffer.from(await r.arrayBuffer()));
  note.bytes = fs.statSync(mp4).size;

  const duration = probeDuration(mp4) || Number(v.json.length) || null;
  const cuts = sceneCuts(mp4);
  note.duration = duration; note.cuts = cuts.length;

  // Dense sampling for "first time product shown"; tighter over the opening.
  const dense = extractFrames(mp4, WORK + '/d', 'fps=1,scale=480:-2', 'd');
  const open = extractFrames(mp4, WORK + '/o', 'fps=5,scale=480:-2', 'o').slice(0, 15);

  // Audio for whisper — tiny, and quick to extract.
  const wav = WORK + '/a.wav';
  ffmpeg('-i ' + JSON.stringify(mp4) + ' -vn -ac 1 -ar 16000 -c:a pcm_s16le -y ' + JSON.stringify(wav));
  const hasAudio = fs.existsSync(wav) && fs.statSync(wav).size > 1000;

  // The four key frames we actually keep.
  const firstCut = cuts.length ? cuts[0] : (duration ? Math.min(1, duration / 4) : 1);
  const keyDefs = [
    { kind: 'opening', t: 0 },
    { kind: 'first_cut', t: Math.min(firstCut, Math.max(0, (duration || 1) - 0.2)) },
    { kind: 'mid', t: duration ? duration / 2 : 2 },
    { kind: 'closing', t: duration ? Math.max(0, duration - 0.4) : 3 },
  ];
  const keyFiles = keyDefs.map(k => ({ ...k, file: extractOne(mp4, k.t, WORK + '/key_' + k.kind + '.jpg', 640) })).filter(k => k.file);

  // --- vision ---
  const openPick = spread(open, 8).map(x => x.v);
  const densePick = spread(dense, 14);
  const denseTimes = densePick.map(x => x.i); // dense is 1 fps, so index == second
  const [openTags, timeTags] = [
    await ai.tagOpening(cfg.model_tagging, openPick.map(b64), 5).catch(e => ({ error: String(e.message || e).slice(0, 150) })),
    await ai.tagTimeline(cfg.model_tagging, densePick.map(x => b64(x.v)), denseTimes).catch(e => ({ error: String(e.message || e).slice(0, 150) })),
  ];

  // --- transcript ---
  let tr = { text: '', segments: [] }, source = 'none';
  if (hasAudio) { tr = transcribe(wav, modelPath, cfg.brand_glossary); source = tr.error ? 'failed' : 'whisper'; }
  const onscreen = [openTags.onscreen_text_open, timeTags.onscreen_text].filter(Boolean).join(' — ');
  let fixed = { text: tr.text || '', fixes: [] };
  if (tr.text) fixed = await ai.fixTranscript(cfg.model_tagging, tr.text, onscreen, cfg.brand_glossary).catch(() => ({ text: tr.text, fixes: [] }));

  // --- first time the product appears ---
  let firstProductAt = null;
  if (openTags.product_in_first_3s && openTags.first_product_frame != null) firstProductAt = Math.round(openTags.first_product_frame / 5 * 100) / 100;
  else if (Array.isArray(timeTags.product_frames) && timeTags.product_frames.length) {
    const idx = Math.min(...timeTags.product_frames.map(Number).filter(n => !isNaN(n)));
    if (isFinite(idx)) firstProductAt = denseTimes[idx] != null ? denseTimes[idx] : idx;
  }

  // --- keep the four key frames, drop everything else ---
  const frameRows = [];
  for (const k of keyFiles) {
    const p = 'ads/' + ad.ad_id + '/' + k.kind + '.jpg';
    try {
      const up = await putObject(p, fs.readFileSync(k.file), 'image/jpeg');
      frameRows.push({ ad_id: ad.ad_id, kind: k.kind, t_sec: Math.round(k.t * 100) / 100, storage_path: up.path, public_url: up.public_url });
    } catch (e) { note.frame_error = String(e.message || e).slice(0, 120); }
  }

  const tags = {
    format: timeTags.format || openTags.format_hint || null,
    time_to_first_cut: cuts.length ? cuts[0] : null,
    total_cuts: cuts.length,
    cuts,
    length_sec: duration,
    product_in_first_3s: openTags.product_in_first_3s === true,
    first_product_at: firstProductAt,
    toaster_or_plate: timeTags.toaster_or_plate === true,
    eating_on_camera: timeTags.eating_on_camera === true,
    visible_claims: Array.isArray(timeTags.visible_claims) ? timeTags.visible_claims : [],
    lighting: timeTags.lighting || null,
    shoot_type: timeTags.shoot_type || null,
    subtitles_present: timeTags.subtitles_present === true || !!onscreen,
    hook_words: openTags.hook_words || null,
    transcript: fixed.text || null,
    transcript_source: source,
    onscreen_text: onscreen || null,
    onscreen_text_source: 'vision_ocr',
    spoken_words: fixed.text ? fixed.text.split(/\s+/).filter(Boolean).length : 0,
    brand_fixes: fixed.fixes || [],
    still_analysis: false,
    raw: { open: openTags, timeline: timeTags, whisper_segments: (tr.segments || []).slice(0, 200), note, summary: timeTags.summary || null },
  };

  rmrf(WORK);
  return { tags, frameRows, duration };
}

async function doStill(ad, cfg) {
  rmrf(WORK); fs.mkdirSync(WORK, { recursive: true });
  const url = ad.image_url || ad.thumb_url;
  if (!url) throw new Error('no image url');
  const r = await fetch(url);
  if (!r.ok) throw new Error('image fetch ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  const f = WORK + '/still.jpg';
  fs.writeFileSync(f, buf);

  const t = await ai.tagStill(cfg.model_tagging, buf.toString('base64')).catch(e => ({ error: String(e.message || e).slice(0, 150) }));
  const frameRows = [];
  try {
    const up = await putObject('ads/' + ad.ad_id + '/opening.jpg', buf, 'image/jpeg');
    frameRows.push({ ad_id: ad.ad_id, kind: 'opening', t_sec: 0, storage_path: up.path, public_url: up.public_url });
  } catch (e) { /* the Meta thumbnail still renders in the list */ }

  const tags = {
    format: t.format || null, time_to_first_cut: null, total_cuts: 0, cuts: [], length_sec: null,
    product_in_first_3s: t.product_visible === true, first_product_at: t.product_visible ? 0 : null,
    toaster_or_plate: t.toaster_or_plate === true, eating_on_camera: t.eating_on_camera === true,
    visible_claims: Array.isArray(t.visible_claims) ? t.visible_claims : [],
    lighting: t.lighting || null, shoot_type: t.shoot_type || null,
    subtitles_present: false, hook_words: null,
    transcript: null, transcript_source: 'not_applicable',
    onscreen_text: t.onscreen_text || null, onscreen_text_source: 'vision_ocr',
    spoken_words: 0, brand_fixes: [], still_analysis: true,
    raw: { still: t, summary: t.summary || null },
  };
  rmrf(WORK);
  return { tags, frameRows, duration: null };
}

// --- runner -----------------------------------------------------------------

async function run(qp) {
  const started = Date.now();
  const cfg = await config();
  const limit = Math.min(Number(qp.limit) || cfg.batch_size, 25);
  const out = { started_at: new Date().toISOString(), limit, bins: ensureBins(), done: [], failed: [] };

  let ads;
  if (qp.ad_id) ads = await db('ad?ad_id=eq.' + encodeURIComponent(qp.ad_id) + '&select=*') || [];
  else {
    // The same film often runs as several ads across ad sets. Analyse one copy
    // per creative and let the result propagate — it is the same video, and
    // paying a vision model to watch it twice buys nothing.
    const pool = await db('ad?analysis_state=eq.pending&media_type=in.(video,image,carousel)'
      + '&order=created_time.desc&limit=' + (limit * 6) + '&select=*') || [];
    const seen = new Set(); ads = [];
    for (const a of pool) {
      const key = a.readable_video_id || a.creative_code || a.thumb_url || a.ad_id;
      if (seen.has(key)) continue;
      seen.add(key); ads.push(a);
      if (ads.length >= limit) break;
    }
  }
  out.queued = ads.length;
  if (!ads.length) { out.seconds = Math.round((Date.now() - started) / 1000); return out; }

  // Only pay for the model if there is actually a video in this batch.
  let modelPath = null;
  if (ads.some(a => a.media_type === 'video' && a.readable_video_id)) {
    const m = await ensureModel(cfg.whisper_model);
    modelPath = m.path; out.model = { ...m, path: undefined };
  }

  for (const ad of ads) {
    const t0 = Date.now();
    try {
      const isVideo = ad.media_type === 'video' && ad.readable_video_id;
      const res = isVideo ? await doVideo(ad, cfg, modelPath) : await doStill(ad, cfg);

      // Judgement call, with performance as context.
      const perf = await db('ad_perf?ad_id=eq.' + encodeURIComponent(ad.ad_id) + '&select=win,spend,impressions,purchases_1d_click,purchases_7d_click,purchases_1d_view,purchases_meta,value_7d_click,value_meta,cpa_meta,cpa,roas_meta,roas,ctr,hook_rate,hold_rate,active_days').catch(() => []);
      const verdict = await ai.analyse(cfg.model_analysis, ad, res.tags, perf).catch(e => ({ error: String(e.message || e).slice(0, 150) }));

      await upsert('ad_tags', [{
        ad_id: ad.ad_id, ...res.tags,
        scores: verdict.scores || null,
        score_notes: verdict.score_notes || null,
        observations: verdict.observations || null,
        recommendation: verdict.recommendation || null,
        raw: { ...res.tags.raw, verdict },
        model_tagging: cfg.model_tagging, model_analysis: cfg.model_analysis,
        taxonomy_version: TAXONOMY_VERSION, tagged_at: new Date().toISOString(),
      }], 'ad_id');

      if (res.frameRows.length) {
        // ad_frame has a generated id, so replace the ad's rows rather than upsert.
        await db('ad_frame?ad_id=eq.' + encodeURIComponent(ad.ad_id), { method: 'DELETE', headers: { Prefer: 'return=minimal' } }).catch(() => {});
        await db('ad_frame', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(res.frameRows) });
      }

      await db('ad?ad_id=eq.' + encodeURIComponent(ad.ad_id), { method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ analysis_state: 'done', analysis_note: null, analysis_at: new Date().toISOString(),
          duration_sec: res.duration != null ? res.duration : ad.duration_sec }) });

      // Siblings are the same creative running elsewhere: identical video id,
      // or (for stills) the identical image. Copy the analysis across rather
      // than re-deriving it. Never matched on name alone — that is a guess.
      let shared = 0;
      const sibFilter = isVideo
        ? (ad.readable_video_id ? 'readable_video_id=eq.' + encodeURIComponent(ad.readable_video_id) : null)
        : (ad.thumb_url ? 'thumb_url=eq.' + encodeURIComponent(ad.thumb_url) : null);
      if (sibFilter) {
        const sibs = await db('ad?' + sibFilter + '&analysis_state=eq.pending&ad_id=neq.' + encodeURIComponent(ad.ad_id) + '&select=ad_id') || [];
        if (sibs.length) {
          await upsert('ad_tags', sibs.map(sb => ({
            ad_id: sb.ad_id, ...res.tags,
            scores: verdict.scores || null, score_notes: verdict.score_notes || null,
            observations: verdict.observations || null, recommendation: verdict.recommendation || null,
            raw: { ...res.tags.raw, verdict, copied_from: ad.ad_id },
            model_tagging: cfg.model_tagging, model_analysis: cfg.model_analysis,
            taxonomy_version: TAXONOMY_VERSION, tagged_at: new Date().toISOString(),
          })), 'ad_id');
          for (const sb of sibs) {
            await db('ad?ad_id=eq.' + encodeURIComponent(sb.ad_id), { method: 'PATCH', headers: { Prefer: 'return=minimal' },
              body: JSON.stringify({ analysis_state: 'done', analysis_at: new Date().toISOString(),
                duration_sec: res.duration != null ? res.duration : null,
                analysis_note: 'Same creative as ' + ad.ad_name + '; analysis shared.' }) }).catch(() => {});
            if (res.frameRows.length) {
              await db('ad_frame?ad_id=eq.' + encodeURIComponent(sb.ad_id), { method: 'DELETE', headers: { Prefer: 'return=minimal' } }).catch(() => {});
              await db('ad_frame', { method: 'POST', headers: { Prefer: 'return=minimal' },
                body: JSON.stringify(res.frameRows.map(f => ({ ...f, ad_id: sb.ad_id }))) }).catch(() => {});
            }
          }
          shared = sibs.length;
        }
      }
      out.done.push({ ad_id: ad.ad_id, name: ad.ad_name, kind: isVideo ? 'video' : 'still', seconds: Math.round((Date.now() - t0) / 1000), words: res.tags.spoken_words, shared_with: shared });
    } catch (e) {
      const msg = String((e && e.message) || e).slice(0, 300);
      out.failed.push({ ad_id: ad.ad_id, name: ad.ad_name, error: msg });
      await db('ad?ad_id=eq.' + encodeURIComponent(ad.ad_id), { method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ analysis_state: (ad.analysis_attempts || 0) >= 2 ? 'error' : 'pending',
          analysis_attempts: (ad.analysis_attempts || 0) + 1, analysis_note: msg, analysis_at: new Date().toISOString() }) }).catch(() => {});
      rmrf(WORK);
    }
    // Breathe between ads — keeps us inside model rate limits on a long backfill.
    await new Promise(r => setTimeout(r, 1500));
  }
  out.seconds = Math.round((Date.now() - started) / 1000);

  // Opt-in chaining, for the one-off historical backfill. Each invocation gets
  // 15 minutes; rather than risk being cut off mid-ad, hand the rest to a fresh
  // invocation. Bounded, and never on by default — the nightly run stays a
  // single batch so a bad day cannot spend all night retrying.
  // Keep going as long as the batch made progress. Stopping the whole backfill
  // because one ad had no usable image wastes the other 250 — failures are
  // already recorded, retried twice, then parked as 'error', so the queue still
  // drains rather than looping.
  const chain = Number(qp.chain) || 0;
  if (chain > 0 && (out.done.length || out.failed.length)) {
    const left = await db('ad?analysis_state=eq.pending&media_type=in.(video,image,carousel)&select=ad_id&limit=1').catch(() => []);
    if (left && left.length) {
      const key = [...require('crypto').randomBytes(24)].map(b => b.toString(16).padStart(2, '0')).join('');
      await db('job', { method: 'POST', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify([{ kind: 'runkey', status: 'open', cursor: key, note: 'backfill chain ' + (chain - 1), started_at: new Date().toISOString() }]) }).catch(() => {});
      const site = process.env.URL || 'https://team.revive.co.nz';
      // Await it. Lambda freezes the container the moment the handler returns,
      // which silently drops any request still in flight — the first attempt at
      // chaining looked like it worked (the kick was logged) and went nowhere.
      // A background function answers 202 straight away, so this costs nothing.
      try {
        const r = await fetch(site + '/.netlify/functions/ads-video-background?k=' + key + '&limit=' + limit + '&chain=' + (chain - 1), { method: 'POST' });
        out.chained = chain - 1;
        out.chain_http = r.status;
      } catch (e) { out.chain_error = String(e.message || e).slice(0, 150); }
    }
  }
  return out;
}

exports.handler = async (event) => {
  const qp = (event && event.queryStringParameters) || {};
  const auth = await authorizeRun(event);
  if (!auth.ok) {
    const isSchedule = !!(event && event.body && String(event.body).includes('next_run'));
    if (!isSchedule) return { statusCode: 403, body: 'nope' };
  }
  let out, ok = true;
  try { out = await run(qp); }
  catch (e) { ok = false; out = { error: String((e && e.message) || e).slice(0, 400), stack: String((e && e.stack) || '').slice(0, 900) }; }
  await log('ads-video', ok, out);
  return { statusCode: ok ? 200 : 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(out) };
};
