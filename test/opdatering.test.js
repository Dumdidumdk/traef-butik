'use strict';
// Automatisk opdatering: versionstjek, udpakning, scripts\opdater.js og start-butik.cmd.
// En falsk "GitHub" kører lokalt (TRAEF_OPDATERING_URL), og hver test bruger sin egen kopi af installationen
// i en midlertidig mappe – den rigtige mappe røres ikke. Kør: node --test test/opdatering.test.js

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { ROD, nyMappe, sletMappe, findLedigPort, startServer } = require('./hjaelp.js');
const { zip } = require(path.join(ROD, 'server', 'xlsx.js'));
const { udpak } = require(path.join(ROD, 'scripts', 'udpak.js'));
const O = require(path.join(ROD, 'server', 'opdatering.js'));

const PROGRAM = ['server', 'public', 'scripts', 'start-butik.cmd', 'version.json', 'README.md'];
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const shaFil = (f) => sha(fs.readFileSync(f));
const laes = (rod, ...d) => fs.readFileSync(path.join(rod, ...d), 'utf8');
const version = (rod) => JSON.parse(laes(rod, 'version.json')).version;

// Alle filer under en mappe -> { relativ sti: sha256 }
function fingeraftryk(mappe) {
  const ud = {};
  const gaa = (m) => {
    for (const e of fs.readdirSync(m, { withFileTypes: true })) {
      const f = path.join(m, e.name);
      if (e.isDirectory()) gaa(f);
      else ud[path.relative(mappe, f)] = shaFil(f);
    }
  };
  if (fs.existsSync(mappe)) gaa(mappe);
  return ud;
}

// En installation som i release-zip'en, med "brugerdata" i data\.
function lavInstallation(mappe, v, { node = true } = {}) {
  for (const n of PROGRAM) fs.cpSync(path.join(ROD, n), path.join(mappe, n), { recursive: true });
  fs.cpSync(path.join(ROD, 'data', 'standard'), path.join(mappe, 'data', 'standard'), { recursive: true });
  fs.writeFileSync(path.join(mappe, 'version.json'), JSON.stringify({ version: v }));
  fs.writeFileSync(path.join(mappe, 'data', 'butik.db'), crypto.randomBytes(5000));
  fs.writeFileSync(path.join(mappe, 'data', 'butik.db-wal'), crypto.randomBytes(300));
  fs.mkdirSync(path.join(mappe, 'data', 'billeder'));
  fs.writeFileSync(path.join(mappe, 'data', 'billeder', 'eget-billede.png'), crypto.randomBytes(2000));
  if (node) {
    fs.mkdirSync(path.join(mappe, 'runtime', 'node'), { recursive: true });
    fs.copyFileSync(process.execPath, path.join(mappe, 'runtime', 'node', 'node.exe'));
    fs.writeFileSync(path.join(mappe, 'runtime', 'node', 'npm.cmd'), 'rem udviklerens npm skal blive\n');
  }
  return mappe;
}

// Release-zip som Compress-Archive laver den: "traef-butik\..." med omvendte skråstreger.
// aendr(mappe) kan rette i pakken, før den zippes.
function lavPakke(v, { node = false, nyNode = false, aendr } = {}) {
  const m = nyMappe('traef-pakke-');
  for (const n of PROGRAM) fs.cpSync(path.join(ROD, n), path.join(m, n), { recursive: true });
  fs.cpSync(path.join(ROD, 'data', 'standard'), path.join(m, 'data', 'standard'), { recursive: true });
  fs.writeFileSync(path.join(m, 'version.json'), JSON.stringify({ version: v }));
  fs.writeFileSync(path.join(m, 'public', 'NY-I-PAKKEN.txt'), 'v' + v);
  fs.writeFileSync(path.join(m, 'data', 'standard', 'ny-katalogvare.svg'), '<svg/>');
  // node: samme node.exe som den installerede. nyNode: en anden node.exe (ekstra bytes sidst i en exe ændrer
  // ikke, hvordan den kører, men giver en anden kontrolsum). Uden begge er der ingen runtime i pakken (hurtigere test).
  if (node || nyNode) {
    fs.mkdirSync(path.join(m, 'runtime', 'node'), { recursive: true });
    const nodeBuf = fs.readFileSync(process.execPath);
    fs.writeFileSync(path.join(m, 'runtime', 'node', 'node.exe'), nyNode ? Buffer.concat([nodeBuf, Buffer.from('ny node')]) : nodeBuf);
  }
  aendr?.(m);
  const filer = Object.keys(fingeraftryk(m)).map((rel) => ({ navn: 'traef-butik\\' + rel, data: fs.readFileSync(path.join(m, rel)) }));
  const buf = zip(filer);
  fs.rmSync(m, { recursive: true, force: true });
  return buf;
}

