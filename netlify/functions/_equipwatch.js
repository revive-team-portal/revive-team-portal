// Equipment watch: pulls current listings from NZ second-hand / auction sites
// and normalises them to one shape. No logins, public pages/JSON only.
// Item: { key, site, title, url, image, price, closes_at, location, how, desc, force }
//   key   = stable id "<site>:<id>"
//   how   = purchase details line (auction type, buyer's premium, etc.)
//   force = send to the relevance check even without a keyword hit (auction notices)

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', '#039': "'", apos: "'", nbsp: ' ', mdash: '-', ndash: '-' };
const unent = (s) => String(s || '').replace(/&(#\d+|#x[0-9a-f]+|[a-z0-9]+);/gi, (m, e) => {
  if (ENT[e] != null) return ENT[e];
  if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return isNaN(n) ? m : String.fromCharCode(n); }
  return m;
});
const strip = (s) => unent(String(s || '').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const money = (n) => (n == null || n === '' || isNaN(Number(n))) ? null : '$' + Number(n).toLocaleString('en-NZ', { maximumFractionDigits: 2 });

async function get(url, { json = false, headers = {}, timeout = 25000 } = {}) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: json ? 'application/json' : 'text/html,*/*', ...headers }, signal: ctl.signal, redirect: 'follow' });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url.split('?')[0]);
    return json ? res.json() : res.text();
  } finally { clearTimeout(t); }
}

function premium(text) {
  const s = strip(text);
  const m = s.match(/(\d{1,2}(?:\.\d+)?)\s*%[^.]{0,60}?premium/i) || s.match(/premium[^.%]{0,60}?(\d{1,2}(?:\.\d+)?)\s*%/i);
  return m ? m[1] + '% buyer\'s premium' : null;
}

// ---------------------------------------------------------------- Thorntons (BidWrangler)
async function thorntons() {
  const base = 'https://bid.thorntons.net.nz';
  const a = await get(base + '/api/auctions', { json: true });
  const live = (a.auctions || []).filter(x => x.published && !x.complete && !x.archived && /accepting_bids|pending|active/.test(x.status || ''));
  const out = [];
  for (const au of live) {
    const bp = premium(au.description);
    const loc = au.location ? [au.location.street, au.location.city].filter(Boolean).join(', ') : 'Penrose, Auckland';
    for (let page = 1; page <= 10; page++) {
      const d = await get(`${base}/api/auctions/${au.id}/items?page=${page}&per_page=300`, { json: true });
      const items = d.items || [];
      for (const it of items) {
        if (!it.published || /sold|closed|passed|withdrawn/.test(it.status || '')) continue;
        const st = it.api_bidding_state || {};
        const bid = st.high && st.high.amount;
        const img = (it.images && it.images[0]) || {};
        out.push({
          key: 'thorntons:' + it.id, site: 'Thorntons', title: it.name,
          url: `${base}/ui/auctions/${au.id}`, image: img.sm || img.lg || img.xs || null,
          price: bid ? money(bid) + ' current bid (' + (st.accepted_bid_count || 0) + ' bids)' : 'No bids - opens ' + money(st.ask_amount || it.start_amount),
          closes_at: it.scheduled_end_time || au.scheduled_end_time || null, location: loc,
          how: `Online auction "${au.name}", lot #${it.lot_identifier}` + (bp ? ', ' + bp : ', check terms for buyer\'s premium') + '. Pay & collect from Thorntons, 50 Fairfax Ave Penrose.',
          desc: String(it.description_without_html || '').slice(0, 300),
        });
      }
      if (out.length && items.length < 300) break;
      if (!items.length) break;
    }
  }
  return out;
}

