const { runNZPostAlertCheck } = require('./_nzpostalert');
exports.handler = async () => { try { const r=await runNZPostAlertCheck(); console.log('nzpost-alert',JSON.stringify(r)); return {statusCode:200,body:JSON.stringify(r)}; } catch(e){ return {statusCode:500,body:String(e)}; } };
