// Pulse notifications — emails a survey's notify_emails when a new response arrives.
// Uses the portal's shared mailer (_mail.js → Resend when configured, else Gmail).
// Customer name/email are hidden so it can be shared with staff. Each response has a #.
// If the survey has color_code on, answers are colour-coded (green good … red bad);
// names/dishes/free text stay black. Question titles are small grey; answers are bold.
const { sendMail } = require('./_mail');

const APPS_URL = 'https://xcwrawjdfajlmbkdwlbm.supabase.co';
const KEY = process.env.APPS_SERVICE_ROLE_KEY;
const esc = s => String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function sb(path){ return fetch(APPS_URL+path,{ headers:{ apikey:KEY, Authorization:'Bearer '+KEY, 'Accept-Profile':'pulse' } }); }

const C = { green:'#2e7d32', lgreen:'#6aa84f', amber:'#b7791f', orange:'#d9622b', red:'#c0392b', black:'#243029' };
function colorForFraction(f){ if(f>=0.8)return C.green; if(f>=0.6)return C.lgreen; if(f>=0.4)return C.amber; if(f>=0.2)return C.orange; return C.red; }
function colorForRating(n, scale){
  n=Number(n); if(isNaN(n)||!scale) return null;
  if(scale>=9){ if(n>=9)return C.green; if(n>=7)return C.amber; return C.red; }   // NPS bands
  return colorForFraction((n-1)/(scale-1));
}
function colorForChoice(v){
  const s=String(v||'').trim().toLowerCase();
  if(/(strongly disagree|very dissatisfied|very poor|terrible|awful|definitely not)/.test(s)) return C.red;
  if(/(strongly agree|very satisfied|very good|excellent)/.test(s)) return C.green;
  if(/(^|\W)(disagree|dissatisfied|poor|unlikely|probably not)(\W|$)/.test(s)) return C.orange;
  if(/(^|\W)(agree|satisfied|good|likely|probably)(\W|$)/.test(s)) return C.lgreen;
  if(/(neutral|neither|average|^ok(ay)?$|unsure|maybe|sometimes|n\/?a)/.test(s)) return C.amber;
  return null; // unknown → not coloured
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode:405, body:'Method not allowed' };
  const k = event.headers['x-pulse-key'] || event.headers['X-Pulse-Key'];
  if (k !== 'pulsenotify2025') return { statusCode:403, body:'no' };
  if (!KEY) return { statusCode:500, body:'Server not configured (APPS_SERVICE_ROLE_KEY).' };
  let b; try { b = JSON.parse(event.body||'{}'); } catch { return { statusCode:400, body:'bad' }; }
  const { survey_id, response_id } = b;
  if (!survey_id || !response_id) return { statusCode:400, body:'missing ids' };

  const survey = (await (await sb('/rest/v1/surveys?id=eq.'+survey_id+'&select=title,notify_emails,slug,color_code')).json())[0];
  if (!survey || !Array.isArray(survey.notify_emails) || !survey.notify_emails.length) return { statusCode:200, body:'no recipients' };
  const resp = (await (await sb('/rest/v1/responses?id=eq.'+response_id+'&select=seq,respondent_name,respondent_email,submitted_at,meta')).json())[0] || {};
  const questions = await (await sb('/rest/v1/questions?survey_id=eq.'+survey_id+'&select=id,label,type,sort_order,settings&order=sort_order')).json();
  const answers = await (await sb('/rest/v1/answers?response_id=eq.'+response_id+'&select=question_id,value,value_options,value_number')).json();
  const amap = {}; (answers||[]).forEach(a => amap[a.question_id] = a);

  const cc = !!survey.color_code;
  const name = (resp.respondent_name || '').trim().toLowerCase();
  const email = (resp.respondent_email || '').trim().toLowerCase();
  const isIdentity = (v) => { const s=String(v||'').trim().toLowerCase(); return s && (s===name || s===email); };

  const rows = (questions||[])
    .filter(q => q.type!=='info' && q.type!=='image' && q.type!=='email' && q.type!=='email_klaviyo')
    .map(q => {
      const a = amap[q.id]; if (!a) return '';
      const v = a.value_options ? a.value_options.join(', ') : (a.value != null ? a.value : (a.value_number != null ? a.value_number : ''));
      if (v==='' || v==null) return '';
      if (isIdentity(v)) return '';
      const scale = q.settings && q.settings.scale;
      let color = C.black;
      if (cc) {
        if (q.type==='rating') { const c=colorForRating(a.value_number!=null?a.value_number:v, scale); if(c) color=c; }
        else if (q.type==='radio' || q.type==='dropdown') { const c=colorForChoice(v); if(c) color=c; }
      }
      const disp = (q.type==='rating' && scale) ? `${v} / ${scale}` : String(v);
      return `<div style="margin:11px 0">
        <div style="font-size:11.5px;color:#8a938c;margin-bottom:1px">${esc(q.label)}</div>
        <div style="font-weight:700;font-size:14px;color:${color}">${esc(disp)}</div>
      </div>`;
    }).join('');

  const collector = resp.meta && resp.meta.collector ? `${esc(resp.meta.collector)} · ` : '';
  const when = resp.submitted_at ? new Date(resp.submitted_at).toLocaleString('en-NZ') : '';
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#243029;max-width:640px">
    <div style="background:#1f6f54;color:#fff;padding:14px 18px;border-radius:10px 10px 0 0">
      <div style="font-size:12px;letter-spacing:.08em;opacity:.85">REVIVE · PULSE</div>
      <div style="font-size:17px;font-weight:700;margin-top:4px">New response — ${esc(survey.title)}</div></div>
    <div style="border:1px solid #e6e0d4;border-top:none;border-radius:0 0 10px 10px;padding:16px 18px">
      <p style="margin:0 0 12px;color:#6b7b72">${resp.seq!=null?`<strong style="color:#1f6f54">Response #${resp.seq}</strong> · `:''}${collector}${when}</p>
      ${rows}
      <p style="margin:16px 0 0;font-size:12.5px;color:#8a938c">Customer details are hidden so this can be shared with the team. Full results &amp; AI analysis: team.revive.co.nz/pulse</p></div></div>`;

  const r = await sendMail({ to: survey.notify_emails.join(','), subject: `New feedback${resp.seq!=null?` #${resp.seq}`:''}: ${survey.title}`, html,
    text: `New response${resp.seq!=null?` #${resp.seq}`:''} to ${survey.title}. Customer details hidden. Full results: team.revive.co.nz/pulse` });
  return { statusCode: 200, headers:{'Content-Type':'application/json'}, body: JSON.stringify(r) };
};