// ---------------------------------------------------------------- Auction Mobility sites (Mainland, All About Auctions)
async function auctionMobility(base, site, prefix, defaultLoc) {
  const html = await get(base + '/');
  const m = html.match(/viewVars\s*=\s*(\{[\s\S]*?\});\s*\n/);
  if (!m) throw new Error('no viewVars');
  const vv = JSON.parse(m[1]);
  const aucs = (vv.upcomingAuctions && vv.upcomingAuctions.result_page) || [];
  const out = [];
  for (const au of aucs) {
    const adesc = au.truncated_description || au.description || '';
    const bp = premium(adesc);
    const loc = (((au.title || '').match(/\bat\s+(.+)$/i) || [])[1] || ((strip(adesc).match(/LOCATION:?\s*(.{5,120})/i) || [])[1]) || defaultLoc).split(/\s+IF YOU|\s{2,}|\.\s/)[0];
    for (let o = 0; o < 3000; o += 100) {
      const d = await get(`${base}/ajax/lots/?auctionId=${au.row_id}&limit=100&o=${o}&order_by=lot_number&order=asc&fieldset=timed-auction+summary`, { json: true, headers: { 'X-Requested-With': 'XMLHttpRequest' } });
      const lots = d.result_page || [];
      for (const l of lots) {
        if (l.status && !/active|upcoming|open/.test(l.status)) continue;
        const bid = l.timed_auction_bid && l.timed_auction_bid.amount;
        out.push({
          key: prefix + ':' + l.row_id, site, title: l.title,
          url: `${base}/lots/view/${l.row_id}`, image: l.cover_thumbnail || null,
          price: bid ? money(bid) + ' current bid' : (l.starting_price ? 'Opens ' + money(l.starting_price) : 'No bids yet'),
          closes_at: l.extended_end_time || null, location: String(loc).trim().slice(0, 120),
          how: `Auction "${String(au.title || '').slice(0, 140)}", lot ${l.lot_number}` + (bp ? ', ' + bp : '') + '. As-is-where-is; buyer arranges collection/freight.',
          desc: strip(l.truncated_description).slice(0, 300),
        });
      }
      const qi = d.query_info || {};
      if (!lots.length || o + lots.length >= (qi.total_num_results || 0)) break;
    }
  }
  return out;
}
const mainland = () => auctionMobility('https://live.mainlandauctions.nz', 'Mainland Auctions', 'mainland', 'Christchurch');
const allAbout = () => auctionMobility('https://auctions.allaboutauctions.co.nz', 'All About Auctions', 'allabout', 'Onehunga, Auckland');

// ---------------------------------------------------------------- SilverChef Certified Used (Shopify)
async function silverchef() {
  const out = [];
  for (let p = 1; p <= 10; p++) {
    const d = await get(`https://www.silverchef.co.nz/collections/used-commercial-kitchen-equipment/products.json?limit=250&page=${p}`, { json: true });
    const ps = d.products || [];
    for (const x of ps) {
      const tags = x.tags || [];
      const tag = (k) => { const t = tags.find(t => t.toLowerCase().startsWith(k + ':')); return t ? t.slice(k.length + 1) : null; };
      const v = (x.variants || [])[0] || {};
      out.push({
        key: 'silverchef:' + x.id, site: 'SilverChef', title: x.title,
        url: 'https://www.silverchef.co.nz/products/' + x.handle, image: (x.images && x.images[0] && x.images[0].src) || null,
        price: v.price ? money(v.price) + ' (check site re GST)' : 'See site', closes_at: null,
        location: [tag('location'), tag('locfilter')].filter(Boolean).join(', ') || null,
        how: 'Fixed price, SilverChef Certified Used (3-month warranty). Buy outright, rent or finance' + (tag('power') ? '. Power: ' + tag('power') : '') + '.',
        desc: [tag('subcat'), tag('make'), tag('model'), tag('assetcondition')].filter(Boolean).join(' | '),
      });
    }
    if (ps.length < 250) break;
  }
  return out;
}

