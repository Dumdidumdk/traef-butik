'use strict';
// Fælles hjælpere til testene: start/stop af serveren, "browsere" med cookies, SSE-læsning og databasetjek.

const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

// Projektets rod. Kan peges et andet sted hen med TRAEF_ROD (fx en anden worktree).
const ROD = process.env.TRAEF_ROD ? path.resolve(process.env.TRAEF_ROD) : path.resolve(__dirname, '..');
const SERVER_JS = path.join(ROD, 'server', 'server.js');

// Standard-agent til kald uden browser; hver Browser har sin egen pulje (som en rigtig browser).
const agent = new http.Agent({ keepAlive: true, maxSockets: Infinity });

// Ny tom midlertidig mappe.
function nyMappe(prefiks = 'traef-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefiks));
}

// Slet en mappe (SQLite-filer kan være låst et øjeblik på Windows).
async function sletMappe(mappe) {
  for (let i = 0; i < 20; i++) {
    try {
      fs.rmSync(mappe, { recursive: true, force: true });
      return;
    } catch {
      await sleepTil(100);
    }
  }
}

function sleepTil(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Finder en ledig TCP-port ved at lade OS'et vælge.
function findLedigPort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// Lavniveau-kald. Stien sendes uændret (vigtigt for sti-traversal-tests, hvor fetch/URL ville normalisere "..").
function raatKald({ port, metode = 'GET', sti, headers = {}, body = null, timeout = 60000, agent: a = agent }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: metode, path: sti, headers, agent: a },
      (res) => {
        const dele = [];
        res.on('data', (d) => dele.push(d));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buffer: Buffer.concat(dele) }));
        res.on('error', reject);
      }
    );
    req.setTimeout(timeout, () => req.destroy(new Error(`Timeout efter ${timeout} ms: ${metode} ${sti}`)));
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

