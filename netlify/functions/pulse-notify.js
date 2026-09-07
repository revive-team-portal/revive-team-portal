// Pulse notifications — emails a survey's notify_emails when a new response arrives.
// Uses the portal's shared mailer (_mail.js → Resend when RESEND_KEY is set, else Gmail).
// Called server-to-server by the Pulse submit edge function (notify_mode = 'each').
const { sendMail } = require('./_mail');

const APPS_URL = 'https://xcwrawjdfajlmbkdwlbm.supabase.co';
const KEY = process.env.APPS_SERVICE_ROLE_KEY;
const esc = s => String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function sb(path){ return fetch(APPS_URL+path,{ headers:{ apikey:KEY, Authorization:'Bearer '+KEY, 'Accept-Profile':'pulse' } }); }

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode:405, body:'Method not allowed' };
  const k = event.headers['x-pulse-key'] || event.headers['X-Pulse-Key'];
  if (k !== 'pulsenotify2025') return { statusCode:403, body:'no' };
  if (!KEY) return { statusCode:500, body:'Server not configured (APPS_SERVICE_ROLE_KEY).' };
  let b; try { b = JSON.parse(event.body||'{}'); } catch { return { statusCode:400, body:'bad' }; }
  const { survey_id, response_id } = b;
  if (!survey_id || !response_id) return { statusCode:400, body:'missing ids' };

  const survey = (await (await sb('/rest/v1/surveys?id=eq.'+survey_id+'&select=title,notify_emails,slug')).json())[0];
  if (!survey || !Array.isArray(survey.notify_emails) || !survey.notify_emails.length) return { statusCode:200, body:'no recipients' };
  const resp = (await (await sb('/rest/v1/responses?id=eq.'+response_id+'&select=respondent_name,respondent_email,submitted_at,meta')).json())[0] || {};
  const questions = await (await sb('/rest/v1/questions?survey_id=eq.'+survey_id+'&select=id,label,type,sort_order&order=sort_order')).json();
  const answers = await (await sb('/rest/v1/answers?response_id=eq.'+response_id+'&select=question_id,value,value_options,value_number')).json();
  const amap = {}; (answers||[]).forEach(a => amap[a.question_id] = a);

  const rows = (questions||[]).filter(q => q.type!=='info' && q.type!=='image').map(q => {
    const a = amap[q.id]; if (!a) return '';
    const v = a.value_options ? a.value_options.join(', ') : (a.value != null ? a.value : (a.value_number != null ? a.value_number : ''));
    return (v==='' || v==null) ? '' : `<p style="margin:7px 0"><strong>${esc(q.label)}</strong><br>${esc(String(v))}</p>`;
  }).join('');

  const who = resp.respondent_name || resp.respondent_email || 'Anonymous';
  const collector = resp.meta && resp.meta.collector ? ` · ${esc(resp.meta.collector)}` : '';
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#243029;max-width:640px">
    <div style="background:#1f6f54;color:#fff;padding:14px 18px;border-radius:10px 10px 0 0">
      <div style="font-size:12px;letter-spacing:.08em;opacity:.85">REVIVE · PULSE</div>
      <div style="font-size:17px;font-weight:700;margin-top:4px">New response — ${esc(survey.title)}</div></div>
    <div style="border:1px solid #e6e0d4;border-top:none;border-radius:0 0 10px 10px;padding:16px 18px">
      <p style="margin:0 0 12px;color:#6b7b72">From ${esc(who)}${collector} · ${resp.submitted_at?new Date(resp.submitted_at).toLocaleString('en-NZ'):''}</p>
      ${rows}
      <p style="margin:16px 0 0;font-size:12.5px;color:#8a938c">Full results &amp; AI analysis: team.revive.co.nz/pulse</p></div></div>`;

  const r = await sendMail({ to: survey.notify_emails.join(','), subject: `New feedback: ${survey.title}`, html,
    text: `New response to ${survey.title} from ${who}. Full results: team.revive.co.nz/pulse` });
  return { statusCode: 200, headers:{'Content-Type':'application/json'}, body: JSON.stringify(r) };
};