// ---------------------------------------------------------------- Brian Millen (Hamilton)
async function brianMillen() {
  const base = 'https://www.brianmillenauctions.co.nz/';
  const out = [];
  const seen = new Set(); const queue = ['used'];
  let n = 0;
  while (queue.length && n < 40) {
    const path = queue.shift(); if (seen.has(path)) continue; seen.add(path); n++;
    const html = await get(base + path);
    const re = /<div class="product-item"><a class="product-item-image" href="([^"]+)"><img src="([^"]+)"[^>]*alt="([^"]*)"/g; let m;
    for (const mm of html.matchAll(re)) {
      const rel = mm[1].replace(/^(\.\.\/)+/, ''); const href = base + rel; const title = unent(mm[3]).trim();
      const segs = rel.split('/');
      if (segs[0] !== 'used-items' || segs.length < 5) { queue.push(segs.join('/')); continue; }
      out.push({ key: 'brianmillen:' + href.split('/').pop(), site: 'Brian Millen Auctions', title, url: href,
        image: base + mm[2].replace(/^(\.\.\/)+/, ''), price: ((title.match(/\$[\d,]+(?:\s*\+\s*gst)?/i) || [])[0]) || (/poa/i.test(title) ? 'POA (price on application)' : 'See listing'), closes_at: null,
        location: 'Hamilton', how: 'Private sale from their warehouse between auctions - call 07 846 7200.', desc: '' });
    }
    for (const mm of html.matchAll(/href="((?:\.\.\/)*used-items\/catalogue\/[^"]+)"/g)) {
      const p = mm[1].replace(/^(\.\.\/)+/, '');
      if (!seen.has(p) && p.split('/').length <= 4) queue.push(p);
    }
  }
  // Auctions page: alert when an auction appears
  const ah = strip(await get(base + 'auctions'));
  if (!/No upcoming auctions found/i.test(ah)) {
    const i = ah.indexOf('View our next'); const txt = ah.slice(i > 0 ? i : 0, (i > 0 ? i : 0) + 600);
    out.push({ key: 'brianmillen:auction:' + txt.slice(0, 120).replace(/\W+/g, '').slice(0, 80), site: 'Brian Millen Auctions',
      title: 'Upcoming catering equipment auction', url: base + 'auctions', image: null, price: 'Auction', closes_at: null,
      location: 'Hamilton', how: 'Catering equipment auction - see page for date and catalogue.', desc: txt, force: true });
  }
  return out;
}

