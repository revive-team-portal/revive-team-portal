// Scores a reply for lavish, warm friendliness /10 and returns a lavished-up version
// (keeping all facts identical), with a weekend-aware closing. Portal-gated (support).
const { json, validatePortalUser } = require('./_portal');
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const TZ = 'Pacific/Auckland';
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const a = await validatePortalUser(event, 'support');
  if (!a.ok) return json(a.status || 403, { error: a.error });
  if (!ANTHROPIC_KEY) return json(200, { score: 10, improved: null, notes: 'AI off' });
  let body; try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad request.' }); }
  const text = (body.text||'').trim();
  if (!text) return json(400, { error: 'Nothing to check.' });
  const dow = new Intl.DateTimeFormat('en-US',{timeZone:TZ,weekday:'long'}).format(new Date());
  try {
    const prompt = `You are the warmth editor for Revive Café (NZ gluten-free food) customer service. Rate this reply for LAVISH, warm friendliness out of 10.
10 = effusively warm and personal: an enthusiastic opening greeting (e.g. "So lovely to hear from you!" / "Thanks so much for getting in touch!"), a genuinely caring, upbeat body, and a warm closing line (e.g. "Let me know if there's anything else at all" + a cheerful farewell). Lower scores lack warmth, feel curt, transactional, or flat.

Then produce an IMPROVED version that keeps EVERY fact, order number, tracking detail, date, amount, commitment and the operator's sign-off name IDENTICAL — only make the tone lavishly warm and friendly, with a delightful greeting and a warm closing. Today is ${dow}: use a weekend farewell (e.g. "have an amazing weekend!") ONLY if today is Friday, Saturday or Sunday; otherwise use a warm day/week farewell (e.g. "have a wonderful day!"). Keep it natural, not over-the-top-cheesy. Preserve emojis and line breaks.

Return ONLY minified JSON: {"score": <int 0-10>, "notes": "<one short sentence>", "improved": "<the full improved reply>"}.

REPLY:
${text}`;
    const res = await fetch('https://api.anthropic.com/v1/messages', { method:'POST', headers:{ 'Content-Type':'application/json', 'x-api-key':ANTHROPIC_KEY, 'anthropic-version':'2023-06-01' }, body: JSON.stringify({ model:'claude-haiku-4-5-20251001', max_tokens:1400, messages:[{ role:'user', content: prompt }] }) });
    const d = await res.json().catch(()=>({}));
    if (!res.ok) return json(200, { score: 10, improved: null, notes: 'check unavailable' });
    let t = ((d.content && d.content[0] && d.content[0].text) || '').replace(/```json/gi,'').replace(/```/g,'').trim();
    let parsed; try { parsed = JSON.parse(t); } catch { return json(200, { score: 10, improved: null, notes: 'parse fail' }); }
    return json(200, { score: Number(parsed.score), improved: parsed.improved || null, notes: parsed.notes || '' });
  } catch (e) { return json(200, { score: 10, improved: null, notes: String(e.message||e) }); }
};