// Starter serveren som child process med fri port og ny DATA_DIR. Returnerer et server-objekt.
// dataDir: brug en eksisterende mappe (fx til migration og genstart); den slettes så ikke ved stop().
async function startServer({ env = {}, logTilKonsol = false, ventMs = 30000, dataDir: egenDataDir } = {}) {
  if (!fs.existsSync(SERVER_JS)) throw new Error(`Serveren findes ikke: ${SERVER_JS}`);
  const port = await findLedigPort();
  const dataDir = egenDataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'traef-test-'));
  const log = [];
  const proces = spawn(process.execPath, [SERVER_JS], {
    cwd: ROD,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const gem = (kilde) => (d) => {
    const t = d.toString();
    log.push(t);
    if (log.length > 2000) log.shift();
    if (logTilKonsol) process.stderr.write(`[server ${kilde}] ${t}`);
  };
  proces.stdout.on('data', gem('ud'));
  proces.stderr.on('data', gem('fejl'));

  let afsluttet = null;
  const afslutning = new Promise((resolve) => {
    proces.on('exit', (code, signal) => {
      afsluttet = { code, signal };
      resolve(afsluttet);
    });
  });

  // Vent til /api/info svarer (eller processen dør).
  const start = Date.now();
  let sidsteFejl = null;
  for (let forsoeg = 0; ; forsoeg++) {
    if (afsluttet) {
      throw new Error(`Serveren stoppede under opstart (kode ${afsluttet.code}).\n${log.join('')}`);
    }
    try {
      const r = await raatKald({ port, sti: '/api/info', timeout: 2000 });
      if (r.status === 200) break;
      sidsteFejl = new Error(`status ${r.status}`);
    } catch (e) {
      sidsteFejl = e;
    }
    if (Date.now() - start > ventMs) {
      proces.kill();
      throw new Error(`Serveren svarede ikke inden ${ventMs} ms (${sidsteFejl && sidsteFejl.message}).\n${log.join('')}`);
    }
    await sleepTil(Math.min(25 * (forsoeg + 1), 200));
  }

  const server = {
    port,
    url: `http://127.0.0.1:${port}`,
    dataDir,
    proces,
    log,
    get afsluttet() {
      return afsluttet;
    },
    browser(navn, valg) {
      return new Browser(server, navn, valg);
    },
    async stop() {
      for (const s of server._stroemme) s.luk();
      for (const b of server._browsere) b.agent.destroy();
      if (!afsluttet) {
        proces.kill();
        await afslutning;
      }
      if (!egenDataDir) await sletMappe(dataDir);
    },
    _stroemme: new Set(),
    _browsere: new Set(),
  };
  return server;
}

// En "browser" med egen cookie-krukke og egen forbindelsespulje (Chrome bruger højst 6 pr. vært).
class Browser {
  constructor(server, navn = 'browser', { maxSockets = 6 } = {}) {
    this.agent = new http.Agent({ keepAlive: true, maxSockets });
    this.server = server;
    server._browsere.add(this);
    this.navn = navn;
    this.cookies = new Map();
    this.sidsteSetCookie = [];
  }

  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  gemCookies(headers) {
    const liste = headers['set-cookie'] || [];
    this.sidsteSetCookie = liste;
    for (const linje of liste) {
      const [foerste, ...attr] = linje.split(';').map((s) => s.trim());
      const lig = foerste.indexOf('=');
      const navn = foerste.slice(0, lig);
      const vaerdi = foerste.slice(lig + 1);
      const a = Object.fromEntries(
        attr.map((x) => {
          const i = x.indexOf('=');
          return i < 0 ? [x.toLowerCase(), true] : [x.slice(0, i).toLowerCase(), x.slice(i + 1)];
        })
      );
      const udloebet =
        vaerdi === '' ||
        (a['max-age'] !== undefined && Number(a['max-age']) <= 0) ||
        (a.expires && Date.parse(a.expires) < Date.now());
      if (udloebet) this.cookies.delete(navn);
      else this.cookies.set(navn, vaerdi);
    }
  }

  // Kald API'et. body (objekt) sendes som JSON; raa = Buffer/streng sendes som den er.
  async kald(metode, sti, body, { headers = {}, raa } = {}) {
    const h = { ...headers };
    const ck = this.cookieHeader();
    if (ck) h.cookie = ck;
    let data = null;
    if (raa !== undefined) {
      data = raa;
    } else if (body !== undefined) {
      data = JSON.stringify(body);
      h['content-type'] = h['content-type'] || 'application/json';
    }
    if (data != null) h['content-length'] = Buffer.byteLength(data);
    const t0 = performance.now();
    const r = await raatKald({ port: this.server.port, metode, sti, headers: h, body: data, agent: this.agent });
    const ms = performance.now() - t0;
    this.gemCookies(r.headers);
    const tekst = r.buffer.toString('utf8');
    let json = null;
    if ((r.headers['content-type'] || '').includes('json')) {
      try {
        json = JSON.parse(tekst);
      } catch {
        json = null;
      }
    }
    return { status: r.status, headers: r.headers, data: json, tekst, buffer: r.buffer, ms };
  }

  get(sti, o) {
    return this.kald('GET', sti, undefined, o);
  }
  post(sti, body, o) {
    return this.kald('POST', sti, body === undefined ? {} : body, o);
  }
  put(sti, body, o) {
    return this.kald('PUT', sti, body, o);
  }
  del(sti, o) {
    return this.kald('DELETE', sti, undefined, o);
  }

  // Åbner en SSE-strøm. Venter på svar-headers (serveren bør flushe headers med det samme).
  async stroem(sti, { ventPaaHeaders = true } = {}) {
    const s = new SseStroem(this, sti);
    this.server._stroemme.add(s);
    if (ventPaaHeaders) await s.aaben;
    return s;
  }
}

// Læser en SSE-strøm og samler hændelser. vent(pred) venter på en hændelse uden faste pauser.
class SseStroem {
  constructor(browser, sti) {
    this.browser = browser;
    this.sti = sti;
    this.haendelser = []; // { event, data, raa, tid }
    this.pings = 0;
    this.status = null;
    this.lukket = false;
    this._ventere = new Set();
    this._lyttere = new Set();
    let buffer = '';
    this.aaben = new Promise((resolve, reject) => {
      const headers = { accept: 'text/event-stream' };
      const ck = browser.cookieHeader();
      if (ck) headers.cookie = ck;
      this.req = http.request(
        { host: '127.0.0.1', port: browser.server.port, path: sti, headers, agent: false },
        (res) => {
          this.status = res.statusCode;
          this.headers = res.headers;
          this.res = res;
          res.setEncoding('utf8');
          res.on('data', (d) => {
            buffer += d.replace(/\r\n?/g, '\n');
            let i;
            while ((i = buffer.indexOf('\n\n')) >= 0) {
              const blok = buffer.slice(0, i);
              buffer = buffer.slice(i + 2);
              this._blok(blok);
            }
          });
          res.on('close', () => this._slut());
          res.on('error', () => this._slut());
          resolve(this);
        }
      );
      this.req.on('error', (e) => {
        this._slut();
        if (!this.lukket) reject(e);
        else resolve(this);
      });
      this.req.end();
    });
    this.aaben.catch(() => {});
  }

  _blok(blok) {
    let event = 'message';
    const data = [];
    let kunKommentar = true;
    for (const linje of blok.split('\n')) {
      if (linje === '') continue;
      if (linje.startsWith(':')) {
        if (linje.slice(1).trim() === 'ping') this.pings++;
        continue;
      }
      kunKommentar = false;
      const i = linje.indexOf(':');
      const felt = i < 0 ? linje : linje.slice(0, i);
      let v = i < 0 ? '' : linje.slice(i + 1);
      if (v.startsWith(' ')) v = v.slice(1);
      if (felt === 'event') event = v;
      else if (felt === 'data') data.push(v);
    }
    if (kunKommentar || data.length === 0) return;
    const raa = data.join('\n');
    let parsed = raa;
    try {
      parsed = JSON.parse(raa);
    } catch {}
    const h = { event, data: parsed, raa, tid: performance.now() };
    this.haendelser.push(h);
    for (const fn of this._lyttere) fn(h);
    for (const v of this._ventere) {
      if (v.pred(h)) {
        this._ventere.delete(v);
        clearTimeout(v.timer);
        v.resolve(h);
      }
    }
  }

  _slut() {
    if (this.lukket) return;
    this.lukket = true;
    for (const v of this._ventere) {
      clearTimeout(v.timer);
      v.reject(new Error(`SSE-strømmen ${this.sti} lukkede, mens vi ventede på: ${v.beskrivelse}`));
    }
    this._ventere.clear();
  }

  // Vent på første hændelse (også tidligere modtagne) der opfylder pred.
  vent(pred, { timeout = 10000, beskrivelse = 'hændelse', fraIndeks = 0 } = {}) {
    for (let i = fraIndeks; i < this.haendelser.length; i++) {
      if (pred(this.haendelser[i])) return Promise.resolve(this.haendelser[i]);
    }
    if (this.lukket) return Promise.reject(new Error(`SSE-strømmen ${this.sti} er lukket (${beskrivelse})`));
    return new Promise((resolve, reject) => {
      const v = { pred, resolve, reject, beskrivelse };
      v.timer = setTimeout(() => {
        this._ventere.delete(v);
        reject(new Error(`Ventede ${timeout} ms på ${beskrivelse} på ${this.sti} uden at få den`));
      }, timeout);
      this._ventere.add(v);
    });
  }

  // Kald fn for hver ny hændelse.
  paa(fn) {
    this._lyttere.add(fn);
  }

  // Hændelser af en bestemt type.
  af(event) {
    return this.haendelser.filter((h) => h.event === event);
  }

  luk() {
    this.lukket = true;
    for (const v of this._ventere) {
      clearTimeout(v.timer);
      v.reject(new Error('SSE-strømmen blev lukket'));
    }
    this._ventere.clear();
    try {
      this.req.destroy();
    } catch {}
    this.browser.server._stroemme.delete(this);
  }
}

// Åbner databasen skrivebeskyttet (WAL tillader læsning mens serveren kører).
function aabnDb(server) {
  const { DatabaseSync } = require('node:sqlite');
  return new DatabaseSync(path.join(server.dataDir, 'butik.db'), { readOnly: true });
}

// Tjekker at alle saldi = summen af bevægelser og at ingen saldo er negativ. Returnerer liste af fejl.
function tjekSaldiIDb(server) {
  const db = aabnDb(server);
  try {
    const fejl = [];
    const rk = db
      .prepare(
        `SELECT d.id, d.pc_nr, d.saldo_oere AS saldo,
                COALESCE((SELECT SUM(b.beloeb_oere) FROM saldo_bevaegelser b WHERE b.deltager_id = d.id), 0) AS sum
         FROM deltagere d`
      )
      .all();
    for (const r of rk) {
      if (Number(r.saldo) !== Number(r.sum)) fejl.push(`PC ${r.pc_nr}: saldo ${r.saldo} ≠ sum af bevægelser ${r.sum}`);
      if (Number(r.saldo) < 0) fejl.push(`PC ${r.pc_nr}: negativ saldo ${r.saldo}`);
    }
    return fejl;
  } finally {
    db.close();
  }
}

// Kontoudtoget kan være et array eller { bevaegelser: [...] } – SPEC siger kun "kontoudtog".
function bevaegelserFra(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.bevaegelser)) return data.bevaegelser;
  throw new Error(`Ukendt format på kontoudtog: ${JSON.stringify(data).slice(0, 200)}`);
}

// Statistik over svartider.
function statistik(tal) {
  if (tal.length === 0) return { antal: 0, median: 0, p95: 0, maks: 0 };
  const s = [...tal].sort((a, b) => a - b);
  const pct = (p) => s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
  return { antal: s.length, median: pct(50), p95: pct(95), maks: s[s.length - 1] };
}

// Kører opgaver med begrænset samtidighed.
async function parallelt(elementer, antal, fn) {
  const res = new Array(elementer.length);
  let i = 0;
  const arbejdere = Array.from({ length: Math.min(antal, elementer.length) }, async () => {
    while (i < elementer.length) {
      const mit = i++;
      res[mit] = await fn(elementer[mit], mit);
    }
  });
  await Promise.all(arbejdere);
  return res;
}

module.exports = {
  ROD,
  nyMappe,
  sletMappe,
  SERVER_JS,
  findLedigPort,
  raatKald,
  startServer,
  Browser,
  SseStroem,
  aabnDb,
  tjekSaldiIDb,
  bevaegelserFra,
  statistik,
  parallelt,
};
