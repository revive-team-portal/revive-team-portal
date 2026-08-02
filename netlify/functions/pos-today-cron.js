const { TODAY_SQL, queueJob } = require('./_posqueries');
exports.handler = async () => { try { const r = await queueJob('cafe-today', TODAY_SQL); return { statusCode: 200, body: JSON.stringify(r) }; } catch (e) { return { statusCode: 500, body: String(e) }; } };
