const { runSpamCheck } = require('./_spamcheck');
exports.handler = async () => { try { const r=await runSpamCheck(); console.log('spam-check',JSON.stringify(r)); return { statusCode:200, body:JSON.stringify(r) }; } catch(e){ return { statusCode:500, body:String(e) }; } };
