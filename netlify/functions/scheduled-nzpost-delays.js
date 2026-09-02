const { runNZPostDelayScan } = require('./_nzpostdelay');
exports.handler = async () => { try { const r=await runNZPostDelayScan(); console.log('nzpost-delays',JSON.stringify(r)); return {statusCode:200,body:JSON.stringify(r)}; } catch(e){ return {statusCode:500,body:String(e)}; } };
