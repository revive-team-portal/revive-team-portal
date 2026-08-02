const { WEEKLY_SQL, queueJob } = require('./_posqueries');
exports.handler = async () => { try { const r = await queueJob('weekly-feed', WEEKLY_SQL); return { statusCode: 200, body: JSON.stringify(r) }; } catch (e) { return { statusCode: 500, body: String(e) }; } };
