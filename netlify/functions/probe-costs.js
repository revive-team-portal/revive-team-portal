// TEMPORARY. ?k=<runkey> — probe Shopify variant costs + TimeKeeper employee pay rates.
const { gql } = require('./_shopify');
const { guard } = require('./_runkey');
const TK_KEY=process.env.TIMEKEEPER_API_KEY;
function tkAuth(){return 'Basic '+Buffer.from(':'+(TK_KEY||'')).toString('base64');}
exports.handler=async(event)=>{
  if(!(await guard(event)).ok) return {statusCode:403,body:'nope'};
  const out={};
  try{
    const d=await gql('query{ orders(first:8, sortKey:CREATED_AT, reverse:true){ nodes{ name lineItems(first:30){ nodes{ quantity title variant{ inventoryItem{ unitCost{ amount } } } } } } } }');
    let lines=0,withCost=0,cogs=0;
    (d.orders.nodes||[]).forEach(o=>(o.lineItems.nodes||[]).forEach(li=>{ lines++; const c=li.variant&&li.variant.inventoryItem&&li.variant.inventoryItem.unitCost&&Number(li.variant.inventoryItem.unitCost.amount); if(c){withCost++; cogs+=c*(Number(li.quantity)||0);} }));
    out.shopify={sampleOrders:(d.orders.nodes||[]).length, lineItems:lines, withUnitCost:withCost, sampleCOGS:Math.round(cogs*100)/100,
      example:(d.orders.nodes[0]&&d.orders.nodes[0].lineItems.nodes[0])};
  }catch(e){ out.shopify_err=String(e.message||e); }
  try{
    const r=await fetch('https://api.timekeeper.co.uk/api/tk/v1/employees?page=1',{headers:{Authorization:tkAuth(),Accept:'application/json'}});
    const j=await r.json().catch(()=>({}));
    const box=j.employees||{}; const emp=(box.employees||[])[0];
    out.tk={status:r.status, total:box.total_pages, employeeFields: emp?Object.keys(emp):null, sample: emp};
  }catch(e){ out.tk_err=String(e.message||e); }
  return {statusCode:200,headers:{'Content-Type':'application/json','Cache-Control':'no-store'},body:JSON.stringify(out,null,1)};
};
