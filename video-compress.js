/* Revive — browser-side video compression for training clips.
 *
 * Why this exists:
 *  - A 30s iPhone clip is 50–90MB. A Netlify function body caps at ~6MB, and
 *    base64 inflates by a third, so raw video can never go through a function.
 *  - iPhones record HEVC by default, which does not play in every browser.
 *    Re-encoding guarantees something everyone can watch.
 *  - Re-drawing through a canvas bakes in the rotation flag, so the sideways
 *    iPhone video problem disappears. Portrait and landscape both come out
 *    the right way up.
 *
 * Trade-off: encoding runs in real time (a 60s clip takes ~60s), because
 * MediaRecorder records a playing video. Hence the progress callback.
 *
 * window.RVVideo.compress(file, opts) -> { blob, mime, seconds, width, height, poster }
 */
(function () {
  'use strict';

  const MIME_PREFS = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4;codecs=avc1.42E01E',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];

  function pickMime(mute) {
    if (typeof MediaRecorder === 'undefined') return null;
    for (const m of MIME_PREFS) {
      const candidate = mute ? m.replace(/,\s*(mp4a\.40\.2|opus)/, '') : m;
      try { if (MediaRecorder.isTypeSupported(candidate)) return candidate; } catch (e) {}
    }
    return null;
  }

  function supported() {
    return typeof MediaRecorder !== 'undefined'
      && !!document.createElement('canvas').captureStream
      && !!pickMime(false);
  }

  function loadVideo(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.muted = true;             // required for autoplay on iOS
      v.playsInline = true;
      v.setAttribute('playsinline', '');
      v.src = url;
      v.onloadedmetadata = () => resolve({ video: v, url });
      v.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That video could not be opened. Try a different file.')); };
      setTimeout(() => reject(new Error('That video took too long to open.')), 30000);
    });
  }

  // videoWidth/videoHeight are already rotation-corrected by the browser, so
  // scaling from them is what fixes orientation.
  function targetSize(v, maxEdge) {
    let w = v.videoWidth, h = v.videoHeight;
    if (!w || !h) throw new Error('That video has no picture track.');
    const longest = Math.max(w, h);
    if (longest > maxEdge) {
      const k = maxEdge / longest;
      w = Math.round(w * k); h = Math.round(h * k);
    }
    // even dimensions keep H.264 encoders happy
    return { w: w - (w % 2), h: h - (h % 2) };
  }

  function grabPoster(video, w, h, at) {
    return new Promise((resolve) => {
      const done = () => {
        try {
          const c = document.createElement('canvas');
          c.width = w; c.height = h;
          c.getContext('2d').drawImage(video, 0, 0, w, h);
          resolve(c.toDataURL('image/jpeg', 0.72));
        } catch (e) { resolve(null); }
      };
      const t = Math.min(at, Math.max(0, (video.duration || 1) - 0.1));
      const onSeek = () => { video.removeEventListener('seeked', onSeek); done(); };
      video.addEventListener('seeked', onSeek);
      try { video.currentTime = t; } catch (e) { done(); }
      setTimeout(() => { video.removeEventListener('seeked', onSeek); done(); }, 4000);
    });
  }

  async function compress(file, opts) {
    opts = opts || {};
    const maxSeconds = opts.maxSeconds || 60;
    const maxEdge = opts.maxEdge || 1280;      // 720p on the long edge
    const bitrate = opts.bitrate || 900000;    // ~6.7MB per minute
    const mute = !!opts.mute;
    const onProgress = opts.onProgress || function () {};

    if (!supported()) throw new Error('This browser cannot compress video. Try Safari or Chrome on your phone.');

    const { video, url } = await loadVideo(file);
    const cleanup = () => { try { URL.revokeObjectURL(url); } catch (e) {} };

    try {
      const duration = video.duration;
      if (!isFinite(duration) || duration <= 0) throw new Error('That video has no readable length.');
      if (duration > maxSeconds + 0.75) {
        throw new Error('That clip is ' + Math.round(duration) + ' seconds. Keep training clips to ' + maxSeconds + ' seconds or less — one point per clip.');
      }

      const { w, h } = targetSize(video, maxEdge);
      const poster = await grabPoster(video, w, h, Math.min(1, duration / 2));
      try { video.currentTime = 0; } catch (e) {}

      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d', { alpha: false });

      const stream = canvas.captureStream(30);

      // Audio via Web Audio — more portable than HTMLMediaElement.captureStream.
      let audioCtx = null;
      if (!mute) {
        try {
          const AC = window.AudioContext || window.webkitAudioContext;
          if (AC) {
            audioCtx = new AC();
            const src = audioCtx.createMediaElementSource(video);
            const dest = audioCtx.createMediaStreamDestination();
            src.connect(dest);
            // deliberately NOT connected to audioCtx.destination — no playback
            // out loud while it encodes
            dest.stream.getAudioTracks().forEach(t => stream.addTrack(t));
            video.muted = false;
            video.volume = 1;
          }
        } catch (e) { /* silent clip is better than a failed upload */ }
      }

      const mime = pickMime(mute);
      const rec = new MediaRecorder(stream, {
        mimeType: mime,
        videoBitsPerSecond: bitrate,
        audioBitsPerSecond: 64000,
      });

      const chunks = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };

      const finished = new Promise((resolve, reject) => {
        rec.onstop = resolve;
        rec.onerror = () => reject(new Error('Encoding failed part way through. Try a shorter clip.'));
      });

      let raf = 0;
      const draw = () => {
        if (video.paused || video.ended) return;
        ctx.drawImage(video, 0, 0, w, h);
        onProgress(Math.min(0.99, video.currentTime / duration));
        raf = requestAnimationFrame(draw);
      };

      rec.start(1000);
      await video.play();
      draw();

      await new Promise((resolve) => {
        const end = () => { video.removeEventListener('ended', end); resolve(); };
        video.addEventListener('ended', end);
        // hard stop in case 'ended' never fires
        setTimeout(resolve, (duration + 8) * 1000);
      });

      cancelAnimationFrame(raf);
      try { ctx.drawImage(video, 0, 0, w, h); } catch (e) {}
      if (rec.state !== 'inactive') rec.stop();
      await finished;
      if (audioCtx) { try { await audioCtx.close(); } catch (e) {} }

      const outMime = (mime || '').split(';')[0] || 'video/mp4';
      const blob = new Blob(chunks, { type: outMime });
      if (!blob.size) throw new Error('Encoding produced an empty file. Try a different clip.');

      onProgress(1);
      return { blob, mime: outMime, seconds: Math.round(duration), width: w, height: h, poster };
    } finally {
      cleanup();
    }
  }

  window.RVVideo = { compress, supported, pickMime };
})();
