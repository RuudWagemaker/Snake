import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { GameServer } from './game.js';
import { initRtc } from './rtc.js';
import { Stats } from './stats.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

// A fingerprint of the client files. Every deploy that changes the game gets a
// new one; pages still running an older version reload themselves.
function computeBuild(dir) {
  const h = createHash('sha1');
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { h.update(e.name); h.update(readFileSync(p)); }
    }
  };
  walk(dir);
  return h.digest('hex').slice(0, 12);
}
export const BUILD = computeBuild(PUBLIC_DIR);

function keyOk(given, key) {
  if (!key || typeof given !== 'string') return false;
  const a = createHash('sha256').update(given).digest(), b = createHash('sha256').update(key).digest();
  return timingSafeEqual(a, b);
}

const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Private usage page: /admin?key=ADMIN_KEY. Without the right key it doesn't exist (404). */
export function adminPage(stats, game) {
  const rows = stats.usage(30);
  const cols = [
    ['day', 'Day'], ['visitors', 'Visitors'], ['players', 'Played'], ['newPlayers', 'New'],
    ['matches', 'Matches'], ['roomMatches', 'In rooms'], ['avgMatchSecs', 'Avg match (s)'],
    ['matchesPerPlayer', 'Matches / player'], ['peakOnline', 'Peak online'],
  ];
  const head = cols.map(([, t]) => `<th>${t}</th>`).join('');
  const body = rows.map((r) => `<tr>${cols.map(([k]) => `<td>${escHtml(r[k])}</td>`).join('')}</tr>`).join('') ||
    `<tr><td colspan="${cols.length}">No data yet</td></tr>`;
  const online = game ? game.clients.size : 0;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Line Clash stats</title><style>
body{font:15px system-ui,sans-serif;background:#0b0f17;color:#e8ecf4;margin:16px}
h1{font-size:22px;margin:0 0 4px}p{color:#8a94a8;margin:0 0 14px}
.wrap{overflow-x:auto}table{border-collapse:collapse;white-space:nowrap}
th,td{padding:6px 10px;text-align:right;border-bottom:1px solid #263049}th{color:#8a94a8;font-weight:600}
td:first-child,th:first-child{text-align:left;position:sticky;left:0;background:#0b0f17}
b{color:#51cf66}</style></head><body>
<h1>Line Clash</h1><p>Online now: <b>${online}</b> · profiles: <b>${stats.profiles.size}</b> · build ${escHtml(BUILD)}</p>
<div class="wrap"><table><tr>${head}</tr>${body}</table></div>
<p style="margin-top:14px">Visitors = opened the game. Played = finished at least one match. New = first match ever. Days run in Amsterdam time.</p>
</body></html>`;
}

/**
 * AdSense (optional, ADSENSE_CLIENT=ca-pub-..., ADSENSE_SLOT=...): Google's script
 * in <head>, and the ids for the client's ad space on the "starting soon" screen.
 */
export function adsConfig(client, slot) {
  if (!/^ca-pub-\d{10,20}$/.test(client || '')) return null;
  return { client, slot: /^\d{5,20}$/.test(slot || '') ? slot : '' };
}
function adsHead(ads) {
  if (!ads) return '';
  return `<meta name="google-adsense-account" content="${ads.client}">\n  <meta name="ads" content="${ads.client}|${ads.slot}">\n` +
    `  <script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ads.client}" crossorigin="anonymous"></script>`;
}

async function serveStatic(req, res, ctx = {}) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (urlPath === '/ads.txt') {
    // Google AdSense asks for this file to prove the site's ads are ours
    const pub = ctx.ads && ctx.ads.client ? ctx.ads.client.replace(/^ca-/, '') : null;
    if (pub) res.writeHead(200, { 'content-type': 'text/plain' }).end(`google.com, ${pub}, DIRECT, f08c47fec0942fa0\n`);
    else res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    return;
  }
  if (urlPath === '/admin') {
    const key = new URL(req.url, 'http://x').searchParams.get('key');
    if (ctx.stats && keyOk(key, ctx.adminKey)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' });
      res.end(adminPage(ctx.stats, ctx.game));
    } else {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    }
    return;
  }
  if (urlPath === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    return;
  }
  if (urlPath.endsWith('/')) urlPath += 'index.html';
  const file = path.resolve(PUBLIC_DIR, '.' + path.posix.normalize(urlPath));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    let data = await readFile(file);
    if (file.endsWith('index.html')) {
      const canonical = /^[a-z0-9.-]+$/.test(ctx.canonicalHost || '') ? ctx.canonicalHost : '';
      data = data.toString().replaceAll('%BUILD%', BUILD).replaceAll('%CANONICAL%', canonical).replace('<!--%ADS%-->', adsHead(ctx.ads));
    }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
}

export async function startServer({ port = 3000, host, statsFile = null, adminKey = null, googleClientId = null, verifyGoogle, canonicalHost = null, ads = null } = {}) {
  await initRtc();
  const stats = new Stats(statsFile);
  const game = new GameServer(BUILD, stats, { googleClientId, ...(verifyGoogle ? { verifyGoogle } : {}) });
  const server = http.createServer((req, res) => serveStatic(req, res, { stats, game, adminKey, canonicalHost, ads }));
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096, perMessageDeflate: false });
  wss.on('connection', (ws) => game.onConnection(ws));
  game.start();
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      resolve({
        port: server.address().port,
        game,
        close: () => new Promise((r) => {
          game.stop();
          stats.saveNow();
          for (const ws of wss.clients) ws.terminate();
          wss.close();
          server.close(() => r());
        }),
      });
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  // STATS_FILE: where player profiles and leaderboards are kept (unset = memory only)
  const statsFile = process.env.STATS_FILE || null;
  // ADMIN_KEY: password for the private usage page /admin?key=... (unset = page off)
  startServer({ port, host: process.env.HOST || undefined, statsFile, adminKey: process.env.ADMIN_KEY || null,
    // GOOGLE_CLIENT_ID: OAuth client id for "Sign in with Google" (unset = guests only)
    googleClientId: process.env.GOOGLE_CLIENT_ID || null,
    // CANONICAL_HOST: the game's main address (e.g. lineclash.com). Pages opened on any
    // other address move there, taking the player's saved progress along.
    canonicalHost: process.env.CANONICAL_HOST || null,
    // ADSENSE_CLIENT / ADSENSE_SLOT: Google AdSense publisher id and ad unit (unset = no ads)
    ads: adsConfig(process.env.ADSENSE_CLIENT, process.env.ADSENSE_SLOT) }).then(({ port, game }) => {
    console.log(`Line Clash (build ${BUILD}) running on http://localhost:${port}` +
      (statsFile ? `, stats in ${statsFile}` : ', stats in memory only (set STATS_FILE to keep them)'));
    // Save the stats before a restart (docker stop sends SIGTERM).
    for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, () => { game.stats.saveNow(); process.exit(0); });
  });
}
