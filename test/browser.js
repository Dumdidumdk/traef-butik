'use strict';
// Browsertest: åbner /, /butik og /admin i headless Chrome via DevTools-protokollen og melder JavaScript-fejl,
// fejlede ressourcer og forsøg på at hente noget fra internettet. Kør: node test/browser.js
// Chrome findes via CHROME-miljøvariablen eller standardstien.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { startServer } = require('./hjaelp.js');

const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PERSONALE_KODE = 'browser-test-123';

function hentJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', (x) => (d += x));
      res.on('end', () => {
        try {
          resolve(JSON.parse(d));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

// Venter på at en betingelse bliver sand (bruges kun hvor der ikke findes en hændelse at lytte på).
async function ventPaa(fn, { timeout = 10000, interval = 100, beskrivelse = 'betingelse' } = {}) {
  const slut = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > slut) throw new Error(`Timeout: ${beskrivelse}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

// Minimal CDP-klient over WebSocket (indbygget i Node 24).
class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.ventende = new Map();
    this.lyttere = new Set();
    this.aaben = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve);
      this.ws.addEventListener('error', reject);
    });
    this.ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.ventende.has(m.id)) {
        const { resolve, reject } = this.ventende.get(m.id);
        this.ventende.delete(m.id);
        if (m.error) reject(new Error(`${m.error.message} ${m.error.data || ''}`));
        else resolve(m.result);
      } else if (m.method) {
        for (const fn of this.lyttere) fn(m);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.ventende.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(msg));
    });
  }
  // Vent på en bestemt hændelse i en session.
  vent(method, sessionId, { timeout = 15000, pred = () => true } = {}) {
    return new Promise((resolve, reject) => {
      const fn = (m) => {
        if (m.method === method && m.sessionId === sessionId && pred(m.params)) {
          this.lyttere.delete(fn);
          clearTimeout(t);
          resolve(m.params);
        }
      };
      const t = setTimeout(() => {
        this.lyttere.delete(fn);
        reject(new Error(`Timeout: ventede på ${method}`));
      }, timeout);
      this.lyttere.add(fn);
    });
  }
  luk() {
    try {
      this.ws.close();
    } catch {}
  }
}

async function startChrome() {
  const profil = fs.mkdtempSync(path.join(os.tmpdir(), 'traef-chrome-'));
  const proc = spawn(CHROME, [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profil}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-extensions',
    '--autoplay-policy=no-user-gesture-required',
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  const filen = path.join(profil, 'DevToolsActivePort');
  // Chrome skriver porten i en fil, når den er klar.
  const port = await ventPaa(() => {
    try {
      const l = fs.readFileSync(filen, 'utf8').split('\n')[0].trim();
      return l ? Number(l) : null;
    } catch {
      return null;
    }
  }, { timeout: 30000, beskrivelse: 'Chrome startede ikke (DevToolsActivePort)' });
  const version = await hentJson(`http://127.0.0.1:${port}/json/version`);
  const cdp = new Cdp(version.webSocketDebuggerUrl);
  await cdp.aaben;
  return {
    cdp,
    async stop() {
      cdp.luk();
      proc.kill();
      await new Promise((r) => (proc.exitCode !== null ? r() : proc.on('exit', r)));
      for (let i = 0; i < 20; i++) {
        try {
          fs.rmSync(profil, { recursive: true, force: true });
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 200));
        }
      }
    },
  };
}

// Åbner en side i en frisk browser-kontekst (egne cookies) og samler fejl.
async function besoeg(cdp, server, { navn, sti, cookies = [], bredde = 1280, efterLoad }) {
  const resultat = { navn, sti, bredde, fejl: [], advarsler: [], info: [] };
  const { browserContextId } = await cdp.send('Target.createBrowserContext', { disposeOnDetach: true });
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const s = (m, p) => cdp.send(m, p, sessionId);
  const host = `127.0.0.1:${server.port}`;
  const forespoergsler = new Map();

  const lytter = (m) => {
    if (m.sessionId !== sessionId) return;
    const p = m.params;
    switch (m.method) {
      case 'Runtime.exceptionThrown': {
        const d = p.exceptionDetails;
        const tekst = (d.exception && d.exception.description) || d.text;
        resultat.fejl.push(`JS-fejl: ${tekst.split('\n')[0]} (${d.url || ''}:${d.lineNumber + 1})`);
        break;
      }
      case 'Runtime.consoleAPICalled':
        if (p.type === 'error' || p.type === 'assert') {
          const tekst = p.args.map((a) => a.value ?? a.description ?? '').join(' ');
          resultat.fejl.push(`console.error: ${tekst.slice(0, 300)}`);
        } else if (p.type === 'warning') {
          resultat.advarsler.push(`console.warn: ${p.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200)}`);
        }
        break;
      case 'Log.entryAdded': {
        const e = p.entry;
        // Netværksfejl håndteres herunder med mere præcision.
        if (e.level === 'error' && e.source !== 'network') resultat.fejl.push(`Browser-log: ${e.text} ${e.url || ''}`);
        break;
      }
      case 'Network.requestWillBeSent': {
        forespoergsler.set(p.requestId, p.request.url);
        const u = new URL(p.request.url);
        if (!['data:', 'blob:', 'about:'].includes(u.protocol) && u.host !== host) {
          resultat.fejl.push(`Ekstern forespørgsel (virker ikke uden internet): ${p.request.url}`);
        }
        break;
      }
      case 'Network.responseReceived': {
        const { status, url } = p.response;
        if (status >= 400) {
          const u = new URL(url);
          // 401 fra API'et er forventet, når man ikke er logget ind.
          if (status === 401 && u.pathname.startsWith('/api/') && cookies.length === 0) resultat.info.push(`401 (forventet uden login): ${u.pathname}`);
          // Chrome spørger selv efter /favicon.ico – kun en advarsel.
          else if (u.pathname === '/favicon.ico') resultat.advarsler.push('Ingen /favicon.ico (tilføj fx <link rel="icon" href="data:,"> eller et ikon)');
          else resultat.fejl.push(`HTTP ${status}: ${u.pathname}`);
        }
        break;
      }
      case 'Network.loadingFailed':
        // Afbrudte SSE-forbindelser ved lukning er ikke fejl.
        if (!p.canceled && p.errorText !== 'net::ERR_ABORTED') {
          resultat.fejl.push(`Kunne ikke hente ${forespoergsler.get(p.requestId) || '?'}: ${p.errorText}`);
        }
        break;
    }
  };
  cdp.lyttere.add(lytter);
  try {
    await s('Runtime.enable');
    await s('Log.enable');
    await s('Network.enable');
    await s('Page.enable');
    await s('Page.setLifecycleEventsEnabled', { enabled: true });
    await s('Emulation.setDeviceMetricsOverride', { width: bredde, height: bredde < 600 ? 780 : 900, deviceScaleFactor: 1, mobile: bredde < 600 });
    for (const c of cookies) await s('Network.setCookie', { ...c, url: server.url });

    const load = cdp.vent('Page.loadEventFired', sessionId, { timeout: 20000 });
    // SSE holder en forbindelse åben, så "networkAlmostIdle" (≤ 2 forbindelser i 500 ms) bruges som "færdig".
    const roligt = cdp.vent('Page.lifecycleEvent', sessionId, { timeout: 20000, pred: (p) => p.name === 'networkAlmostIdle' });
    const nav = await s('Page.navigate', { url: server.url + sti });
    if (nav.errorText) throw new Error(`Navigering fejlede: ${nav.errorText}`);
    await load;
    await roligt.catch(() => resultat.advarsler.push('Siden blev aldrig rolig på netværket (networkAlmostIdle)'));

    const evaluer = async (udtryk) => {
      const r = await s('Runtime.evaluate', { expression: udtryk, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
      return r.result.value;
    };
    const side = await evaluer(`({
      titel: document.title,
      tekst: document.body ? document.body.innerText.trim().length : 0,
      sprog: document.documentElement.lang,
      bredde: document.documentElement.scrollWidth,
      viewport: !!document.querySelector('meta[name=viewport]'),
    })`);
    if (!side.titel) resultat.advarsler.push('Siden har ingen <title>');
    if (side.tekst === 0) resultat.fejl.push('Siden er tom (ingen synlig tekst)');
    if (side.sprog !== 'da') resultat.advarsler.push(`<html lang> er "${side.sprog}", forventede "da"`);
    if (!side.viewport) resultat.advarsler.push('Mangler <meta name="viewport">');
    if (side.bredde > bredde + 1) resultat.advarsler.push(`Vandret scroll: siden er ${side.bredde}px bred i et ${bredde}px vindue`);
    if (efterLoad) await efterLoad({ evaluer, resultat });
  } catch (e) {
    resultat.fejl.push(`Testfejl: ${e.message}`);
  } finally {
    cdp.lyttere.delete(lytter);
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
    await cdp.send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
  }
  return resultat;
}

async function main() {
  if (!fs.existsSync(CHROME)) {
    console.log(`BROWSERTEST: SPRUNGET OVER – Chrome findes ikke på ${CHROME} (sæt CHROME=sti)`);
    process.exitCode = 2;
    return;
  }
  const server = await startServer();
  const chrome = await startChrome();
  const resultater = [];
  try {
    const { cdp } = chrome;

    // Før personalekoden er sat: opsætningsskærmen.
    resultater.push(await besoeg(cdp, server, { navn: 'admin før opsætning', sti: '/admin' }));
    resultater.push(await besoeg(cdp, server, { navn: 'butik før opsætning', sti: '/butik' }));

    // Opsætning via API: personale, en vare, en kunde med penge og en ordre.
    const p = server.browser('personale');
    if ((await p.post('/api/personale/opsaet', { kode: PERSONALE_KODE })).status !== 200) throw new Error('Kunne ikke sætte personalekode');
    await p.post('/api/admin/deltagere', { pc_nr: 17, navn: 'Browser-Bente', pin: '1717', startbeloeb_oere: 20000 });
    const k = server.browser('kunde');
    await k.post('/api/kunde/login', { pc_nr: 17, pin: '1717' });
    const varer = (await k.get('/api/varer')).data;
    const o1 = (await k.post('/api/kunde/ordrer', { linjer: [{ vare_id: varer[0].id, antal: 2 }], levering: 'hent', note: 'uden is' })).data;
    await p.post(`/api/butik/ordrer/${o1.id}/status`, { status: 'laves' });
    await k.post('/api/kunde/indbetalinger', { beloeb_oere: 5000, metode: 'mobilepay', reference: 'Bente' });

    const kundeCookie = [{ name: 'kunde', value: k.cookies.get('kunde') }];
    const personaleCookie = [{ name: 'personale', value: p.cookies.get('personale') }];

    resultater.push(await besoeg(cdp, server, { navn: 'kunde, ikke logget ind', sti: '/' }));
    resultater.push(await besoeg(cdp, server, { navn: 'kunde, ikke logget ind (360 px)', sti: '/', bredde: 360 }));
    resultater.push(await besoeg(cdp, server, {
      navn: 'kunde, logget ind',
      sti: '/',
      cookies: kundeCookie,
      efterLoad: async ({ evaluer, resultat }) => {
        const tekst = await evaluer('document.body.innerText');
        if (!/17/.test(tekst)) resultat.advarsler.push('Kundesiden viser ikke PC-nummeret 17');
        const saldoKr = String(Math.floor((await k.get('/api/kunde/mig')).data.saldo_oere / 100));
        if (!tekst.includes(saldoKr)) resultat.advarsler.push(`Kundesiden ser ikke ud til at vise saldoen (${saldoKr} kr.)`);
        // Live: butikken melder ordren klar → siden bør skrive det.
        await p.post(`/api/butik/ordrer/${o1.id}/status`, { status: 'klar' });
        await ventPaa(async () => /klar/i.test(await evaluer('document.body.innerText')), { timeout: 8000, beskrivelse: 'kundesiden viste ikke "klar" efter SSE' })
          .catch((e) => resultat.fejl.push(e.message));
      },
    }));
    resultater.push(await besoeg(cdp, server, { navn: 'kunde, logget ind (360 px)', sti: '/', cookies: kundeCookie, bredde: 360 }));
    resultater.push(await besoeg(cdp, server, { navn: 'butik, ikke logget ind', sti: '/butik' }));
    resultater.push(await besoeg(cdp, server, {
      navn: 'butik, logget ind',
      sti: '/butik',
      cookies: personaleCookie,
      efterLoad: async ({ evaluer, resultat }) => {
        // En ny ordre skal dukke op live via SSE.
        const ny = (await k.post('/api/kunde/ordrer', { linjer: [{ vare_id: varer[1].id, antal: 1 }], levering: 'hent', note: '' })).data;
        await ventPaa(async () => (await evaluer('document.body.innerText')).includes(`#${ny.nr}`), { timeout: 8000, beskrivelse: `butiksskærmen viste ikke ny ordre #${ny.nr}` })
          .catch((e) => resultat.fejl.push(e.message));
      },
    }));
    resultater.push(await besoeg(cdp, server, { navn: 'butik, logget ind (360 px)', sti: '/butik', cookies: personaleCookie, bredde: 360 }));
    resultater.push(await besoeg(cdp, server, { navn: 'admin, ikke logget ind', sti: '/admin' }));
    resultater.push(await besoeg(cdp, server, { navn: 'admin, logget ind', sti: '/admin', cookies: personaleCookie }));
    resultater.push(await besoeg(cdp, server, { navn: 'admin, logget ind (360 px)', sti: '/admin', cookies: personaleCookie, bredde: 360 }));
  } finally {
    await chrome.stop();
    await server.stop();
  }

  let antalFejl = 0;
  for (const r of resultater) {
    const status = r.fejl.length ? 'FEJL' : 'ok';
    console.log(`${status.padEnd(4)}  ${r.navn} (${r.sti}, ${r.bredde}px)`);
    for (const f of r.fejl) console.log(`        ✗ ${f}`);
    for (const a of r.advarsler) console.log(`        ! ${a}`);
    antalFejl += r.fejl.length;
  }
  if (antalFejl) {
    console.log(`\nBROWSERTEST: FEJLEDE (${antalFejl} fejl)`);
    process.exitCode = 1;
  } else {
    console.log('\nBROWSERTEST: OK – ingen JavaScript-fejl, ingen fejlede filer, intet hentet fra internettet.');
  }
}

main().catch((e) => {
  console.error('Browsertesten stoppede med en fejl:', e && e.stack ? e.stack : e);
  process.exitCode = 1;
});
