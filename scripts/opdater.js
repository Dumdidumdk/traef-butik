'use strict';
// Automatisk opdatering. Køres af start-butik.cmd, før serveren starter.
//
// 1. Spørger GitHub (højst 3 sek.) om der er en nyere udgivelse. Intet internet/fejl -> start normalt.
// 2. Spørger "Ny version vX findes – opdatér nu? (J/N)".
// 3. Henter zip'en, pakker den ud i opdatering\ny, tager en kopi af data\ i backup\data-DATO-TID
//    og bytter programfilerne (alt undtagen data\ og runtime\, men inkl. data\standard = varekataloget).
//    runtime\node\node.exe udskiftes kun, hvis udgivelsen har en anden node.exe.
// 4. Fejler noget, rulles alle flytninger tilbage, og den gamle version starter.
//
// Exit-kode: 10 = opdateret (start-butik.cmd starter den nye udgave), ellers 0 = start som normalt.

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { execFileSync } = require('node:child_process');
const O = require('../server/opdatering');
const { udpak } = require('./udpak');

const ROD = O.ROD;
const ARBEJD = path.join(ROD, 'opdatering');
const OPDATERET = 10;
const BEVAR = new Set(['data', 'runtime', 'backup', 'opdatering', '.git']);

const log = (t = '') => console.log(t ? '  ' + t : '');

function spoerg(tekst) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let svaret = false;
    rl.question('  ' + tekst, (svar) => {
      svaret = true;
      rl.close();
      resolve(svar.trim());
    });
    rl.on('close', () => svaret || resolve(''));
  });
}

// Kører butikken allerede (port optaget)? Så må filerne ikke byttes nu.
function portOptaget(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', (e) => resolve(e.code === 'EADDRINUSE'));
    s.listen(port, () => s.close(() => resolve(false)));
  });
}

function sha256(fil) {
  return crypto.createHash('sha256').update(fs.readFileSync(fil)).digest('hex');
}