// Falsk GitHub: /latest (release-JSON), /download (omdirigerer som GitHub) og /zip.
async function falskGithub() {
  const s = { tag: 'v1.2', zip: null, digest: undefined, haeng: false };
  const server = http.createServer((req, res) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    if (req.url === '/latest') {
      if (s.haeng) return; // svarer aldrig
      const navn = `traef-butik-klar-til-brug-${s.tag}.zip`;
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        tag_name: s.tag,
        html_url: `https://github.com/Dumdidumdk/traef-butik/releases/tag/${s.tag}`,
        draft: false,
        prerelease: false,
        assets: s.zip ? [{
          name: navn, size: s.zip.length, browser_download_url: `${base}/download/${navn}`,
          digest: s.digest === undefined ? 'sha256:' + sha(s.zip) : s.digest,
        }] : [],
      }));
    } else if (req.url.startsWith('/download/')) {
      res.writeHead(302, { Location: '/zip' }).end();
    } else if (req.url === '/zip') {
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': s.zip.length }).end(s.zip);
    } else res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  s.url = `http://127.0.0.1:${server.address().port}/latest`;
  s.luk = () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); };
  return s;
}

// Kør scripts\opdater.js med installationens egen node.exe (som start-butik.cmd gør), og svar på spørgsmålet.
function koerOpdater(rod, { url, svar = '', env = {} } = {}) {
  const node = fs.existsSync(path.join(rod, 'runtime', 'node', 'node.exe')) ? path.join(rod, 'runtime', 'node', 'node.exe') : process.execPath;
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(node, ['scripts\\opdater.js'], {
      cwd: rod, windowsHide: true,
      env: { ...process.env, TRAEF_OPDATERING: '', TRAEF_OPDATERING_URL: url, PORT: env.PORT || '1', ...env },
    });
    let ud = '';
    p.stdout.on('data', (d) => (ud += d));
    p.stderr.on('data', (d) => (ud += d));
    p.stdin.end(svar);
    p.on('close', (kode) => resolve({ kode, ud, ms: Date.now() - t0 }));
  });
}

// Program og data er præcis som før
function tjekUroert(rod, foer, data) {
  assert.deepEqual(fingeraftryk(rod + '\\server'), foer.server);
  assert.deepEqual(fingeraftryk(rod + '\\public'), foer.public);
  assert.equal(laes(rod, 'start-butik.cmd'), foer.cmd);
  assert.equal(version(rod), foer.version);
  assert.deepEqual(fingeraftryk(path.join(rod, 'data')), data);
  assert.ok(!fs.existsSync(path.join(rod, 'opdatering')), 'arbejdsmappen er ryddet op');
}
const tilstand = (rod) => ({
  server: fingeraftryk(rod + '\\server'), public: fingeraftryk(rod + '\\public'),
  cmd: laes(rod, 'start-butik.cmd'), version: version(rod),
});

describe('versionsnumre', () => {
  it('sammenligner versioner rigtigt', () => {
    assert.equal(O.sammenlign('1.2', '1.1'), 1);
    assert.equal(O.sammenlign('v1.10', '1.9'), 1);
    assert.equal(O.sammenlign('1.2.0', 'v1.2'), 0);
    assert.equal(O.sammenlign('1.2', '1.2.1'), -1);
    assert.equal(O.sammenlign('2', '1.99'), 1);
  });
  it('version.json i projektet er gyldig, og mangler den, er versionen "0"', () => {
    assert.match(O.installeretVersion(ROD), /^\d+\.\d+(\.\d+)?$/);
    const m = nyMappe();
    try {
      assert.equal(O.installeretVersion(m), '0');
    } finally {
      fs.rmSync(m, { recursive: true, force: true });
    }
  });
});

