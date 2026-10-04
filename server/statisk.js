'use strict';
// Statiske filer: sikre stier, MIME-typer, ETag og cache

const fs = require('node:fs');
const path = require('node:path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

// Find en sikker fuld sti under rod, eller null
function sikkerSti(rod, rel) {
  let s;
  try {
    s = decodeURIComponent(rel);
  } catch {
    return null;
  }
  if (s.includes('\0') || s.includes('\\')) return null;
  const dele = s.split('/').filter(Boolean);
  // Ingen ".." og ingen skjulte filer
  if (dele.some((d) => d === '..' || d === '.' || d.startsWith('.') || d.includes(':'))) return null;
  const fuld = path.resolve(rod, ...dele);
  const r = path.resolve(rod);
  if (fuld !== r && !fuld.startsWith(r + path.sep)) return null;
  return fuld;
}

// Send fil. Returnerer false hvis den ikke findes (så kalderen kan svare 404).
function sendFil(req, res, fuld, { cache = 'no-cache', headers = {} } = {}) {
  let st;
  try {
    st = fs.statSync(fuld);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;
  const type = MIME[path.extname(fuld).toLowerCase()] || 'application/octet-stream';
  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const h = {
    'Content-Type': type,
    'Cache-Control': cache,
    ETag: etag,
    'Last-Modified': st.mtime.toUTCString(),
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, h);
    res.end();
    return true;
  }
  h['Content-Length'] = st.size;
  res.writeHead(200, h);
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  const s = fs.createReadStream(fuld);
  s.on('error', () => res.destroy());
  s.pipe(res);
  return true;
}

function send404(res) {
  const html = `<!doctype html><html lang="da"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Siden findes ikke</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0f1a;color:#e6f1ff;font:18px/1.5 system-ui,sans-serif;text-align:center;padding:16px}
h1{color:#39ff88;font-size:2.4em;margin:0 0 .3em;text-shadow:0 0 12px #39ff8866}a{color:#4cc9ff}</style></head>
<body><main><h1>404</h1><p>Siden findes ikke (endnu).</p><p><a href="/">Til butikken</a></p></main></body></html>`;
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(html) });
  res.end(html);
}

module.exports = { MIME, sikkerSti, sendFil, send404 };
