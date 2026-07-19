// Supervisor-only data API for the Production app: reads/writes pricing, rates, and
// computes recipe costs. Browser sessions are RLS-denied the pricing tables, so all
// cost data flows through here after a server-side supervisor check.

const { json, validatePortalUser } = require('./_portal');

const APPS_URL   = 'https://xcwrawjdfajlmbkdwlbm.supabase.co';
const APPS_KEY   = process.env.APPS_SERVICE_ROLE_KEY;
const PORTAL_URL = 'https://zpcbtfdjcsbdeqnizrpr.supabase.co';
const PORTAL_KEY = process.env.PORTAL_SERVICE_ROLE_KEY;

async function appsDb(path, opts = {}) {
  const headers = {
    apikey: APPS_KEY, Authorization: 'Bearer ' + APPS_KEY, 'Content-Type': 'application/json',
    'Accept-Profile': 'production', 'Content-Profile': 'production', ...(opts.headers || {}),
  };
  const res = await fetch(APPS_URL + '/rest/v1/' + path, { ...opts, headers });
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error('DB ' + res.status + ': ' + (typeof data === 'string' ? data : JSON.stringify(data)).slice(0, 200));
  return data;
}

async function isSupervisor(userId) {
  const p = await fetch(PORTAL_URL + '/rest/v1/profiles?id=eq.' + userId + '&select=is_admin', {
    headers: { apikey: PORTAL_KEY, Authorization: 'Bearer ' + PORTAL_KEY },
  }).then(r => r.json()).catch(() => []);
  if (p && p[0] && p[0].is_admin) return true;
  const a = await fetch(PORTAL_URL + '/rest/v1/user_app_access?user_id=eq.' + userId + '&app_id=eq.production&select=role', {
    headers: { apikey: PORTAL_KEY, Authorization: 'Bearer ' + PORTAL_KEY },
  }).then(r => r.json()).catch(() => []);
  return !!(a && a[0] && a[0].role === 'supervisor');
}

// effective cost/kg for an ingredient (resolves derived ingredients like cooked chickpeas)
function effCost(name, byName) {
  const ic = byName[name];
  if (!ic) return 0;
  if (ic.derived_from) return (Number((byName[ic.derived_from] || {}).cost_per_kg) || 0) * (Number(ic.derived_ratio) || 1);
  return Number(ic.cost_per_kg) || 0;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  if (!APPS_KEY || !PORTAL_KEY) return json(500, { error: 'Server not configured.' });

  const auth = await validatePortalUser(event, 'production');
  if (!auth.ok) return json(auth.status || 403, { error: auth.error });
  if (!(await isSupervisor(auth.user.id))) return json(403, { error: 'Supervisor access required.' });

  let body; try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad request.' }); }
  const action = body.action;

  try {
    if (action === 'get_pricing') {
      const [ingredients, rates] = await Promise.all([
        appsDb('ingredient_cost?select=*&order=ingredient'),
        appsDb('rate_setting?select=*&order=key'),
      ]);
      return json(200, { ingredients, rates });
    }

    if (action === 'get_recipe_costs') {
      const [recipes, ings, costs] = await Promise.all([
        appsDb('recipe?select=id,sku,flavour,version_label,g_per_waffle&order=sku'),
        appsDb('recipe_ingredient?select=recipe_id,ingredient,batch_g'),
        appsDb('ingredient_cost?select=ingredient,cost_per_kg,derived_from,derived_ratio'),
      ]);
      const byName = {}; costs.forEach(c => { byName[c.ingredient] = c; });
      const out = recipes.map(r => {
        const mine = ings.filter(i => i.recipe_id === r.id);
        const batch_g = mine.reduce((s, i) => s + Number(i.batch_g), 0);
        const batch_cost = mine.reduce((s, i) => s + (Number(i.batch_g) / 1000) * effCost(i.ingredient, byName), 0);
        const gpw = Number(r.g_per_waffle) || 70;
        const packs_per_batch = batch_g / gpw / 8;
        return {
          id: r.id, flavour: r.flavour, version_label: r.version_label,
          batch_cost: +batch_cost.toFixed(2),
          packs_per_batch: +packs_per_batch.toFixed(1),
          cost_per_pack: packs_per_batch > 0 ? +(batch_cost / packs_per_batch).toFixed(3) : null,
          lines: mine.map(i => ({ ingredient: i.ingredient, batch_g: Number(i.batch_g), cost_per_kg: +effCost(i.ingredient, byName).toFixed(4) })),
        };
      });
      return json(200, { recipes: out });
    }

    if (action === 'save_ingredient') {
      const { ingredient, cost_per_kg, supplier, unit_size_kg } = body;
      if (!ingredient) return json(400, { error: 'Missing ingredient.' });
      const patch = {};
      if (cost_per_kg !== undefined && cost_per_kg !== null && cost_per_kg !== '') patch.cost_per_kg = Number(cost_per_kg);
      if (supplier !== undefined) patch.supplier = supplier || null;
      if (unit_size_kg !== undefined) patch.unit_size_kg = (unit_size_kg === '' || unit_size_kg === null) ? null : Number(unit_size_kg);
      await appsDb('ingredient_cost?ingredient=eq.' + encodeURIComponent(ingredient), {
        method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch),
      });
      return json(200, { ok: true });
    }

    if (action === 'save_rate') {
      const { key, value } = body;
      if (!key) return json(400, { error: 'Missing key.' });
      await appsDb('rate_setting?key=eq.' + encodeURIComponent(key), {
        method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ value: Number(value) }),
      });
      return json(200, { ok: true });
    }

    return json(400, { error: 'Unknown action.' });
  } catch (e) {
    return json(502, { error: String(e.message || e).slice(0, 200) });
  }
};
