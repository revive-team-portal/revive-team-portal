// Voicemail pipeline for the Sales CRM.
// Pulls 2talk voicemail emails (pbx@2talk.co.nz) from the shared Gmail mailbox, downloads the
// audio attachment via the Gmail API, transcribes it with OpenAI Whisper (if OPENAI_API_KEY is
// set), matches the caller number to a store by phone, and records everything in sales.voicemails
// (+ a phone_in timeline note when matched). Idempotent: skips gmail ids already stored.
const { getAccessToken } = require('./_gmail');

const APPS_URL = 'https://xcwrawjdfajlmbkdwlbm.supabase.co';
const APPS_KEY = process.env.APPS_SERVICE_ROLE_KEY;

async function salesDb(path, opts = {}) {
  const headers = { apikey: APPS_KEY, Authorization: 'Bearer ' + APPS_KEY, 'Content-Type': 'application/json',
    'Accept-Profile': 'sales', 'Content-Profile': 'sales', ...(opts.headers || {}) };
  const res = await fetch(APPS_URL + '/rest/v1/' + path, { ...opts, headers });
  const t = await res.text();
  if (!res.ok) throw new Error('DB ' + res.status + ': ' + t.slice(0, 200));
  return t ? JSON.parse(t) : null;
}

async function gapi(token, path, opts = {}) {
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/' + path, {
    ...opts, headers: { Authorization: 'Bearer ' + token, ...(opts.headers || {}) } });
  const t = await r.text();
  let d = null; try { d = t ? JSON.parse(t) : null; } catch { d = t; }
  if (!r.ok) throw new Error('Gmail ' + r.status + ': ' + (typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 200));
  return d;
}

const b64urlToBuf = (s) => Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const digits = (s) => String(s || '').replace(/[^0-9]/g, '');
function nzNorm(s) { let d = digits(s); if (d.startsWith('64')) d = '0' + d.slice(2); return d; }

// walk MIME parts collecting text/plain and the first audio attachment
function collectParts(payload, out) {
  if (!payload) return;
  const mt = (payload.mimeType || '').toLowerCase();
  if (mt === 'text/plain' && payload.body && payload.body.data) out.text += b64urlToBuf(payload.body.data).toString('utf8');
  if (mt.startsWith('audio/') && payload.body && payload.body.attachmentId && !out.audio) {
    out.audio = { attachmentId: payload.body.attachmentId, mime: mt, filename: payload.filename || 'vm.wav' };
  }
  (payload.parts || []).forEach((p) => collectParts(p, out));
}

function parseDetails(text, subject) {
  const g = (re) => { const m = (text || '').match(re); return m ? m[1].trim() : ''; };
  let caller = g(/From:\s*([0-9 +()-]{5,})/i);
  const forNum = g(/For:\s*([0-9 +()-]{5,})/i);
  const duration = g(/Duration:\s*([0-9:]+)/i);
  if (!caller) { const m = (subject || '').match(/caller\s+([0-9 +()-]{5,})/i); if (m) caller = m[1].trim(); }
  return { caller: caller || '', forNum: forNum || '', duration: duration || '' };
}

async function transcribe(buf, mime) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { text: null, note: 'no key' };
  try {
    const form = new FormData();
    form.append('model', 'whisper-1');
    form.append('response_format', 'text');
    form.append('file', new Blob([buf], { type: mime || 'audio/wav' }), 'voicemail.wav');
    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: form });
    const t = await r.text();
    if (!r.ok) return { text: null, note: 'openai ' + r.status + ': ' + t.slice(0, 140) };
    return { text: (t || '').trim(), note: 'ok' };
  } catch (e) { return { text: null, note: 'err ' + String(e && e.message || e).slice(0, 120) }; }
}

async function ensureLabel(token) {
  try {
    const list = await gapi(token, 'labels');
    const found = (list.labels || []).find((l) => l.name === 'CRM Voicemail');
    if (found) return found.id;
    const made = await gapi(token, 'labels', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'CRM Voicemail', labelListVisibility: 'labelShow', messageListVisibility: 'show' }) });
    return made.id;
  } catch (e) { return null; }
}

