// The Inspiration Project — continuous-stream playlist.
//
// Why this exists: on Bluetooth car head units (notably 2016-era GM MyLink) the
// player used to show "Paused" at every song change. Each song was its own
// <audio> file, so at each boundary one element genuinely ended and another
// started; iOS reported that instant as "not playing" and the head unit latched
// onto it. This function joins the songs into ONE HLS playlist, so the page plays
// a single stream that never ends — no boundary event for the car to misread.
//
// GET /.netlify/functions/music-playlist?o=3,7,1,...&t=12.5
//   o = song indices (positions in songs.json) in the order to play, may repeat
//   t = optional seconds into the FIRST song to start playback from
//
// Returns an M3U8 whose segments are the site's own MP3 files (HLS "packed
// audio"). Nothing here is private — it only lists public audio URLs.

let cache = { at: 0, data: null };

async function songs(origin) {
  if (cache.data && Date.now() - cache.at < 60000) return cache.data;
  const r = await fetch(origin + '/music/songs.json', { headers: { 'cache-control': 'no-cache' } });
  if (!r.ok) throw new Error('songs.json ' + r.status);
  const d = await r.json();
  cache = { at: Date.now(), data: d.songs || [] };
  return cache.data;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'GET only' };
  const host = event.headers['x-forwarded-host'] || event.headers.host || 'team.revive.co.nz';
  const origin = 'https://' + host;
  const q = event.queryStringParameters || {};

  let list;
  try { list = await songs(origin); } catch (e) { return { statusCode: 502, body: String(e.message || e) }; }
  if (!list.length) return { statusCode: 404, body: 'no songs' };

  let order = String(q.o || '').split(',').map(s => parseInt(s, 10)).filter(n => Number.isInteger(n) && n >= 0 && n < list.length);
  if (!order.length) order = list.map((_, i) => i);
  order = order.slice(0, 400);                                   // ~10 hours max; plenty
  const start = Math.max(0, Number(q.t) || 0);

  const lines = ['#EXTM3U', '#EXT-X-VERSION:4', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-MEDIA-SEQUENCE:0'];
  let maxDur = 1;
  for (const i of order) maxDur = Math.max(maxDur, Number(list[i].duration) || 1);
  lines.push('#EXT-X-TARGETDURATION:' + Math.ceil(maxDur));
  if (start > 0.05) lines.push('#EXT-X-START:TIME-OFFSET=' + start.toFixed(3) + ',PRECISE=YES');

  order.forEach((i, k) => {
    const s = list[i];
    const d = Math.max(0.1, Number(s.duration) || 0.1);
    /* every song is an independent MP3 with its own timestamps, so mark each join */
    if (k > 0) lines.push('#EXT-X-DISCONTINUITY');
    lines.push('#EXTINF:' + d.toFixed(3) + ',' + String(s.title || '').replace(/[\r\n]/g, ' '));
    lines.push(new URL(s.src, origin + '/music/').href);
  });
  lines.push('#EXT-X-ENDLIST');

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*'
    },
    body: lines.join('\n') + '\n'
  };
};