describe('udpakning', () => {
  it('pakker "\\"-stier ud, også under en sti længere end 260 tegn', () => {
    const m = nyMappe();
    try {
      const zf = path.join(m, 'a.zip');
      fs.writeFileSync(zf, zip([{ navn: 'traef-butik\\server\\x.js', data: 'x' }, { navn: 'traef-butik/æøå.txt', data: 'æøå' }]));
      const dyb = path.join(m, 'a'.repeat(100), 'b'.repeat(100), 'c'.repeat(100));
      assert.ok(dyb.length > 300);
      udpak(zf, dyb);
      assert.equal(fs.readFileSync(path.join(dyb, 'traef-butik', 'server', 'x.js'), 'utf8'), 'x');
      assert.equal(fs.readFileSync(path.join(dyb, 'traef-butik', 'æøå.txt'), 'utf8'), 'æøå');
    } finally {
      fs.rmSync(m, { recursive: true, force: true });
    }
  });
  it('afviser stier ud af mappen og ødelagte filer', () => {
    const m = nyMappe();
    try {
      fs.writeFileSync(path.join(m, 'ond.zip'), zip([{ navn: 'traef-butik\\..\\..\\ond.txt', data: 'x' }]));
      assert.throws(() => udpak(path.join(m, 'ond.zip'), path.join(m, 'ud')), /Ugyldig sti/);
      const god = zip([{ navn: 'a.txt', data: 'hej hej hej hej' }]);
      god[40] ^= 0xff; // ødelæg de komprimerede data
      fs.writeFileSync(path.join(m, 'brudt.zip'), god);
      assert.throws(() => udpak(path.join(m, 'brudt.zip'), path.join(m, 'ud2')));
      assert.ok(!fs.existsSync(path.join(m, 'ond.txt')));
    } finally {
      fs.rmSync(m, { recursive: true, force: true });
    }
  });
});

