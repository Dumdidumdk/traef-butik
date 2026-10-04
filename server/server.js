'use strict';
// Træf-butik – start af serveren

const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const D = require('./db');
const api = require('./api');
const sse = require('./sse');
const { sikkerSti, sendFil, send404 } = require('./statisk');

const PROJEKT = path.resolve(__dirname, '..');
const PUBLIC = path.join(PROJEKT, 'public');

const SIKKERHED = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'SAMEORIGIN',
};

// Sider: sti -> mappe i public/
const SIDER = { '/': 'kunde', '/butik/': 'butik', '/admin/': 'admin' };

function lavHandler(billedDir) {
  return (req, res) => {
    for (const [k, v] of Object.entries(SIKKERHED)) res.setHeader(k, v);
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      res.writeHead(400).end();
      return;
    }
    const sti = url.pathname;

    if (sti.startsWith('/api/')) {
      api.haandter(req, res, url);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }

    // Billeder: uploadede SVG'er må ikke kunne køre script
    if (sti.startsWith('/billeder/')) {
      const fuld = sikkerSti(billedDir, sti.slice('/billeder/'.length));
      const ok = fuld && sendFil(req, res, fuld, {
        cache: 'public, max-age=86400',
        headers: { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:" },
      });
      if (!ok) send404(res);
      return;
    }

    // /butik og /admin uden skråstreg -> med skråstreg, så relative stier virker
    if (sti === '/butik' || sti === '/admin') {
      res.writeHead(302, { Location: sti + '/' + url.search }).end();
      return;
    }
    if (sti === '/kunde' || sti === '/kunde/') {
      res.writeHead(302, { Location: '/' + url.search }).end();
      return;
    }
    if (SIDER[sti]) {
      if (!sendFil(req, res, path.join(PUBLIC, SIDER[sti], 'index.html'))) send404(res);
      return;
    }

    // Øvrige filer fra public/; filer i roden falder tilbage til public/kunde/ (kundesidens relative stier)
    const fuld = sikkerSti(PUBLIC, sti);
    if (fuld && sendFil(req, res, fuld)) return;
    if (!sti.slice(1).includes('/')) {
      const kf = sikkerSti(path.join(PUBLIC, 'kunde'), sti);
      if (kf && sendFil(req, res, kf)) return;
    }
    send404(res);
  };
}

function lanAdresser() {
  const ud = [];
  for (const liste of Object.values(os.networkInterfaces())) {
    for (const a of liste || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) ud.push(a.address);
    }
  }
  return ud;
}

function start({ port = Number(process.env.PORT) || 3000, dataDir = process.env.DATA_DIR, stille = false } = {}) {
  dataDir = path.resolve(dataDir || path.join(PROJEKT, 'data'));
  const billedDir = path.join(dataDir, 'billeder');
  D.init(dataDir, PROJEKT);
  api.init(billedDir);
  sse.startPing();

  const server = http.createServer(lavHandler(billedDir));
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 70000;
  server.requestTimeout = 120000;
  server.maxConnections = 5000;

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      const p = server.address().port;
      if (!stille) {
        const ips = lanAdresser();
        console.log('');
        console.log('  Træf-butikken kører!');
        console.log(`  Data: ${dataDir}`);
        console.log('');
        for (const ip of ips.length ? ips : ['localhost']) {
          console.log(`  Kundesiden:   http://${ip}:${p}`);
          console.log(`  Butiksskærm:  http://${ip}:${p}/butik`);
          console.log(`  Admin:        http://${ip}:${p}/admin`);
          console.log('');
        }
        console.log('  Luk vinduet eller tryk Ctrl+C for at stoppe.');
      }
      resolve(server);
    });
  });
}

function stop(server) {
  sse.lukAlle();
  return new Promise((resolve) => {
    server.close(() => {
      D.luk();
      resolve();
    });
    server.closeAllConnections?.();
  });
}

module.exports = { start, stop };

if (require.main === module) {
  start().then((server) => {
    const afslut = () => {
      console.log('\n  Stopper serveren …');
      stop(server).then(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref();
    };
    process.on('SIGINT', afslut);
    process.on('SIGTERM', afslut);
  }).catch((e) => {
    if (e.code === 'EADDRINUSE') console.error(`\n  Port ${e.port} er allerede i brug. Kører butikken allerede?`);
    else console.error(e);
    process.exit(1);
  });
}
