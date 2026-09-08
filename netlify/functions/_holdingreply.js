// Auto "we're a bit busy" holding reply for tickets left unanswered past the SLA.
// Business hours only: weekends never count towards the clock and nothing is ever
// sent on a Saturday or Sunday. One holding reply per ticket, ever.
const { rest } = require('./_appsdb');
const { getAccessToken } = require('./_gmail');

const TZ = 'Pacific/Auckland';
const MAX_PER_RUN = 25;
const DEFAULT_BODY = 'Hi {{first_name}},\n\nThanks so much for getting in touch with us.\n\nJust letting you know your email has arrived safely and it is in our queue. We are a bit busier than usual at the moment, so it is taking us a little longer than we would like to reply to everyone.\n\nWe will get back to you shortly with a proper answer.\n\nThanks for your patience,\nThe Revive team';

// ---- NZ time helpers --------------------------------------------------------
function nzParts(d){
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false, weekday:'short' }).formatToParts(d);
  const g = t => p.find(x => x.type === t).value;
  return { y:+g('year'), m:+g('month'), d:+g('day'), hour:+g('hour'), dow:g('weekday') };
}
function nzMidnight(y,m,d){
  const guess = new Date(Date.UTC(y, m-1, d, 0, 0, 0));
  const asNZ = new Date(guess.toLocaleString('en-US', { timeZone: TZ }));
  return new Date(guess.getTime() - (asNZ.getTime() - guess.getTime()));
}
function midnightOf(ms){ const p = nzParts(new Date(ms)); return +nzMidnight(p.y, p.m, p.d); }
function isWeekend(ms){ const dow = nzParts(new Date(ms)).dow; return dow === 'Sat' || dow === 'Sun'; }

// Elapsed ms between two instants, counting NZ weekdays only.
function businessMs(startMs, nowMs){
  if (!startMs || startMs >= nowMs) return 0;
  if (nowMs - startMs > 60 * 86400000) return nowMs - startMs; // ancient: don't walk 60+ days
  let total = 0, cur = startMs, guard = 0;
  while (cur < nowMs && guard++ < 90) {
    const dayStart = midnightOf(cur);
    const nextDay = midnightOf(dayStart + 36 * 3600000); // DST-safe next NZ midnight
    const segEnd = Math.min(nextDay, nowMs);
    if (!isWeekend(dayStart + 12 * 3600000)) total += segEnd - cur;
    cur = segEnd;
  }
  return total;
}

// ---- settings ---------------------------------------------------------------
async function loadSettings(){
  const rows = await rest('settings?select=key,value');
  const m = {}; (rows || []).forEach(r => m[r.key] = r.value);
  return m;
}
function parseWindow(v){
  const m = String(v || '8-18').match(/(\d{1,2})\s*-\s*(\d{1,2})/);
  if (!m) return [8, 18];
  return [Math.max(0, Math.min(23, +m[1])), Math.max(1, Math.min(24, +m[2]))];
}

