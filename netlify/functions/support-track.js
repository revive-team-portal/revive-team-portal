// Live courier tracking via eShip / Starshipit (api.starshipit.com). Portal-gated (support).
// Returns the real carrier status + scan events for a tracking number — the source of truth,
// independent of Shopify's fulfilment field.
const { json, validatePortalUser } = require('./_portal');
const API_KEY = process.env.ESHIP_API_KEY;
const SUB_KEY = process.env.ESHIP_SUBSCRIPTION_KEY;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const a = await validatePortalUser(event, 'support');
  if (!a.ok) return json(a.status || 403, { error: a.error });
  if (!API_KEY || !SUB_KEY) return json(500, { error: 'eShip not configured (ESHIP_API_KEY / ESHIP_SUBSCRIPTION_KEY).' });

  let body; try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad request body.' }); }
  const tn = (body.trackingNumber || '').trim();
  const on = (body.orderNumber || '').trim();
  if (!tn && !on) return json(400, { error: 'No tracking or order number.' });

  const qs = tn ? 'tracking_number=' + encodeURIComponent(tn) : 'order_number=' + encodeURIComponent(on);
  try {
    const res = await fetch('https://api.starshipit.com/api/track?' + qs, {
      headers: { 'StarShipIT-Api-Key': API_KEY, 'Ocp-Apim-Subscription-Key': SUB_KEY, 'Content-Type': 'application/json' },
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.success === false) {
      const msg = (j.errors && j.errors[0] && (j.errors[0].message || j.errors[0].details)) || j.message || ('HTTP ' + res.status);
      return json(502, { error: 'Courier lookup failed: ' + msg });
    }
    const rz = j.results || j;
    const rawEvents = rz.tracking_details || rz.events || rz.tracking_events || rz.trackingDetails || [];
    const events = rawEvents.map(e => ({
      date: e.status_date || e.date || e.event_datetime || e.timestamp || e.datetime || '',
      status: e.status || e.tracking_status || '',
      detail: e.status_details || e.details || e.description || e.message || e.event || e.status || '',
      location: e.location || e.city || e.depot || e.facility || '',
      signedBy: e.signed_by || e.signer || e.signature || e.signature_name || '',
    })).sort((x, y) => new Date(y.date) - new Date(x.date));
    const signedBy = rz.signature || rz.signed_by || rz.signer || rz.signature_name || (events.find(e => e.signedBy) || {}).signedBy || '';
    return json(200, {
      status: rz.status || rz.tracking_status || (events[0] && events[0].status) || 'Unknown',
      carrier: rz.carrier_name || rz.carrier || '',
      service: rz.carrier_service || rz.service || '',
      trackingUrl: rz.tracking_url || '',
      trackingNumber: rz.tracking_number || tn,
      deliveredDate: rz.delivered_date || rz.delivery_date || rz.date_delivered || '',
      signedBy,
      events,
      _raw: { keys: Object.keys(rz || {}), sampleEvent: rawEvents[0] || null },
    });
  } catch (e) { return json(502, { error: String(e.message || e) }); }
};