describe('opdatering ved start (scripts\\opdater.js)', () => {
  let gh;
  let rod;
  let data;
  let foer;
  before(async () => {
    gh = await falskGithub();
  });
  after(() => gh.luk());

  const nyInstallation = (opt) => {
    rod = lavInstallation(nyMappe('traef-inst-'), '1.2', opt);
    data = fingeraftryk(path.join(rod, 'data'));
    foer = tilstand(rod);
  };
  const ryd = () => sletMappe(rod);

  it('uden internet: starter med det samme, ingen spørgsmål', async () => {
    nyInstallation({ node: false });
    try {
      const r = await koerOpdater(rod, { url: 'http://127.0.0.1:9/latest' });
      assert.equal(r.kode, 0);
      assert.ok(r.ms < 2000, `tog ${r.ms} ms`);
      assert.doesNotMatch(r.ud, /Ny version|fejl/i);
      tjekUroert(rod, foer, data);
      assert.ok(!fs.existsSync(path.join(rod, 'backup')));
    } finally {
      await ryd();
    }
  });

  it('GitHub svarer ikke: giver op efter ca. 3 sek.', async () => {
    nyInstallation({ node: false });
    gh.haeng = true;
    try {
      const r = await koerOpdater(rod, { url: gh.url });
      assert.equal(r.kode, 0);
      assert.ok(r.ms >= 2900 && r.ms < 5000, `tog ${r.ms} ms`);
      assert.equal(r.ud.trim(), '');
      tjekUroert(rod, foer, data);
    } finally {
      gh.haeng = false;
      await ryd();
    }
  });

  it('TRAEF_OPDATERING=0 og samme version: intet spørgsmål', async () => {
    nyInstallation({ node: false });
    gh.tag = 'v1.2';
    gh.zip = lavPakke('1.2');
    try {
      let r = await koerOpdater(rod, { url: gh.url });
      assert.equal(r.kode, 0);
      assert.doesNotMatch(r.ud, /Ny version/);
      gh.tag = 'v1.3';
      r = await koerOpdater(rod, { url: gh.url, env: { TRAEF_OPDATERING: '0' } });
      assert.equal(r.kode, 0);
      assert.equal(r.ud.trim(), '');
      tjekUroert(rod, foer, data);
    } finally {
      await ryd();
    }
  });

  it('nyere version, svar N: intet ændres', async () => {
    nyInstallation({ node: false });
    gh.tag = 'v1.3';
    gh.zip = lavPakke('1.3');
    try {
      const r = await koerOpdater(rod, { url: gh.url, svar: 'n\n' });
      assert.equal(r.kode, 0);
      assert.match(r.ud, /Ny version v1\.3 findes - opdatér nu\? \(J\/N\)/);
      tjekUroert(rod, foer, data);
      assert.ok(!fs.existsSync(path.join(rod, 'backup')));
    } finally {
      await ryd();
    }
  });

  it('nyere version, svar J: programmet udskiftes, data bevares og kopieres, samme node beholdes', async () => {
    nyInstallation();
    gh.tag = 'v1.3';
    gh.zip = lavPakke('1.3', { node: true });
    const nodeFoer = shaFil(path.join(rod, 'runtime', 'node', 'node.exe'));
    fs.writeFileSync(path.join(rod, 'public', 'gammel-fil.txt'), 'findes ikke i v1.3');
    try {
      const r = await koerOpdater(rod, { url: gh.url, svar: 'J\n' });
      assert.equal(r.kode, 10, r.ud);
      assert.match(r.ud, /Opdateret til v1\.3/);
      assert.equal(version(rod), '1.3');
      assert.equal(laes(rod, 'public', 'NY-I-PAKKEN.txt'), 'v1.3');
      assert.ok(!fs.existsSync(path.join(rod, 'public', 'gammel-fil.txt')), 'gamle programfiler fjernes');
      assert.ok(fs.existsSync(path.join(rod, 'data', 'standard', 'ny-katalogvare.svg')), 'varekataloget opdateres');
      // data\ (database, egne billeder) er uændret
      const dataEfter = fingeraftryk(path.join(rod, 'data'));
      for (const [f, h] of Object.entries(data)) if (!f.startsWith('standard')) assert.equal(dataEfter[f], h, f);
      // Kopi i backup\data-DATO-TID
      const kopier = fs.readdirSync(path.join(rod, 'backup'));
      assert.equal(kopier.length, 1);
      assert.match(kopier[0], /^data-\d{4}-\d\d-\d\d-\d{6}$/);
      assert.deepEqual(fingeraftryk(path.join(rod, 'backup', kopier[0])), data);
      // runtime\ beholdes (samme node.exe; udviklerens npm bliver)
      assert.equal(shaFil(path.join(rod, 'runtime', 'node', 'node.exe')), nodeFoer);
      assert.ok(fs.existsSync(path.join(rod, 'runtime', 'node', 'npm.cmd')));
      assert.ok(!fs.existsSync(path.join(rod, 'opdatering')), 'arbejdsmappen ryddes op');
    } finally {
      await ryd();
    }
  });

  it('udgivelse med ny node.exe: den kørende node.exe udskiftes', async () => {
    nyInstallation();
    gh.tag = 'v1.3';
    gh.zip = lavPakke('1.3', { nyNode: true });
    try {
      const r = await koerOpdater(rod, { url: gh.url, svar: 'ja\n' });
      assert.equal(r.kode, 10, r.ud);
      assert.match(r.ud, /ny Node\.js/);
      const ny = fs.readFileSync(path.join(rod, 'runtime', 'node', 'node.exe'));
      assert.equal(ny.subarray(-7).toString(), 'ny node');
      assert.match(execFileSync(path.join(rod, 'runtime', 'node', 'node.exe'), ['--version']).toString(), /^v\d+/);
      assert.ok(fs.existsSync(path.join(rod, 'runtime', 'node', 'npm.cmd')));
      // Næste start rydder den gamle node.exe væk
      await koerOpdater(rod, { url: 'http://127.0.0.1:9/latest' });
      assert.ok(!fs.existsSync(path.join(rod, 'opdatering')));
    } finally {
      await ryd();
    }
  });

  it('beskadiget download: den gamle version bevares', async () => {
    nyInstallation({ node: false });
    gh.tag = 'v1.3';
    gh.zip = lavPakke('1.3');
    gh.digest = 'sha256:' + '0'.repeat(64);
    try {
      const r = await koerOpdater(rod, { url: gh.url, svar: 'j\n' });
      assert.equal(r.kode, 0);
      assert.match(r.ud, /mislykkedes: .*kontrolsum[\s\S]*gamle version \(v1\.2\) bevares/);
      tjekUroert(rod, foer, data);
    } finally {
      gh.digest = undefined;
      await ryd();
    }
  });

  it('pakke uden nyere version.json (glemt at rette versionen): afvises', async () => {
    nyInstallation({ node: false });
    gh.tag = 'v1.3';
    gh.zip = lavPakke('1.2');
    try {
      const r = await koerOpdater(rod, { url: gh.url, svar: 'j\n' });
      assert.equal(r.kode, 0);
      assert.match(r.ud, /ikke nyere end den installerede/);
      tjekUroert(rod, foer, data);
    } finally {
      await ryd();
    }
  });

  it('pakke med syntaksfejl i serveren: afvises før noget byttes', async () => {
    nyInstallation({ node: false });
    gh.tag = 'v1.3';
    gh.zip = lavPakke('1.3', { aendr: (m) => fs.appendFileSync(path.join(m, 'server', 'api.js'), '\n}}}(\n') });
    try {
      const r = await koerOpdater(rod, { url: gh.url, svar: 'j\n' });
      assert.equal(r.kode, 0);
      assert.match(r.ud, /mislykkedes/);
      tjekUroert(rod, foer, data);
    } finally {
      await ryd();
    }
  });

  it('fejl midt i udskiftningen: alt rulles tilbage', async () => {
    nyInstallation();
    gh.tag = 'v1.3';
    gh.zip = lavPakke('1.3');
    // En proces med "public" som arbejdsmappe gør, at mappen ikke kan omdøbes (som når Stifinder har den åben).
    // public kommer efter README.md og .gitignore, så noget er allerede byttet, når det fejler.
    const laas = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { cwd: path.join(rod, 'public'), windowsHide: true });
    try {
      const r = await koerOpdater(rod, { url: gh.url, svar: 'j\n' });
      assert.equal(r.kode, 0, r.ud);
      assert.match(r.ud, /mislykkedes[\s\S]*gamle version \(v1\.2\) bevares/);
      assert.doesNotMatch(r.ud, /ufuldstændig/);
      tjekUroert(rod, foer, data);
      assert.equal(laes(rod, 'README.md'), laes(ROD, 'README.md'));
    } finally {
      laas.kill();
      await new Promise((r) => laas.once('exit', r));
      await ryd();
    }
  });

  it('butikken kører allerede (porten er optaget): opdaterer ikke', async () => {
    nyInstallation({ node: false });
    gh.tag = 'v1.3';
    gh.zip = lavPakke('1.3');
    const optaget = http.createServer();
    await new Promise((r) => optaget.listen(0, r));
    try {
      const r = await koerOpdater(rod, { url: gh.url, svar: 'j\n', env: { PORT: String(optaget.address().port) } });
      assert.equal(r.kode, 0);
      assert.match(r.ud, /kører allerede/);
      tjekUroert(rod, foer, data);
    } finally {
      optaget.close();
      await ryd();
    }
  });
});

