// Shared eShip / Starshipit tracking lookup (source of truth for courier status).
const API_KEY = process.env.ESHIP_API_KEY;
const SUB_KEY = process.env.ESHIP_SUBSCRIPTION_KEY;

async function track({ trackingNumber, orderNumber } = {}) {
  if (!API_KEY || !SUB_KEY) return { ok: false, error: 'eShip not configured.' };
  if (!trackingNumber && !orderNumber) return { ok: false, error: 'No tracking or order number.' };
  const qs = trackingNumber ? 'tracking_number=' + encodeURIComponent(trackingNumber) : 'order_number=' + encodeURIComponent(orderNumber);
  const res = await fetch('https://api.starshipit.com/api/track?' + qs, {
    headers: { 'StarShipIT-Api-Key': API_KEY, 'Ocp-Apim-Subscription-Key': SUB_KEY, 'Content-Type': 'application/json' },
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.success === false) {
    const msg = (j.errors && j.errors[0] && (j.errors[0].message || j.errors[0].details)) || j.message || ('HTTP ' + res.status);
    return { ok: false, error: msg };
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
  return {
    ok: true,
    status: rz.status || rz.tracking_status || (events[0] && events[0].status) || 'Unknown',
    carrier: rz.carrier_name || rz.carrier || '',
    service: rz.carrier_service || rz.service || '',
    trackingUrl: rz.tracking_url || '',
    trackingNumber: rz.tracking_number || trackingNumber,
    deliveredDate: rz.delivered_date || rz.delivery_date || rz.date_delivered || '',
    signedBy, events,
    raw: { keys: Object.keys(rz || {}), sampleEvent: rawEvents[0] || null },
  };
}
module.exports = { track };
