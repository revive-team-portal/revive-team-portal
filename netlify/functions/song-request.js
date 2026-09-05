// Song request form on the public /music/ page.
// Anyone can post — no login — so keep it tight: size caps, a honeypot,
// a per-IP cooldown and a link check to keep spam bots out of Jeremy's inbox.

const { json } = require('./_portal');
const { sendMail } = require('./_mail');

const TO = 'jeremy@revive.co.nz';
const MAX_NAME = 80;
const MAX_THEME = 1200;
const COOLDOWN_MS = 60 * 1000;   // one request per IP per minute
const recent = new Map();        // survives while the lambda instance is warm

const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Use POST.' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Could not read that request.' }); }

  const name = String(body.name || '').trim();
  const theme = String(body.theme || '').trim();
  const trap = String(body.website || '').trim();   // honeypot: humans never fill this

  if (trap) return json(200, { ok: true });          // silently swallow bots
  if (!name || !theme) return json(400, { error: 'Please add your name and what the song is about.' });
  if (name.length > MAX_NAME) return json(400, { error: 'That name is a bit long.' });
  if (theme.length > MAX_THEME) return json(400, { error: 'Please keep it under 1200 characters.' });

  // bots love links
  const links = (theme.match(/https?:\/\/|www\./gi) || []).length;
  if (links > 1) return json(400, { error: 'Please describe the idea without links.' });

  const ip = (event.headers['x-nf-client-connection-ip']
    || event.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const now = Date.now();
  const last = recent.get(ip);
  if (last && now - last < COOLDOWN_MS) {
    return json(429, { error: 'Thanks — that just came through. Give it a minute before sending another.' });
  }
  recent.set(ip, now);
  if (recent.size > 500) recent.clear();

  const when = new Date().toLocaleString('en-NZ', { timeZone: 'Pacific/Auckland' });
  const html = `
    <div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;font-size:15px;line-height:1.55;color:#111">
      <p style="margin:0 0 18px"><strong>${esc(name)}</strong> has asked for a song.</p>
      <div style="border-left:3px solid #2BD97C;padding:2px 0 2px 14px;margin:0 0 20px;white-space:pre-wrap">${esc(theme)}</div>
      <p style="margin:0;color:#666;font-size:12.5px">Sent from The Inspiration Project &middot; ${esc(when)}</p>
    </div>`;
  const text = `${name} has asked for a song.\n\n${theme}\n\nSent from The Inspiration Project - ${when}`;

  const r = await sendMail({
    to: TO,
    subject: `Song request from ${name}`,
    html,
    text,
  });

  if (!r || !r.ok) {
    console.error('song-request send failed:', r && r.error);
    return json(502, { error: "That didn't send. Please try again shortly." });
  }
  return json(200, { ok: true });
};
