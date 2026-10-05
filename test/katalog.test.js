'use strict';
// Tillæg 2, del A: varekatalog. Kør: node --test test/katalog.test.js

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROD, startServer } = require('./hjaelp.js');

const STD_DIR = path.join(ROD, 'data', 'standard');
const KATEGORIER = ['Drikke', 'Energi', 'Varme drikke', 'Mad', 'Morgenmad', 'Slik og snacks', 'Frugt og sundt', 'Udstyr'];
const BILLEDTYPER = /\.(svg|png|jpe?g|webp|gif)$/i;
const DE_14 = ['Coca-Cola 0,5 l', 'Coca-Cola Zero 0,5 l', 'Fanta 0,5 l', 'Faxe Kondi 0,5 l', 'Monster Energy', 'Red Bull', 'Vand',
  'Kaffe', 'Toast med skinke og ost', 'Toast med ost', 'Pose vingummi', 'Chips', 'Snickers', 'Pizza-slice'];

const ok2xx = (s) => s >= 200 && s < 300;
function ok(r) {
  assert.ok(ok2xx(r.status), `Uventet status ${r.status}: ${r.tekst.slice(0, 300)}`);
  return r.data;
}
const somTal = (v) => (v === true ? 1 : v === false ? 0 : Number(v));

// Alle katalogfiler i alfabetisk rækkefølge og deres varer.
function laesKatalog() {
  const filer = fs.readdirSync(STD_DIR).filter((f) => /^katalog.*\.json$/.test(f)).sort();
  const varer = [];
  for (const f of filer) {
    const indhold = JSON.parse(fs.readFileSync(path.join(STD_DIR, f), 'utf8'));
    assert.ok(Array.isArray(indhold), `${f} skal være et JSON-array`);
    for (const v of indhold) varer.push({ ...v, _fil: f });
  }
  return { filer, varer };
}

describe('Katalogfilerne', () => {
  let katalog;
  before(() => {
    katalog = laesKatalog();
  });

  it('katalog.json og katalog-2.json findes og er gyldig JSON', () => {
    assert.ok(katalog.filer.includes('katalog.json'), 'Mangler data/standard/katalog.json');
    assert.ok(katalog.filer.includes('katalog-2.json'), 'Mangler data/standard/katalog-2.json');
    assert.ok(katalog.varer.length > 14, `Kataloget skal have "mange flere" varer end 14 (har ${katalog.varer.length})`);
  });

  it('hver vare har gyldige felter', () => {
    for (const v of katalog.varer) {
      const hvor = `${v._fil}: ${v.katalog_id || JSON.stringify(v).slice(0, 60)}`;
      assert.match(String(v.katalog_id), /^[a-z0-9]+(-[a-z0-9]+)*$/, `${hvor}: katalog_id må kun have små bogstaver, tal og bindestreger`);
      assert.equal(typeof v.navn, 'string', `${hvor}: navn`);
      assert.ok(v.navn.trim().length > 0 && v.navn.length <= 80, `${hvor}: navn skal være 1–80 tegn`);
      assert.equal(typeof v.beskrivelse, 'string', `${hvor}: beskrivelse`);
      assert.ok(KATEGORIER.includes(v.kategori), `${hvor}: ukendt kategori "${v.kategori}"`);
      assert.ok(Number.isInteger(v.pris_oere) && v.pris_oere > 0 && v.pris_oere < 100000, `${hvor}: pris_oere skal være et positivt heltal (${v.pris_oere})`);
      assert.equal(typeof v.standard_aktiv, 'boolean', `${hvor}: standard_aktiv skal være true/false`);
      assert.ok(Number.isInteger(v.sortering), `${hvor}: sortering skal være et heltal`);
      assert.equal(typeof v.billede, 'string', `${hvor}: billede`);
      assert.match(v.billede, BILLEDTYPER, `${hvor}: billedet skal være svg/png/jpg/webp/gif`);
      assert.ok(!/[\\/]|\.\./.test(v.billede), `${hvor}: billede skal være et filnavn, ikke en sti`);
    }
  });

  it('katalog_id er unikke på tværs af filerne', () => {
    const set = new Map();
    for (const v of katalog.varer) {
      assert.ok(!set.has(v.katalog_id), `katalog_id "${v.katalog_id}" findes både i ${set.get(v.katalog_id)} og ${v._fil}`);
      set.set(v.katalog_id, v._fil);
    }
    const navne = new Set();
    for (const v of katalog.varer) {
      assert.ok(!navne.has(v.navn.toLowerCase()), `Navnet "${v.navn}" findes to gange i kataloget`);
      navne.add(v.navn.toLowerCase());
    }
  });

  it('alle billeder findes og SVG-filerne ser rigtige ud', () => {
    for (const v of katalog.varer) {
      const fil = path.join(STD_DIR, v.billede);
      assert.ok(fs.existsSync(fil), `${v.katalog_id}: billedet ${v.billede} findes ikke i data/standard/`);
      const indhold = fs.readFileSync(fil);
      assert.ok(indhold.length > 0, `${v.billede} er tom`);
      if (/\.svg$/i.test(v.billede)) {
        const tekst = indhold.toString('utf8');
        assert.match(tekst, /<svg[\s>]/, `${v.billede} er ikke en SVG`);
        assert.match(tekst, /viewBox\s*=\s*["'][^"']+["']/, `${v.billede} mangler viewBox`);
        assert.ok(!/<script|javascript:|on\w+\s*=|https?:\/\/(?!www\.w3\.org)/i.test(tekst), `${v.billede} indeholder script eller eksterne links`);
      }
    }
  });

  it('præcis de 14 gamle varer er standard_aktiv, og de ligger i katalog.json', () => {
    const aktive = katalog.varer.filter((v) => v.standard_aktiv);
    assert.deepEqual(aktive.map((v) => v.navn).sort(), [...DE_14].sort());
    assert.ok(aktive.every((v) => v._fil === 'katalog.json'), 'De 14 standardvarer skal ligge i katalog.json');
    assert.ok(katalog.varer.filter((v) => v._fil !== 'katalog.json').every((v) => !v.standard_aktiv), 'Alle nye varer skal have standard_aktiv: false');
    assert.equal(katalog.varer.find((v) => v.navn === 'Kaffe').kategori, 'Varme drikke', 'Kaffe skal flyttes til Varme drikke');
  });

  it('alle 8 kategorier er i brug', () => {
    const brugt = new Set(katalog.varer.map((v) => v.kategori));
    for (const k of KATEGORIER) assert.ok(brugt.has(k), `Ingen varer i kategorien ${k}`);
  });
});

