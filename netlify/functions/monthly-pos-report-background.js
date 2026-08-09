// Emails last month's Cafe POS report to the saved recipient list. Scheduled for the
// first few days of each month; sends once (guarded), retrying on later days if the
// till PC was unreachable on the 1st.
const { reportSql, parseReport, emailHtml } = require('./_posreport');
const { sendMail } = require('./_mail');
const APPS_URL = 'https://xcwrawjdfajlmbkdwlbm.supabase.co';
const APPS_KEY = process.env.APPS_SERVICE_ROLE_KEY;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
async function db(path, opts = {}) {
  const headers = { apikey: APPS_KEY, Authorization: 'Bearer ' + APPS_KEY, 'Content-Type': 'application/json',
    'Accept-Profile': 'scoreboard', 'Content-Profile': 'scoreboard', ...(opts.headers || {}) };
  const res = await fetch(APPS_URL + '/rest/v1/' + path, { ...opts, headers });
  const t = await res.text(); if (!res.ok) throw new Error('DB ' + res.status + ': ' + t.slice(0, 140));
  return t ? JSON.parse(t) : null;
}
async function getSetting(k) { const r = await db('app_setting?key=eq.' + k + '&select=value'); return r && r[0] ? r[0].value : null; }
async function setSetting(k, v) { await db('app_setting?on_conflict=key', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify([{ key: k, value: v, updated_at: new Date().toISOString() }]) }); }

exports.handler = async () => {
  try {
    const nz = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const [Y, M] = nz.split('-').map(Number); const pad = x => String(x).padStart(2, '0');
    const lm = M === 1 ? 12 : M - 1, ly = M === 1 ? Y - 1 : Y;
    const monthKey = ly + '-' + pad(lm);
    if (await getSetting('pos_report_last_month') === monthKey) { console.log('already sent for ' + monthKey); return { statusCode: 200, body: 'already sent' }; }
    const to = await getSetting('pos_report_emails');
    if (!to) { console.log('no recipients'); return { statusCode: 200, body: 'no recipients' }; }
    const start = ly + '-' + pad(lm) + '-01';
    const lastDay = new Date(Date.UTC(ly, lm, 0)).getUTCDate();
    const end = ly + '-' + pad(lm) + '-' + pad(lastDay);
    const endNext = Y + '-' + pad(M) + '-01';
    const label = Number(1) + ' ' + MON[lm - 1] + ' ' + ly + ' – ' + lastDay + ' ' + MON[lm - 1] + ' ' + ly;
    // queue the till job and wait (background function has plenty of time)
    const ins = await db('pos_jobs', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify([{ sql: reportSql(start, endNext), note: 'report' }]) });
    const id = ins && ins[0] ? ins[0].id : null;
    let result = null;
    for (let i = 0; i < 90 && id; i++) { await sleep(3000); const r = await db('pos_jobs?id=eq.' + id + '&select=status,result'); const j = r && r[0]; if (j && j.status === 'done') { result = j.result; break; } if (j && j.status === 'error') break; }
    if (!result) { console.log('till unreachable for ' + monthKey + ' — will retry'); return { statusCode: 200, body: 'till unreachable, will retry' }; }
    const d = parseReport(result);
    const html = emailHtml(label, d);
    const r = await sendMail({ to, subject: 'Cafe POS report — ' + MON[lm - 1] + ' ' + ly, html, text: 'Cafe POS report ' + label });
    if (!r.ok) { console.log('send failed: ' + r.error); return { statusCode: 500, body: r.error }; }
    await setSetting('pos_report_last_month', monthKey);
    console.log('sent ' + monthKey + ' to ' + to);
    return { statusCode: 200, body: 'sent' };
  } catch (e) { console.log('monthly-pos-report error', String(e && e.message || e)); return { statusCode: 500, body: String(e) }; }
};
