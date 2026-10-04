'use strict';
// Belastningstest: 250 kunder, SSE åben, samtidige ordrer, butikken flytter alt igennem, til sidst udbetaling.
// Kør alene: node test/belastning.js   (valgfrit: KUNDER=250)
// Afslutter med kode 0 hvis alt gik godt, ellers 1.

const assert = require('node:assert/strict');
const { startServer, tjekSaldiIDb, statistik, parallelt } = require('./hjaelp.js');

const ANTAL = Number(process.env.KUNDER || 250);
const START_BELOEB = 20000; // 200 kr. til hver
const GRAADIG_ORDRER = 20; // samme kunde sender 20 ordrer på én gang ...
const GRAADIG_RAD = 3; // ... men har kun penge til 3
const VENT_MS = 120000;
// 250 mennesker trykker ikke inden for samme millisekund: hver kundes ordrer starter tilfældigt inden for dette vindue.
// (Windows-klienter afviser ca. 200+ HELT samtidige nye forbindelser på loopback – også mod en triviel server.)
const SPREDNING_MS = Number(process.env.SPREDNING_MS || 500);

const maalinger = new Map(); // kategori → [ms]
const fejl = []; // alt der er gået galt
const uventede = []; // 5xx og netværksfejl

function maal(kategori, ms) {
  if (!maalinger.has(kategori)) maalinger.set(kategori, []);
  maalinger.get(kategori).push(ms);
}

// Kald med måling. Netværksfejl og 5xx registreres altid.
async function kald(b, kategori, metode, sti, body) {
  const t0 = performance.now();
  try {
    const r = await b.kald(metode, sti, body);
    maal(kategori, r.ms);
    if (r.status >= 500) uventede.push(`${metode} ${sti} → ${r.status} ${r.tekst.slice(0, 200)}`);
    return r;
  } catch (e) {
    maal(kategori, performance.now() - t0);
    uventede.push(`${metode} ${sti} → netværksfejl: ${e.message}`);
    return { status: 0, data: null, tekst: e.message };
  }
}

function skal(betingelse, besked) {
  if (!betingelse) fejl.push(besked);
}

const ok2xx = (r) => r.status >= 200 && r.status < 300;
const kr = (oere) => `${(oere / 100).toLocaleString('da-DK')} kr.`;

