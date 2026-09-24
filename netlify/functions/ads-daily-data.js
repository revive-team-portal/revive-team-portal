// Raw data behind the daily Meta ads email, for ad-hoc analysis from chat.
// ?k=<runkey>  ?day=YYYY-MM-DD (NZ date, default yesterday). Read-only.
const { guard, DENY } = require('./_runkey');
const { gather } = require('./_adsdaily');
exports.handler = async (event) => {
  if (!(await guard(event)).ok) return DENY;
  const qp = (event && event.queryStringParameters) || {};
  try { return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(await gather(qp.day)) }; }
  catch (e) { return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: String(e.message || e) }) }; }
};