// ---------------------------------------------------------------- Skylarc (auctions run on Trade Me)
async function skylarc() {
  const base = 'https://www.skylarc.co.nz/';
  const html = await get(base + 'auctions.php?per_page=90');
  const cards = html.split('<a class="section-3__card"').slice(1);
  const out = [];
  for (const c of cards) {
    const id = (c.match(/event_id=(\d+)/) || [])[1]; if (!id) continue;
    const badge = strip((c.match(/badge-text">([\s\S]*?)<\/p>/) || [])[1] || '');
    if (/ended/i.test(badge)) continue;
    const aname = unent((c.match(/alt="([^"]*)"/) || [])[1] || '');
    for (let page = 1; page <= 15; page++) {
      const eh = await get(`${base}event.php?event_id=${id}` + (page > 1 ? '&page=' + page : ''));
      const prods = eh.split(/<article\s+class="event-product-card"/).slice(1);
      let added = 0;
      for (const p of prods) {
        const pid = (p.match(/product\.php\?event_id=\d+&amp;id=(\d+)/) || [])[1]; if (!pid) continue;
        if (/status--sold/.test(p)) continue;
        const key = 'skylarc:' + pid; if (out.some(o => o.key === key)) continue;
        const title = strip((p.match(/card__title-link"[^>]*>([\s\S]*?)<\/a>/) || [])[1]);
        const plab = strip((p.match(/price-label">([\s\S]*?)<\/p>/) || [])[1]);
        const pr = strip((p.match(/card__price">([\s\S]*?)<\/p>/) || [])[1]);
        const img = (p.match(/<img[^>]*src="([^"]+)"/) || [])[1];
        const dsearch = unent((p.match(/data-search="([^"]*)"/) || [])[1] || '').replace(/\s+/g, ' ');
        out.push({ key, site: 'Skylarc', title, url: `${base}product.php?event_id=${id}&id=${pid}`, image: img ? new URL(img, base).href : null,
          price: [plab, pr].filter(Boolean).join(' ') || 'See listing', closes_at: null, location: null,
          how: `Skylarc auction "${aname}" (${badge}) - bidding is on Trade Me via the Skylarc listing.`, desc: dsearch.slice(0, 300) });
        added++;
      }
      if (!added || !new RegExp('event_id=' + id + '[^"]*page=' + (page + 1)).test(eh)) break;
    }
  }
  return out;
}

// ---------------------------------------------------------------- Federal (FHE) clearance - new stock
async function federal() {
  const out = [];
  for (let p = 1; p <= 10; p++) {
    const html = await get(`https://fedproducts.co.nz/special-offers-clearance.html?p=${p}&product_list_limit=36`);
    const cards = html.split('class="product-item-info"').slice(1);
    let added = 0;
    for (const c of cards) {
      const url = (c.match(/class="product-item-link"\s+href="([^"]+)"/) || [])[1]; if (!url) continue;
      const key = 'federal:' + url.split('/').pop().replace(/\.html$/, ''); if (out.some(o => o.key === key)) continue;
      const title = strip((c.match(/class="product-item-link"[^>]*>([\s\S]*?)<\/a>/) || [])[1]);
      const ex = strip((c.match(/gst-price-excl">([\s\S]*?)<span/) || [])[1]);
      out.push({ key, site: 'Federal (FHE) Clearance', title, url, image: (c.match(/product-image-photo"[\s\S]*?src="([^"]+)"/) || [])[1] || null,
        price: ex ? ex + ' + GST' : 'See site', closes_at: null, location: 'Nationwide (Federal Hospitality Equipment)',
        how: 'Fixed-price clearance - NEW or ex-demo stock, not second-hand. Buy online.', desc: '' });
      added++;
    }
    if (!added || cards.length < 36) break;
  }
  return out;
}

// ---------------------------------------------------------------- Tiger Hospo (Shopify, only second-hand items)
async function tiger() {
  const out = [];
  for (let p = 1; p <= 10; p++) {
    const d = await get(`https://www.tigerhospoequipment.com/products.json?limit=250&page=${p}`, { json: true });
    const ps = d.products || [];
    for (const x of ps) {
      if (!/second.?hand|\bused\b|ex.?demo|pre.?owned|refurb/i.test(x.title + ' ' + (x.tags || []).join(' ') + ' ' + (x.product_type || ''))) continue;
      const v = (x.variants || [])[0] || {};
      out.push({ key: 'tiger:' + x.id, site: 'Tiger Hospo', title: x.title, url: 'https://www.tigerhospoequipment.com/products/' + x.handle,
        image: (x.images && x.images[0] && x.images[0].src) || null, price: v.price ? money(v.price) : 'See site', closes_at: null,
        location: 'Christchurch', how: 'Fixed price, used (6-12 month warranty per Tiger).', desc: strip(x.body_html).slice(0, 200) });
    }
    if (ps.length < 250) break;
  }
  return out;
}

// ---------------------------------------------------------------- Alastair Beer Auctions (WordPress auction notices)
async function abAuctions() {
  const d = await get('https://abauctions.co.nz/wp-json/wp/v2/posts?per_page=10&_fields=id,date,link,title,excerpt', { json: true });
  return (d || []).map(p => ({ key: 'abauctions:' + p.id, site: 'Alastair Beer Auctions', title: strip(p.title && p.title.rendered), url: p.link,
    image: null, price: 'Auction', closes_at: null, location: 'Bay of Plenty / on-site', how: 'On-site auction or tender - see notice for date and terms.',
    desc: strip(p.excerpt && p.excerpt.rendered).slice(0, 400), force: true }));
}

// ---------------------------------------------------------------- Trade Me (official API, app-only auth)
// Keys: ads.config trademe_consumer_key / trademe_consumer_secret (Revive Apps), or env
// TRADEME_CONSUMER_KEY / TRADEME_CONSUMER_SECRET. Dormant (returns []) until keys exist.
const TM_TERMS = ['upright freezer', 'commercial freezer', 'freezer 2 door', 'blast chiller', 'blast freezer', 'shock freezer',
  'freezer room', 'cool room', 'coolroom panels', 'walk in freezer', 'tray sealer', 'vacuum packer', 'vacuum packing machine',
  'flow wrapper', 'band sealer', 'labeller', 'label applicator', 'shrink wrap machine', 'packaging machine', 'date coder'];
async function tmKeys() {
  if (process.env.TRADEME_CONSUMER_KEY) return { key: process.env.TRADEME_CONSUMER_KEY, secret: process.env.TRADEME_CONSUMER_SECRET };
  try {
    const { db } = require('./_adsdb');
    const rows = await db("config?select=key,value&key=in.(trademe_consumer_key,trademe_consumer_secret)");
    const m = {}; (rows || []).forEach(r => { m[r.key] = typeof r.value === 'string' ? r.value : String(r.value); });
    return m.trademe_consumer_key ? { key: m.trademe_consumer_key, secret: m.trademe_consumer_secret } : null;
  } catch (e) { return null; }
}
const tmDate = (v) => { const m = String(v || '').match(/Date\((\d+)/); return m ? new Date(Number(m[1])).toISOString() : (v || null); };
async function trademe() {
  const k = await tmKeys();
  if (!k) return [];
  const auth = `OAuth oauth_consumer_key="${k.key}", oauth_signature_method="PLAINTEXT", oauth_signature="${k.secret}&"`;
  const since = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 19);
  const out = []; const seen = new Set();
  for (const term of TM_TERMS) {
    const d = await get(`https://api.trademe.co.nz/v1/Search/General.json?search_string=${encodeURIComponent(term)}&rows=100&sort_order=ExpiryDesc&date_from=${since}&photo_size=Large`, { json: true, headers: { Authorization: auth } });
    for (const x of d.List || []) {
      if (seen.has(x.ListingId)) continue; seen.add(x.ListingId);
      const auction = !x.IsBuyNowOnly && !x.IsClassified;
      const parts = [];
      if (x.PriceDisplay) parts.push(x.PriceDisplay);
      if (x.HasBuyNow && x.BuyNowPrice) parts.push('Buy Now ' + money(x.BuyNowPrice));
      if (x.BidCount) parts.push(x.BidCount + ' bids');
      out.push({ key: 'trademe:' + x.ListingId, site: 'Trade Me', title: x.Title, url: 'https://www.trademe.co.nz/a/listing/' + x.ListingId,
        image: x.PictureHref || null, price: parts.join(' · ') || 'See listing', closes_at: tmDate(x.EndDate),
        location: [x.Suburb, x.Region].filter(Boolean).join(', ') || null,
        how: (x.IsClassified ? 'Trade Me classified - contact seller' : auction ? 'Trade Me auction' + (x.HasBuyNow ? ' with Buy Now' : '') + (x.HasReserve ? (x.ReserveState === 1 ? ', reserve met' : ', reserve not met') : ', no reserve') : 'Trade Me Buy Now (fixed price)') + (x.IsNew ? ', new item' : ', used') + (x.Category ? '. Category ' + x.Category : '') + '.',
        desc: (x.Subtitle || '') + ' [search: ' + term + ']', force: true });
    }
  }
  return out;
}

const SITES = { trademe, thorntons, mainland, allAbout, silverchef, brianMillen, skylarc, federal, tiger, abAuctions };

async function fetchAll(only) {
  const names = only ? only.split(',') : Object.keys(SITES);
  const results = await Promise.all(names.map(async (n) => {
    const t0 = Date.now();
    try { const items = await SITES[n](); return { site: n, ok: true, count: items.length, ms: Date.now() - t0, items }; }
    catch (e) { return { site: n, ok: false, error: String(e.message || e).slice(0, 200), ms: Date.now() - t0, items: [] }; }
  }));
  return results;
}

// Cheap keyword gate before the Claude relevance check (title; strong words in description).
const STRONG = /freez|blast.?chill|shock.?chill|cold.?room|cool.?room|coolroom|flow.?wrap|tray.?seal|band.?seal|heat.?seal|vacuum.?pack|label(l)?er|packaging machine|packing machine/i;
const isMatch = (i) => !!(i.force || KEYWORDS.test(i.title || '') || STRONG.test(i.desc || ''));
const KEYWORDS = /freez|blast|shock.?chill|chiller|cold.?room|cool.?room|chiller room|walk.?in|coolroom|refrigerat|sealer|sealing|flow.?wrap|wrapper|wrapping|label(l)?er|labelling|label printer|packaging machine|packing machine|packing machine|vacuum pack|vac pack|shrink|bagg|bag.?filler|filler|filling machine|date.?cod|inkjet|thermal transfer|tray seal|heat seal|band seal|induction seal|cartoner|carton|check.?weigh|metal detect/i;

module.exports = { fetchAll, KEYWORDS, STRONG, isMatch, SITES, strip };