async function main() {
  const tStart = performance.now();
  console.log(`Belastningstest med ${ANTAL} kunder + 1 grådig kunde`);
  const server = await startServer();
  console.log(`Server kører på ${server.url} (DATA_DIR ${server.dataDir})`);
  const streams = [];
  try {
    // ---------- opsætning ----------
    // Butikken har et par skærme/faner åbne – derfor flere forbindelser end én kunde.
    const p = server.browser('personale', { maxSockets: 18 });
    assert.ok(ok2xx(await p.post('/api/personale/opsaet', { kode: 'belastning-123' })), 'Kunne ikke sætte personalekode');
    // Lavere grænse, så nogle ordrer bliver "bring til plads".
    const ind = (await p.get('/api/admin/indstillinger')).data;
    const somType = (gl, v) => (typeof gl === 'number' ? Number(v) : typeof gl === 'boolean' ? Boolean(Number(v)) : String(v));
    assert.ok(ok2xx(await p.put('/api/admin/indstillinger', {
      levering_min_oere: somType(ind.levering_min_oere, 4000),
      tilmelding_aaben: somType(ind.tilmelding_aaben, 1),
    })));
    const varer = (await p.get('/api/varer')).data.filter((v) => !v.udsolgt && v.pris_oere <= 3000);
    assert.ok(varer.length > 0, 'Ingen varer at bestille');
    const minLevering = 4000;

    // ---------- 1. tilmelding: halvdelen via check-in med startbeløb, resten tilmelder sig selv ----------
    console.log('1/6 Tilmelding ...');
    const kunder = [];
    for (let i = 1; i <= ANTAL; i++) kunder.push({ pc: i, pin: String(1000 + i), b: server.browser(`PC ${i}`), checkin: i % 2 === 0 });
    const graadig = { pc: 9000, pin: '9000', b: server.browser('grådig'), checkin: true, graadig: true };
    let forventetIndbetalt = 0;

    await Promise.all([...kunder, graadig].map(async (k) => {
      if (k.checkin) {
        const beloeb = k.graadig ? GRAADIG_RAD * 2000 : START_BELOEB;
        const r = await kald(p, 'check-in (opret + startbeløb)', 'POST', '/api/admin/deltagere', {
          pc_nr: k.pc, navn: `Spiller ${k.pc}`, pin: k.pin, startbeloeb_oere: beloeb, metode: 'kontant',
        });
        if (!ok2xx(r)) return skal(false, `Check-in PC ${k.pc}: ${r.status} ${r.tekst}`);
        forventetIndbetalt += beloeb;
        const l = await kald(k.b, 'login', 'POST', '/api/kunde/login', { pc_nr: k.pc, pin: k.pin });
        skal(ok2xx(l), `Login PC ${k.pc}: ${l.status} ${l.tekst}`);
        k.id = r.data.id;
      } else {
        const r = await kald(k.b, 'tilmeld', 'POST', '/api/kunde/tilmeld', { pc_nr: k.pc, navn: `Spiller ${k.pc}`, pin: k.pin });
        if (!ok2xx(r)) return skal(false, `Tilmeld PC ${k.pc}: ${r.status} ${r.tekst}`);
        k.id = r.data.id;
      }
    }));

    // ---------- 2. indbetalinger for dem der tilmeldte sig selv ----------
    console.log('2/6 Indbetalinger og godkendelse ...');
    const selv = kunder.filter((k) => !k.checkin && k.id);
    const indbetalinger = await Promise.all(selv.map((k) =>
      kald(k.b, 'indbetaling', 'POST', '/api/kunde/indbetalinger', { beloeb_oere: START_BELOEB, metode: 'mobilepay', reference: `Spiller ${k.pc}` })));
    await Promise.all(indbetalinger.map(async (r, i) => {
      if (!ok2xx(r)) return skal(false, `Indbetaling PC ${selv[i].pc}: ${r.status} ${r.tekst}`);
      const g = await kald(p, 'godkend indbetaling', 'POST', `/api/admin/indbetalinger/${r.data.id}/godkend`, {});
      if (ok2xx(g)) forventetIndbetalt += START_BELOEB;
      else skal(false, `Godkend PC ${selv[i].pc}: ${g.status} ${g.tekst}`);
    }));

    // ---------- 3. SSE for alle ----------
    console.log('3/6 Åbner SSE for alle kunder og butikken ...');
    const alle = [...kunder, graadig].filter((k) => k.id);
    const tSse = performance.now();
    await Promise.all(alle.map(async (k) => {
      const t0 = performance.now();
      k.s = await k.b.stroem('/api/kunde/stream');
      maal('SSE åbnes', performance.now() - t0);
      streams.push(k.s);
      skal(k.s.status === 200, `SSE PC ${k.pc}: status ${k.s.status}`);
    }));
    console.log(`   ${alle.length} strømme åbne på ${Math.round(performance.now() - tSse)} ms`);
    const sButik = await p.stroem('/api/butik/stream');
    streams.push(sButik);
    skal(sButik.status === 200, `Butikkens SSE: status ${sButik.status}`);

    // ---------- butikken: flytter hver ordre videre, så snart den ser den ----------
    const naeste = { ny: 'laves', laves: 'klar', klar: 'leveret' };
    const haandteret = new Set();
    const slutStatus = new Map(); // ordre-id → sidst sete status hos butikken
    const butikSaaNy = new Set();
    const behandl = (h) => {
      if (h.event !== 'ordre') return;
      const o = h.data;
      slutStatus.set(o.id, o.status);
      if (o.status === 'ny') butikSaaNy.add(o.id);
      const til = naeste[o.status];
      const noegle = `${o.id}:${o.status}`;
      if (!til || haandteret.has(noegle)) return;
      haandteret.add(noegle);
      // En rigtig skærm prøver igen ved netværksfejl.
      const proev = async (n) => {
        const r = await kald(p, `status ${o.status}→${til}`, 'POST', `/api/butik/ordrer/${o.id}/status`, { status: til });
        return r.status === 0 && n > 1 ? proev(n - 1) : r;
      };
      proev(3).then((r) => {
        // 409 er ok hvis kunden nåede at annullere først.
        if (!ok2xx(r) && !(r.status === 409 && o.status === 'ny')) skal(false, `Butik ${o.id} ${o.status}→${til}: ${r.status} ${r.tekst}`);
      });
    };
    sButik.paa(behandl);

    // ---------- 4. bestillinger ----------
    console.log('4/6 Bestiller (2 runder, 3 + 1 ordrer pr. kunde samtidig, grådig kunde sender 20) ...');
    const ordrer = new Map(); // id → { k, total, annulleret }
    let naesteVare = 0;
    const lavOrdre = () => {
      const antalLinjer = 1 + (naesteVare % 2);
      const linjer = [];
      for (let i = 0; i < antalLinjer; i++) {
        const v = varer[naesteVare++ % varer.length];
        if (!linjer.some((l) => l.vare_id === v.id)) linjer.push({ vare_id: v.id, antal: 1, pris: v.pris_oere });
      }
      const total = linjer.reduce((s, l) => s + l.pris, 0);
      return { linjer: linjer.map(({ vare_id, antal }) => ({ vare_id, antal })), total, levering: total >= minLevering ? 'bord' : 'hent' };
    };
    const bestil = async (k, o) => {
      const r = await kald(k.b, 'bestil', 'POST', '/api/kunde/ordrer', { linjer: o.linjer, levering: o.levering, note: `PC ${k.pc}` });
      if (ok2xx(r)) {
        ordrer.set(r.data.id, { k, total: r.data.total_oere, annulleret: false });
        skal(r.data.total_oere === o.total, `Ordre ${r.data.id}: total ${r.data.total_oere}, forventet ${o.total}`);
      }
      return r;
    };

    // Som efter en sideindlæsning: hver browser har et par varme keep-alive-forbindelser.
    await Promise.all(alle.map((k) => Promise.all(Array.from({ length: 4 }, () => kald(k.b, 'opvarmning (GET /api/varer)', 'GET', '/api/varer')))));

    const runde = async (antalPrKunde) => {
      await Promise.all([
        ...kunder.filter((k) => k.id).map(async (k) => {
          await new Promise((r) => setTimeout(r, Math.random() * SPREDNING_MS));
          // Højst 60 kr. pr. ordre: 3 ordrer går altid igennem, den 4. kan blive afvist pga. saldo.
          const svar = await Promise.all(Array.from({ length: antalPrKunde }, () => bestil(k, lavOrdre())));
          for (const r of svar) {
            if (!ok2xx(r) && !(r.data && r.data.kode === 'ikke_nok_penge')) skal(false, `Bestil PC ${k.pc}: ${r.status} ${r.tekst}`);
            if (!ok2xx(r) && r.data && r.data.kode === 'ikke_nok_penge') k.afvist = (k.afvist || 0) + 1;
          }
          // Hver 10. kunde fortryder sin første ordre med det samme.
          if (k.pc % 10 === 0 && !k.harAnnulleret) {
            const foerste = svar.find(ok2xx);
            if (foerste) {
              k.harAnnulleret = true;
              const a = await kald(k.b, 'annuller', 'POST', `/api/kunde/ordrer/${foerste.data.id}/annuller`, {});
              if (ok2xx(a)) ordrer.get(foerste.data.id).annulleret = true;
              else skal(a.status === 409 || a.status === 400, `Annuller PC ${k.pc}: ${a.status} ${a.tekst}`);
            }
          }
        }),
        antalPrKunde === 3 && graadig.id
          ? (async () => {
              const svar = await Promise.all(Array.from({ length: GRAADIG_ORDRER }, () =>
                bestil(graadig, { linjer: [{ vare_id: varer.find((v) => v.pris_oere === 2000).id, antal: 1 }], total: 2000, levering: 'hent' })));
              const lykkedes = svar.filter(ok2xx).length;
              graadig.lykkedes = lykkedes;
              skal(lykkedes === GRAADIG_RAD, `Grådig kunde: ${lykkedes} ordrer lykkedes, forventet ${GRAADIG_RAD}`);
              for (const r of svar.filter((r) => !ok2xx(r))) skal(r.data && r.data.kode === 'ikke_nok_penge', `Grådig: ${r.status} ${r.tekst}`);
            })()
          : null,
      ]);
    };
    const tBestil = performance.now();
    await runde(3);
    await runde(1);
    const afvist = kunder.reduce((s, k) => s + (k.afvist || 0), 0);
    console.log(`   ${ordrer.size} ordrer oprettet på ${Math.round(performance.now() - tBestil)} ms (${afvist} afvist pga. saldo – tilladt ved 4. ordre)`);

    // ---------- 5. vent til butikken har flyttet alt og kunderne har fået hændelserne ----------
    console.log('5/6 Venter på at butikken leverer alt og at kunderne får besked ...');
    const tVent = performance.now();
    await Promise.all([...ordrer].map(async ([id, o]) => {
      const slut = o.annulleret ? 'annulleret' : 'leveret';
      try {
        await sButik.vent((h) => h.event === 'ordre' && h.data.id === id && h.data.status === slut, { timeout: VENT_MS, beskrivelse: `ordre ${id} ${slut} hos butikken` });
      } catch (e) {
        skal(false, e.message);
      }
      try {
        await o.k.s.vent((h) => h.event === 'ordre' && h.data.id === id && h.data.status === slut, { timeout: VENT_MS, beskrivelse: `ordre ${id} ${slut} hos PC ${o.k.pc}` });
      } catch (e) {
        skal(false, e.message);
      }
    }));
    console.log(`   alt leveret på ${Math.round(performance.now() - tVent)} ms`);
    for (const id of ordrer.keys()) skal(butikSaaNy.has(id), `Butikken fik aldrig ordre ${id} som ny`);

    // Ingen kunde har fået andres hændelser.
    for (const k of alle) {
      const fremmede = k.s.haendelser.filter((h) => (h.event === 'ordre' || h.event === 'indbetaling') && h.data.pc_nr !== k.pc);
      skal(fremmede.length === 0, `PC ${k.pc} fik ${fremmede.length} hændelser fra andre`);
    }

    // Seneste saldo-hændelse = saldo på serveren.
    await Promise.all(alle.map(async (k) => {
      const mig = await kald(k.b, 'mig', 'GET', '/api/kunde/mig');
      if (!ok2xx(mig)) return skal(false, `mig PC ${k.pc}: ${mig.status}`);
      k.saldo = mig.data.saldo_oere;
      skal(k.saldo >= 0, `PC ${k.pc}: negativ saldo ${k.saldo}`);
      try {
        await k.s.vent((h) => h.event === 'saldo' && h.data.saldo_oere === k.saldo, { timeout: 10000, beskrivelse: `saldo ${k.saldo} hos PC ${k.pc}` });
        const saldoer = k.s.af('saldo');
        skal(saldoer[saldoer.length - 1].data.saldo_oere === k.saldo, `PC ${k.pc}: sidste saldo-hændelse ${saldoer[saldoer.length - 1].data.saldo_oere} ≠ ${k.saldo}`);
      } catch (e) {
        skal(false, e.message);
      }
    }));

    // ---------- 6. udbetaling af restsaldo til alle ----------
    console.log('6/6 Udbetaler restsaldo ...');
    const medPenge = alle.filter((k) => k.saldo > 0);
    let forventetUdbetalt = 0;
    await parallelt(medPenge, 50, async (k) => {
      const r = await kald(p, 'udbetal', 'POST', `/api/admin/deltagere/${k.id}/udbetal`, { metode: 'mobilepay', reference: `PC ${k.pc}` });
      if (!ok2xx(r)) return skal(false, `Udbetal PC ${k.pc}: ${r.status} ${r.tekst}`);
      forventetUdbetalt += k.saldo;
      try {
        await k.s.vent((h) => h.event === 'saldo' && h.data.saldo_oere === 0, { timeout: 10000, beskrivelse: `saldo 0 efter udbetaling hos PC ${k.pc}` });
      } catch (e) {
        skal(false, e.message);
      }
    });
    const u = (await kald(p, 'udbetalinger', 'GET', '/api/admin/udbetalinger')).data;
    skal(u && u.mangler.length === 0, `Efter udbetaling mangler ${u && u.mangler.length} stadig penge`);

    // ---------- regnskab ----------
    const rap = (await kald(p, 'rapport', 'GET', '/api/admin/rapport')).data;
    const omsaetning = [...ordrer.values()].filter((o) => !o.annulleret).reduce((s, o) => s + o.total, 0);
    const antalAnnulleret = [...ordrer.values()].filter((o) => o.annulleret).length;
    if (rap) {
      skal(rap.indbetalt_oere === forventetIndbetalt, `Rapport indbetalt ${rap.indbetalt_oere} ≠ forventet ${forventetIndbetalt}`);
      skal(rap.omsaetning_oere === omsaetning, `Rapport omsætning ${rap.omsaetning_oere} ≠ forventet ${omsaetning}`);
      skal(rap.udbetalt_oere === forventetUdbetalt, `Rapport udbetalt ${rap.udbetalt_oere} ≠ forventet ${forventetUdbetalt}`);
      skal(rap.samlet_saldo_oere === 0, `Samlet saldo efter udbetaling er ${rap.samlet_saldo_oere}`);
      skal(rap.antal_ordrer === ordrer.size - antalAnnulleret, `Rapport antal_ordrer ${rap.antal_ordrer} ≠ ${ordrer.size - antalAnnulleret}`);
      skal(rap.indbetalt_oere === rap.omsaetning_oere + rap.udbetalt_oere + rap.samlet_saldo_oere,
        `Regnskabet går ikke op: indbetalt ${rap.indbetalt_oere} ≠ omsætning ${rap.omsaetning_oere} + udbetalt ${rap.udbetalt_oere} + saldo ${rap.samlet_saldo_oere}`);
    } else skal(false, 'Kunne ikke hente rapporten');
    for (const f of tjekSaldiIDb(server)) skal(false, f);
    skal(server.afsluttet === null, 'Serveren døde undervejs');

    // ---------- resultat ----------
    console.log('\nSvartider (ms):');
    const raekker = [...maalinger].map(([k, v]) => ({ k, ...statistik(v) }));
    const bredde = Math.max(...raekker.map((r) => r.k.length));
    console.log(`  ${'kald'.padEnd(bredde)}  antal   median      p95     maks`);
    for (const r of raekker) {
      console.log(`  ${r.k.padEnd(bredde)}  ${String(r.antal).padStart(5)}  ${r.median.toFixed(0).padStart(7)}  ${r.p95.toFixed(0).padStart(7)}  ${r.maks.toFixed(0).padStart(7)}`);
    }
    console.log(`\nOrdrer: ${ordrer.size} (${antalAnnulleret} annulleret) · Omsætning ${kr(omsaetning)} · Indbetalt ${kr(forventetIndbetalt)} · Udbetalt ${kr(forventetUdbetalt)}`);
    console.log(`SSE-hændelser modtaget: ${alle.reduce((s, k) => s + k.s.haendelser.length, 0)} hos kunder, ${sButik.haendelser.length} hos butikken`);
    console.log(`Samlet tid: ${((performance.now() - tStart) / 1000).toFixed(1)} s`);
  } finally {
    for (const s of streams) s.luk();
    await server.stop();
  }

  const alleFejl = [...uventede.map((x) => `UVENTET: ${x}`), ...fejl];
  if (alleFejl.length) {
    // Grupér ens fejl (tal udskiftes med #), så oversigten kan læses.
    const grupper = new Map();
    for (const f of alleFejl) {
      const n = f.replace(/\d+/g, '#');
      if (!grupper.has(n)) grupper.set(n, { antal: 0, eksempel: f });
      grupper.get(n).antal++;
    }
    console.log(`\nFEJL (${alleFejl.length}, ${grupper.size} slags):`);
    for (const g of [...grupper.values()].sort((a, b) => b.antal - a.antal).slice(0, 40)) {
      console.log(`  - ${g.antal}× ${g.eksempel}`);
    }
    console.log('\nBELASTNINGSTEST: FEJLEDE');
    process.exitCode = 1;
  } else {
    console.log('\nBELASTNINGSTEST: OK – ingen 500-fejl, ingen negativ saldo, alle fik deres hændelser, regnskabet går op.');
  }
}

main().catch((e) => {
  console.error('Belastningstesten stoppede med en fejl:', e && e.stack ? e.stack : e);
  process.exitCode = 1;
});
