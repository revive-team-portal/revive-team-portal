const GRAPH='https://graph.facebook.com/v21.0';const TOKEN=process.env.META_ACCESS_TOKEN;
const ACCT=process.env.META_AD_ACCOUNT||'act_242089740673955';const GUARD='30a0af1fcbdfaec3871731e4fa0dd0dc';
exports.handler=async(e)=>{const q=(e&&e.queryStringParameters)||{};
 if(q.k!==GUARD)return{statusCode:403,body:'nope'};if(!TOKEN)return{statusCode:500,body:'{"error":"no token"}'};
 const p=String(q.path||ACCT);if(!/^(act_\d+|\d+)(\/[a-z_]+)?$/.test(p))return{statusCode:400,body:'{"error":"bad path"}'};
 let url=GRAPH+'/'+p+'?'+String(q.q||'')+'&limit=100&access_token='+encodeURIComponent(TOKEN);
 const all=[];let meta=null;
 try{for(let i=0;i<15&&url;i++){const r=await fetch(url);const j=await r.json().catch(()=>({}));
  if(j.error)return{statusCode:200,headers:{'Content-Type':'application/json'},body:JSON.stringify({error:j.error.message})};
  if(!j.data){meta=j;break;}j.data.forEach(x=>all.push(x));url=(j.paging&&j.paging.next)?j.paging.next:null;}}
 catch(err){return{statusCode:500,body:JSON.stringify({error:String(err.message||err)})};}
 return{statusCode:200,headers:{'Content-Type':'application/json'},body:JSON.stringify(meta||{n:all.length,data:all})};};
