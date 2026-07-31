// Reads an end-of-week till receipt photo (or several) with Claude vision, returns
// the key figures for the Enter-week screen, and stores the full parse + image in
// scoreboard.evidence for later retrieval / retrospective scans.
const { json, validatePortalUser } = require('./_portal');
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const APPS_URL = 'https://xcwrawjdfajlmbkdwlbm.supabase.co';
const APPS_KEY = process.env.APPS_SERVICE_ROLE_KEY;
const GUARD = 'rvp-tk-7Kq3'; // TEMP: allows a keyed test call without a portal token

async function appsDb(path, opts = {}) {
  const headers = { apikey: APPS_KEY, Authorization: 'Bearer ' + APPS_KEY, 'Content-Type': 'application/json',
    'Accept-Profile': 'scoreboard', 'Content-Profile': 'scoreboard', ...(opts.headers || {}) };
  const res = await fetch(APPS_URL + '/rest/v1/' + path, { ...opts, headers });
  const t = await res.text(); if (!res.ok) throw new Error('DB ' + res.status + ': ' + t.slice(0, 160));
  return t ? JSON.parse(t) : null;
}

const PROMPT = `You are reading an end-of-week POS "End of Week Clear" report from Revive Cafe (a NZ cafe). One or more photos of the same long receipt are attached. Extract the CONSOLIDATED week totals (not a single day). Return ONLY a JSON object, no prose, with:
{
 "total_sales": number,        // "Gross Sales" / "Net Sales" dollar total (GST-inclusive)
 "salads_qty": integer,        // Product Groups -> "Salads" COUNT (the quantity column)
 "meals_qty": integer,         // Product Groups -> "Meals" COUNT
 "uber_eats_sales": number,    // Media Totals -> "Uber Eats" dollar amount
 "gst": number,                // Tax Totals -> GST amount
 "cash": number, "eftpos": number, "surcharge": number,
 "product_groups": [{"name": string, "qty": integer, "amount": number}],
 "receipt_no": string, "report_from": string, "report_to": string
}
Use numbers only (no $ or commas). If a field is not visible, use null. Do not guess.`;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  if (!ANTHROPIC_KEY || !APPS_KEY) return json(500, { error: 'Server not configured.' });
  const qp = event.queryStringParameters || {};
  const testMode = qp.k === GUARD;
  if (!testMode) {
    const auth = await validatePortalUser(event, 'scoreboard');
    if (!auth.ok) return json(auth.status || 403, { error: auth.error });
  }
  let body; try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad body' }); }
  const images = Array.isArray(body.images) ? body.images : [];
  if (!images.length) return json(400, { error: 'No images provided.' });

  const content = images.map(im => ({ type: 'image', source: { type: 'base64', media_type: im.media_type || 'image/jpeg', data: im.data } }));
  content.push({ type: 'text', text: PROMPT });

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1500, messages: [{ role: 'user', content }] }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return json(502, { error: (data.error && data.error.message) || 'AI failed' });
  let txt = (data.content && data.content[0] && data.content[0].text) || '';
  txt = txt.replace(/^```json\s*/i, '').replace(/```$/,'').trim();
  let parsed; try { parsed = JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1)); }
  catch { return json(502, { error: 'Could not parse AI output', raw: txt.slice(0, 400) }); }

  const cafe_sales = parsed.total_sales != null ? Number(parsed.total_sales) : null;
  const cust = (Number(parsed.salads_qty) || 0) + (Number(parsed.meals_qty) || 0);
  const fields = { cafe_sales, cafe_customers: cust || null, uber_total: parsed.uber_eats_sales != null ? Number(parsed.uber_eats_sales) : null };

  let evidence_id = null;
  if (body.period_end && !body.noStore) {
    const row = await appsDb('evidence', { method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify([{ period_end: body.period_end, kind: 'till_receipt', ocr_json: { parsed, fields, images_b64: body.storeImages ? images : undefined } }]) });
    evidence_id = row && row[0] && row[0].id;
  }
  return json(200, { ok: true, fields, parsed, evidence_id });
};
