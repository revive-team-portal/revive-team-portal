// AI for Pulse: per-question summary OR whole-survey strategic overview. Pulse-access users only.
const { json, validatePortalUser } = require('./_portal');
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  if (!ANTHROPIC_KEY) return json(500, { error: 'Server not configured (ANTHROPIC_API_KEY).' });
  const auth = await validatePortalUser(event, 'pulse');
  if (!auth.ok) return json(auth.status || 403, { error: auth.error });

  let body; try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad body' }); }

  let prompt;
  if (body.digest) {
    prompt = `You are a strategic research analyst for Revive (a NZ cafe & wholefoods brand). `
      + `Below are the full results of a survey titled "${(body.title||'').slice(0,200)}" (${body.n||0} responses).\n\n`
      + String(body.digest).slice(0, 12000)
      + `\n\nGive a sharp, executive-level read in markdown:\n`
      + `**Top findings** — an ordered list, most important first, LED BY THE NUMBERS (cite the key percentages/averages).\n`
      + `**Watch-outs** — risks or negatives worth acting on.\n`
      + `**Recommendations** — 3-5 concrete, prioritised actions.\n`
      + `Be concise and strategic, not a data dump.`;
  } else {
    const question = (body.question || '').slice(0, 500);
    const answers = (Array.isArray(body.answers) ? body.answers : []).filter(Boolean).slice(0, 400);
    if (!answers.length) return json(400, { error: 'No answers to summarise.' });
    prompt = `Analyse open-ended survey responses for Revive (NZ cafe & food brand).\nQuestion: "${question}"\n\nResponses (${answers.length}):\n`
      + answers.map((a,i)=>`${i+1}. ${String(a).slice(0,600)}`).join("\n")
      + `\n\nGive a tight analysis: 3-6 key themes (with rough frequency), notable positives, issues to act on, and 1-2 representative quotes. Short markdown, specific and practical.`;
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version':'2023-06-01' },
    body: JSON.stringify({ model:'claude-haiku-4-5-20251001', max_tokens: 1400, messages:[{role:'user',content:prompt}] }),
  });
  const data = await res.json().catch(()=>({}));
  if (!res.ok) return json(502, { error: (data.error&&data.error.message)||'AI request failed.' });
  return json(200, { text: (data.content&&data.content[0]&&data.content[0].text)||'' });
};
