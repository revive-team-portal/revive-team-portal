// Live courier tracking via eShip / Starshipit. Portal-gated (support).
const { json, validatePortalUser } = require('./_portal');
const { track } = require('./_eship');
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const a = await validatePortalUser(event, 'support');
  if (!a.ok) return json(a.status || 403, { error: a.error });
  let body; try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad request body.' }); }
  const t = await track({ trackingNumber: (body.trackingNumber || '').trim(), orderNumber: (body.orderNumber || '').trim() });
  if (!t.ok) return json(502, { error: 'Courier lookup failed: ' + t.error });
  return json(200, { status: t.status, carrier: t.carrier, service: t.service, trackingUrl: t.trackingUrl, trackingNumber: t.trackingNumber, deliveredDate: t.deliveredDate, signedBy: t.signedBy, events: t.events, _raw: t.raw });
};