// ---- mail -------------------------------------------------------------------
function b64url(buf){ return Buffer.from(buf).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
function encHeader(s){ return /[^\x00-\x7F]/.test(s||'') ? '=?UTF-8?B?'+Buffer.from(s).toString('base64')+'?=' : (s||''); }
function esc(s){ return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function firstName(name){
  const n = String(name || '').trim();
  if (!n || /@/.test(n)) return 'there';
  const f = n.split(/\s+/)[0];
  return f.length > 1 ? f : 'there';
}
const BAD_ADDR = /(no-?reply|noreply|do-?not-?reply|donotreply|mailer-daemon|postmaster|notification|@revive\.co\.nz|@revivealicious)/i;

function lastMessage(t){
  return (t.messages || []).reduce((mx, m) => (m.sent_at && (!mx || new Date(m.sent_at) > new Date(mx.sent_at))) ? m : mx, null);
}

// A ticket is "waiting on us": no outbound since the customer's last message.
function waitingSince(t){
  const lm = lastMessage(t);
  if (!lm) return t.created_at ? +new Date(t.created_at) : null;
  if (lm.direction === 'outbound') return null;
  return +new Date(lm.sent_at);
}

async function runHoldingReplies(opts){
  const o = opts || {};
  const S = await loadSettings();
  if (!o.force && String(S.holding_reply_enabled || '1') === '0') return { ran:false, reason:'disabled', sent:0 };

  const hours = Number(S.holding_reply_hours || 24) || 24;
  const [w0, w1] = parseWindow(S.holding_reply_window);
  const now = new Date(); const nowMs = +now; const np = nzParts(now);

  if (!o.force) {
    if (np.dow === 'Sat' || np.dow === 'Sun') return { ran:false, reason:'weekend', sent:0 };
    if (np.hour < w0 || np.hour >= w1) return { ran:false, reason:'outside send window ('+w0+':00–'+w1+':00 NZ)', sent:0 };
  }

  const rows = await rest('tickets?select=id,subject,gmail_thread_id,status,ticket_type,created_at,holding_reply_sent_at,customer:customers(email,name),messages(direction,sent_at)'
    + '&holding_reply_sent_at=is.null&status=neq.Resolved&excluded=is.false&order=created_at.desc&limit=500');

  const due = [];
  for (const t of (rows || [])) {
    if (!t.gmail_thread_id) continue;
    if (t.ticket_type === 'misc') continue;
    const email = ((t.customer && t.customer.email) || '').trim();
    if (!email || !/@/.test(email) || BAD_ADDR.test(email)) continue;
    const since = waitingSince(t);
    if (!since) continue;
    if (businessMs(since, nowMs) < hours * 3600000) continue;
    due.push({ t, email, since });
  }

  if (o.dryRun) return { ran:true, reason:'dry run', due: due.length, sent:0, tickets: due.map(d => ({ id:d.t.id, subject:d.t.subject, email:d.email })) };

  const at = await getAccessToken('cafe');
  if (!at.ok) return { ran:false, reason: at.error, sent:0, due: due.length };
  const from = at.email || 'cafe@revive.co.nz';

  let footer = '';
  try { const fr = await rest('settings?select=value&key=eq.reply_footer'); footer = (fr && fr[0] && fr[0].value) || ''; } catch (e) {}
  const template = S.holding_reply_body || DEFAULT_BODY;

  let sent = 0; const errors = [];
  for (const d of due.slice(0, MAX_PER_RUN)) {
    try {
      let text = template.replace(/\{\{\s*first_name\s*\}\}/gi, firstName((d.t.customer || {}).name))
                         .replace(/\{\{\s*name\s*\}\}/gi, ((d.t.customer || {}).name || 'there'));
      if (footer && !text.includes(footer)) text = text + '\n\n' + footer;

      let subject = d.t.subject || 'your enquiry';
      if (!/^re:/i.test(subject)) subject = 'Re: ' + subject;

      const altB = 'alt_' + Date.now() + '_' + sent;
      const html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;white-space:pre-wrap">' + esc(text) + '</div>';
      const mime = ['From: ' + from, 'To: ' + d.email, 'Subject: ' + encHeader(subject), 'MIME-Version: 1.0',
        'Content-Type: multipart/alternative; boundary="' + altB + '"'].join('\r\n') + '\r\n\r\n'
        + '--' + altB + '\r\nContent-Type: text/plain; charset="UTF-8"\r\n\r\n' + text + '\r\n'
        + '--' + altB + '\r\nContent-Type: text/html; charset="UTF-8"\r\n\r\n' + html + '\r\n--' + altB + '--';

      const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method:'POST', headers:{ Authorization:'Bearer ' + at.access_token, 'Content-Type':'application/json' },
        body: JSON.stringify({ raw: b64url(mime), threadId: String(d.t.gmail_thread_id) }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { errors.push(d.t.id + ': ' + ((j.error && j.error.message) || 'send failed')); continue; }

      await rest('messages', { method:'POST', headers:{ Prefer:'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({
        gmail_message_id: j.id, ticket_id: d.t.id, direction:'outbound', from_addr: from, to_addr: d.email,
        body: text, sent_at: new Date().toISOString(), is_ai_draft: false }) });

      // Status deliberately unchanged — we still owe this customer a real reply.
      await rest('tickets?id=eq.' + encodeURIComponent(d.t.id), { method:'PATCH', headers:{ Prefer:'return=minimal' },
        body: JSON.stringify({ holding_reply_sent_at: new Date().toISOString() }) });
      sent++;
    } catch (e) { errors.push(d.t.id + ': ' + String(e.message || e)); }
  }

  return { ran:true, due: due.length, sent, skipped: Math.max(0, due.length - MAX_PER_RUN), errors };
}

module.exports = { runHoldingReplies, businessMs, DEFAULT_BODY };
