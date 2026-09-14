// TEMP read-only: Meta daily purchases by attribution window + Shopify orders by source. Delete after use.
const GRAPH = 'https://graph.facebook.com/v21.0';
const TOKEN = process.env.META_ACCESS_TOKEN;
const ACCT = process.env.META_AD_ACCOUNT || 'act_242089740673955';
const KEY = 'cg6Lw2mbEHJvER5fxTo7XYyk4ka2';
const { gql } = require('./_shopify');
const PT = ['omni_purchase','purchase','offsite_conversion.fb_pixel_purchase'];
function pick(arr, win){ for (const t of PT){ const a=(arr||[]).find(x=>x.action_type===t); if(a && a[win]!=null) return Number(a[win]); } return 0; }
async function meta(level, since, until){
  let url = GRAPH+'/'+ACCT+'/insights?level='+level+'&fields='+encodeURIComponent('date_start,campaign_name,spend,impressions,clicks,actions,action_values')
   +'&action_attribution_windows='+encodeURIComponent('1d_click,7d_click,1d_view')
   +'&time_increment=1&time_range='+encodeURIComponent(JSON.stringify({since,until}))+'&limit=200&access_token='+encodeURIComponent(TOKEN);
  const out=[]; for(let i=0;i<10&&url;i++){ const r=await fetch(url); const j=await r.json(); if(j.error) throw new Error('Meta '+j.error.message); (j.data||[]).forEach(x=>out.push(x)); url=j.paging&&j.paging.next; }
  return out.map(r=>({date:r.date_start, campaign:r.campaign_name, spend:+r.spend, imp:+r.impressions, clicks:+r.clicks,
    p_1dc:pick(r.actions,'1d_click'), p_7dc:pick(r.actions,'7d_click'), p_1dv:pick(r.actions,'1d_view'), p_default:pick(r.actions,'value'),
    v_1dc:pick(r.action_values,'1d_click'), v_7dc:pick(r.action_values,'7d_click'), v_1dv:pick(r.action_values,'1d_view'), v_default:pick(r.action_values,'value')}));
}
async function shop(sinceIso){
  const q='query($q:String!,$c:String){orders(first:100,query:$q,after:$c,sortKey:CREATED_AT){pageInfo{hasNextPage endCursor} nodes{name createdAt totalPriceSet{shopMoney{amount}} discountCodes sourceName customerJourneySummary{momentsCount firstVisit{source sourceType referrerUrl utmParameters{source medium campaign}} lastVisit{source sourceType referrerUrl utmParameters{source medium campaign}}} lineItems(first:30){nodes{quantity title}}}}}';
  let c=null, out=[]; for(let i=0;i<5;i++){ const d=await gql(q,{q:'created_at:>='+sinceIso+' -status:cancelled',c}); out.push(...d.orders.nodes); if(!d.orders.pageInfo.hasNextPage) break; c=d.orders.pageInfo.endCursor; }
  return out;
}
exports.handler = async (event) => {
  const qp=(event&&event.queryStringParameters)||{};
  if(qp.k!==KEY) return {statusCode:403,body:'nope'};
  try{
    const [acct,camps,acctInfo,orders]=await Promise.all([meta('account',qp.since,qp.until),meta('campaign',qp.since,qp.until),
      fetch(GRAPH+'/'+ACCT+'?fields=timezone_name,currency&access_token='+encodeURIComponent(TOKEN)).then(r=>r.json()), shop(qp.shopsince)]);
    return {statusCode:200,headers:{'Content-Type':'application/json','Cache-Control':'no-store'},body:JSON.stringify({acctInfo,account:acct,campaigns:camps,orders})};
  }catch(e){ return {statusCode:500,body:String(e.message||e)}; }
};