describe('start-butik.cmd', () => {
  let gh;
  before(async () => {
    gh = await falskGithub();
  });
  after(() => gh.luk());

  // Starter start-butik.cmd, venter på at serveren melder sig, og stopper den igen.
  async function koerCmd(rod, { svar = '', url }) {
    const port = await findLedigPort();
    const dataDir = nyMappe('traef-cmd-data-');
    const p = spawn('cmd.exe', ['/d', '/c', path.join(rod, 'start-butik.cmd')], {
      cwd: rod, windowsHide: true,
      env: { ...process.env, TRAEF_OPDATERING: '', TRAEF_OPDATERING_URL: url, PORT: String(port), DATA_DIR: dataDir },
    });
    let ud = '';
    p.stdout.on('data', (d) => (ud += d));
    p.stderr.on('data', (d) => (ud += d));
    p.stdin.write(svar);
    const t0 = Date.now();
    try {
      while (!/kører! \(v[\d.]+\)/.test(ud)) {
        if (Date.now() - t0 > 30000 || p.exitCode !== null) throw new Error('Serveren startede ikke:\n' + ud);
        await new Promise((r) => setTimeout(r, 100));
      }
      return { ud, ms: Date.now() - t0 };
    } finally {
      try { execFileSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
      await sletMappe(dataDir);
    }
  }

  it('uden internet: butikken starter normalt', async () => {
    const rod = lavInstallation(nyMappe('traef-cmd-'), '1.2');
    try {
      const r = await koerCmd(rod, { url: 'http://127.0.0.1:9/latest' });
      assert.match(r.ud, /kører! \(v1\.2\)/);
      assert.doesNotMatch(r.ud, /Ny version/);
    } finally {
      await sletMappe(rod);
    }
  });

  it('svar J: filen udskifter sig selv, og den nye version starter', async () => {
    const rod = lavInstallation(nyMappe('traef-cmd-'), '1.2');
    const data = fingeraftryk(path.join(rod, 'data'));
    gh.tag = 'v1.3';
    gh.zip = lavPakke('1.3', {
      node: true,
      // Den nye start-butik.cmd er anderledes (længere), så vi kan se, at det er den, der kører bagefter
      aendr: (m) => {
        const f = path.join(m, 'start-butik.cmd');
        fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('title Traef-butik', 'title Traef-butik\r\necho   NY START-FIL v1.3 %1\r\nrem ' + 'x'.repeat(500)));
      },
    });
    try {
      const r = await koerCmd(rod, { url: gh.url, svar: 'J\n' });
      assert.match(r.ud, /Opdateret til v1\.3/);
      assert.match(r.ud, /NY START-FIL v1\.3 efter-opdatering/);
      assert.match(r.ud, /kører! \(v1\.3\)/);
      const efter = fingeraftryk(path.join(rod, 'data'));
      for (const [f, h] of Object.entries(data)) if (!f.startsWith('standard')) assert.equal(efter[f], h, f);
    } finally {
      await sletMappe(rod);
    }
  });
});

