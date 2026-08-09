// Read-only Meta budget/pacing config dump. ?k=rvp-tk-7Kq3
// Shows account spend cap, campaign + ad set budgets, bid strategy, pacing and
// dayparting schedules — the settings that govern how much Meta can spend in a day.
const GUARD = 'rvp-tk-7Kq3';
const GRAPH = 'https://graph.facebook.com/v21.0';
const TOKEN = process.env.META_ACCESS_TOKEN;
const ACCT = process.env.META_AD_ACCOUNT || 'act_242089740673955';

async function g(path, fields, extra) {
  if (!TOKEN) throw new Error('missing META_ACCESS_TOKEN');
  let url = GRAPH + '/' + path + '?fields=' + encodeURIComponent(fields) + (extra || '') + '&limit=200&access_token=' + encodeURIComponent(TOKEN);
  const all = [];
  for (let i = 0; i < 20 && url; i++) {
    const r = await fetch(url); const j = await r.json().catch(() => ({}));
    if (j.error) throw new Error('Meta ' + String(j.error.message || '').slice(0, 200));
    if (!j.data) return j;
    j.data.forEach(x => all.push(x));
    url = (j.paging && j.paging.next) ? j.paging.next : null;
  }
  return all;
}
const money = (v) => v == null ? null : Math.round(Number(v)) / 100;

exports.handler = async (event) => {
  const qp = (event && event.queryStringParameters) || {};
  if (qp.k !== GUARD) return { statusCode: 403, body: 'nope' };
  try {
    const [acct, camps, sets] = await Promise.all([
      g(ACCT, 'name,currency,timezone_name,spend_cap,amount_spent,balance,account_status,disable_reason,adtrust_dsl,is_prepay_account,funding_source_details,min_daily_budget'),
      g(ACCT + '/campaigns', 'name,status,effective_status,objective,buying_type,bid_strategy,daily_budget,lifetime_budget,budget_remaining,spend_cap,start_time,stop_time,budget_rebalance_flag', '&effective_status=' + encodeURIComponent(JSON.stringify(['ACTIVE', 'PAUSED']))),
      g(ACCT + '/adsets', 'name,status,effective_status,campaign_id,daily_budget,lifetime_budget,budget_remaining,bid_strategy,bid_amount,billing_event,optimization_goal,pacing_type,start_time,end_time,adset_schedule,attribution_spec', '&effective_status=' + encodeURIComponent(JSON.stringify(['ACTIVE', 'PAUSED']))),
    ]);
    const clean = (x) => ({ ...x, daily_budget: money(x.daily_budget), lifetime_budget: money(x.lifetime_budget), budget_remaining: money(x.budget_remaining), spend_cap: money(x.spend_cap) });
    return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ account: { ...acct, spend_cap: money(acct.spend_cap), amount_spent: money(acct.amount_spent), balance: money(acct.balance) },
        campaigns: camps.map(clean), adsets: sets.map(clean) }, null, 1) };
  } catch (e) { return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: String(e.message || e) }) }; }
};
