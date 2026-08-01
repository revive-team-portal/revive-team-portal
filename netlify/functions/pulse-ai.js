// AI summariser for Pulse open-ended answers. Serves logged-in portal users with pulse access.
const { json, validatePortalUser } = require('./_portal');
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  if (!ANTHROPIC_KEY) return json(500, { error: 'Server not configured (ANTHROPIC_API_KEY).' });
  const auth = await validatePortalUser(event, 'pulse');
  if (!auth.ok) return json(auth.status || 403, { error: auth.error });

  let body; try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad body' }); }
  const question = (body.question || '').slice(0, 500);
  const answers = (Array.isArray(body.answers) ? body.answers : []).filter(Boolean).slice(0, 400);
  if (!answers.length) return json(400, { error: 'No answers to summarise.' });

  const prompt = `You are analysing open-ended survey responses for a New Zealand cafe & food company (Revive).\n`
    + `Question: "${question}"\n\nResponses (${answers.length}):\n`
    + answers.map((a,i)=>`${i+1}. ${String(a).slice(0,600)}`).join("\n")
    + `\n\nGive a tight analysis: 3-6 key themes (each with rough frequency), notable positives, notable issues to act on, and one or two representative quotes. Use short markdown. Be specific and practical.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version':'2023-06-01' },
    body: JSON.stringify({ model:'claude-haiku-4-5-20251001', max_tokens: 1024, messages:[{role:'user',content:prompt}] }),
  });
  const data = await res.json().catch(()=>({}));
  if (!res.ok) return json(502, { error: (data.error&&data.error.message)||'AI request failed.' });
  return json(200, { text: (data.content&&data.content[0]&&data.content[0].text)||'' });
};
