// ============================================================
// Jobs mail overflow
//
// Resend allows 100 sends a day, which is not enough while a position is
// being advertised. Anything the jobs site queues past its cap is sent
// from here through Gmail instead, so overflow goes out the same day
// rather than waiting until tomorrow.
//
// Runs on a schedule (see netlify.toml). Also callable with ?check=1 to
// report which addresses the mailbox is allowed to send as.
// ============================================================

const { getAccessToken } = require('./_gmail');

const APPS_URL = 'https://xcwrawjdfajlmbkdwlbm.supabase.co';
const APPS_KEY = process.env.APPS_SERVICE_ROLE_KEY;

// The mailbox the overflow is sent from, and the address we would prefer
// to appear as. Gmail only allows a "send as" address that has been
// verified on that account.
const MAILBOX = 'cafe';
const PREFERRED_FROM = 'noreply@revive.co.nz';
const FROM_NAME = 'Revive Cafe Jobs';

const BATCH = 40;   // per run; Workspace allows far more per day than Resend

function jobsRest(path, opts = {}) {
  return fetch(APPS_URL + '/rest/v1/' + path, {
    ...opts,
    headers: {
      apikey: APPS_KEY,
      Authorization: 'Bearer ' + APPS_KEY,
      'Content-Type': 'application/json',
      'Accept-Profile': 'jobs',
      'Content-Profile': 'jobs',
      ...(opts.headers || {})
    }
  });
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function encHeader(x) {
  return /[^\x00-\x7F]/.test(x || '') ? '=?UTF-8?B?' + Buffer.from(x).toString('base64') + '?=' : (x || '');
}

// Which addresses this mailbox may send as, and whether ours is one of them.
async function resolveFrom(accessToken, mailboxEmail) {
  try {
    const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs', {
      headers: { Authorization: 'Bearer ' + accessToken }
    });
    const d = await res.json().catch(() => ({}));
    const list = (d.sendAs || []).map(a => ({
      email: a.sendAsEmail,
      verified: a.verificationStatus === 'accepted' || !!a.isPrimary,
      primary: !!a.isPrimary
    }));
    const wanted = list.find(a => a.email &&
      a.email.toLowerCase() === PREFERRED_FROM.toLowerCase() && a.verified);
    return { from: wanted ? wanted.email : mailboxEmail, aliases: list };
  } catch (err) {
    console.error('Could not read sendAs aliases', err);
    return { from: mailboxEmail, aliases: [] };
  }
}

exports.handler = async (event) => {
  if (!APPS_KEY) return { statusCode: 500, body: 'APPS_SERVICE_ROLE_KEY missing' };

  const at = await getAccessToken(MAILBOX);
  if (!at.ok) {
    console.error('Gmail not available for overflow:', at.error);
    return { statusCode: 200, body: JSON.stringify({ sent: 0, error: at.error }) };
  }

  const resolved = await resolveFrom(at.access_token, at.email);

  // Diagnostic mode — report what we can send as without sending anything.
  if (event && event.queryStringParameters && event.queryStringParameters.check) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mailbox: at.email,
        wanted: PREFERRED_FROM,
        willSendAs: resolved.from,
        canUsePreferred: resolved.from.toLowerCase() === PREFERRED_FROM.toLowerCase(),
        aliases: resolved.aliases
      }, null, 2)
    };
  }

  // Anything the jobs site has queued, oldest first — ignoring send_after,
  // because the whole point is not to make people wait until tomorrow.
  const rows = await (await jobsRest(
    `email_queue?status=eq.queued&order=queued_at.asc&limit=${BATCH}&select=*`
  )).json().catch(() => []);

  if (!Array.isArray(rows) || !rows.length) {
    return { statusCode: 200, body: JSON.stringify({ sent: 0, reason: 'queue empty' }) };
  }

  let sent = 0, failed = 0;
  for (const item of rows) {
    const p = item.payload || {};
    try {
      const altB = 'alt_' + Date.now() + '_' + sent;
      const html = p.html || '';
      const plain = String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const alt =
        '--' + altB + '\r\nContent-Type: text/plain; charset="UTF-8"\r\n\r\n' + plain + '\r\n' +
        '--' + altB + '\r\nContent-Type: text/html; charset="UTF-8"\r\n\r\n' + html + '\r\n--' + altB + '--';

      const headers = [
        'From: ' + encHeader(FROM_NAME) + ' <' + resolved.from + '>',
        'To: ' + (p.to || item.to_email),
        'Subject: ' + encHeader(p.subject || 'Revive Cafe'),
        p.reply_to ? 'Reply-To: ' + p.reply_to : '',
        'MIME-Version: 1.0',
        'Content-Type: multipart/alternative; boundary="' + altB + '"'
      ].filter(Boolean);

      const mime = headers.join('\r\n') + '\r\n\r\n' + alt;
      const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + at.access_token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw: b64url(mime) })
      });
      const d = await res.json().catch(() => ({}));

      if (!res.ok) {
        const msg = (d.error && d.error.message) || ('Gmail ' + res.status);
        const attempts = (item.attempts || 0) + 1;
        await patch(item.id, attempts >= 3
          ? { status: 'failed', attempts, last_error: msg }
          : { attempts, last_error: msg });
        failed++;
        continue;
      }

      await patch(item.id, {
        status: 'sent',
        sent_at: new Date().toISOString(),
        attempts: (item.attempts || 0) + 1,
        last_error: 'Sent via Gmail (' + resolved.from + ') — Resend cap reached'
      });
      sent++;
    } catch (err) {
      console.error('Overflow send threw', err);
      await patch(item.id, { attempts: (item.attempts || 0) + 1, last_error: String(err.message || err) });
      failed++;
    }
  }

  console.log(`Jobs mail overflow: sent ${sent} via Gmail as ${resolved.from}, ${failed} failed`);
  return { statusCode: 200, body: JSON.stringify({ sent, failed, from: resolved.from }) };
};

async function patch(id, fields) {
  await jobsRest('email_queue?id=eq.' + id, {
    method: 'PATCH',
    body: JSON.stringify(fields)
  }).catch(err => console.error('Could not update queue row', err));
}
