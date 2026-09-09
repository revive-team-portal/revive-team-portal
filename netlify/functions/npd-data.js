// NPD cost + NIP compute. Available to ANY production user (not supervisor-gated):
// returns aggregate cost/kg and NIP per 100g of finished product for a formulation,
// plus the same for a starting/source recipe — never exposes the per-ingredient price list.
const { json, validatePortalUser } = require('./_portal');
const APPS_URL = 'https://xcwrawjdfajlmbkdwlbm.supabase.co';
const APPS_KEY = process.env.APPS_SERVICE_ROLE_KEY;

async function db(path) {
  const res = await fetch(APPS_URL + '/rest/v1/' + path, {
    headers: { apikey: APPS_KEY, Authorization: 'Bearer ' + APPS_KEY,
      'Accept-Profile': 'production', 'Content-Type': 'application/json' } });
  const t = await res.text(); let d = null; try { d = t ? JSON.parse(t) : null; } catch { d = t; }
  if (!res.ok) throw new Error('DB ' + res.status);
  return d || [];
}
function effCost(name, cm) { const ic = cm[name]; if (!ic) return 0;
  if (ic.derived_from) return (Number((cm[ic.derived_from] || {}).cost_per_kg) || 0) * (Number(ic.derived_ratio) || 1);
  return Number(ic.cost_per_kg) || 0; }
const NKEYS = ['energy_kj','protein_g','fat_g','satfat_g','carb_g','sugar_g','fibre_g','sodium_mg'];
function computeOne(lines, cm, nm, moisture) {
  let totalG = 0, cost = 0; const nut = {}; NKEYS.forEach(k => nut[k] = 0);
  (lines || []).forEach(l => {
    const g = Number(l.grams != null ? l.grams : l.batch_g) || 0; if (!l.ingredient) return;
    totalG += g; cost += (g / 1000) * effCost(l.ingredient, cm);
    const n = nm[l.ingredient]; if (n) NKEYS.forEach(k => { nut[k] += (g / 100) * (Number(n[k]) || 0); });
  });
  const finished = totalG * (1 - (Number(moisture) || 0) / 100);
  const per100 = {}; NKEYS.forEach(k => per100[k] = finished > 0 ? +(nut[k] / (finished / 100)).toFixed(2) : 0);
  return { total_g: totalG, cost_per_kg: totalG > 0 ? +(cost / (totalG / 1000)).toFixed(3) : 0, nip: per100 };
}
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  if (!APPS_KEY) return json(500, { error: 'Server not configured.' });
  const auth = await validatePortalUser(event, 'production');
  if (!auth.ok) return json(auth.status || 403, { error: auth.error });
  let body; try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad request.' }); }
  try {
    if (body.action === 'compute') {
      const [costs, nuts] = await Promise.all([
        db('ingredient_cost?select=ingredient,cost_per_kg,derived_from,derived_ratio'),
        db('ingredient_nutrition?select=*') ]);
      const cm = {}; costs.forEach(c => cm[c.ingredient] = c);
      const nm = {}; nuts.forEach(n => nm[n.ingredient] = n);
      const moisture = body.moisture_pct != null ? body.moisture_pct : 40;
      const out = { new: computeOne(body.ingredients, cm, nm, moisture) };
      if (body.source_recipe_id) {
        const src = await db('recipe_ingredient?select=ingredient,batch_g&recipe_id=eq.' + encodeURIComponent(body.source_recipe_id));
        out.starting = computeOne(src, cm, nm, moisture);
      }
      return json(200, out);
    }
    if (body.action === 'recipe_nips') {
      const [recs, ings, nuts, rates] = await Promise.all([
        db('recipe?select=id,sku,flavour,version_label,g_per_waffle&active=eq.true&is_current=eq.true&order=sku'),
        db('recipe_ingredient?select=recipe_id,ingredient,batch_g'),
        db('ingredient_nutrition?select=*'),
        db('rate_setting?select=key,value') ]);
      const nm = {}; nuts.forEach(n => nm[n.ingredient] = n);
      const rk = {}; rates.forEach(r => rk[r.key] = Number(r.value));
      const moisture = rk.moisture_pct != null ? rk.moisture_pct : 40;
      const serves = rk.serves_per_pack != null ? rk.serves_per_pack : 4;
      const wops = rk.wopples_per_serving != null ? rk.wopples_per_serving : 2;
      const out = recs.map(r => {
        const lines = ings.filter(i => i.recipe_id === r.id).map(i => ({ ingredient: i.ingredient, grams: Number(i.batch_g) }));
        const c = computeOne(lines, {}, nm, moisture);
        const gpw = Number(r.g_per_waffle) || 70;
        const serving_g = Math.round(wops * gpw * (1 - moisture / 100));
        const f = serving_g / 100;
        const perServe = {}; NKEYS.forEach(k => perServe[k] = +(c.nip[k] * f).toFixed((k === 'energy_kj' || k === 'sodium_mg') ? 0 : 1));
        return { id: r.id, sku: r.sku, flavour: r.flavour, version_label: r.version_label, per100: c.nip, perServe, serving_g };
      });
      return json(200, { recipes: out, serves_per_pack: serves, wopples_per_serving: wops, moisture_pct: moisture });
    }
    return json(400, { error: 'Unknown action.' });
  } catch (e) { return json(502, { error: String(e.message || e).slice(0, 200) }); }
};
