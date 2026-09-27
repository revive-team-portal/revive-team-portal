// Equipment watch: every 3 days (equip-watch-cron.js) check NZ second-hand /
// auction sites for upright freezers, blast chillers / freezer rooms and
// packaging machinery; email Jeremy only the NEW relevant listings.
//   ?k=<runkey>     manual run
//   ?dry=1          return JSON only (no DB writes, no email)
//   ?to=<email>     override recipient      ?only=thorntons,mainland   limit sites
// State: ads.equip_seen (Revive Apps). Log: ads.sync_log kind 'equip-watch'.
const { guard, DENY } = require('./_runkey');
const { fetchAll, isMatch } = require('./_equipwatch');
const { sendMail } = require('./_mail');
const { db, upsert, log } = require('./_adsdb');
const KEY = process.env.ANTHROPIC_API_KEY;
const TO = process.env.EQUIP_WATCH_TO || 'jeremy@revive.co.nz';
const MODEL = 'claude-haiku-4-5-20251001'; // cheap relevance filter

const BRIEF = `Jeremy runs a NZ plant-based food manufacturer (frozen waffles "Wopples" and frozen/chilled ready meals). He is watching second-hand and auction sites for production equipment. RELEVANT (answer yes):
- Upright / stand-up freezers of ANY size, commercial first but domestic upright freezers are acceptable (say "domestic" in the note). Solid or glass door. Includes upright dual-temp fridge/freezers only if the freezer section is substantial.
- Blast chillers, blast freezers, shock freezers, walk-in freezers, freezer rooms / cool rooms / cold-room panels and refrigeration units for them.
- Food packaging machinery: tray/heat/band/vacuum sealers, flow wrappers, labellers and label printers for packaging, date coders, bagging/filling machines, shrink wrappers, cartoners, checkweighers, metal detectors.
- An auction NOTICE (a whole sale) whose description suggests it contains the above (e.g. a food factory, cafe, bakery or restaurant liquidation).
In NZ trade listings a "chiller" is a FRIDGE: a title saying chiller with no mention of blast/shock/freezer/freezing is NOT relevant. Judge by the title's own words - do not guess that a plain fridge or chiller might be a freezer.
NOT relevant: chest freezers, undercounter/drawer units of any kind including dual-temp, ice-cream/display freezers, bar/undercounter/underbench freezers or fridges, fridges and chillers without freezing, display cabinets, packaging supplies/consumables (boxes, film, labels themselves), items merely "in original packaging", cars, furniture, tools, anything unrelated.`;

async function classify(items) {
  if (!items.length) return {};
  if (!KEY) throw new Error('missing ANTHROPIC_API_KEY');
  const out = {};
  for (let i = 0; i < items.length; i += 60) {
    const batch = items.slice(i, i + 60).map(x => ({ id: x.key, site: x.site, title: x.title, price: x.price, desc: (x.desc || '').slice(0, 250) }));
    const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 4000,
        system: BRIEF + '\n\nReturn ONLY a JSON array, no prose, no code fences: [{"id":"...","relevant":true|false,"category":"Upright freezer|Blast chiller / freezer room|Packaging machine|Auction notice|-","note":"<=12 words: size/brand/condition cue, or why not"}] - one entry per input item.',
        messages: [{ role: 'user', content: JSON.stringify(batch) }] }) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error('claude ' + res.status + ': ' + String((j.error && j.error.message) || '').slice(0, 200));
    const txt = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('').replace(/^[\s\S]*?\[/, '[').replace(/\][^\]]*$/, ']');
    let arr = []; try { arr = JSON.parse(txt); } catch (e) { throw new Error('bad classifier JSON: ' + txt.slice(0, 200)); }
    for (const r of arr) if (r && r.id) out[r.id] = r;
  }
  return out;
}

