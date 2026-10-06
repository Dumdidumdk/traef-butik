'use strict';
// Versionsnummer og tjek af nyeste udgivelse på GitHub (kun indbygget Node).
// Bruges af serveren (besked på admin-siden) og af scripts/opdater.js (opdatering ved start).
//
// Miljøvariabler:
//   TRAEF_OPDATERING=0       slå tjekket helt fra
//   TRAEF_OPDATERING_URL     anden adresse end GitHub (http(s):// eller file:///…/release.json) – bruges til test

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { fileURLToPath } = require('node:url');

const ROD = path.resolve(__dirname, '..');
const GITHUB_URL = 'https://api.github.com/repos/Dumdidumdk/traef-butik/releases/latest';
const ZIP_NAVN = /^traef-butik-klar-til-brug-v[\d.]+\.zip$/i;

const slaaetFra = () => process.env.TRAEF_OPDATERING === '0';
const apiUrl = () => process.env.TRAEF_OPDATERING_URL || GITHUB_URL;

// Den installerede version fra version.json ("0" hvis filen mangler).
function installeretVersion(rod = ROD) {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(rod, 'version.json'), 'utf8')).version || '0');
  } catch {
    return '0';
  }
}

// "v1.10" > "1.9" > "1.2.0" = "1.2". Giver -1, 0 eller 1.
function sammenlign(a, b) {
  const dele = (v) => String(v).trim().replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0);
  const x = dele(a);
  const y = dele(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

// GET af en adresse. Følger omdirigeringer (GitHub sender downloads videre til et CDN).
// tilFil: gem i en fil i stedet for at returnere en Buffer. timeout: samlet frist; inaktivTimeout: frist uden data.
function hent(url, { timeout = 0, inaktivTimeout = 30000, tilFil = null, maksBytes = 500 * 1024 * 1024, vedData } = {}) {
  if (url.startsWith('file:')) {
    const fil = fileURLToPath(url);
    if (tilFil) {
      fs.copyFileSync(fil, tilFil);
      return Promise.resolve(null);
    }
    return fs.promises.readFile(fil);
  }
  return new Promise((resolve, reject) => {
    let faerdig = false;
    let aktuel = null;
    const slut = (fejl, vaerdi) => {
      if (faerdig) return;
      faerdig = true;
      clearTimeout(samlet);
      if (fejl) {
        aktuel?.destroy();
        reject(fejl);
      } else resolve(vaerdi);
    };
    const samlet = timeout ? setTimeout(() => slut(new Error('Tidsfristen udløb')), timeout) : null;

    const kald = (adr, spring) => {
      const mod = adr.startsWith('https:') ? https : http;
      const req = mod.get(adr, { headers: { 'User-Agent': 'traef-butik', Accept: 'application/vnd.github+json, */*' } }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          if (spring >= 5) return slut(new Error('For mange omdirigeringer'));
          return kald(new URL(res.headers.location, adr).href, spring + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return slut(new Error(`HTTP ${res.statusCode} fra ${adr}`));
        }
        let antal = 0;
        const dele = [];
        const ud = tilFil ? fs.createWriteStream(tilFil) : null;
        ud?.on('error', (e) => slut(e));
        res.on('data', (d) => {
          antal += d.length;
          if (antal > maksBytes) return slut(new Error('Filen er for stor'));
          vedData?.(antal);
          if (ud) ud.write(d);
          else dele.push(d);
        });
        res.on('error', (e) => slut(e));
        res.on('end', () => {
          if (faerdig) return;
          if (ud) ud.end(() => slut(null, null));
          else slut(null, Buffer.concat(dele));
        });
      });
      aktuel = req;
      req.setTimeout(inaktivTimeout, () => slut(new Error('Ingen svar fra serveren')));
      req.on('error', (e) => slut(e));
    };
    kald(url, 0);
  });
}

// Nyeste udgivelse: { version, tag, url, zip: { navn, url, stoerrelse, sha256 } | null }.
// Kaster ved fejl (intet internet, timeout, ugyldigt svar).
async function nyesteUdgivelse({ timeout = 3000 } = {}) {
  const buf = await hent(apiUrl(), { timeout, inaktivTimeout: timeout, maksBytes: 2 * 1024 * 1024 });
  const r = JSON.parse(buf.toString('utf8'));
  if (!r || typeof r.tag_name !== 'string' || r.draft || r.prerelease) throw new Error('Ugyldigt svar fra GitHub');
  const asset = (r.assets || []).find((a) => ZIP_NAVN.test(a.name || ''));
  const sha = /^sha256:([0-9a-f]{64})$/i.exec(asset?.digest || '');
  return {
    version: r.tag_name.replace(/^v/i, ''),
    tag: r.tag_name,
    url: r.html_url || '',
    zip: asset
      ? { navn: asset.name, url: asset.browser_download_url, stoerrelse: asset.size || 0, sha256: sha ? sha[1].toLowerCase() : null }
      : null,
  };
}

// ---------- Til serveren: tjek i baggrunden, svar fra hukommelsen ----------

let senest = null; // { version, url } for en nyere udgivelse, ellers null
let timer = null;

async function tjekNu() {
  if (slaaetFra()) return;
  try {
    const u = await nyesteUdgivelse({ timeout: 5000 });
    senest = sammenlign(u.version, installeretVersion()) > 0 ? { version: u.version, url: u.url } : null;
  } catch {
    // Intet internet eller GitHub svarer ikke – ingen besked, ingen fejl.
  }
}

// Tjek kort efter start og derefter hver 6. time.
function startBaggrundstjek() {
  if (slaaetFra() || timer) return;
  setTimeout(tjekNu, 2000).unref();
  timer = setInterval(tjekNu, 6 * 60 * 60 * 1000);
  timer.unref();
}

const status = () => ({ version: installeretVersion(), ny: senest });

module.exports = { ROD, installeretVersion, sammenlign, hent, nyesteUdgivelse, startBaggrundstjek, status, slaaetFra };
