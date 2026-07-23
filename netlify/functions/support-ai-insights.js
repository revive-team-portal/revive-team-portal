// AI commentary over a sample of the Gmail archive (last ~3 months): friendliness of our
// replies, customer happiness, issues-by-type, and an overall /10 score. Portal-gated (support).
const { json, validatePortalUser } = require('./_portal');
const { getAccessToken } = require('./_gmail');
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
async function gapi(token, path){ const r=await fetch('https://gmail.googleapis.com/gmail/v1/users/me/'+path,{headers:{Authorization:'Bearer '+token}}); return r.json().catch(()=>({})); }
async function sample(token, q, n){
  const list = await gapi(token, 'messages?maxResults='+n+'&q='+encodeURIComponent(q));
  const ids = (list.messages||[]).map(m=>m.id).slice(0,n);
  const out=[];
  for (let i=0;i<ids.length;i+=6){
    const batch = await Promise.all(ids.slice(i,i+6).map(id=>gapi(token,'messages/'+id+'?format=metadata&metadataHeaders=Subject')));
    for (const m of batch){ const h={}; ((m.payload&&m.payload.headers)||[]).forEach(x=>h[x.name.toLowerCase()]=x.value); out.push((h.subject||'')+' :: '+((m.snippet||'').replace(/\s+/g,' ').slice(0,200))); }
  }
  return out;
}

exports.handler = async (event) => {
  const a = await validatePortalUser(event, 'support');
  if (!a.ok) return json(a.status || 403, { error: a.error });
  if (!ANTHROPIC_KEY) return json(500, { error: 'AI not configured.' });
  const at = await getAccessToken('cafe');
  if (!at.ok) return json(400, { error: at.error });
  try {
    const [inbound, outbound] = await Promise.all([
      sample(at.access_token, 'to:cafe@revive.co.nz newer_than:3m', 18),
      sample(at.access_token, 'from:cafe@revive.co.nz newer_than:3m', 14),
    ]);
    const prompt = `You are a customer-experience analyst for Revive Café (NZ gluten-free food). Analyse these email samples from the last 3 months.

CUSTOMER EMAILS IN (${inbound.length}):
${inbound.map((x,i)=>(i+1)+'. '+x).join('\n')}

OUR REPLIES OUT (${outbound.length}):
${outbound.map((x,i)=>(i+1)+'. '+x).join('\n')}

Return ONLY minified JSON:
{"friendliness_out": <0-100>, "friendliness_comment": "<1 sentence>",
 "happiness_in": <0-100>, "happiness_comment": "<1 sentence>",
 "issues_by_type": [{"category":"<e.g. General enquiry / Order issue / Delivery / Product / Payment / Subscription>","subcategory":"<e.g. nutrition, website, discount code, late, missing item, damaged, change to order, refund>","count":<int>}],
 "performance_score": <0-10, one decimal>,
 "commentary": "<2-3 sentence overall assessment with one improvement suggestion>"}
Base issues_by_type only on the customer emails in; make counts reflect the sample.`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST', headers:{ 'Content-Type':'application/json', 'x-api-key':ANTHROPIC_KEY, 'anthropic-version':'2023-06-01' },
      body: JSON.stringify({ model:'claude-haiku-4-5-20251001', max_tokens:1200, messages:[{ role:'user', content: prompt }] }),
    });
    const d = await res.json().catch(()=>({}));
    if (!res.ok) return json(502, { error: (d&&d.error&&d.error.message)||'AI request failed.' });
    let txt = (d.content && d.content[0] && d.content[0].text) || '';
    txt = txt.replace(/```json/gi,'').replace(/```/g,'').trim();
    let parsed; try { parsed = JSON.parse(txt); } catch { return json(502, { error: 'Could not parse AI output.' }); }
    parsed.sampleIn = inbound.length; parsed.sampleOut = outbound.length;
    return json(200, parsed);
  } catch (e) { return json(502, { error: String(e.message || e) }); }
};