async function seenKeys() {
  const keys = new Set();
  for (let off = 0; off < 200000; off += 1000) {
    const rows = await db(`equip_seen?select=key&order=key&limit=1000&offset=${off}`);
    rows.forEach(r => keys.add(r.key));
    if (rows.length < 1000) break;
  }
  return keys;
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const nz = (iso) => iso ? new Date(iso).toLocaleString('en-NZ', { timeZone: 'Pacific/Auckland', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '';
const ORDER = ['Upright freezer', 'Blast chiller / freezer room', 'Packaging machine', 'Auction notice'];

function renderEmail(hits, runs) {
  const groups = {};
  hits.forEach(h => { const c = ORDER.includes(h.v.category) ? h.v.category : 'Other'; (groups[c] = groups[c] || []).push(h); });
  let html = `<p style="margin:0 0 12px">${hits.length} new listing${hits.length === 1 ? '' : 's'} matching your watch list (upright freezers, blast chillers / freezer rooms, packaging machinery - anywhere in NZ).</p>`;
  for (const cat of [...ORDER, 'Other']) {
    const g = groups[cat]; if (!g) continue;
    g.sort((a, b) => (a.i.closes_at ? Date.parse(a.i.closes_at) : 9e15) - (b.i.closes_at ? Date.parse(b.i.closes_at) : 9e15));
    html += `<h3 style="margin:18px 0 6px;font-size:15px">${esc(cat)} (${g.length})</h3><table cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:13px">`;
    for (const { i, v } of g) {
      html += `<tr style="border-top:1px solid #ddd;vertical-align:top">
<td style="width:130px">${i.image ? `<a href="${esc(i.url)}"><img src="${esc(i.image)}" width="120" style="width:120px;max-height:120px;object-fit:cover;border:1px solid #eee" alt=""></a>` : ''}</td>
<td><a href="${esc(i.url)}" style="font-weight:bold;color:#111">${esc(i.title)}</a><br>
<span style="color:#555">${esc(v.note || '')}</span><br>
<b>${esc(i.price || '')}</b>${i.closes_at ? ` &middot; closes ${esc(nz(i.closes_at))}` : ''}<br>
${esc(i.site)}${i.location ? ' &middot; ' + esc(i.location) : ''}<br>
<span style="color:#555">${esc(i.how || '')}</span></td></tr>`;
    }
    html += '</table>';
  }
  const bad = runs.filter(r => !r.ok);
  html += `<p style="color:#888;font-size:12px;margin-top:18px">Sites checked: ${runs.map(r => esc(r.site) + (r.ok ? ' (' + r.count + ')' : ' FAILED')).join(', ')}.` +
    (bad.length ? ' Failed: ' + bad.map(r => esc(r.site + ': ' + r.error)).join('; ') + '.' : '') +
    ' Not covered: Trade Me (no public feed), Turners, Grays NZ (site down). Prices are as at the time of checking - auction bids move. Generated by team.revive.co.nz equip-watch.</p>';
  return '<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#111;max-width:760px">' + html + '</div>';
}

exports.handler = async (event) => {
  if (!(await guard(event)).ok) return DENY;
  const qp = (event && event.queryStringParameters) || {};
  const dry = qp.dry === '1';
  try {
    const runs = await fetchAll(qp.only);
    const all = runs.flatMap(r => r.items);
    const matched = all.filter(isMatch);
    const seen = await seenKeys();
    const fresh = []; const dupe = new Set();
    for (const i of matched) { if (!seen.has(i.key) && !dupe.has(i.key)) { dupe.add(i.key); fresh.push(i); } }
    const verdicts = await classify(fresh);
    const hits = fresh.filter(i => verdicts[i.key] && verdicts[i.key].relevant).map(i => ({ i, v: verdicts[i.key] }));
    const summary = runs.map(r => ({ site: r.site, ok: r.ok, count: r.count, error: r.error, ms: r.ms }));
    if (dry) return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ summary, matched: matched.length, fresh: fresh.length, hits: hits.map(h => ({ ...h.i, verdict: h.v })) }) };

    let mail = null;
    if (hits.length) {
      const cats = [...new Set(hits.map(h => h.v.category))].filter(c => c && c !== '-').join(', ');
      mail = await sendMail({ to: qp.to || TO, subject: `Equipment watch: ${hits.length} new - ${cats}`.slice(0, 150), html: renderEmail(hits, runs),
        text: hits.map(h => `${h.i.title} | ${h.i.price} | ${h.i.site} | ${h.i.url}`).join('\n') });
    }
    const now = new Date().toISOString();
    await upsert('equip_seen', fresh.map(i => ({ key: i.key, site: i.site, title: (i.title || '').slice(0, 400), url: i.url, image: i.image, price: i.price,
      closes_at: i.closes_at, location: i.location, matched: true, relevant: !!(verdicts[i.key] && verdicts[i.key].relevant),
      verdict: verdicts[i.key] ? [verdicts[i.key].category, verdicts[i.key].note].filter(Boolean).join(' - ') : null,
      alerted_at: (mail && mail.ok && verdicts[i.key] && verdicts[i.key].relevant) ? now : null })), 'key');
    const failed = summary.filter(s => !s.ok);
    await log('equip-watch', failed.length < 3, { summary, matched: matched.length, fresh: fresh.length, hits: hits.length, mail });
    if (failed.length >= 3) {
      try { await sendMail({ to: TO, subject: 'Equipment watch: ' + failed.length + ' sites failing', html: '<p>' + failed.map(f => esc(f.site + ': ' + f.error)).join('<br>') + '</p>', text: JSON.stringify(failed) }); } catch (e) {}
    }
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, summary, matched: matched.length, fresh: fresh.length, hits: hits.length, mail }) };
  } catch (e) {
    console.error('equip-watch failed', e && e.message);
    await log('equip-watch', false, { error: String(e.message || e) });
    try { await sendMail({ to: TO, subject: 'Equipment watch FAILED', html: '<p>equip-watch-background error: ' + esc(e.message || e) + '</p>', text: String(e.message || e) }); } catch (e2) {}
    return { statusCode: 500, body: JSON.stringify({ error: String(e.message || e) }) };
  }
};
