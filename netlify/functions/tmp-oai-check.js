// TEMP read-only proxy: GET OpenAI Ads API path, or Shopify chatgpt orders. Delete after use.
const KEY='cg6Lw2mbEHJvER5fxTo7XYyk4ka2'; const { gql } = require('./_shopify');
exports.handler = async (event) => {
  const qp=(event&&event.queryStringParameters)||{}; if(qp.k!==KEY) return {statusCode:403,body:'nope'};
  try{
    if(qp.shop){
      const q='query($q:String!){orders(first:100,query:$q,sortKey:CREATED_AT){nodes{name createdAt totalPriceSet{shopMoney{amount}} customerJourneySummary{customerOrderIndex firstVisit{source utmParameters{source medium campaign}} lastVisit{source landingPage utmParameters{source medium campaign}}}}}}';
      const d=await gql(q,{q:'created_at:>=2026-09-10T00:00:00+12:00 -status:cancelled'});
      const hit=d.orders.nodes.filter(o=>JSON.stringify(o).toLowerCase().includes('chatgpt')||JSON.stringify(o).toLowerCase().includes('openai')||JSON.stringify(o).includes('lp006'));
      return {statusCode:200,body:JSON.stringify({total:d.orders.nodes.length,hits:hit})};
    }
    const r=await fetch('https://api.ads.openai.com/v1'+qp.p,{headers:{Authorization:'Bearer '+process.env.OPENAI_ADS_API_KEY}});
    return {statusCode:200,headers:{'Content-Type':'application/json'},body:JSON.stringify({status:r.status,body:await r.text()})};
  }catch(e){return {statusCode:500,body:String(e.message||e)};}
};
