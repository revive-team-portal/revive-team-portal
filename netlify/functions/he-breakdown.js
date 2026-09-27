// TEMPORARY. ?k=<runkey> — break down Heat&Eat + Muesli units for a week to spot miscounts.
const { gql } = require('./_shopify');
const { guard } = require('./_runkey');
function nzDate(iso){return new Intl.DateTimeFormat('en-CA',{timeZone:'Pacific/Auckland',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(iso));}
function weekEndFri(ymd){const d=new Date(ymd+'T00:00:00Z');const add=(5-d.getUTCDay()+7)%7;d.setUTCDate(d.getUTCDate()+add);return d.toISOString().slice(0,10);}
function mpu(t){const m=/\((\d+)\s*items?/i.exec(t||'');return m?Math.max(1,parseInt(m[1],10)):1;}
exports.handler=async(event)=>{
  if(!(await guard(event)).ok) return {statusCode:403,body:'nope'};
  const qp=(event&&event.queryStringParameters)||{}; const start=qp.start||'2026-09-19', end=qp.end||'2026-09-25';
  const Q=`query($q:String!,$after:String){ orders(first:100, query:$q, after:$after){ pageInfo{ hasNextPage endCursor } nodes{ createdAt lineItems(first:50){ nodes{ quantity title product{ productType } } } } } }`;
  let after=null, byType={}, meals={}, muesli={};
  for(let g=0;g<60;g++){
    const d=await gql(Q,{q:`created_at:>='${start}T00:00:00Z' created_at:<='${end}T23:59:59Z'`,after});
    const o=d&&d.orders; if(!o) break;
    for(const ord of o.nodes){ const we=weekEndFri(nzDate(ord.createdAt)); if(we<start||we>end) continue;
      for(const li of ord.lineItems.nodes){ const pt=li.product&&li.product.productType||'(none)'; const q=Number(li.quantity)||0;
        byType[pt]=(byType[pt]||0)+q;
        if(pt==='Reheat'||pt==='Heat & Eat Meals'){ const k=li.title+' [x'+mpu(li.title)+']'; meals[k]=(meals[k]||0)+q*mpu(li.title); }
        if(pt==='Mueslis'){ const k=li.title+' [x'+mpu(li.title)+']'; muesli[k]=(muesli[k]||0)+q*mpu(li.title); }
      } }
    if(!o.pageInfo.hasNextPage) break; after=o.pageInfo.endCursor;
  }
  const sum=o=>Object.values(o).reduce((a,b)=>a+b,0);
  return {statusCode:200,headers:{'Content-Type':'application/json','Cache-Control':'no-store'},
    body:JSON.stringify({unitsByProductType:byType, mealsTotal:sum(meals), meals, muesliTotal:sum(muesli), muesli},null,1)};
};
