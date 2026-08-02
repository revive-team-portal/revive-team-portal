const { WEEKLY_SQL, DEPT_SQL, queueJob } = require('./_posqueries');
exports.handler = async () => { try { const a = await queueJob('weekly-feed', WEEKLY_SQL); const b = await queueJob('dept-feed', DEPT_SQL); return { statusCode: 200, body: JSON.stringify({ weekly: a, dept: b }) }; } catch (e) { return { statusCode: 500, body: String(e) }; } };