describe('admin: besked om ny version', () => {
  it('GET /api/admin/version viser ny version fra GitHub (og intet uden internet)', async () => {
    const gh = await falskGithub();
    gh.tag = 'v9.9';
    const s1 = await startServer({ env: { TRAEF_OPDATERING: '', TRAEF_OPDATERING_URL: gh.url } });
    const s2 = await startServer({ env: { TRAEF_OPDATERING: '', TRAEF_OPDATERING_URL: 'http://127.0.0.1:9/latest' } });
    try {
      for (const s of [s1, s2]) {
        const b = s.browser();
        assert.equal((await b.post('/api/personale/opsaet', { navn: 'Admin', kode: 'hemmelig1' })).status < 300, true);
      }
      const ekspedient = s1.browser();
      assert.equal((await ekspedient.get('/api/admin/version')).status, 401);
      // Serveren tjekker 2 sek. efter start
      const b = s1.browser();
      await b.post('/api/personale/login', { navn: 'Admin', kode: 'hemmelig1' });
      let v;
      for (let i = 0; i < 50; i++) {
        v = (await b.get('/api/admin/version')).data;
        if (v?.ny) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      assert.deepEqual(v, { version: O.installeretVersion(ROD), ny: { version: '9.9', url: 'https://github.com/Dumdidumdk/traef-butik/releases/tag/v9.9' } });

      await new Promise((r) => setTimeout(r, 2500));
      const b2 = s2.browser();
      await b2.post('/api/personale/login', { navn: 'Admin', kode: 'hemmelig1' });
      const r2 = await b2.get('/api/admin/version');
      assert.equal(r2.status, 200);
      assert.equal(r2.data.ny, null);
      assert.doesNotMatch(s2.log?.join?.('') || '', /Serverfejl/);
    } finally {
      await s1.stop();
      await s2.stop();
      await gh.luk();
    }
  });
});
