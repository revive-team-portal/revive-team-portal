// AI for Pulse: structured open-ended THEMES, or a whole-survey STRATEGIC overview.
// Pulse-access portal users only.
const { json, validatePortalUser } = require('./_portal');
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

async function callClaude(prompt, max_tokens) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version':'2023-06-01' },
    body: JSON.stringify({ model:'claude-haiku-4-5-20251001', max_tokens, messages:[{role:'user',content:prompt}] }),
  });
  const data = await res.json().catch(()=>({}));
  if (!res.ok) throw new Error((data.error&&data.error.message)||'AI request failed.');
  return (data.content&&data.content[0]&&data.content[0].text)||'';
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  if (!ANTHROPIC_KEY) return json(500, { error: 'Server not configured (ANTHROPIC_API_KEY).' });
  const auth = await validatePortalUser(event, 'pulse');
  if (!auth.ok) return json(auth.status || 403, { error: auth.error });
  let body; try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad body' }); }

  try {
    // ---- whole-survey strategic overview (markdown) ----
    if (body.digest) {
      const prompt = `You are a strategic research analyst for Revive (a NZ cafe & wholefoods brand). `
        + `Below are the full results of a survey titled "${(body.title||'').slice(0,200)}" (${body.n||0} responses).\n\n`
        + String(body.digest).slice(0, 12000)
        + `\n\nWrite a sharp, executive-level read in clean markdown with these sections (use ## headings):\n`
        + `## Top findings\nAn ordered list, most important first, each led by the numbers (cite key %/averages).\n`
        + `## Watch-outs\nRisks or negatives worth acting on.\n`
        + `## Recommendations\n3-5 concrete, prioritised actions.\nBe concise and strategic, not a data dump.`;
      return json(200, { text: await callClaude(prompt, 1400) });
    }

    // ---- per-question themes (structured JSON) ----
    const question = (body.question || '').slice(0, 500);
    const answers = (Array.isArray(body.answers) ? body.answers : []).filter(Boolean).slice(0, 400);
    if (!answers.length) return json(400, { error: 'No answers to summarise.' });
    const prompt = `Analyse these open-ended survey responses for Revive (a NZ cafe & food brand).\n`
      + `Question: "${question}"\nResponses (${answers.length}):\n`
      + answers.map((a,i)=>`${i+1}. ${String(a).slice(0,500)}`).join("\n")
      + `\n\nIdentify the main recurring themes. Respond with ONLY a JSON object (no markdown, no commentary) of exactly this shape:\n`
      + `{"summary":"one or two sentence overview of what people said","themes":[{"label":"short theme name","count":<approx number of responses expressing this theme>,"sentiment":"positive|negative|mixed|neutral","quote":"one short representative verbatim"}]}\n`
      + `Order themes by count descending. Counts should not exceed the number of responses. Max 8 themes. Keep labels 1-4 words.`;
    let raw = await callClaude(prompt, 1200);
    raw = raw.trim().replace(/^```(?:json)?/i,'').replace(/```$/,'').trim();
    let parsed; try { parsed = JSON.parse(raw); } catch { parsed = { summary:'', themes:[], raw }; }
    return json(200, parsed);
  } catch (e) {
    return json(502, { error: String(e.message||e) });
  }
};