describe('Kataloget i serveren', () => {
  let server;
  let personale;
  let kunde;
  let katalog;

  before(async () => {
    katalog = laesKatalog();
    server = await startServer();
    personale = server.browser('personale');
    ok(await personale.post('/api/personale/opsaet', { navn: 'Katalog-admin', kode: 'katalog-test-1' }));
    const d = ok(await personale.post('/api/admin/deltagere', { pc_nr: 42, navn: 'Katja Katalog', pin: '4242', startbeloeb_oere: 50000 }));
    kunde = server.browser('kunde');
    ok(await kunde.post('/api/kunde/login', { pc_nr: 42, pin: '4242' }));
    kunde.deltager = d;
  });
  after(async () => {
    if (server) await server.stop();
  });

  it('første start: kunderne ser præcis varerne med standard_aktiv', async () => {
    const off = ok(await server.browser().get('/api/varer'));
    const forventet = katalog.varer.filter((v) => v.standard_aktiv).map((v) => v.navn).sort();
    assert.deepEqual(off.map((v) => v.navn).sort(), forventet);
    assert.ok(off.every((v) => somTal(v.aktiv) === 1));
  });

  it('admin ser alle katalogvarer med katalog_id og rigtig aktiv-markering', async () => {
    const alle = ok(await personale.get('/api/admin/varer'));
    assert.equal(alle.length, katalog.varer.length, `Admin ser ${alle.length} varer, kataloget har ${katalog.varer.length}`);
    const efterId = new Map(alle.map((v) => [v.katalog_id, v]));
    for (const kv of katalog.varer) {
      const v = efterId.get(kv.katalog_id);
      assert.ok(v, `Varen ${kv.katalog_id} mangler i /api/admin/varer`);
      assert.equal(v.navn, kv.navn);
      assert.equal(v.pris_oere, kv.pris_oere);
      assert.equal(v.kategori, kv.kategori);
      assert.equal(somTal(v.aktiv), kv.standard_aktiv ? 1 : 0, `${kv.katalog_id}: aktiv skal være ${kv.standard_aktiv}`);
    }
  });

  it('alle katalogbilleder kan hentes, og kun billedfiler kopieres til DATA_DIR', async () => {
    const alle = ok(await personale.get('/api/admin/varer'));
    for (const v of alle) {
      const r = await server.browser().get(v.billede_url);
      assert.equal(r.status, 200, `${v.navn}: ${v.billede_url} gav ${r.status}`);
      assert.match(r.headers['content-type'] || '', /^image\//);
    }
    const kopieret = fs.readdirSync(path.join(server.dataDir, 'billeder'));
    const andre = kopieret.filter((f) => !BILLEDTYPER.test(f));
    assert.deepEqual(andre, [], 'Kun billedfiler må kopieres til <DATA_DIR>/billeder/');
    const r = await server.browser().get('/billeder/katalog.json');
    assert.ok(r.status >= 400, '/billeder/katalog.json må ikke kunne hentes');
  });

  it('GET /api/admin/kategorier: de 8 i rækkefølge, derefter egne', async () => {
    const k1 = ok(await personale.get('/api/admin/kategorier'));
    assert.deepEqual(k1.slice(0, 8), KATEGORIER);
    const egen = ok(await personale.post('/api/admin/varer', { navn: 'Crew-kage', beskrivelse: '', kategori: 'Kager fra crewet', pris_oere: 1500, aktiv: 1, udsolgt: 0, sortering: 999 }));
    assert.ok(egen.katalog_id === null || egen.katalog_id === undefined, 'En vare admin selv opretter, har ingen katalog_id');
    const k2 = ok(await personale.get('/api/admin/kategorier'));
    assert.deepEqual(k2.slice(0, 8), KATEGORIER);
    assert.ok(k2.includes('Kager fra crewet'), 'Egen kategori skal med i listen');
    assert.equal(new Set(k2).size, k2.length, 'Ingen dubletter i kategorilisten');
    const iAdmin = ok(await personale.get('/api/admin/varer')).find((v) => v.id === egen.id);
    assert.equal(iAdmin.katalog_id ?? null, null);
  });

  it('en vare der ikke sælges, kan ikke bestilles', async () => {
    const ikkeAktiv = ok(await personale.get('/api/admin/varer')).find((v) => somTal(v.aktiv) === 0 && v.katalog_id);
    assert.ok(ikkeAktiv, 'Fandt ingen ikke-aktiv katalogvare');
    const foer = ok(await kunde.get('/api/kunde/mig')).saldo_oere;
    const r = await kunde.post('/api/kunde/ordrer', { linjer: [{ vare_id: ikkeAktiv.id, antal: 1 }], levering: 'hent', note: '' });
    assert.ok(r.status >= 400 && r.status < 500, `Bestilling af ikke-aktiv vare gav ${r.status}`);
    assert.ok(r.data && r.data.kode, 'Fejlen skal have en kode');
    assert.equal(ok(await kunde.get('/api/kunde/mig')).saldo_oere, foer);
    assert.equal(ok(await kunde.get('/api/kunde/ordrer')).length, 0);
  });

  it('POST /api/admin/varer/aktiv slår mange til på én gang og sender ét varer-event', async () => {
    const alle = ok(await personale.get('/api/admin/varer'));
    const valgte = alle.filter((v) => somTal(v.aktiv) === 0 && v.katalog_id).slice(0, 12);
    assert.ok(valgte.length >= 5, 'Kataloget skal have mindst 5 ikke-aktive varer');
    const ids = valgte.map((v) => v.id);
    const s = await kunde.stroem('/api/kunde/stream');
    try {
      const foer = s.haendelser.length;
      const r = ok(await personale.post('/api/admin/varer/aktiv', { ids, aktiv: true }));
      assert.equal(r.opdateret, ids.length);
      // Markør: en info-hændelse efter. Alt fra bulk-opdateringen ligger før den på samme forbindelse.
      const nyNavn = `Markør ${Date.now()}`;
      ok(await personale.put('/api/admin/indstillinger', { traef_navn: nyNavn }));
      await s.vent((h) => h.event === 'info' && h.data.traef_navn === nyNavn, { beskrivelse: 'info-markør', fraIndeks: foer });
      const varerEvents = s.haendelser.slice(foer).filter((h) => h.event === 'varer');
      assert.equal(varerEvents.length, 1, `Forventede præcis ét varer-event, fik ${varerEvents.length}`);
      ok(await personale.put('/api/admin/indstillinger', { traef_navn: 'Træf-butikken' }));
    } finally {
      s.luk();
    }
    const off = ok(await server.browser().get('/api/varer'));
    for (const id of ids) assert.ok(off.some((v) => v.id === id), `Vare ${id} sælges ikke efter aktivering`);
    // Nu kan den bestilles.
    const o = ok(await kunde.post('/api/kunde/ordrer', { linjer: [{ vare_id: ids[0], antal: 1 }], levering: 'hent', note: '' }));
    assert.equal(o.total_oere, valgte[0].pris_oere);

    // Og slås fra igen i én omgang.
    const r2 = ok(await personale.post('/api/admin/varer/aktiv', { ids, aktiv: false }));
    assert.equal(r2.opdateret, ids.length);
    const off2 = ok(await server.browser().get('/api/varer'));
    for (const id of ids) assert.ok(!off2.some((v) => v.id === id), `Vare ${id} sælges stadig efter deaktivering`);
    const admin = ok(await personale.get('/api/admin/varer'));
    for (const id of ids) assert.equal(somTal(admin.find((v) => v.id === id).aktiv), 0);
  });

  it('bulk-aktiv er én transaktion: et ugyldigt id ændrer intet', async () => {
    const alle = ok(await personale.get('/api/admin/varer'));
    const to = alle.filter((v) => somTal(v.aktiv) === 0).slice(0, 2).map((v) => v.id);
    const r = await personale.post('/api/admin/varer/aktiv', { ids: [...to, 'x'], aktiv: true });
    assert.equal(r.status, 400, `Ugyldigt id skal give 400 (fik ${r.status})`);
    const efter = ok(await personale.get('/api/admin/varer'));
    for (const id of to) assert.equal(somTal(efter.find((v) => v.id === id).aktiv), 0, 'Intet må ændres ved fejl');
  });

  it('bulk-aktiv afviser dårligt input og kræver personale', async () => {
    for (const body of [{}, { ids: 'alle', aktiv: true }, { ids: [1], aktiv: 'måske' }, { ids: [1] }]) {
      const r = await personale.post('/api/admin/varer/aktiv', body);
      assert.equal(r.status, 400, `${JSON.stringify(body)} gav ${r.status}`);
    }
    assert.equal((await kunde.post('/api/admin/varer/aktiv', { ids: [1], aktiv: false })).status, 401);
    assert.equal((await server.browser().post('/api/admin/varer/aktiv', { ids: [1], aktiv: false })).status, 401);
    assert.equal((await kunde.get('/api/admin/kategorier')).status, 401);
  });

  it('kataloget ændrer ikke admins rettelser ved genstart, og der kommer ingen dubletter', async () => {
    const cola = ok(await personale.get('/api/admin/varer')).find((v) => v.navn === 'Coca-Cola 0,5 l');
    ok(await personale.put(`/api/admin/varer/${cola.id}`, { ...cola, pris_oere: 2300, beskrivelse: 'Rettet af admin' }));
    const fanta = ok(await personale.get('/api/admin/varer')).find((v) => v.navn === 'Fanta 0,5 l');
    ok(await personale.post('/api/admin/varer/aktiv', { ids: [fanta.id], aktiv: false }));
    const foer = ok(await personale.get('/api/admin/varer'));
    const dataDir = server.dataDir;
    // Stop uden at slette data, og start igen på samme DATA_DIR.
    const gammel = server;
    server = await genstart(gammel);
    personale = server.browser('personale');
    ok(await personale.post('/api/personale/login', { navn: 'Katalog-admin', kode: 'katalog-test-1' }));
    const efter = ok(await personale.get('/api/admin/varer'));
    assert.equal(efter.length, foer.length, 'Antallet af varer ændrede sig ved genstart');
    const ids = efter.map((v) => v.katalog_id).filter(Boolean);
    assert.equal(new Set(ids).size, ids.length, 'Dubletter af katalog_id');
    const cola2 = efter.find((v) => v.id === cola.id);
    assert.equal(cola2.pris_oere, 2300);
    assert.equal(cola2.beskrivelse, 'Rettet af admin');
    assert.equal(somTal(efter.find((v) => v.id === fanta.id).aktiv), 0, 'Kataloget må ikke slå en vare til igen');
    assert.equal(server.dataDir, dataDir);
  });

  // Genstart på samme DATA_DIR: dræb processen, behold mappen.
  async function genstart(gammel) {
    for (const s of gammel._stroemme) s.luk();
    for (const b of gammel._browsere) b.agent.destroy();
    const dataDir = gammel.dataDir;
    gammel.proces.kill();
    await new Promise((r) => (gammel.afsluttet ? r() : gammel.proces.once('exit', r)));
    const ny = await startServer({ dataDir });
    // Når testen er færdig, skal mappen slettes som normalt.
    const stop = ny.stop.bind(ny);
    ny.stop = async () => {
      await stop();
      const { sletMappe } = require('./hjaelp.js');
      await sletMappe(dataDir);
    };
    return ny;
  }
});
