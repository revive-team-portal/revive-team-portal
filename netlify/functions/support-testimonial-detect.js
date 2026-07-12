// Detects whether a ticket's latest inbound email contains a testimonial / positive feedback,
// and extracts a short excerpt + product (if mentioned). Portal-gated (support).
const { json, validatePortalUser } = require('./_portal');
const { rest, hasKey } = require('./_appsdb');
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const a = await validatePortalUser(event, 'support');
  if (!a.ok) return json(a.status || 403, { error: a.error });
  if (!ANTHROPIC_KEY || !hasKey()) return json(200, { isTestimonial: false });
  let body; try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad request.' }); }
  if (!body.id) return json(400, { error: 'No ticket id.' });
  try {
    const t = await rest('tickets?id=eq.'+encodeURIComponent(body.id)+'&select=customer:customers(name,email)&limit=1');
    const cust = (t && t[0] && t[0].customer) || {};
    const msgs = await rest('messages?ticket_id=eq.'+encodeURIComponent(body.id)+'&direction=eq.inbound&select=body,sent_at&order=sent_at.desc&limit=1');
    const latest = msgs && msgs[0];
    if (!latest || !(latest.body||'').trim()) return json(200, { isTestimonial: false });

    const prompt = `Analyse this customer email to Revive Café (a NZ gluten-free food company). Decide if it contains a genuine testimonial or clearly positive feedback about the products or service (praise, thanks-with-delight, compliments). Ignore neutral logistics questions or complaints.\n\nReturn ONLY minified JSON: {"is_testimonial": true|false, "excerpt": "<a short verbatim quote of the positive part, max 220 chars>", "product": "<product mentioned, or empty>"}.\n\nEMAIL:\n${(latest.body||'').slice(0,2000)}`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST', headers:{ 'Content-Type':'application/json', 'x-api-key':ANTHROPIC_KEY, 'anthropic-version':'2023-06-01' },
      body: JSON.stringify({ model:'claude-haiku-4-5-20251001', max_tokens:400, messages:[{ role:'user', content: prompt }] }),
    });
    const d = await res.json().catch(()=>({}));
    let txt = (d.content && d.content[0] && d.content[0].text) || '';
    txt = txt.replace(/```json/gi,'').replace(/```/g,'').trim();
    let parsed = {}; try { parsed = JSON.parse(txt); } catch { return json(200, { isTestimonial:false }); }
    if (!parsed.is_testimonial) return json(200, { isTestimonial:false });
    return json(200, {
      isTestimonial: true,
      excerpt: (parsed.excerpt||'').slice(0,300),
      product: (parsed.product||'').slice(0,120),
      name: cust.name || '',
      email: cust.email || '',
      date: latest.sent_at || null,
    });
  } catch (e) { return json(200, { isTestimonial:false }); }
};
