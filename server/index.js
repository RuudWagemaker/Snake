import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { GameServer } from './game.js';
import { initRtc } from './rtc.js';

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

async function serveStatic(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400).end();
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
    if (file.endsWith('index.html')) data = data.toString().replaceAll('%BUILD%', BUILD);
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
}

export async function startServer({ port = 3000, host } = {}) {
  await initRtc();
  const server = http.createServer(serveStatic);
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096, perMessageDeflate: false });
  const game = new GameServer(BUILD);
  wss.on('connection', (ws) => game.onConnection(ws));
  game.start();
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      resolve({
        port: server.address().port,
        game,
        close: () => new Promise((r) => {
          game.stop();
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
  startServer({ port, host: process.env.HOST || undefined }).then(({ port }) => {
    console.log(`Curve Royale (build ${BUILD}) running on http://localhost:${port}`);
  });
}
