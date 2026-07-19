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
          batch_cost: +batch_cost.toFixed(3),
          packs_per_batch: +packs_per_batch.toFixed(1),
          cost_per_pack: packs_per_batch > 0 ? +(batch_cost / packs_per_batch).toFixed(3) : null,
          lines: mine.map(i => ({ ingredient: i.ingredient, batch_g: Number(i.batch_g), cost_per_kg: +effCost(i.ingredient, byName).toFixed(3) })),
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

    if (action === 'save_plan') {
      const { id, plan_date, flavour, planned_packs, notes } = body;
      if (!plan_date || !flavour) return json(400, { error: 'Missing date or flavour.' });
      const row = { plan_date, flavour, planned_packs: Number(planned_packs) || 0, notes: notes || null };
      if (id) {
        await appsDb('production_plan?id=eq.' + encodeURIComponent(id), { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(row) });
      } else {
        await appsDb('production_plan', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(row) });
      }
      return json(200, { ok: true });
    }

    if (action === 'delete_plan') {
      if (!body.id) return json(400, { error: 'Missing id.' });
      await appsDb('production_plan?id=eq.' + encodeURIComponent(body.id), { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      return json(200, { ok: true });
    }

    if (action === 'save_recipe_version') {
      const { base_recipe_id, sku, flavour, short_code, version_label, change_note, cook_sec, blend_min, viscosity_sec, g_per_waffle, ingredients } = body;
      if (!version_label || !change_note) return json(400, { error: 'Version label and change note are required.' });
      if (!Array.isArray(ingredients) || !ingredients.length) return json(400, { error: 'At least one ingredient is required.' });
      const created = await appsDb('recipe', {
        method: 'POST', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ sku, flavour, short_code: short_code || null, version_label, is_current: true, active: true,
          cook_sec: cook_sec || null, blend_min: blend_min || null, viscosity_sec: viscosity_sec || null,
          g_per_waffle: g_per_waffle || 70, change_note }),
      });
      const newId = created[0].id;
      const rows = ingredients
        .filter(i => i.ingredient && i.batch_g)
        .map((i, idx) => ({ recipe_id: newId, ingredient: String(i.ingredient).trim(), batch_g: Math.round(Number(i.batch_g)), sort: idx + 1 }));
      await appsDb('recipe_ingredient', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(rows) });
      if (base_recipe_id) {
        await appsDb('recipe?id=eq.' + encodeURIComponent(base_recipe_id), {
          method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ is_current: false, active: false }) });
      }
      return json(200, { ok: true, id: newId });
    }

    if (action === 'get_recipe_history') {
      const hist = await appsDb('recipe?select=id,version_label,change_note,created_at,created_by,is_current,active&sku=eq.' + encodeURIComponent(body.sku) + '&order=created_at.desc');
      return json(200, { history: hist });
    }

    return json(400, { error: 'Unknown action.' });
  } catch (e) {
    return json(502, { error: String(e.message || e).slice(0, 200) });
  }
};