async function runVoicemailSync({ lookbackDays = 21, max = 20, doTranscribe = true } = {}) {
  const summary = { processed: 0, matched: 0, unmatched: 0, transcribed: 0, skipped: 0, errors: [] };
  const at = await getAccessToken('shared');
  if (!at.ok) throw new Error(at.error || 'Gmail not connected');
  const token = at.access_token;

  const q = encodeURIComponent('from:pbx@2talk.co.nz newer_than:' + lookbackDays + 'd');
  const list = await gapi(token, 'messages?maxResults=50&q=' + q);
  const ids = (list.messages || []).map((m) => m.id);
  if (!ids.length) return summary;

  const existing = await salesDb('voicemails?select=gmail_id');
  const have = new Set((existing || []).map((r) => r.gmail_id));

  // store phones for matching
  const stores = await salesDb('stores?select=id,contact_phone,contact2_phone,contact3_phone,contact4_phone,contact5_phone,contact6_phone,store_phone') || [];
  const phoneIndex = [];
  stores.forEach((s) => {
    ['contact_phone','contact2_phone','contact3_phone','contact4_phone','contact5_phone','contact6_phone','store_phone']
      .forEach((k) => { const d = nzNorm(s[k]); if (d.length >= 8) phoneIndex.push({ id: s.id, tail: d.slice(-8) }); });
  });
  const matchStore = (caller) => { const d = nzNorm(caller); if (d.length < 8) return null; const hit = phoneIndex.find((p) => p.tail === d.slice(-8)); return hit ? hit.id : null; };

  const labelId = await ensureLabel(token);

  for (const id of ids) {
    if (have.has(id)) { summary.skipped++; continue; }
    if (summary.processed >= max) break;
    try {
      const msg = await gapi(token, 'messages/' + id + '?format=full');
      const parts = { text: '', audio: null };
      collectParts(msg.payload, parts);
      const subject = ((msg.payload && msg.payload.headers) || []).find((h) => h.name.toLowerCase() === 'subject');
      const det = parseDetails(parts.text, subject && subject.value);
      const occurred = msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : new Date().toISOString();

      let audioB64 = null, audioMime = 'audio/wav', transcript = null, tnote = 'no audio';
      if (parts.audio) {
        audioMime = parts.audio.mime.includes('wav') ? 'audio/wav' : (parts.audio.mime.includes('mpeg') || parts.audio.mime.includes('mp3') ? 'audio/mpeg' : parts.audio.mime);
        const att = await gapi(token, 'messages/' + id + '/attachments/' + parts.audio.attachmentId);
        const buf = b64urlToBuf(att.data);
        audioB64 = buf.toString('base64');
        if (doTranscribe) { const tr = await transcribe(buf, audioMime); transcript = tr.text; tnote = tr.note; if (transcript) summary.transcribed++; }
        else { tnote = 'transcribe skipped'; }
      }

      const storeId = matchStore(det.caller);
      const status = storeId ? 'matched' : 'to_match';

      const row = {
        gmail_id: id, caller: det.caller || null, for_number: det.forNum || null,
        occurred_at: occurred, duration: det.duration || null,
        transcript: transcript, audio_b64: audioB64, audio_mime: audioMime,
        store_id: storeId, status,
      };
      await salesDb('voicemails?on_conflict=gmail_id', { method: 'POST',
        headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify(row) });

      if (storeId) {
        summary.matched++;
        const res = '📞 Voicemail' + (det.duration ? ' (' + det.duration + ')' : '') + ' from ' + (det.caller || 'unknown') + (transcript ? ': ' + transcript : '');
        await salesDb('activities', { method: 'POST', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ store_id: storeId, type: 'phone_in', result: res, created_by: 'Voicemail', occurred_at: occurred }) }).catch(() => {});
      } else { summary.unmatched++; }

      if (labelId) { await gapi(token, 'messages/' + id + '/modify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ addLabelIds: [labelId] }) }).catch(() => {}); }

      summary.processed++;
      if (parts.audio && !transcript) summary.errors.push(id.slice(-6) + ': ' + tnote);
    } catch (e) {
      summary.errors.push(id.slice(-6) + ': ' + String((e && e.message) || e).slice(0, 120));
    }
  }
  return summary;
}

module.exports = { runVoicemailSync, salesDb };
