// 14-day tracking: per day -> tickets received, resolved, and unresolved at 5pm (NZ). Portal-gated (support).
const { json, validatePortalUser } = require('./_portal');
const { rest, hasKey } = require('./_appsdb');
const TZ='Pacific/Auckland';
function nzParts(d){ const p=new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit',weekday:'short'}).formatToParts(d); const g=t=>p.find(x=>x.type===t).value; return { y:+g('year'), m:+g('month'), d:+g('day'), dow:g('weekday') }; }
function nzMidnight(y,m,d){ const guess=new Date(Date.UTC(y,m-1,d,0,0,0)); const asNZ=new Date(guess.toLocaleString('en-US',{timeZone:TZ})); const off=asNZ.getTime()-guess.getTime(); return new Date(guess.getTime()-off); }
function addDays(dt,n){ return new Date(dt.getTime()+n*86400000); }
function ord(d){ if(d>3&&d<21) return d+'th'; switch(d%10){ case 1:return d+'st'; case 2:return d+'nd'; case 3:return d+'rd'; default:return d+'th'; } }

exports.handler = async (event) => {
  const a = await validatePortalUser(event, 'support');
  if (!a.ok) return json(a.status || 403, { error: a.error });
  if (!hasKey()) return json(500, { error: 'Not configured.' });
  try {
    const tickets = await rest('tickets?select=created_at,resolved_at,excluded&limit=20000');
    const T=(tickets||[]).map(t=>({ c: t.created_at?+new Date(t.created_at):null, r: t.resolved_at?+new Date(t.resolved_at):null, x: !!t.excluded }));
    const now=new Date(); const nowMs=now.getTime(); const tn=nzParts(now); const todayMid=nzMidnight(tn.y,tn.m,tn.d);
    const days=[];
    for(let i=13;i>=0;i--){
      const mid=addDays(todayMid,-i); const pp=nzParts(mid);
      const dayStart=+mid, dayEnd=+addDays(mid,1), fivePM=mid.getTime()+17*3600000;
      const asOf = fivePM<=nowMs ? fivePM : nowMs;
      let received=0, resolved=0, unresolved=0;
      for(const t of T){
        if(!t.x && t.c!=null && t.c>=dayStart && t.c<dayEnd) received++;
        if(!t.x && t.r!=null && t.r>=dayStart && t.r<dayEnd) resolved++;
        if(t.c!=null && t.c<=asOf && (t.r==null || t.r>asOf)) unresolved++;
      }
      days.push({ label: pp.dow+' '+ord(pp.d), received, resolved, unresolved, isToday: i===0 });
    }
    return json(200, { days });
  } catch (e) { return json(502, { error: String(e.message || e) }); }
};