function tidsstempel(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Omdøbning med få genforsøg (antivirus/Stifinder kan holde en fil et øjeblik).
function flyt(fra, til) {
  for (let i = 0; ; i++) {
    try {
      fs.mkdirSync(path.dirname(til), { recursive: true });
      fs.renameSync(fra, til);
      return;
    } catch (e) {
      if (i >= 9 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
}

// Arbejdsmappen ryddes, undtagen hvis en tilbagerulning ikke lykkedes helt – så ligger de gamle filer der.
const MAERKE = path.join(ARBEJD, 'LAES-MIG.txt');
function ryd() {
  if (!fs.existsSync(MAERKE)) slet(ARBEJD);
}

function slet(sti) {
  try {
    fs.rmSync(sti, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // fx en gammel node.exe, der stadig kører – ryddes næste gang
  }
}

// Find mappen i den udpakkede zip, der indeholder start-butik.cmd (normalt "traef-butik").
function findPakkeRod(mappe) {
  if (fs.existsSync(path.join(mappe, 'start-butik.cmd'))) return mappe;
  for (const n of fs.readdirSync(mappe)) {
    const m = path.join(mappe, n);
    if (fs.statSync(m).isDirectory() && fs.existsSync(path.join(m, 'start-butik.cmd'))) return m;
  }
  throw new Error('Pakken indeholder ikke start-butik.cmd');
}

// Bytter programfilerne. Hver flytning noteres, så den kan rulles tilbage.
function byt(ny, gammel, journal) {
  const emner = fs.readdirSync(ny).filter((n) => !BEVAR.has(n.toLowerCase())).map((n) => [n]);
  if (fs.existsSync(path.join(ny, 'data', 'standard'))) emner.push(['data', 'standard']);

  // Ny node.exe? Kun hvis den er anderledes end den installerede.
  const nyNode = path.join(ny, 'runtime', 'node', 'node.exe');
  const node = path.join(ROD, 'runtime', 'node', 'node.exe');
  if (fs.existsSync(nyNode) && (!fs.existsSync(node) || sha256(nyNode) !== sha256(node))) {
    emner.push(['runtime', 'node', 'node.exe']);
    log('Udgivelsen har en ny Node.js – den udskiftes også.');
  }

  for (const dele of emner) {
    const her = path.join(ROD, ...dele);
    if (fs.existsSync(her)) {
      const til = path.join(gammel, ...dele);
      flyt(her, til); // en kørende node.exe kan godt omdøbes, men ikke slettes
      journal.push([her, til]);
    }
    flyt(path.join(ny, ...dele), her);
    journal.push([path.join(ny, ...dele), her, true]);
  }
}

function rulTilbage(journal) {
  let ok = true;
  for (const [fra, til, nyFil] of journal.reverse()) {
    try {
      if (nyFil && !fs.existsSync(til)) continue;
      flyt(til, fra);
    } catch (e) {
      ok = false;
      log(`Kunne ikke flytte ${til} tilbage: ${e.message}`);
    }
  }
  return ok;
}

async function opdater(u) {
  ryd();
  if (fs.existsSync(MAERKE)) throw new Error('En tidligere opdatering blev ikke rullet helt tilbage – se opdatering\\LAES-MIG.txt');
  fs.mkdirSync(ARBEJD, { recursive: true });
  const zipFil = path.join(ARBEJD, 'pakke.zip');
  const nyMappe = path.join(ARBEJD, 'ny');
  const gammel = path.join(ARBEJD, 'gammel');

  // 1. Hent
  const mb = (b) => (b / 1024 / 1024).toFixed(0);
  let vist = 0;
  process.stdout.write(`  Henter ${u.zip.navn}${u.zip.stoerrelse ? ` (${mb(u.zip.stoerrelse)} MB)` : ''} …`);
  await O.hent(u.zip.url, {
    tilFil: zipFil,
    inaktivTimeout: 30000,
    vedData: (n) => {
      if (n - vist >= 5 * 1024 * 1024) {
        vist = n;
        process.stdout.write('.');
      }
    },
  });
  process.stdout.write('\n');
  const str = fs.statSync(zipFil).size;
  if (u.zip.stoerrelse && str !== u.zip.stoerrelse) throw new Error(`Downloaden er ufuldstændig (${str} af ${u.zip.stoerrelse} bytes)`);
  if (u.zip.sha256 && sha256(zipFil) !== u.zip.sha256) throw new Error('Downloaden er beskadiget (forkert kontrolsum)');

  // 2. Pak ud og tjek pakken
  log('Pakker ud …');
  udpak(zipFil, nyMappe);
  const ny = findPakkeRod(nyMappe);
  for (const f of ['server/server.js', 'public', 'version.json']) {
    if (!fs.existsSync(path.join(ny, f))) throw new Error(`Pakken mangler ${f}`);
  }
  const nyVersion = O.installeretVersion(ny);
  if (O.sammenlign(nyVersion, O.installeretVersion()) <= 0) {
    throw new Error(`Pakken har versionsnummer ${nyVersion} i version.json – ikke nyere end den installerede`);
  }
  // Syntakstjek af serverfilerne med den node, der skal køre dem
  const nyNode = path.join(ny, 'runtime', 'node', 'node.exe');
  const node = fs.existsSync(nyNode) ? nyNode : process.execPath;
  for (const f of fs.readdirSync(path.join(ny, 'server')).filter((f) => f.endsWith('.js'))) {
    execFileSync(node, ['--check', path.join(ny, 'server', f)], { stdio: 'pipe' });
  }

  // 3. Kopi af data\ (database og egne billeder) – data\ selv røres aldrig
  const data = path.join(ROD, 'data');
  if (fs.existsSync(data)) {
    const kopi = path.join(ROD, 'backup', 'data-' + tidsstempel());
    fs.cpSync(data, kopi, { recursive: true, errorOnExist: true, force: false });
    log(`Kopi af data gemt i ${path.relative(ROD, kopi)}`);
  }

  // 4. Byt programfilerne – ved fejl rulles alt tilbage
  const journal = [];
  try {
    byt(ny, gammel, journal);
  } catch (e) {
    const ok = rulTilbage(journal);
    if (!ok) {
      fs.writeFileSync(MAERKE, 'Opdateringen fejlede, og ikke alle filer kunne flyttes tilbage.\r\n'
        + 'De gamle programfiler ligger i mappen "gammel", de nye i "ny". data\\ er ikke rørt (kopi i backup\\).\r\n'
        + 'Pak evt. den nyeste zip ud på ny og kopiér data\\ derover. Slet så denne mappe.\r\n');
    }
    throw new Error(`${e.message}${ok ? '' : ' (tilbagerulning ufuldstændig – se backup-mappen)'}`);
  }
  slet(ARBEJD);
  return nyVersion;
}

async function main() {
  if (O.slaaetFra()) return 0;
  ryd(); // rester fra en tidligere opdatering (fx den gamle node.exe)

  let u;
  try {
    u = await O.nyesteUdgivelse({ timeout: 3000 });
  } catch {
    return 0; // intet internet eller GitHub svarer ikke – start som normalt
  }
  const har = O.installeretVersion();
  if (O.sammenlign(u.version, har) <= 0 || !u.zip) return 0;

  log('');
  log(`Ny version v${u.version} findes (du har v${har}).`);
  if (u.url) log(`Nyheder: ${u.url}`);
  if (await portOptaget(Number(process.env.PORT) || 3000)) {
    log('Butikken kører allerede i et andet vindue – luk den først for at opdatere.');
    return 0;
  }
  const svar = await spoerg(`Ny version v${u.version} findes - opdatér nu? (J/N) `);
  if (!/^(j|ja|y|yes)$/i.test(svar)) {
    log('Springer opdateringen over.');
    return 0;
  }

  try {
    const v = await opdater(u);
    log(`Opdateret til v${v}. Starter butikken …`);
    return OPDATERET;
  } catch (e) {
    ryd();
    log('');
    log(`Opdateringen mislykkedes: ${e.message}`);
    log(`Den gamle version (v${har}) bevares og starter nu. Dine data er ikke rørt.`);
    log('');
    return 0;
  }
}

main().then(
  (kode) => process.exit(kode),
  (e) => {
    log(`Uventet fejl i opdateringen: ${e.message}`);
    process.exit(0);
  },
);
