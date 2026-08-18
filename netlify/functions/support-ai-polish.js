// Light spelling/grammar polish of a reply draft (preserves tone/wording). Portal-gated (support).
const { json, validatePortalUser } = require('./_portal');
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const a = await validatePortalUser(event, 'support');
  if (!a.ok) return json(a.status || 403, { error: a.error });
  if (!ANTHROPIC_KEY) return json(500, { error: 'AI not configured.' });
  let body; try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad request.' }); }
  const text = (body.text||'').trim();
  if (!text) return json(400, { error: 'Nothing to polish.' });
  try {
    const prompt = `Polish this customer-service reply for Revive Cafe so it reads professional, friendly and brief. Fix all spelling and grammar, and smooth any awkward phrasing — the writer may not be a native English speaker, so make it natural, clear and concise while staying warm and polite. Keep ALL facts, order numbers, tracking details, amounts, dates, commitments and the sign-off name identical. Do not add new information. Preserve line breaks. Return ONLY the polished text, nothing else.\n\n---\n${text}`;
    const res = await fetch('https://api.anthropic.com/v1/messages', { method:'POST', headers:{ 'Content-Type':'application/json', 'x-api-key':ANTHROPIC_KEY, 'anthropic-version':'2023-06-01' }, body: JSON.stringify({ model:'claude-haiku-4-5-20251001', max_tokens:1200, messages:[{ role:'user', content: prompt }] }) });
    const d = await res.json().catch(()=>({}));
    if (!res.ok) return json(502, { error: (d&&d.error&&d.error.message)||'Polish failed.' });
    const out = (d.content && d.content[0] && d.content[0].text) || text;
    return json(200, { text: out.trim() });
  } catch (e) { return json(502, { error: String(e.message || e) }); }
};
