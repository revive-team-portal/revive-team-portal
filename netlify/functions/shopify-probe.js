// TEMPORARY diagnostic. ?k=<PORTAL_RUN_KEY> — lists the granted Shopify access scopes and
// probes which order-attribution fields the current app can actually read.
const { gql, STORE, API_VER } = require('./_shopify');
const GUARD = process.env.PORTAL_RUN_KEY;

const PROBES = {
  landing_referrer: 'landingPageUrl referrerUrl',
  journey_summary: 'customerJourneySummary{ momentsCount daysToConversion lastVisit{ source sourceType referrerUrl landingPage utmParameters{ source medium campaign } } }',
  customer_journey: 'customerJourney{ momentsCount lastVisit{ source } }',
  publication: 'publication{ name }',
  channel_info: 'channelInformation{ channelDefinition{ channelName subChannelName } }',
  note_attrs: 'customAttributes{ key value }',
};

exports.handler = async (event) => {
  const qp = (event && event.queryStringParameters) || {};
  if (!GUARD || qp.k !== GUARD) return { statusCode: 403, body: 'nope' };
  const out = { store: STORE, api_version: API_VER, scopes: null, probes: {} };
  try {
    const s = await gql('{ currentAppInstallation{ accessScopes{ handle } app{ title } } }');
    out.scopes = (s.currentAppInstallation.accessScopes || []).map(x => x.handle).sort();
    out.app = s.currentAppInstallation.app && s.currentAppInstallation.app.title;
  } catch (e) { out.scopes = 'ERR: ' + String(e.message || e).slice(0, 200); }

  for (const [name, frag] of Object.entries(PROBES)) {
    try {
      const d = await gql('{ orders(first:1, sortKey:CREATED_AT, reverse:true){ nodes{ name ' + frag + ' } } }');
      out.probes[name] = { ok: true, sample: d.orders.nodes[0] };
    } catch (e) { out.probes[name] = { ok: false, err: String(e.message || e).slice(0, 240) }; }
  }
  return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(out, null, 1) };
};
