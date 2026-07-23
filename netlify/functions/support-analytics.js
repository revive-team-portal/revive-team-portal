// Daily/weekly scorecard for the dashboard analytics bar. NZ-timezone aware.
// Metrics vs editable targets, colour-coded. Portal-gated (support).
const { json, validatePortalUser } = require('./_portal');
const { rest, hasKey } = require('./_appsdb');
const { gql } = require('./_shopify');
const TZ = 'Pacific/Auckland';

function nzParts(d){
  const p=new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit',weekday:'short'}).formatToParts(d);
  const g=t=>p.find(x=>x.type===t).value;
  return { y:+g('year'), m:+g('month'), d:+g('day'), dow:g('weekday') };
}
// NZ local midnight of y-m-d, returned as a UTC Date instant.
function nzMidnight(y,m,d){
  const guess=new Date(Date.UTC(y,m-1,d,0,0,0));
  const asNZ=new Date(guess.toLocaleString('en-US',{timeZone:TZ}));
  const offset=asNZ.getTime()-guess.getTime();
  return new Date(guess.getTime()-offset);
}
function addDays(dt,n){ return new Date(dt.getTime()+n*86400000); }
function isoDate(dt){ return dt.toISOString().slice(0,10); }
function median(a){ if(!a.length) return null; const s=a.slice().sort((x,y)=>x-y); const m=Math.floor(s.length/2); return s.length%2?s[m]:(s[m-1]+s[m])/2; }
function fmtDur(h){ if(h==null) return '—'; if(h<1) return Math.round(h*60)+'m'; if(h<48) return (Math.round(h*10)/10)+'h'; return (Math.round(h/24*10)/10)+'d'; }

function period(key){
  const now=new Date(); const n=nzParts(now);
  const todayMid=nzMidnight(n.y,n.m,n.d);
  const dowIdx={Sun:0,Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6}[n.dow];
  let start, end=now, label;
  if(key==='today'){ start=todayMid; label='Today'; }
  else if(key==='yesterday'){ start=addDays(todayMid,-1); end=todayMid; label='Yesterday'; }
  else if(key==='mtd'){ start=nzMidnight(n.y,n.m,1); label='Month to date'; }
  else if(key==='last7'){ start=addDays(todayMid,-6); label='Last 7 days'; }
  else if(key==='last30'){ start=addDays(todayMid,-29); label='Last 30 days'; }
  else if(key==='lifetime'){ start=new Date('2000-01-01'); label='Lifetime'; }
  else if(key==='lastweek'){ const mondayThis=addDays(todayMid,-((dowIdx+6)%7)); start=addDays(mondayThis,-7); end=addDays(mondayThis,-2); /* prev Mon..Fri end */ end=addDays(mondayThis,-2); label='Last week'; end=addDays(start,5); }
  else { // wtd — this week to date (Mon start, ends Friday)
    const mondayThis=addDays(todayMid,-((dowIdx+6)%7)); start=mondayThis;
    const fridayEnd=addDays(mondayThis,5); // Sat 00:00 = end of Fri
    end = now<fridayEnd ? now : fridayEnd; label='This week to date';
  }
  return { start, end, label, key };
}
function workingDays(start,end,excludeWeekends){
  let days=0; let cur=new Date(start);
  const endMs=end.getTime();
  // iterate calendar days
  cur=new Date(Date.UTC(cur.getUTCFullYear(),cur.getUTCMonth(),cur.getUTCDate()));
  while(cur.getTime()<endMs){
    const p=nzParts(cur); const dow=p.dow;
    if(!excludeWeekends || (dow!=='Sat'&&dow!=='Sun')) days++;
    cur=addDays(cur,1);
  }
  return Math.max(days,1);
}

