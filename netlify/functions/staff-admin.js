// Staff setup — the one place a person is created. Lives behind the Timesheets
// app, because a staff member is a staff member whether they are clocking in or
// doing training. Issues the /me access code, sends the intro email, resets PINs.

const { json, validatePortalUser } = require('./_portal');
const { db, generateUniqueCode, signOutAll } = require('./_staffauth');

const TC = (p, o) => db(p, o, 'timeclock');
const RET = { headers: { Prefer: 'return=representation' } };
const MIN = { headers: { Prefer: 'return=minimal' } };
const BASE = 'https://team.revive.co.nz';

function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function inviteEmail(name, code, reset) {
  const link = BASE + '/me/' + code;
  const heading = reset ? 'Your Revive PIN has been reset' : 'Welcome to the Revive team page';
  const intro = reset
    ? 'Your PIN has been reset. Open your personal link below and choose a new 4-digit PIN.'
    : 'This is your own page for clocking in, your timesheet, and your training. Everything in one place.';
  const html = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#14211c;max-width:520px">
  <p style="font-size:19px;font-weight:600;margin:0 0 14px">${esc(heading)}</p>
  <p style="margin:0 0 14px">Hi ${esc(name)},</p>
  <p style="margin:0 0 18px">${esc(intro)}</p>
  <p style="margin:0 0 8px"><a href="${esc(link)}" style="display:inline-block;background:#16543f;color:#fff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:600">Open my page</a></p>
  <p style="margin:14px 0 18px;font-size:13px;color:#6e7b75">Or go to <b>${esc(link)}</b></p>
  <p style="margin:0 0 10px"><b>First time:</b> the page will greet you by name and ask you to choose a 4-digit PIN. Pick something you will remember — you will need it each time you sign in.</p>
  <p style="margin:0 0 10px"><b>On your own phone:</b> tick "this is my phone" and you will stay signed in. Add the page to your home screen and it is one tap after that.</p>
  <p style="margin:0 0 18px"><b>On the shared iPad:</b> you will be asked for your PIN each time, and it signs itself out after a few minutes.</p>
  <p style="margin:0;font-size:13px;color:#6e7b75">Keep this link to yourself. If you lose your PIN, ask a manager to reset it.</p>
</div>`;
  const text = `${heading}

Hi ${name},

${intro}

Your page: ${link}

First time: the page will greet you by name and ask you to choose a 4-digit PIN.
On your own phone, tick "this is my phone" to stay signed in.
On the shared iPad you will be asked for your PIN each time.

Keep this link to yourself. If you lose your PIN, ask a manager to reset it.`;
  return { subject: reset ? 'Your Revive PIN has been reset' : 'Your Revive team page', html, text };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const auth = await validatePortalUser(event, 'timeclock');
  if (!auth.ok) return json(auth.status || 403, { error: auth.error });
  const actor = auth.user.email || auth.user.id;

  let b;
  try { b = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad request.' }); }

  try {
    if (b.action === 'list') {
      const [staff, areas, links] = await Promise.all([
        TC('staff?select=id,name,email,phone,active,is_manager,access_code,pin_set_at,invited_at,portal_user_id&order=active.desc,name.asc'),
        TC('area?active=eq.true&select=id,label&order=sort.asc'),
        TC('staff_area?select=staff_id,area_id'),
      ]);
      return json(200, {
        areas,
        staff: staff.map(s => ({
          ...s,
          has_pin: !!s.pin_set_at,
          link: s.access_code ? BASE + '/me/' + s.access_code : null,
          areas: links.filter(l => l.staff_id === s.id).map(l => l.area_id),
        })),
      });
    }

    if (b.action === 'save') {
      const patch = {};
      for (const k of ['name', 'email', 'phone', 'is_manager', 'active']) if (k in b) patch[k] = b[k] === '' ? null : b[k];
      if (b.staff_id) {
        if (!Object.keys(patch).length) return json(400, { error: 'Nothing to save.' });
        const row = (await TC('staff?id=eq.' + b.staff_id, { method: 'PATCH', ...RET, body: JSON.stringify(patch) }))[0];
        return json(200, { staff: row });
      }
      if (!String(patch.name || '').trim()) return json(400, { error: 'A name is required.' });
      patch.access_code = await generateUniqueCode();
      if (!('leave_basis' in patch)) patch.leave_basis = 'hours';
      const row = (await TC('staff', { method: 'POST', ...RET, body: JSON.stringify(patch) }))[0];
      return json(200, { staff: row, link: BASE + '/me/' + row.access_code });
    }

    if (b.action === 'issue_code') {
      const code = await generateUniqueCode();
      const row = (await TC('staff?id=eq.' + b.staff_id, { method: 'PATCH', ...RET, body: JSON.stringify({ access_code: code }) }))[0];
      await signOutAll(b.staff_id);
      return json(200, { staff: row, link: BASE + '/me/' + code });
    }

    if (b.action === 'invite' || b.action === 'reset_pin') {
      const s = (await TC('staff?id=eq.' + b.staff_id + '&select=id,name,email,access_code&limit=1'))[0];
      if (!s) return json(404, { error: 'Person not found.' });
      let code = s.access_code;
      if (!code) {
        code = await generateUniqueCode();
        await TC('staff?id=eq.' + s.id, { method: 'PATCH', ...MIN, body: JSON.stringify({ access_code: code }) });
      }
      const reset = b.action === 'reset_pin';
      if (reset) {
        await TC('staff?id=eq.' + s.id, {
          method: 'PATCH', ...MIN,
          body: JSON.stringify({ pin_hash: null, pin_set_at: null, pin_attempts: 0, locked_until: null }),
        });
        await signOutAll(s.id);
      }
      let sent = false, mailError = null;
      if (s.email) {
        try {
          const { sendMail } = require('./_mail');
          const msg = inviteEmail(s.name, code, reset);
          const r = await sendMail({ to: s.email, subject: msg.subject, html: msg.html, text: msg.text });
          sent = !!(r && r.ok !== false);
          if (!sent) mailError = (r && r.error) || 'Mail service did not confirm the send.';
        } catch (e) {
          mailError = String(e.message || e).slice(0, 200);
        }
      } else {
        mailError = 'No email address on file — share the link directly.';
      }
      await TC('staff?id=eq.' + s.id, { method: 'PATCH', ...MIN, body: JSON.stringify({ invited_at: new Date().toISOString() }) });
      return json(200, { ok: true, sent, mailError, link: BASE + '/me/' + code, reset, actor });
    }

    if (b.action === 'set_areas') {
      await TC('staff_area?staff_id=eq.' + b.staff_id, { method: 'DELETE', ...MIN });
      const areas = (b.areas || []).filter(a => Number.isInteger(a));
      if (areas.length) await TC('staff_area', { method: 'POST', ...MIN, body: JSON.stringify(areas.map(a => ({ staff_id: b.staff_id, area_id: a }))) });
      return json(200, { ok: true });
    }

    if (b.action === 'signout_all') {
      await signOutAll(b.staff_id);
      return json(200, { ok: true });
    }

    return json(400, { error: 'Unknown action.' });
  } catch (e) {
    return json(500, { error: String(e.message || e).slice(0, 300) });
  }
};