exports.handler = async (event) => {
  const a = await validatePortalUser(event, 'support');
  if (!a.ok) return json(a.status || 403, { error: a.error });
  if (!hasKey()) return json(500, { error: 'Not configured.' });
  let body; try { body = JSON.parse(event.body||'{}'); } catch { body={}; }
  const P = period(body.period||'wtd');
  const excludeWeekends = !!body.excludeWeekends;
  const days = workingDays(P.start, P.end, excludeWeekends);
  const S=P.start.toISOString(), E=P.end.toISOString();

  // targets
  let T={ resolved_per_day:8, outstanding_max:15, fulfilled_per_day:30, resends_per_day:1, response_hours:4 };
  try { const rows=await rest('settings?select=value&key=eq.analytics_targets'); if(rows&&rows[0]&&rows[0].value){ T=Object.assign(T, JSON.parse(rows[0].value)); } } catch(e){}

  try {
    const [inPeriod, resolvedRows, outstandingRows, resendRows] = await Promise.all([
      rest('tickets?created_at=gte.'+S+'&created_at=lte.'+E+'&select=id,messages(direction,sent_at)&limit=3000'),
      rest('tickets?resolved_at=gte.'+S+'&resolved_at=lte.'+E+'&select=id&limit=3000'),
      rest('tickets?status=neq.Resolved&select=id&limit=3000'),
      rest('claims?created_at=gte.'+S+'&created_at=lte.'+E+'&select=id&limit=3000'),
    ]);
    const newTickets=(inPeriod||[]).length;
    const resolved=(resolvedRows||[]).length;
    const outstanding=(outstandingRows||[]).length;
    const resends=(resendRows||[]).length;
    const frt=[];
    for(const t of (inPeriod||[])){ const ms=t.messages||[]; const ins=ms.filter(m=>m.direction==='inbound'&&m.sent_at).map(m=>+new Date(m.sent_at)).sort((x,y)=>x-y); const outs=ms.filter(m=>m.direction==='outbound'&&m.sent_at).map(m=>+new Date(m.sent_at)).sort((x,y)=>x-y); if(ins.length&&outs.length){ const fo=outs.find(o=>o>=ins[0]); if(fo) frt.push((fo-ins[0])/3600000); } }
    const respH=median(frt);

    // Shopify: orders fulfilled (by order date within period)
    let fulfilled=0, capped=false;
    try { let after=null,pages=0; const q='created_at:>='+isoDate(P.start)+' created_at:<='+isoDate(P.end)+' fulfillment_status:fulfilled';
      while(pages<3){ const d=await gql('query($q:String!,$after:String){ orders(first:100, query:$q, after:$after){ pageInfo{ hasNextPage endCursor } edges{ node{ id } } } }',{q,after}); const c=d.orders; fulfilled+=(c.edges||[]).length; pages++; if(!c.pageInfo.hasNextPage) break; after=c.pageInfo.endCursor; if(pages>=3&&c.pageInfo.hasNextPage) capped=true; } } catch(e){}

    const hiStatus=(v,tg)=> v>=tg?'good':(v>=0.6*tg?'ok':'bad');
    const loLevel=(v,tg)=> v<=tg?'good':(v<=1.5*tg?'ok':'bad');
    const loFlow=(v,tg)=> v<=tg?'good':(v<=1.75*tg?'ok':'bad');
    const tgtResolved=Math.round(T.resolved_per_day*days), tgtFulfilled=Math.round(T.fulfilled_per_day*days), tgtResends=Math.round(T.resends_per_day*days);

    const metrics=[
      { key:'new', label:'New tickets', value:String(newTickets), target:'', status:'ok' },
      { key:'resolved', label:'Resolved', value:String(resolved), target:'≥ '+tgtResolved, status:hiStatus(resolved,tgtResolved) },
      { key:'outstanding', label:'Outstanding', value:String(outstanding), target:'≤ '+T.outstanding_max, status:loLevel(outstanding,T.outstanding_max) },
      { key:'fulfilled', label:'Fulfilled', value:String(fulfilled)+(capped?'+':''), target:'≥ '+tgtFulfilled, status:hiStatus(fulfilled,tgtFulfilled) },
      { key:'resends', label:'Resends', value:String(resends), target:'≤ '+tgtResends, status:loFlow(resends,tgtResends) },
      { key:'response', label:'1st response', value:fmtDur(respH), target:'≤ '+T.response_hours+'h', status: respH==null?'ok':(respH<=T.response_hours?'good':(respH<=1.5*T.response_hours?'ok':'bad')) },
    ];
    return json(200, { period:{ label:P.label, days, excludeWeekends }, metrics });
  } catch (e) { return json(502, { error: String(e.message || e) }); }
};
