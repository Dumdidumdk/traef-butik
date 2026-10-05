'use strict';
// API-tests efter SPEC.md. Kør: node --test test/api.test.js
// Starter selv serveren med fri port og midlertidig DATA_DIR.

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, Browser, raatKald, aabnDb, tjekSaldiIDb, bevaegelserFra } = require('./hjaelp.js');

const PERSONALE_KODE = 'hemmelig-kode-42';
const ADMIN = 'Test-admin'; // tillæg 3: personale logger ind med navn + kode

// Registrér alle svar med status 5xx – en sidste test kræver, at der ingen er.
const svar5xx = [];
const origKald = Browser.prototype.kald;
Browser.prototype.kald = async function (metode, sti, ...rest) {
  const r = await origKald.call(this, metode, sti, ...rest);
  if (r.status >= 500) svar5xx.push(`${metode} ${sti} → ${r.status} ${r.tekst.slice(0, 200)}`);
  return r;
};

// ---------- små hjælpere ----------

function vis(r) {
  return `status ${r.status}, svar: ${r.tekst.slice(0, 300)}`;
}

// Tjek status (tal eller funktion) og evt. fejlkode + at fejlbeskeden er en ikke-tom tekst.
function forvent(r, status, kode) {
  if (typeof status === 'function') assert.ok(status(r.status), `Uventet ${vis(r)}`);
  else assert.equal(r.status, status, `Forventede ${status}, fik ${vis(r)}`);
  if (kode) {
    assert.ok(r.data && typeof r.data === 'object', `Forventede JSON-fejl med kode ${kode}, fik ${vis(r)}`);
    assert.equal(r.data.kode, kode, `Forventede kode ${kode}, fik ${vis(r)}`);
    assert.equal(typeof r.data.fejl, 'string', `"fejl" skal være en tekst: ${vis(r)}`);
    assert.ok(r.data.fejl.length > 0, 'Tom fejlbesked');
  }
  return r.data;
}
const ok2xx = (s) => s >= 200 && s < 300;
const fejl4xx = (s) => s >= 400 && s < 500;
const ok = (r) => forvent(r, ok2xx);

// Sammenlign indstillingsværdier uanset om de er tal, tekst eller boolean.
const somTal = (v) => (v === true ? 1 : v === false ? 0 : Number(v));

describe('Træf-butik API', () => {
  let server;
  let personale; // logget-ind personale-browser
  let pcTaeller = 100;
  const kendteDeltagere = new Map(); // id → pc_nr
  const v = {}; // testvarer: v.vand (10 kr), v.cola (20 kr), v.toast (25 kr)

  // Ny deltager: crew opretter ved indgangen (tillæg 1), deltageren logger ind i egen browser.
  async function nyKunde({ navn, pin = '1234', pc } = {}) {
    const b = server.browser(navn || 'kunde');
    const pc_nr = pc || pcTaeller++;
    const d = ok(await personale.post('/api/admin/deltagere', { pc_nr, navn: navn || `Tester ${pc_nr}`, pin }));
    kendteDeltagere.set(d.id, pc_nr);
    b.deltager = ok(await b.post('/api/kunde/login', { pc_nr, pin }));
    assert.equal(b.deltager.id, d.id);
    return b;
  }

  // Sæt penge ind via indbetaling + godkendelse.
  async function givPenge(kunde, beloeb_oere) {
    const ind = ok(await kunde.post('/api/kunde/indbetalinger', { beloeb_oere, metode: 'mobilepay', reference: 'test' }));
    ok(await personale.post(`/api/admin/indbetalinger/${ind.id}/godkend`, {}));
    return ind;
  }

  async function saldo(kunde) {
    return ok(await kunde.get('/api/kunde/mig')).saldo_oere;
  }

  async function bestil(kunde, linjer, levering = 'hent', note = '') {
    return kunde.post('/api/kunde/ordrer', { linjer, levering, note });
  }

  async function saetStatus(id, status) {
    return personale.post(`/api/butik/ordrer/${id}/status`, { status });
  }

  // Sæt en indstilling og bevar typen, serveren selv bruger.
  async function saetIndstilling(noegle, vaerdi) {
    const nu = ok(await personale.get('/api/admin/indstillinger'));
    const gammel = nu[noegle];
    let ny = vaerdi;
    if (typeof gammel === 'number') ny = Number(vaerdi);
    else if (typeof gammel === 'boolean') ny = Boolean(Number(vaerdi));
    else ny = String(vaerdi);
    ok(await personale.put('/api/admin/indstillinger', { [noegle]: ny }));
  }

  // Tjek saldo = sum af kontoudtog og ingen negative – både i databasen og via API'et.
  async function tjekPenge() {
    const dbFejl = tjekSaldiIDb(server);
    assert.deepEqual(dbFejl, [], 'Saldo stemmer ikke med bevægelser i databasen');
    for (const [id, pc] of kendteDeltagere) {
      const r = await personale.get(`/api/admin/deltagere?q=${pc}`);
      const d = ok(r).find((x) => x.id === id);
      assert.ok(d, `Deltager ${id} (PC ${pc}) blev ikke fundet ved søgning`);
      const bev = bevaegelserFra(ok(await personale.get(`/api/admin/deltagere/${id}/bevaegelser`)));
      const sum = bev.reduce((s, b) => s + b.beloeb_oere, 0);
      assert.equal(d.saldo_oere, sum, `PC ${pc}: saldo ${d.saldo_oere} ≠ sum af kontoudtog ${sum}`);
      assert.ok(d.saldo_oere >= 0, `PC ${pc}: negativ saldo ${d.saldo_oere}`);
    }
  }

  before(async () => {
    server = await startServer();
  });

  after(async () => {
    if (server) await server.stop();
  });

  // Efter hver test: penge skal stemme (springes over, før personalet findes).
  afterEach(async () => {
    if (personale && personale.cookies.has('personale')) await tjekPenge();
  });

  // =====================================================================
  describe('Offentligt og opstart', () => {
    it('bruger DATA_DIR til databasen', () => {
      assert.ok(fs.existsSync(path.join(server.dataDir, 'butik.db')), 'butik.db findes ikke i DATA_DIR');
      assert.ok(fs.existsSync(path.join(server.dataDir, 'billeder')), 'billeder/ findes ikke i DATA_DIR');
    });

    it('GET /api/info har standardværdierne', async () => {
      const b = server.browser();
      const info = ok(await b.get('/api/info'));
      for (const f of ['traef_navn', 'butik_aaben', 'tilmelding_aaben', 'levering_aktiv', 'levering_min_oere', 'mobilepay_nr', 'personale_opsat']) {
        assert.ok(f in info, `/api/info mangler ${f}`);
      }
      assert.equal(info.traef_navn, 'Træf-butikken');
      assert.equal(somTal(info.butik_aaben), 1);
      assert.equal(somTal(info.tilmelding_aaben), 0, 'Tillæg 1: tilmelding er lukket som standard');
      assert.equal(somTal(info.levering_aktiv), 1);
      assert.equal(somTal(info.levering_min_oere), 10000);
      assert.equal(info.mobilepay_nr, '');
      assert.equal(somTal(info.personale_opsat), 0);
    });

    it('GET /api/varer har de 14 standardvarer med billeder', async () => {
      const b = server.browser();
      const varer = ok(await b.get('/api/varer'));
      assert.ok(Array.isArray(varer));
      assert.equal(varer.length, 14, `Forventede 14 standardvarer, fik ${varer.length}`);
      const navne = varer.map((x) => x.navn);
      for (const n of ['Coca-Cola', 'Fanta', 'Faxe Kondi', 'Monster', 'Red Bull', 'Vand', 'Kaffe', 'Snickers', 'Pizza']) {
        assert.ok(navne.some((x) => x.includes(n)), `Mangler standardvaren ${n}`);
      }
      const kategorier = new Set(varer.map((x) => x.kategori));
      for (const k of ['Drikke', 'Energi', 'Mad', 'Slik og snacks']) assert.ok(kategorier.has(k), `Mangler kategori ${k}`);
      for (const x of varer) {
        for (const f of ['id', 'navn', 'beskrivelse', 'kategori', 'pris_oere', 'billede_url', 'aktiv', 'udsolgt', 'sortering']) {
          assert.ok(f in x, `Vare ${x.navn} mangler feltet ${f}`);
        }
        assert.ok(Number.isInteger(x.pris_oere) && x.pris_oere > 0, `Pris skal være heltal i øre: ${x.navn}`);
      }
      const cola = varer.find((x) => x.navn.startsWith('Coca-Cola 0,5'));
      assert.equal(cola && cola.pris_oere, 2000, 'Coca-Cola skal koste 2000 øre');
      // Alle billeder kan hentes.
      for (const x of varer) {
        assert.ok(x.billede_url, `${x.navn} har ingen billede_url`);
        const r = await b.get(x.billede_url);
        assert.equal(r.status, 200, `Billedet til ${x.navn} (${x.billede_url}) gav ${r.status}`);
        assert.match(r.headers['content-type'] || '', /^image\//, `Forkert MIME-type for ${x.billede_url}`);
      }
    });

    it('siderne /, /butik og /admin serveres som HTML', async () => {
      const b = server.browser();
      for (const sti of ['/', '/butik', '/admin']) {
        let r = await b.get(sti);
        // Omdirigering (fx /butik → /butik/) er fin – følg den.
        for (let i = 0; i < 3 && r.status >= 301 && r.status <= 308 && r.headers.location; i++) {
          const l = new URL(r.headers.location, server.url);
          assert.equal(l.host, `127.0.0.1:${server.port}`, `${sti} omdirigerer ud af huset: ${r.headers.location}`);
          r = await b.get(l.pathname + l.search);
        }
        assert.equal(r.status, 200, `${sti} gav ${r.status}`);
        assert.match(r.headers['content-type'] || '', /text\/html/, `${sti} er ikke text/html`);
      }
    });

    it('ukendt API-sti giver 404 med JSON-fejl', async () => {
      const r = await server.browser().get('/api/findes-ikke');
      forvent(r, 404);
    });
  });

  // =====================================================================
  describe('Personale-opsætning og login', () => {
    it('admin kræver login før opsætning', async () => {
      forvent(await server.browser().get('/api/admin/indstillinger'), 401);
    });

    it('kode under 6 tegn afvises', async () => {
      forvent(await server.browser().post('/api/personale/opsaet', { navn: ADMIN, kode: '12345' }), 400);
      const info = ok(await server.browser().get('/api/info'));
      assert.equal(somTal(info.personale_opsat), 0);
    });

    it('opsætning virker én gang og logger ind', async () => {
      personale = server.browser('personale');
      ok(await personale.post('/api/personale/opsaet', { navn: ADMIN, kode: PERSONALE_KODE }));
      assert.ok(personale.cookies.has('personale'), 'Ingen personale-cookie efter opsætning');
      ok(await personale.get('/api/admin/indstillinger'));
      const info = ok(await server.browser().get('/api/info'));
      assert.equal(somTal(info.personale_opsat), 1);
    });

    it('opsætning kan ikke gentages (heller ikke af en anden)', async () => {
      const angriber = server.browser('angriber');
      forvent(await angriber.post('/api/personale/opsaet', { navn: 'Angriber', kode: 'ny-kode-123' }), fejl4xx);
      assert.ok(!angriber.cookies.has('personale'));
      forvent(await personale.post('/api/personale/opsaet', { navn: 'Angriber', kode: 'ny-kode-123' }), fejl4xx);
      // Den gamle kode virker stadig, den nye gør ikke.
      forvent(await server.browser().post('/api/personale/login', { navn: 'Angriber', kode: 'ny-kode-123' }), 401);
      ok(await server.browser().post('/api/personale/login', { navn: ADMIN, kode: PERSONALE_KODE }));
    });

    it('personale-login, forkert kode og logout', async () => {
      const b = server.browser();
      forvent(await b.post('/api/personale/login', { navn: ADMIN, kode: 'forkert-kode' }), 401);
      assert.ok(!b.cookies.has('personale'));
      ok(await b.post('/api/personale/login', { navn: ADMIN, kode: PERSONALE_KODE }));
      assert.ok(b.cookies.has('personale'));
      const token = b.cookies.get('personale');
      ok(await b.get('/api/butik/ordrer'));
      ok(await b.post('/api/personale/logout', {}));
      // Selv med den gamle token skal sessionen være død.
      const gammel = server.browser();
      gammel.cookies.set('personale', token);
      forvent(await gammel.get('/api/butik/ordrer'), 401);
    });

    it('indstillinger indeholder ikke personale_kode', async () => {
      const ind = ok(await personale.get('/api/admin/indstillinger'));
      assert.ok(!('personale_kode' in ind), 'personale_kode må ikke sendes ud');
      assert.ok(!JSON.stringify(ind).includes(PERSONALE_KODE));
      // Og kan ikke ændres via PUT.
      await personale.put('/api/admin/indstillinger', { personale_kode: 'hacket' });
      forvent(await server.browser().post('/api/personale/login', { navn: ADMIN, kode: 'hacket' }), 401);
      ok(await server.browser().post('/api/personale/login', { navn: ADMIN, kode: PERSONALE_KODE }));
    });

    it('opretter testvarer med kendte priser', async () => {
      const lav = async (navn, pris_oere, sortering) =>
        ok(await personale.post('/api/admin/varer', { navn, beskrivelse: 'Testvare', kategori: 'Test', pris_oere, aktiv: 1, udsolgt: 0, sortering }));
      v.vand = await lav('Test-vand', 1000, 900);
      v.cola = await lav('Test-cola', 2000, 901);
      v.toast = await lav('Test-toast', 2500, 902);
      for (const x of Object.values(v)) assert.ok(Number.isInteger(x.id), 'Oprettet vare mangler id');
    });
  });

  // =====================================================================
  describe('Kundekonto', () => {
    it('tilmelding er lukket som standard: 403 tilmelding_lukket', async () => {
      const b = server.browser();
      forvent(await b.post('/api/kunde/tilmeld', { pc_nr: 17, navn: 'Mads', pin: '4321' }), 403, 'tilmelding_lukket');
      assert.ok(!b.cookies.has('kunde'));
    });

    // Resten af tilmeldingstestene kører med åben tilmelding (lukkes igen sidst i blokken).
    it('personalet åbner for tilmelding', async () => {
      await saetIndstilling('tilmelding_aaben', 1);
      assert.equal(somTal(ok(await server.browser().get('/api/info')).tilmelding_aaben), 1);
    });

    it('tilmeld giver Deltager og en korrekt cookie', async () => {
      const b = server.browser();
      const r = await b.post('/api/kunde/tilmeld', { pc_nr: 17, navn: 'Mads', pin: '4321' });
      const d = ok(r);
      kendteDeltagere.set(d.id, 17);
      assert.equal(d.pc_nr, 17);
      assert.equal(d.navn, 'Mads');
      assert.equal(d.saldo_oere, 0);
      assert.ok(Number.isInteger(d.id));
      assert.ok(!('pin_hash' in d) && !('pin_salt' in d), 'PIN-hash må ikke sendes ud');
      const ck = b.sidsteSetCookie.find((c) => c.startsWith('kunde='));
      assert.ok(ck, 'Ingen kunde-cookie');
      assert.match(ck, /HttpOnly/i);
      assert.match(ck, /SameSite=Lax/i);
      assert.match(ck, /Path=\//i);
      const maxAge = /Max-Age=(\d+)/i.exec(ck);
      const expires = /Expires=([^;]+)/i.exec(ck);
      const sek = maxAge ? Number(maxAge[1]) : expires ? (Date.parse(expires[1]) - Date.now()) / 1000 : 0;
      assert.ok(Math.abs(sek - 30 * 86400) < 3600, `Cookien skal leve 30 dage (fik ${sek} sek.)`);
      ok(await b.get('/api/kunde/mig'));
    });

    it('PIN gemmes som hash med salt', () => {
      const db = aabnDb(server);
      try {
        const r = db.prepare('SELECT pin_salt, pin_hash FROM deltagere WHERE pc_nr = 17').get();
        assert.ok(r.pin_salt && r.pin_hash);
        assert.ok(!String(r.pin_hash).includes('4321') && !String(r.pin_salt).includes('4321'));
      } finally {
        db.close();
      }
    });

    it('PC-nr optaget giver 409 pc_optaget', async () => {
      forvent(await server.browser().post('/api/kunde/tilmeld', { pc_nr: 17, navn: 'Anden', pin: '1111' }), 409, 'pc_optaget');
    });

    it('ugyldige tilmeldinger afvises med 400', async () => {
      const b = server.browser();
      const daarlige = [
        { pc_nr: 18, navn: 'X', pin: '123' },
        { pc_nr: 18, navn: 'X', pin: '1234567' },
        { pc_nr: 18, navn: 'X', pin: '12a4' },
        { pc_nr: 0, navn: 'X', pin: '1234' },
        { pc_nr: 10000, navn: 'X', pin: '1234' },
        { pc_nr: 1.5, navn: 'X', pin: '1234' },
        { pc_nr: 'abc', navn: 'X', pin: '1234' },
        { pc_nr: 18, navn: '', pin: '1234' },
        { pc_nr: 18, navn: '   ', pin: '1234' },
        { pc_nr: 18, navn: 'X'.repeat(500), pin: '1234' },
        { pc_nr: 18, pin: '1234' },
        {},
      ];
      for (const body of daarlige) {
        const r = await b.post('/api/kunde/tilmeld', body);
        assert.equal(r.status, 400, `Forventede 400 for ${JSON.stringify(body).slice(0, 80)}, fik ${vis(r)}`);
        assert.ok(r.data && r.data.fejl && r.data.kode, 'Fejl skal have fejl og kode');
      }
      assert.ok(!b.cookies.has('kunde'));
      // Grænserne er lovlige.
      for (const [pc_nr, pin] of [[1, '0000'], [9999, '123456']]) {
        const d = ok(await server.browser().post('/api/kunde/tilmeld', { pc_nr, navn: `Grænse ${pc_nr}`, pin }));
        kendteDeltagere.set(d.id, pc_nr);
      }
    });

    it('login, logout og forkert PIN', async () => {
      const b = server.browser();
      forvent(await b.post('/api/kunde/login', { pc_nr: 17, pin: '0000' }), 401, 'forkert_login');
      forvent(await b.post('/api/kunde/login', { pc_nr: 4242, pin: '1234' }), 401, 'forkert_login');
      forvent(await b.get('/api/kunde/mig'), 401, 'ikke_logget_ind');
      const d = ok(await b.post('/api/kunde/login', { pc_nr: 17, pin: '4321' }));
      assert.equal(d.pc_nr, 17);
      assert.ok(b.cookies.has('kunde'));
      assert.equal(ok(await b.get('/api/kunde/mig')).navn, 'Mads');
      const token = b.cookies.get('kunde');
      ok(await b.post('/api/kunde/logout', {}));
      forvent(await b.get('/api/kunde/mig'), 401, 'ikke_logget_ind');
      const gammel = server.browser();
      gammel.cookies.set('kunde', token);
      forvent(await gammel.get('/api/kunde/mig'), 401, 'ikke_logget_ind');
    });

    it('falsk cookie giver 401', async () => {
      const b = server.browser();
      b.cookies.set('kunde', 'findes-ikke-123');
      forvent(await b.get('/api/kunde/mig'), 401, 'ikke_logget_ind');
      b.cookies.set('personale', 'findes-ikke-123');
      forvent(await b.get('/api/butik/ordrer'), 401);
    });

    it('rate limit: maks 10 forkerte logins pr. PC-nr', async () => {
      const kunde = await nyKunde({ pin: '2468' });
      const pc = kunde.deltager.pc_nr;
      const b = server.browser();
      for (let i = 1; i <= 10; i++) {
        forvent(await b.post('/api/kunde/login', { pc_nr: pc, pin: '9999' }), 401, 'forkert_login');
      }
      forvent(await b.post('/api/kunde/login', { pc_nr: pc, pin: '9999' }), fejl4xx, 'for_mange_forsoeg');
      // Også rigtig PIN blokeres nu.
      forvent(await b.post('/api/kunde/login', { pc_nr: pc, pin: '2468' }), fejl4xx, 'for_mange_forsoeg');
      assert.ok(!b.cookies.has('kunde'));
      // En allerede logget ind computer er ikke ramt, og andre PC-numre er ikke ramt.
      ok(await kunde.get('/api/kunde/mig'));
      ok(await server.browser().post('/api/kunde/login', { pc_nr: 17, pin: '4321' }));
    });

    it('tilmelding lukket: kun personalet kan oprette', async () => {
      await saetIndstilling('tilmelding_aaben', 0);
      try {
        assert.equal(somTal(ok(await server.browser().get('/api/info')).tilmelding_aaben), 0);
        const r = await server.browser().post('/api/kunde/tilmeld', { pc_nr: 555, navn: 'Lukket', pin: '1234' });
        forvent(r, 403, 'tilmelding_lukket');
        const d = ok(await personale.post('/api/admin/deltagere', { pc_nr: 555, navn: 'Via personale', pin: '5555' }));
        kendteDeltagere.set(d.id, 555);
        assert.equal(d.pc_nr, 555);
        ok(await server.browser().post('/api/kunde/login', { pc_nr: 555, pin: '5555' }));
        forvent(await personale.post('/api/admin/deltagere', { pc_nr: 555, navn: 'Igen', pin: '5555' }), 409, 'pc_optaget');
      } finally {
        await saetIndstilling('tilmelding_aaben', 1);
      }
    });

    it('personalet kan rette navn og nulstille PIN', async () => {
      const k = await nyKunde({ pin: '1111' });
      const id = k.deltager.id;
      const d = ok(await personale.put(`/api/admin/deltagere/${id}`, { navn: 'Nyt Navn' }));
      assert.equal(d.navn, 'Nyt Navn');
      ok(await personale.put(`/api/admin/deltagere/${id}`, { pin: '7777' }));
      forvent(await server.browser().post('/api/kunde/login', { pc_nr: k.deltager.pc_nr, pin: '1111' }), 401, 'forkert_login');
      const ny = ok(await server.browser().post('/api/kunde/login', { pc_nr: k.deltager.pc_nr, pin: '7777' }));
      assert.equal(ny.navn, 'Nyt Navn');
      forvent(await personale.put(`/api/admin/deltagere/${id}`, { pin: '12' }), 400);
    });

    it('søgning på deltagere efter PC-nr og navn', async () => {
      const efterPc = ok(await personale.get('/api/admin/deltagere?q=17'));
      assert.ok(efterPc.some((d) => d.pc_nr === 17));
      const efterNavn = ok(await personale.get(`/api/admin/deltagere?q=${encodeURIComponent('mads')}`));
      assert.ok(efterNavn.some((d) => d.navn === 'Mads'), 'Søgning på navn skal finde "Mads" (uanset store/små bogstaver)');
      const ingen = ok(await personale.get('/api/admin/deltagere?q=zzzzqqq'));
      assert.equal(ingen.length, 0);
    });

    it('tilmelding lukkes igen', async () => {
      await saetIndstilling('tilmelding_aaben', 0);
      forvent(await server.browser().post('/api/kunde/tilmeld', { pc_nr: 556, navn: 'Sen', pin: '1234' }), 403, 'tilmelding_lukket');
    });
  });

  // =====================================================================
  describe('Check-in: crew opretter deltagere (tillæg 1)', () => {
    // Felter, hvor en PIN i klartekst aldrig må dukke op.
    function harIkkePin(obj, pin, hvor) {
      assert.ok(!JSON.stringify(obj).includes(`"pin":`), `${hvor} indeholder feltet "pin"`);
      assert.ok(!JSON.stringify(obj).includes(`"${pin}"`), `${hvor} indeholder PIN ${pin} i klartekst`);
    }

    it('uden pin: serveren laver en 4-cifret PIN, som kun vises i svaret', async () => {
      const pc_nr = pcTaeller++;
      const d = ok(await personale.post('/api/admin/deltagere', { pc_nr, navn: 'Check Ind' }));
      kendteDeltagere.set(d.id, pc_nr);
      assert.match(String(d.pin), /^\d{4}$/, `Forventede 4-cifret PIN, fik ${d.pin}`);
      assert.equal(typeof d.pin, 'string', 'PIN skal være en tekst (så "0042" ikke bliver til 42)');
      assert.equal(d.pc_nr, pc_nr);
      assert.equal(d.saldo_oere, 0);
      // Kan logge ind med den.
      const b = server.browser();
      const mig = ok(await b.post('/api/kunde/login', { pc_nr, pin: d.pin }));
      harIkkePin(mig, d.pin, 'Login-svaret');
      harIkkePin(ok(await b.get('/api/kunde/mig')), d.pin, '/api/kunde/mig');
      harIkkePin(ok(await personale.get(`/api/admin/deltagere?q=${pc_nr}`)), d.pin, 'Deltagersøgningen');
      harIkkePin(ok(await personale.get(`/api/admin/deltagere/${d.id}/bevaegelser`)), d.pin, 'Kontoudtoget');
      const db = aabnDb(server);
      try {
        const r = db.prepare('SELECT * FROM deltagere WHERE id = ?').get(d.id);
        assert.ok(!('pin' in r), 'Tabellen deltagere må ikke have en pin-kolonne i klartekst');
        assert.notEqual(String(r.pin_hash), d.pin);
      } finally {
        db.close();
      }
    });

    it('tilfældige PIN-koder varierer', async () => {
      const pins = new Set();
      for (let i = 0; i < 8; i++) {
        const pc_nr = pcTaeller++;
        const d = ok(await personale.post('/api/admin/deltagere', { pc_nr, navn: `Pin ${i}` }));
        kendteDeltagere.set(d.id, pc_nr);
        pins.add(d.pin);
      }
      assert.ok(pins.size >= 5, `Kun ${pins.size} forskellige PIN-koder ud af 8`);
    });

    it('med selvvalgt pin virker den', async () => {
      const pc_nr = pcTaeller++;
      const d = ok(await personale.post('/api/admin/deltagere', { pc_nr, navn: 'Selvvalgt', pin: '864213' }));
      kendteDeltagere.set(d.id, pc_nr);
      ok(await server.browser().post('/api/kunde/login', { pc_nr, pin: '864213' }));
      forvent(await personale.post('/api/admin/deltagere', { pc_nr: pcTaeller++, navn: 'X', pin: '12' }), 400);
    });

    it('startbeløb giver en godkendt indbetaling og saldo med det samme', async () => {
      const pc_nr = pcTaeller++;
      const d = ok(await personale.post('/api/admin/deltagere', { pc_nr, navn: 'Rig', startbeloeb_oere: 20000, metode: 'kontant' }));
      kendteDeltagere.set(d.id, pc_nr);
      assert.equal(d.saldo_oere, 20000);
      const b = server.browser();
      ok(await b.post('/api/kunde/login', { pc_nr, pin: d.pin }));
      assert.equal(await saldo(b), 20000);
      const ind = ok(await b.get('/api/kunde/indbetalinger'));
      assert.equal(ind.length, 1);
      assert.equal(ind[0].status, 'godkendt');
      assert.equal(ind[0].metode, 'kontant');
      assert.equal(ind[0].beloeb_oere, 20000);
      assert.ok(!ok(await personale.get('/api/admin/indbetalinger?status=afventer')).some((x) => x.pc_nr === pc_nr), 'Startbeløbet må ikke stå som afventende');
      const bev = bevaegelserFra(ok(await personale.get(`/api/admin/deltagere/${d.id}/bevaegelser`)));
      assert.equal(bev.length, 1);
      assert.equal(bev[0].type, 'indbetaling');
      assert.equal(bev[0].beloeb_oere, 20000);
    });

    it('startbeløb uden metode bruger mobilepay; 0 giver ingen indbetaling', async () => {
      const pc1 = pcTaeller++;
      const d1 = ok(await personale.post('/api/admin/deltagere', { pc_nr: pc1, navn: 'Std', startbeloeb_oere: 10000 }));
      kendteDeltagere.set(d1.id, pc1);
      const b1 = server.browser();
      ok(await b1.post('/api/kunde/login', { pc_nr: pc1, pin: d1.pin }));
      assert.equal(ok(await b1.get('/api/kunde/indbetalinger'))[0].metode, 'mobilepay');
      const pc2 = pcTaeller++;
      const d2 = ok(await personale.post('/api/admin/deltagere', { pc_nr: pc2, navn: 'Nul', startbeloeb_oere: 0 }));
      kendteDeltagere.set(d2.id, pc2);
      const b2 = server.browser();
      ok(await b2.post('/api/kunde/login', { pc_nr: pc2, pin: d2.pin }));
      assert.equal(ok(await b2.get('/api/kunde/indbetalinger')).length, 0);
      assert.equal(await saldo(b2), 0);
    });

    it('ugyldigt startbeløb eller optaget PC-nr opretter intet (én transaktion)', async () => {
      const pc_nr = pcTaeller++;
      for (const body of [
        { pc_nr, navn: 'Fejl', startbeloeb_oere: -100 },
        { pc_nr, navn: 'Fejl', startbeloeb_oere: 12.5 },
        { pc_nr, navn: 'Fejl', startbeloeb_oere: 1000, metode: 'bitcoin' },
      ]) {
        forvent(await personale.post('/api/admin/deltagere', body), 400);
      }
      assert.equal(ok(await personale.get(`/api/admin/deltagere?q=${pc_nr}`)).filter((d) => d.pc_nr === pc_nr).length, 0);
      // PC-nr 17 findes – ingen penge må oprettes nogen steder.
      const db = aabnDb(server);
      const foer = db.prepare('SELECT COUNT(*) AS n FROM indbetalinger').get().n;
      db.close();
      forvent(await personale.post('/api/admin/deltagere', { pc_nr: 17, navn: 'Dublet', startbeloeb_oere: 5000 }), 409, 'pc_optaget');
      const db2 = aabnDb(server);
      const efter = db2.prepare('SELECT COUNT(*) AS n FROM indbetalinger').get().n;
      db2.close();
      assert.equal(efter, foer, 'Fejlet oprettelse må ikke efterlade en indbetaling');
    });

    it('nulstil_pin laver en ny PIN, som kun vises én gang', async () => {
      const pc_nr = pcTaeller++;
      const d = ok(await personale.post('/api/admin/deltagere', { pc_nr, navn: 'Glemsom', pin: '1357' }));
      kendteDeltagere.set(d.id, pc_nr);
      const r = ok(await personale.put(`/api/admin/deltagere/${d.id}`, { nulstil_pin: true }));
      assert.match(String(r.pin), /^\d{4}$/);
      forvent(await server.browser().post('/api/kunde/login', { pc_nr, pin: '1357' }), 401, 'forkert_login');
      ok(await server.browser().post('/api/kunde/login', { pc_nr, pin: r.pin }));
      harIkkePin(ok(await personale.get(`/api/admin/deltagere?q=${pc_nr}`)), r.pin, 'Søgning efter nulstilling');
      // En almindelig rettelse returnerer ingen PIN.
      const navn = ok(await personale.put(`/api/admin/deltagere/${d.id}`, { navn: 'Glemsom 2' }));
      assert.ok(!('pin' in navn), 'PUT uden nulstil_pin må ikke returnere pin');
    });
  });

  // =====================================================================
  describe('Adgangskontrol', () => {
    let kunde;
    before(async () => {
      kunde = await nyKunde();
    });

    const personaleStier = [
      ['GET', '/api/butik/ordrer'],
      ['POST', '/api/butik/ordrer/1/status', { status: 'laves' }],
      ['GET', '/api/admin/varer'],
      ['POST', '/api/admin/varer', { navn: 'Hack', kategori: 'X', pris_oere: 1 }],
      ['PUT', '/api/admin/varer/1', { pris_oere: 1 }],
      ['DELETE', '/api/admin/varer/1'],
      ['GET', '/api/admin/deltagere?q='],
      ['POST', '/api/admin/deltagere', { pc_nr: 7777, navn: 'Hack', pin: '1234' }],
      ['PUT', '/api/admin/deltagere/1', { navn: 'Hack' }],
      ['POST', '/api/admin/deltagere/1/saldo', { beloeb_oere: 100000, tekst: 'gratis' }],
      ['GET', '/api/admin/deltagere/1/bevaegelser'],
      ['GET', '/api/admin/indbetalinger?status=afventer'],
      ['POST', '/api/admin/indbetalinger/1/godkend', {}],
      ['POST', '/api/admin/indbetalinger/1/afvis', {}],
      ['GET', '/api/admin/indstillinger'],
      ['PUT', '/api/admin/indstillinger', { butik_aaben: 0 }],
      ['GET', '/api/admin/rapport'],
      ['GET', '/api/admin/udbetalinger'],
      ['POST', '/api/admin/deltagere/1/udbetal', { metode: 'kontant', reference: 'hack' }],
    ];

    it('kunde kan ikke kalde butik/admin (401)', async () => {
      for (const [m, sti, body] of personaleStier) {
        const r = await kunde.kald(m, sti, body);
        assert.equal(r.status, 401, `Kunde fik ${r.status} på ${m} ${sti}`);
      }
      const r = await kunde.kald('POST', `/api/admin/varer/${v.cola.id}/billede`, undefined, {
        headers: { 'content-type': 'image/png' },
        raa: Buffer.from('x'),
      });
      assert.equal(r.status, 401, 'Kunde må ikke uploade billeder');
    });

    it('ikke-logget ind får 401 overalt', async () => {
      const anon = server.browser('anon');
      for (const [m, sti, body] of personaleStier) {
        const r = await anon.kald(m, sti, body);
        assert.equal(r.status, 401, `Anonym fik ${r.status} på ${m} ${sti}`);
      }
      const kundeStier = [
        ['GET', '/api/kunde/mig'],
        ['GET', '/api/kunde/ordrer'],
        ['POST', '/api/kunde/ordrer', { linjer: [{ vare_id: v.vand.id, antal: 1 }], levering: 'hent' }],
        ['POST', '/api/kunde/ordrer/1/annuller', {}],
        ['GET', '/api/kunde/indbetalinger'],
        ['POST', '/api/kunde/indbetalinger', { beloeb_oere: 1000, metode: 'mobilepay', reference: 'x' }],
      ];
      for (const [m, sti, body] of kundeStier) {
        const r = await anon.kald(m, sti, body);
        forvent(r, 401, 'ikke_logget_ind');
      }
    });

    it('personale-cookie giver ikke adgang til kunde-API', async () => {
      forvent(await personale.get('/api/kunde/mig'), 401, 'ikke_logget_ind');
    });

    it('SSE kræver login', async () => {
      const anon = server.browser();
      const s1 = await anon.stroem('/api/kunde/stream');
      assert.equal(s1.status, 401);
      s1.luk();
      const s2 = await anon.stroem('/api/butik/stream');
      assert.equal(s2.status, 401);
      s2.luk();
      const s3 = await kunde.stroem('/api/butik/stream');
      assert.equal(s3.status, 401, 'Kunde må ikke åbne butikkens strøm');
      s3.luk();
    });

    it('adgangsforsøgene ændrede intet', async () => {
      const r = ok(await personale.get('/api/admin/deltagere?q=7777'));
      assert.equal(r.filter((d) => d.pc_nr === 7777).length, 0);
      const ind = ok(await personale.get('/api/admin/indstillinger'));
      assert.equal(somTal(ind.butik_aaben), 1);
      assert.equal(await saldo(kunde), 0);
    });
  });

  // =====================================================================
  describe('Varer (admin)', () => {
    it('opret, ret og skjul vare', async () => {
      const ny = ok(await personale.post('/api/admin/varer', { navn: 'Midlertidig', beskrivelse: 'x', kategori: 'Test', pris_oere: 1234, aktiv: 1, udsolgt: 0, sortering: 950 }));
      assert.equal(ny.pris_oere, 1234);
      let off = ok(await server.browser().get('/api/varer'));
      assert.ok(off.some((x) => x.id === ny.id));
      const rettet = ok(await personale.put(`/api/admin/varer/${ny.id}`, { ...ny, navn: 'Midlertidig 2', pris_oere: 1500 }));
      assert.equal(rettet.navn, 'Midlertidig 2');
      assert.equal(rettet.pris_oere, 1500);
      ok(await personale.del(`/api/admin/varer/${ny.id}`));
      off = ok(await server.browser().get('/api/varer'));
      assert.ok(!off.some((x) => x.id === ny.id), 'Skjult vare må ikke vises offentligt');
      const alle = ok(await personale.get('/api/admin/varer'));
      const skjult = alle.find((x) => x.id === ny.id);
      assert.ok(skjult, 'Admin skal stadig kunne se skjulte varer');
      assert.equal(somTal(skjult.aktiv), 0);
      // En skjult vare kan ikke bestilles.
      const k = await nyKunde();
      await givPenge(k, 5000);
      forvent(await bestil(k, [{ vare_id: ny.id, antal: 1 }]), fejl4xx, 'vare_findes_ikke');
      assert.equal(await saldo(k), 5000);
    });

    it('ugyldige varer afvises', async () => {
      for (const body of [
        { navn: '', kategori: 'Test', pris_oere: 1000 },
        { navn: 'X', kategori: 'Test', pris_oere: -1 },
        { navn: 'X', kategori: 'Test', pris_oere: 12.5 },
      ]) {
        forvent(await personale.post('/api/admin/varer', body), 400);
      }
      forvent(await personale.put('/api/admin/varer/999999', { navn: 'X', kategori: 'Test', pris_oere: 1000 }), 404);
    });

    it('/api/varer er sorteret efter sortering og navn', async () => {
      const a = ok(await personale.post('/api/admin/varer', { navn: 'Bbb', kategori: 'Test', pris_oere: 100, aktiv: 1, udsolgt: 0, sortering: 5 }));
      const b = ok(await personale.post('/api/admin/varer', { navn: 'Aaa', kategori: 'Test', pris_oere: 100, aktiv: 1, udsolgt: 0, sortering: 5 }));
      const c = ok(await personale.post('/api/admin/varer', { navn: 'Ccc', kategori: 'Test', pris_oere: 100, aktiv: 1, udsolgt: 0, sortering: -1 }));
      try {
        const liste = ok(await server.browser().get('/api/varer'));
        for (let i = 1; i < liste.length; i++) {
          const x = liste[i - 1];
          const y = liste[i];
          assert.ok(x.sortering <= y.sortering, `Ikke sorteret efter sortering: ${x.navn} før ${y.navn}`);
        }
        const ids = liste.map((x) => x.id);
        assert.ok(ids.indexOf(c.id) < ids.indexOf(b.id), 'Sortering -1 skal komme før 5');
        assert.ok(ids.indexOf(b.id) < ids.indexOf(a.id), 'Aaa skal komme før Bbb ved samme sortering');
      } finally {
        for (const x of [a, b, c]) ok(await personale.del(`/api/admin/varer/${x.id}`));
      }
    });
  });

  // =====================================================================
  describe('Indbetalinger og saldo', () => {
    it('indbetaling → afventer → godkend giver saldo', async () => {
      const k = await nyKunde();
      const ind = ok(await k.post('/api/kunde/indbetalinger', { beloeb_oere: 10000, metode: 'mobilepay', reference: 'Mads MP' }));
      assert.equal(ind.status, 'afventer');
      assert.equal(ind.beloeb_oere, 10000);
      assert.equal(ind.pc_nr, k.deltager.pc_nr);
      assert.equal(await saldo(k), 0, 'Saldo må først stige, når indbetalingen er godkendt');
      const afv = ok(await personale.get('/api/admin/indbetalinger?status=afventer'));
      assert.ok(afv.some((x) => x.id === ind.id));
      assert.ok(afv.every((x) => x.status === 'afventer'));
      const g = ok(await personale.post(`/api/admin/indbetalinger/${ind.id}/godkend`, {}));
      assert.equal(g.status, 'godkendt');
      assert.equal(await saldo(k), 10000);
      const mine = ok(await k.get('/api/kunde/indbetalinger'));
      assert.equal(mine.find((x) => x.id === ind.id).status, 'godkendt');
      // Kan ikke godkendes eller afvises igen.
      forvent(await personale.post(`/api/admin/indbetalinger/${ind.id}/godkend`, {}), fejl4xx);
      forvent(await personale.post(`/api/admin/indbetalinger/${ind.id}/afvis`, {}), fejl4xx);
      assert.equal(await saldo(k), 10000, 'Dobbelt godkendelse må ikke give penge to gange');
      const afv2 = ok(await personale.get('/api/admin/indbetalinger?status=afventer'));
      assert.ok(!afv2.some((x) => x.id === ind.id));
    });

    it('afvist indbetaling giver ingen saldo', async () => {
      const k = await nyKunde();
      const ind = ok(await k.post('/api/kunde/indbetalinger', { beloeb_oere: 5000, metode: 'kontant', reference: '' }));
      const a = ok(await personale.post(`/api/admin/indbetalinger/${ind.id}/afvis`, {}));
      assert.equal(a.status, 'afvist');
      assert.equal(await saldo(k), 0);
      forvent(await personale.post(`/api/admin/indbetalinger/${ind.id}/godkend`, {}), fejl4xx);
      assert.equal(await saldo(k), 0);
      forvent(await personale.post('/api/admin/indbetalinger/999999/godkend', {}), 404);
    });

    it('samtidige godkendelser af samme indbetaling giver kun penge én gang', async () => {
      const k = await nyKunde();
      const ind = ok(await k.post('/api/kunde/indbetalinger', { beloeb_oere: 3000, metode: 'mobilepay', reference: 'x' }));
      const svar = await Promise.all(Array.from({ length: 10 }, () => personale.post(`/api/admin/indbetalinger/${ind.id}/godkend`, {})));
      assert.equal(svar.filter((r) => ok2xx(r.status)).length, 1);
      assert.equal(await saldo(k), 3000);
    });

    it('ugyldige indbetalinger afvises', async () => {
      const k = await nyKunde();
      for (const body of [
        { beloeb_oere: 0, metode: 'mobilepay', reference: '' },
        { beloeb_oere: -500, metode: 'mobilepay', reference: '' },
        { beloeb_oere: 10.5, metode: 'mobilepay', reference: '' },
        { beloeb_oere: 1000, metode: 'bitcoin', reference: '' },
        { metode: 'mobilepay' },
      ]) {
        forvent(await k.post('/api/kunde/indbetalinger', body), 400);
      }
      assert.equal(ok(await k.get('/api/kunde/indbetalinger')).length, 0);
    });

    it('kunden ser kun egne indbetalinger', async () => {
      const a = await nyKunde();
      const b = await nyKunde();
      ok(await a.post('/api/kunde/indbetalinger', { beloeb_oere: 2000, metode: 'andet', reference: 'a' }));
      const lb = ok(await b.get('/api/kunde/indbetalinger'));
      assert.equal(lb.length, 0);
      const la = ok(await a.get('/api/kunde/indbetalinger'));
      assert.equal(la.length, 1);
      assert.equal(la[0].pc_nr, a.deltager.pc_nr);
    });

    it('manuel justering (+/-), men aldrig negativ saldo', async () => {
      const k = await nyKunde();
      const id = k.deltager.id;
      ok(await personale.post(`/api/admin/deltagere/${id}/saldo`, { beloeb_oere: 5000, tekst: 'Præmie' }));
      assert.equal(await saldo(k), 5000);
      ok(await personale.post(`/api/admin/deltagere/${id}/saldo`, { beloeb_oere: -2000, tekst: 'Retning' }));
      assert.equal(await saldo(k), 3000);
      forvent(await personale.post(`/api/admin/deltagere/${id}/saldo`, { beloeb_oere: -3001, tekst: 'For meget' }), fejl4xx);
      assert.equal(await saldo(k), 3000);
      forvent(await personale.post(`/api/admin/deltagere/${id}/saldo`, { beloeb_oere: 1.5, tekst: 'x' }), 400);
      forvent(await personale.post(`/api/admin/deltagere/${id}/saldo`, { beloeb_oere: 0, tekst: 'x' }), 400);
      const bev = bevaegelserFra(ok(await personale.get(`/api/admin/deltagere/${id}/bevaegelser`)));
      assert.equal(bev.length, 2);
      assert.ok(bev.every((b) => b.type === 'justering'));
      assert.ok(bev.some((b) => b.tekst === 'Præmie'));
    });

    it('kontoudtoget viser typerne indbetaling, koeb og refusion', async () => {
      const k = await nyKunde();
      await givPenge(k, 5000);
      const o = ok(await bestil(k, [{ vare_id: v.cola.id, antal: 1 }]));
      ok(await k.post(`/api/kunde/ordrer/${o.id}/annuller`, {}));
      const bev = bevaegelserFra(ok(await personale.get(`/api/admin/deltagere/${k.deltager.id}/bevaegelser`)));
      const typer = bev.map((b) => b.type).sort();
      assert.deepEqual(typer, ['indbetaling', 'koeb', 'refusion']);
      assert.equal(bev.find((b) => b.type === 'koeb').beloeb_oere, -2000);
      assert.equal(bev.find((b) => b.type === 'refusion').beloeb_oere, 2000);
      assert.equal(bev.find((b) => b.type === 'koeb').ordre_id, o.id);
    });
  });

  // =====================================================================
  describe('Ordrer', () => {
    let k;
    before(async () => {
      k = await nyKunde({ navn: 'Bestiller' });
      await givPenge(k, 60000);
    });

    it('serveren regner prisen ud og ignorerer falske priser', async () => {
      const foer = await saldo(k);
      const r = await k.post('/api/kunde/ordrer', {
        linjer: [
          { vare_id: v.cola.id, antal: 2, pris_oere: 1, navn: 'Gratis' },
          { vare_id: v.vand.id, antal: 1, pris_oere: 0 },
        ],
        levering: 'hent',
        note: 'uden is',
        total_oere: 1,
        pris_oere: 1,
      });
      const o = ok(r);
      assert.equal(o.total_oere, 5000);
      assert.equal(o.id, o.nr);
      assert.equal(o.status, 'ny');
      assert.equal(o.levering, 'hent');
      assert.equal(o.note, 'uden is');
      assert.equal(o.pc_nr, k.deltager.pc_nr);
      assert.equal(o.navn, 'Bestiller');
      assert.ok(o.oprettet && o.opdateret);
      const cola = o.linjer.find((l) => l.vare_id === v.cola.id);
      assert.equal(cola.pris_oere, 2000);
      assert.equal(cola.antal, 2);
      assert.equal(cola.navn, 'Test-cola');
      assert.equal(await saldo(k), foer - 5000);
    });

    it('navn og pris kopieres ved køb', async () => {
      const o = ok(await bestil(k, [{ vare_id: v.toast.id, antal: 1 }]));
      const gl = v.toast;
      ok(await personale.put(`/api/admin/varer/${gl.id}`, { ...gl, navn: 'Toast (ny)', pris_oere: 9900 }));
      try {
        const liste = ok(await k.get('/api/kunde/ordrer'));
        const igen = liste.find((x) => x.id === o.id);
        assert.equal(igen.linjer[0].navn, 'Test-toast');
        assert.equal(igen.linjer[0].pris_oere, 2500);
        assert.equal(igen.total_oere, 2500);
      } finally {
        v.toast = ok(await personale.put(`/api/admin/varer/${gl.id}`, { ...gl }));
      }
    });

    it('tom kurv og ugyldige linjer', async () => {
      const foer = await saldo(k);
      forvent(await bestil(k, []), fejl4xx, 'tom_kurv');
      forvent(await k.post('/api/kunde/ordrer', { levering: 'hent' }), fejl4xx);
      forvent(await bestil(k, [{ vare_id: 999999, antal: 1 }]), fejl4xx, 'vare_findes_ikke');
      for (const antal of [0, -1, 21, 1.5, 'to', null]) {
        forvent(await bestil(k, [{ vare_id: v.vand.id, antal }]), 400);
      }
      forvent(await bestil(k, [{ vare_id: v.vand.id, antal: 1 }], 'raket'), 400);
      // 20 er tilladt
      const o = ok(await bestil(k, [{ vare_id: v.vand.id, antal: 20 }]));
      assert.equal(o.total_oere, 20000);
      assert.equal(await saldo(k), foer - 20000);
      // giv pengene tilbage for de næste tests
      ok(await k.post(`/api/kunde/ordrer/${o.id}/annuller`, {}));
      assert.equal(await saldo(k), foer);
    });

    it('udsolgt vare kan ikke bestilles', async () => {
      ok(await personale.put(`/api/admin/varer/${v.cola.id}`, { ...v.cola, udsolgt: 1 }));
      try {
        const off = ok(await server.browser().get('/api/varer'));
        assert.equal(somTal(off.find((x) => x.id === v.cola.id).udsolgt), 1, 'Udsolgt vare skal stadig vises (som udsolgt)');
        const foer = await saldo(k);
        forvent(await bestil(k, [{ vare_id: v.vand.id, antal: 1 }, { vare_id: v.cola.id, antal: 1 }]), fejl4xx, 'vare_udsolgt');
        assert.equal(await saldo(k), foer, 'Ingen penge må trækkes ved fejl');
      } finally {
        ok(await personale.put(`/api/admin/varer/${v.cola.id}`, { ...v.cola, udsolgt: 0 }));
      }
    });

    it('butik lukket: varer kan ses, men ikke bestilles', async () => {
      await saetIndstilling('butik_aaben', 0);
      try {
        assert.equal(somTal(ok(await server.browser().get('/api/info')).butik_aaben), 0);
        assert.ok(ok(await server.browser().get('/api/varer')).length > 0);
        const foer = await saldo(k);
        forvent(await bestil(k, [{ vare_id: v.vand.id, antal: 1 }]), fejl4xx, 'butik_lukket');
        assert.equal(await saldo(k), foer);
      } finally {
        await saetIndstilling('butik_aaben', 1);
      }
      ok(await bestil(k, [{ vare_id: v.vand.id, antal: 1 }]));
    });

    it('levering under, på og over levering_min_oere', async () => {
      const kk = await nyKunde();
      await givPenge(kk, 50000);
      // 99,99 kr. – lige under grænsen (100 kr.)
      const lav = ok(await personale.post('/api/admin/varer', { navn: 'Næsten', kategori: 'Test', pris_oere: 9999, aktiv: 1, udsolgt: 0, sortering: 999 }));
      try {
        forvent(await bestil(kk, [{ vare_id: lav.id, antal: 1 }], 'bord'), fejl4xx, 'levering_ikke_mulig');
        forvent(await bestil(kk, [{ vare_id: v.cola.id, antal: 4 }], 'bord'), fejl4xx, 'levering_ikke_mulig');
        assert.equal(await saldo(kk), 50000);
        ok(await bestil(kk, [{ vare_id: lav.id, antal: 1 }], 'hent'));
        const paa = ok(await bestil(kk, [{ vare_id: v.cola.id, antal: 5 }], 'bord'));
        assert.equal(paa.total_oere, 10000);
        assert.equal(paa.levering, 'bord');
        ok(await bestil(kk, [{ vare_id: v.toast.id, antal: 5 }], 'bord'));
        assert.equal(await saldo(kk), 50000 - 9999 - 10000 - 12500);
      } finally {
        ok(await personale.del(`/api/admin/varer/${lav.id}`));
      }
    });

    it('levering_min_oere = 0 gør levering altid mulig', async () => {
      await saetIndstilling('levering_min_oere', 0);
      try {
        ok(await bestil(k, [{ vare_id: v.vand.id, antal: 1 }], 'bord'));
      } finally {
        await saetIndstilling('levering_min_oere', 10000);
      }
      forvent(await bestil(k, [{ vare_id: v.vand.id, antal: 1 }], 'bord'), fejl4xx, 'levering_ikke_mulig');
    });

    it('levering slået fra: kun afhentning', async () => {
      await saetIndstilling('levering_aktiv', 0);
      try {
        assert.equal(somTal(ok(await server.browser().get('/api/info')).levering_aktiv), 0);
        const foer = await saldo(k);
        forvent(await bestil(k, [{ vare_id: v.toast.id, antal: 5 }], 'bord'), fejl4xx, 'levering_ikke_mulig');
        assert.equal(await saldo(k), foer);
        ok(await bestil(k, [{ vare_id: v.vand.id, antal: 1 }], 'hent'));
      } finally {
        await saetIndstilling('levering_aktiv', 1);
      }
    });

    it('ikke nok penge', async () => {
      const fattig = await nyKunde();
      forvent(await bestil(fattig, [{ vare_id: v.vand.id, antal: 1 }]), fejl4xx, 'ikke_nok_penge');
      await givPenge(fattig, 2500);
      forvent(await bestil(fattig, [{ vare_id: v.cola.id, antal: 2 }]), fejl4xx, 'ikke_nok_penge');
      assert.equal(await saldo(fattig), 2500);
      assert.equal(ok(await fattig.get('/api/kunde/ordrer')).length, 0, 'Afviste ordrer må ikke gemmes');
      // Præcis nok penge går fint og giver saldo 0.
      ok(await bestil(fattig, [{ vare_id: v.toast.id, antal: 1 }]));
      assert.equal(await saldo(fattig), 0);
    });

    it('20 samtidige ordrer med penge til 3 – præcis 3 lykkes', async () => {
      const kk = await nyKunde();
      await givPenge(kk, 6000);
      const svar = await Promise.all(Array.from({ length: 20 }, () => bestil(kk, [{ vare_id: v.cola.id, antal: 1 }])));
      const lykkedes = svar.filter((r) => ok2xx(r.status));
      assert.equal(lykkedes.length, 3, `Forventede 3 ordrer, fik ${lykkedes.length}`);
      for (const r of svar.filter((r) => !ok2xx(r.status))) forvent(r, fejl4xx, 'ikke_nok_penge');
      assert.equal(await saldo(kk), 0);
      assert.equal(ok(await kk.get('/api/kunde/ordrer')).length, 3);
    });

    it('kunden ser kun egne ordrer, nyeste først', async () => {
      const a = await nyKunde();
      const b = await nyKunde();
      await givPenge(a, 5000);
      const o1 = ok(await bestil(a, [{ vare_id: v.vand.id, antal: 1 }]));
      const o2 = ok(await bestil(a, [{ vare_id: v.vand.id, antal: 2 }]));
      const la = ok(await a.get('/api/kunde/ordrer'));
      assert.deepEqual(la.map((o) => o.id), [o2.id, o1.id]);
      assert.equal(ok(await b.get('/api/kunde/ordrer')).length, 0);
    });

    it('annuller: kun egen ordre, kun med status ny, og pengene kommer tilbage', async () => {
      const a = await nyKunde();
      const b = await nyKunde();
      await givPenge(a, 10000);
      const o = ok(await bestil(a, [{ vare_id: v.toast.id, antal: 2 }]));
      assert.equal(await saldo(a), 5000);
      // B må ikke annullere A's ordre.
      forvent(await b.post(`/api/kunde/ordrer/${o.id}/annuller`, {}), fejl4xx);
      assert.equal(await saldo(a), 5000);
      assert.equal(await saldo(b), 0);
      // A annullerer.
      const ann = ok(await a.post(`/api/kunde/ordrer/${o.id}/annuller`, {}));
      assert.equal(ann.status, 'annulleret');
      assert.equal(await saldo(a), 10000);
      // Igen → fejl, ingen dobbelt refusion.
      forvent(await a.post(`/api/kunde/ordrer/${o.id}/annuller`, {}), fejl4xx);
      assert.equal(await saldo(a), 10000);
      // Når butikken er gået i gang, kan kunden ikke annullere.
      const o2 = ok(await bestil(a, [{ vare_id: v.vand.id, antal: 1 }]));
      ok(await saetStatus(o2.id, 'laves'));
      forvent(await a.post(`/api/kunde/ordrer/${o2.id}/annuller`, {}), fejl4xx);
      assert.equal(await saldo(a), 9000);
      forvent(await a.post('/api/kunde/ordrer/999999/annuller', {}), fejl4xx);
    });

    it('samtidige annulleringer refunderer kun én gang', async () => {
      const a = await nyKunde();
      await givPenge(a, 2000);
      const o = ok(await bestil(a, [{ vare_id: v.cola.id, antal: 1 }]));
      const svar = await Promise.all([
        ...Array.from({ length: 5 }, () => a.post(`/api/kunde/ordrer/${o.id}/annuller`, {})),
        ...Array.from({ length: 5 }, () => saetStatus(o.id, 'annulleret')),
      ]);
      assert.equal(svar.filter((r) => ok2xx(r.status)).length, 1);
      assert.equal(await saldo(a), 2000);
    });
  });

  // =====================================================================
  describe('Statusskift (butik)', () => {
    let k;
    before(async () => {
      k = await nyKunde({ navn: 'Status' });
      await givPenge(k, 30000);
    });

    async function nyOrdre() {
      return ok(await bestil(k, [{ vare_id: v.vand.id, antal: 1 }]));
    }

    it('hele vejen: ny → laves → klar → leveret, med lovlige skridt tilbage', async () => {
      const o = await nyOrdre();
      const skift = async (status, forventet = 200) => {
        const r = await saetStatus(o.id, status);
        if (forventet === 200) {
          const d = ok(r);
          assert.equal(d.status, status);
          assert.equal(d.id, o.id);
          assert.ok(Array.isArray(d.linjer));
        } else {
          forvent(r, 409, 'ugyldigt_skift');
        }
      };
      await skift('klar', 409);
      await skift('leveret', 409);
      await skift('ny', 409);
      await skift('laves');
      await skift('laves', 409);
      await skift('ny'); // ét skridt tilbage
      await skift('laves');
      await skift('leveret', 409);
      await skift('klar');
      await skift('ny', 409);
      await skift('annulleret', 409);
      await skift('laves'); // tilbage
      await skift('klar');
      await skift('leveret');
      for (const s of ['ny', 'laves', 'klar', 'annulleret', 'leveret']) await skift(s, 409);
      assert.equal(await saldo(k), 30000 - 1000, 'Leveret ordre må ikke refunderes');
    });

    it('ukendt status og ukendt ordre', async () => {
      const o = await nyOrdre();
      forvent(await saetStatus(o.id, 'spist'), fejl4xx);
      forvent(await saetStatus(o.id, ''), fejl4xx);
      forvent(await saetStatus(999999, 'laves'), 404);
      const r = ok(await k.get('/api/kunde/ordrer')).find((x) => x.id === o.id);
      assert.equal(r.status, 'ny');
    });

    it('annullering fra ny og fra laves refunderer; annulleret er endeligt', async () => {
      const foer = await saldo(k);
      const a = await nyOrdre();
      const b = await nyOrdre();
      assert.equal(await saldo(k), foer - 2000);
      ok(await saetStatus(a.id, 'annulleret'));
      ok(await saetStatus(b.id, 'laves'));
      ok(await saetStatus(b.id, 'annulleret'));
      assert.equal(await saldo(k), foer);
      for (const s of ['ny', 'laves', 'klar', 'leveret', 'annulleret']) {
        forvent(await saetStatus(a.id, s), 409, 'ugyldigt_skift');
      }
      assert.equal(await saldo(k), foer);
    });

    it('GET /api/butik/ordrer: filter og ældste først', async () => {
      const o1 = await nyOrdre();
      const o2 = await nyOrdre();
      const o3 = await nyOrdre();
      ok(await saetStatus(o2.id, 'laves'));
      ok(await saetStatus(o3.id, 'laves'));
      ok(await saetStatus(o3.id, 'klar'));
      const nye = ok(await personale.get('/api/butik/ordrer?status=ny'));
      assert.ok(nye.every((o) => o.status === 'ny'));
      assert.ok(nye.some((o) => o.id === o1.id));
      const flere = ok(await personale.get('/api/butik/ordrer?status=laves,klar'));
      assert.ok(flere.every((o) => o.status === 'laves' || o.status === 'klar'));
      assert.ok(flere.some((o) => o.id === o2.id) && flere.some((o) => o.id === o3.id));
      for (const liste of [nye, flere]) {
        for (let i = 1; i < liste.length; i++) {
          assert.ok(liste[i - 1].id < liste[i].id, 'Butikkens liste skal være ældste først');
        }
      }
      // Uden filter: aktive + nyligt leverede/annullerede
      const alle = ok(await personale.get('/api/butik/ordrer'));
      const ids = new Set(alle.map((o) => o.id));
      assert.ok(ids.has(o1.id) && ids.has(o2.id) && ids.has(o3.id));
      ok(await saetStatus(o3.id, 'leveret'));
      const efter = ok(await personale.get('/api/butik/ordrer'));
      assert.equal(efter.find((o) => o.id === o3.id)?.status, 'leveret', 'Nyligt leverede skal med uden filter');
      const o = efter.find((x) => x.id === o1.id);
      for (const f of ['id', 'nr', 'pc_nr', 'navn', 'total_oere', 'levering', 'note', 'status', 'oprettet', 'opdateret', 'linjer']) {
        assert.ok(f in o, `Ordre mangler ${f}`);
      }
    });
  });

  // =====================================================================
  describe('Udbetaling af restsaldo (tillæg 1)', () => {
    it('udbetal hele saldoen: saldo 0, bevægelse "udbetaling", vises i historik', async () => {
      const k = await nyKunde({ navn: 'Hjemrejse' });
      await givPenge(k, 10000);
      ok(await bestil(k, [{ vare_id: v.toast.id, antal: 1 }]));
      const liste1 = ok(await personale.get('/api/admin/udbetalinger'));
      assert.ok(Array.isArray(liste1.mangler) && Array.isArray(liste1.udbetalt));
      const m = liste1.mangler.find((d) => d.id === k.deltager.id);
      assert.ok(m, 'Deltageren skal stå under "mangler"');
      assert.equal(m.saldo_oere, 7500);
      assert.ok(liste1.mangler.every((d) => d.saldo_oere > 0), '"mangler" må kun have deltagere med saldo > 0');

      const s = await k.stroem('/api/kunde/stream');
      try {
        ok(await personale.post(`/api/admin/deltagere/${k.deltager.id}/udbetal`, { metode: 'mobilepay', reference: 'MobilePay til 12345678' }));
        await s.vent((h) => h.event === 'saldo' && h.data.saldo_oere === 0, { beskrivelse: 'saldo 0 efter udbetaling' });
      } finally {
        s.luk();
      }
      assert.equal(await saldo(k), 0);
      const bev = bevaegelserFra(ok(await personale.get(`/api/admin/deltagere/${k.deltager.id}/bevaegelser`)));
      const u = bev.filter((b) => b.type === 'udbetaling');
      assert.equal(u.length, 1);
      assert.equal(u[0].beloeb_oere, -7500);

      const liste2 = ok(await personale.get('/api/admin/udbetalinger'));
      assert.ok(!liste2.mangler.some((d) => d.id === k.deltager.id));
      const h = liste2.udbetalt.find((x) => x.pc_nr === k.deltager.pc_nr);
      assert.ok(h, 'Udbetalingen skal stå i historikken');
      assert.equal(h.beloeb_oere, 7500);
      assert.equal(h.metode, 'mobilepay');
      assert.equal(h.reference, 'MobilePay til 12345678');
      assert.equal(h.navn, 'Hjemrejse');
      assert.ok(h.id && h.oprettet);

      // Igen → 409 ingen_saldo.
      forvent(await personale.post(`/api/admin/deltagere/${k.deltager.id}/udbetal`, { metode: 'kontant', reference: '' }), 409, 'ingen_saldo');
      assert.equal(ok(await personale.get('/api/admin/udbetalinger')).udbetalt.filter((x) => x.pc_nr === k.deltager.pc_nr).length, 1);
    });

    it('deltager uden penge: 409 ingen_saldo; ukendt deltager: 404', async () => {
      const k = await nyKunde();
      forvent(await personale.post(`/api/admin/deltagere/${k.deltager.id}/udbetal`, { metode: 'kontant', reference: '' }), 409, 'ingen_saldo');
      forvent(await personale.post('/api/admin/deltagere/999999/udbetal', { metode: 'kontant', reference: '' }), 404);
    });

    it('samtidige udbetalinger udbetaler kun én gang', async () => {
      const k = await nyKunde();
      await givPenge(k, 4000);
      const svar = await Promise.all(Array.from({ length: 10 }, () => personale.post(`/api/admin/deltagere/${k.deltager.id}/udbetal`, { metode: 'kontant', reference: '' })));
      assert.equal(svar.filter((r) => ok2xx(r.status)).length, 1);
      for (const r of svar.filter((r) => !ok2xx(r.status))) forvent(r, 409, 'ingen_saldo');
      assert.equal(await saldo(k), 0);
    });

    it('udbetaling samtidig med bestillinger giver aldrig negativ saldo', async () => {
      const k = await nyKunde();
      await givPenge(k, 10000);
      const svar = await Promise.all([
        ...Array.from({ length: 5 }, () => bestil(k, [{ vare_id: v.cola.id, antal: 1 }])),
        personale.post(`/api/admin/deltagere/${k.deltager.id}/udbetal`, { metode: 'kontant', reference: '' }),
        ...Array.from({ length: 5 }, () => bestil(k, [{ vare_id: v.cola.id, antal: 1 }])),
      ]);
      assert.ok(svar.every((r) => r.status < 500));
      assert.equal(await saldo(k), 0);
      const bev = bevaegelserFra(ok(await personale.get(`/api/admin/deltagere/${k.deltager.id}/bevaegelser`)));
      assert.equal(bev.reduce((s, b) => s + b.beloeb_oere, 0), 0);
    });

    it('efter udbetaling kan deltageren ikke bestille', async () => {
      const k = await nyKunde();
      await givPenge(k, 2000);
      ok(await personale.post(`/api/admin/deltagere/${k.deltager.id}/udbetal`, { metode: 'andet', reference: 'kontanter i hånden' }));
      forvent(await bestil(k, [{ vare_id: v.vand.id, antal: 1 }]), fejl4xx, 'ikke_nok_penge');
    });

    it('ugyldig metode afvises', async () => {
      const k = await nyKunde();
      await givPenge(k, 2000);
      forvent(await personale.post(`/api/admin/deltagere/${k.deltager.id}/udbetal`, { metode: 'bitcoin', reference: '' }), 400);
      assert.equal(await saldo(k), 2000);
    });

    it('regnskabet går op: indbetalt = omsætning + udbetalt + samlet saldo', async () => {
      // Kun gyldigt uden manuelle justeringer – dem har testene ovenfor lavet, så de trækkes fra via databasen.
      const r = ok(await personale.get('/api/admin/rapport'));
      assert.ok('udbetalt_oere' in r, 'Rapporten mangler udbetalt_oere');
      const db = aabnDb(server);
      let just;
      try {
        just = db.prepare("SELECT COALESCE(SUM(beloeb_oere),0) AS s FROM saldo_bevaegelser WHERE type = 'justering'").get().s;
      } finally {
        db.close();
      }
      assert.equal(r.indbetalt_oere + Number(just), r.omsaetning_oere + r.udbetalt_oere + r.samlet_saldo_oere,
        `indbetalt ${r.indbetalt_oere} + justeringer ${just} ≠ omsætning ${r.omsaetning_oere} + udbetalt ${r.udbetalt_oere} + saldo ${r.samlet_saldo_oere}`);
    });
  });

  // =====================================================================
  describe('SSE-hændelser', () => {
    let a, b, sa, sb, sbutik;
    before(async () => {
      a = await nyKunde({ navn: 'Anna' });
      b = await nyKunde({ navn: 'Bo' });
      sa = await a.stroem('/api/kunde/stream');
      sb = await b.stroem('/api/kunde/stream');
      sbutik = await personale.stroem('/api/butik/stream');
    });
    after(() => {
      for (const s of [sa, sb, sbutik]) s && s.luk();
    });

    it('strømmene svarer 200 med text/event-stream', () => {
      for (const s of [sa, sb, sbutik]) {
        assert.equal(s.status, 200);
        assert.match(s.headers['content-type'] || '', /text\/event-stream/);
      }
    });

    it('indbetaling: butikken får besked, kunden får indbetaling + saldo ved godkendelse', async () => {
      const ind = ok(await a.post('/api/kunde/indbetalinger', { beloeb_oere: 20000, metode: 'mobilepay', reference: 'Anna' }));
      await sbutik.vent((h) => h.event === 'indbetaling' && h.data.id === ind.id && h.data.status === 'afventer', { beskrivelse: 'ny indbetaling på butikkens strøm' });
      ok(await personale.post(`/api/admin/indbetalinger/${ind.id}/godkend`, {}));
      await sa.vent((h) => h.event === 'indbetaling' && h.data.id === ind.id && h.data.status === 'godkendt', { beskrivelse: 'godkendt indbetaling' });
      await sa.vent((h) => h.event === 'saldo' && h.data.saldo_oere === 20000, { beskrivelse: 'saldo 20000' });
    });

    it('ordre: butikken får ny ordre, kunden får status og saldo', async () => {
      const o = ok(await bestil(a, [{ vare_id: v.toast.id, antal: 1 }]));
      const h = await sbutik.vent((h) => h.event === 'ordre' && h.data.id === o.id && h.data.status === 'ny', { beskrivelse: 'ny ordre på butikkens strøm' });
      assert.equal(h.data.pc_nr, a.deltager.pc_nr);
      assert.equal(h.data.linjer.length, 1);
      await sa.vent((h) => h.event === 'saldo' && h.data.saldo_oere === 17500, { beskrivelse: 'saldo efter køb' });
      for (const s of ['laves', 'klar', 'leveret']) {
        ok(await saetStatus(o.id, s));
        await sa.vent((h) => h.event === 'ordre' && h.data.id === o.id && h.data.status === s, { beskrivelse: `ordre ${s} hos kunden` });
        await sbutik.vent((h) => h.event === 'ordre' && h.data.id === o.id && h.data.status === s, { beskrivelse: `ordre ${s} hos butikken` });
      }
    });

    it('annullering giver ordre- og saldo-hændelse', async () => {
      const o = ok(await bestil(a, [{ vare_id: v.vand.id, antal: 2 }]));
      await sa.vent((h) => h.event === 'saldo' && h.data.saldo_oere === 15500, { beskrivelse: 'saldo efter køb' });
      const idx = sa.haendelser.length;
      ok(await a.post(`/api/kunde/ordrer/${o.id}/annuller`, {}));
      await sa.vent((h) => h.event === 'ordre' && h.data.id === o.id && h.data.status === 'annulleret', { beskrivelse: 'annulleret ordre' });
      await sa.vent((h) => h.event === 'saldo' && h.data.saldo_oere === 17500, { beskrivelse: 'saldo efter refusion', fraIndeks: idx });
      await sbutik.vent((h) => h.event === 'ordre' && h.data.id === o.id && h.data.status === 'annulleret', { beskrivelse: 'annulleret hos butikken' });
    });

    it('info-hændelse til alle kunder, når indstillinger ændres', async () => {
      await saetIndstilling('traef_navn', 'SSE-Træf');
      try {
        for (const s of [sa, sb]) {
          const h = await s.vent((h) => h.event === 'info' && h.data.traef_navn === 'SSE-Træf', { beskrivelse: 'info med nyt navn' });
          assert.ok('butik_aaben' in h.data && 'levering_min_oere' in h.data);
        }
      } finally {
        await saetIndstilling('traef_navn', 'Træf-butikken');
      }
    });

    it('B fik ingen af A\'s hændelser', async () => {
      // Markør: en hændelse til B. Alt der var sendt forkert til B før, ligger før markøren.
      const ind = ok(await b.post('/api/kunde/indbetalinger', { beloeb_oere: 1234, metode: 'kontant', reference: 'Bo' }));
      ok(await personale.post(`/api/admin/indbetalinger/${ind.id}/godkend`, {}));
      await sb.vent((h) => h.event === 'saldo' && h.data.saldo_oere === 1234, { beskrivelse: 'B\'s saldo' });
      const forkerte = sb.haendelser.filter(
        (h) =>
          (h.event === 'ordre' && h.data.pc_nr !== b.deltager.pc_nr) ||
          (h.event === 'indbetaling' && h.data.pc_nr !== b.deltager.pc_nr) ||
          (h.event === 'saldo' && ![0, 1234].includes(h.data.saldo_oere)) // B har kun haft 0 og 1234
      );
      assert.deepEqual(forkerte.map((h) => h.raa), [], 'B modtog andres hændelser');
      // Og A fik ikke B's.
      const tilA = sa.haendelser.filter((h) => (h.event === 'indbetaling' || h.event === 'ordre') && h.data.pc_nr !== a.deltager.pc_nr);
      assert.deepEqual(tilA.map((h) => h.raa), []);
    });

    it('logget ud kunde holder op med at få hændelser på en ny strøm', async () => {
      const c = await nyKunde();
      ok(await c.post('/api/kunde/logout', {}));
      const s = await c.stroem('/api/kunde/stream');
      assert.equal(s.status, 401);
      s.luk();
    });
  });

  // =====================================================================
  describe('Billeder', () => {
    // 1×1 PNG
    const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#0f0"/></svg>');

    async function upload(b, id, type, data) {
      return b.kald('POST', `/api/admin/varer/${id}/billede`, undefined, { headers: { 'content-type': type }, raa: data });
    }

    it('upload af PNG og SVG, og billedet kan hentes', async () => {
      for (const [type, data] of [['image/png', PNG], ['image/svg+xml', SVG]]) {
        const r = await upload(personale, v.vand.id, type, data);
        ok(r);
        const vare = ok(await server.browser().get('/api/varer')).find((x) => x.id === v.vand.id);
        assert.ok(vare.billede_url && vare.billede_url.startsWith('/billeder/'), `billede_url: ${vare.billede_url}`);
        const g = await server.browser().get(vare.billede_url);
        assert.equal(g.status, 200);
        assert.equal((g.headers['content-type'] || '').split(';')[0], type);
        assert.ok(g.buffer.equals(data), 'Billedet skal hentes uændret');
      }
    });

    it('forkert type afvises', async () => {
      for (const type of ['text/plain', 'application/json', 'text/html', 'application/octet-stream', 'image/bmp']) {
        const r = await upload(personale, v.vand.id, type, Buffer.from('<script>alert(1)</script>'));
        forvent(r, fejl4xx);
      }
      const r = await personale.kald('POST', `/api/admin/varer/${v.vand.id}/billede`, undefined, { raa: PNG });
      forvent(r, fejl4xx);
    });

    it('over 3 MB afvises, 3 MB er ok', async () => {
      const for_stor = Buffer.alloc(3 * 1024 * 1024 + 1, 0x41);
      const r = await upload(personale, v.vand.id, 'image/png', for_stor);
      forvent(r, (s) => s === 413 || s === 400);
      const lige = Buffer.alloc(3 * 1024 * 1024, 0x41);
      PNG.copy(lige);
      ok(await upload(personale, v.vand.id, 'image/png', lige));
      ok(await server.browser().get('/api/info'));
    });

    it('upload til ukendt vare giver 404', async () => {
      forvent(await upload(personale, 999999, 'image/png', PNG), 404);
    });

    it('ingen sti-traversal på /billeder/ eller statiske filer', async () => {
      const stier = [
        '/billeder/../butik.db',
        '/billeder/../../SPEC.md',
        '/billeder/..%2fbutik.db',
        '/billeder/..%2f..%2fSPEC.md',
        '/billeder/%2e%2e/butik.db',
        '/billeder/%2e%2e%2f%2e%2e%2fSPEC.md',
        '/billeder/..%5cbutik.db',
        '/billeder/..\\butik.db',
        '/billeder/..%5c..%5cSPEC.md',
        '/billeder/%252e%252e%252fbutik.db',
        '/billeder/....//butik.db',
        '/billeder/%00../butik.db',
        '/billeder/',
        '/billeder/C:%5cWindows%5cwin.ini',
        '/billeder//etc/passwd',
        '/../SPEC.md',
        '/kunde/../../SPEC.md',
        '/kunde/..%2f..%2fSPEC.md',
        '/kunde/%2e%2e/%2e%2e/server/server.js',
        '/butik/..%5c..%5cserver%5cserver.js',
        '/admin/../../.git/HEAD',
      ];
      for (const sti of stier) {
        const r = await raatKald({ port: server.port, sti });
        const tekst = r.buffer.toString('latin1');
        assert.ok(r.status !== 200 || !/SQLite format|# Træf-butik|require\(|\[fonts\]|ref: refs/.test(tekst),
          `Sti-traversal: ${sti} gav ${r.status} og afslørede en fil`);
        assert.ok(r.status < 500, `${sti} gav ${r.status}`);
        if (sti.startsWith('/billeder/')) assert.ok(r.status >= 400, `${sti} burde give fejl, gav ${r.status}`);
      }
      assert.equal(server.afsluttet, null, 'Serveren døde');
    });
  });

  // =====================================================================
  describe('Robusthed', () => {
    it('ugyldig JSON giver 400, ikke 500', async () => {
      const k = await nyKunde();
      for (const raa of ['{', 'null', '[]', '"tekst"', 'ikke json']) {
        const r = await k.kald('POST', '/api/kunde/ordrer', undefined, { headers: { 'content-type': 'application/json' }, raa });
        assert.ok(r.status >= 400 && r.status < 500, `${raa} gav ${r.status}`);
      }
      const r = await server.browser().kald('POST', '/api/kunde/login', undefined, { headers: { 'content-type': 'application/json' }, raa: '{"pc_nr":' });
      forvent(r, 400);
    });

    it('JSON-body over 64 KB afvises', async () => {
      const k = await nyKunde();
      const r = await k.post('/api/kunde/ordrer', { linjer: [{ vare_id: v.vand.id, antal: 1 }], levering: 'hent', note: 'x'.repeat(70 * 1024) });
      forvent(r, (s) => s === 413 || s === 400);
    });

    it('meget lang note afvises eller afkortes', async () => {
      const k = await nyKunde();
      await givPenge(k, 1000);
      const r = await bestil(k, [{ vare_id: v.vand.id, antal: 1 }], 'hent', 'n'.repeat(5000));
      if (ok2xx(r.status)) assert.ok(r.data.note.length <= 1000, 'Noten bør begrænses');
      else forvent(r, 400);
    });

    it('ingen svar med status 5xx i hele testen', () => {
      assert.deepEqual(svar5xx, []);
      assert.equal(server.afsluttet, null, 'Serveren må ikke være stoppet');
    });
  });
});

// =====================================================================
// Rapporten testes på en frisk server, så tallene er kendte.
describe('Rapport', () => {
  let server;
  before(async () => {
    server = await startServer();
  });
  after(async () => {
    if (server) await server.stop();
  });

  it('rapporten summerer salg, indbetalinger og saldi', async () => {
    const p = server.browser('personale');
    ok(await p.post('/api/personale/opsaet', { navn: ADMIN, kode: PERSONALE_KODE }));
    const lav = async (navn, pris_oere) => ok(await p.post('/api/admin/varer', { navn, kategori: 'Test', pris_oere, aktiv: 1, udsolgt: 0, sortering: 0 }));
    const v1 = await lav('Rapport-cola', 2000);
    const v2 = await lav('Rapport-vand', 1000);

    const tom = ok(await p.get('/api/admin/rapport'));
    assert.equal(tom.omsaetning_oere, 0);
    assert.equal(tom.antal_ordrer, 0);
    assert.equal(tom.indbetalt_oere, 0);
    assert.equal(tom.samlet_saldo_oere, 0);
    assert.equal(tom.udbetalt_oere, 0);

    // A får penge via check-in (startbeløb), B via indbetaling + godkendelse.
    const a = server.browser();
    const da = ok(await p.post('/api/admin/deltagere', { pc_nr: 1, navn: 'R1', startbeloeb_oere: 10000, metode: 'kontant' }));
    ok(await a.post('/api/kunde/login', { pc_nr: 1, pin: da.pin }));
    const b = server.browser();
    const db_ = ok(await p.post('/api/admin/deltagere', { pc_nr: 2, navn: 'R2', pin: '2222' }));
    ok(await b.post('/api/kunde/login', { pc_nr: 2, pin: '2222' }));
    const indB = ok(await b.post('/api/kunde/indbetalinger', { beloeb_oere: 5000, metode: 'mobilepay', reference: '' }));
    ok(await p.post(`/api/admin/indbetalinger/${indB.id}/godkend`, {}));
    // C får 3000 og får det hele udbetalt.
    const dc = ok(await p.post('/api/admin/deltagere', { pc_nr: 3, navn: 'R3', startbeloeb_oere: 3000 }));
    ok(await p.post(`/api/admin/deltagere/${dc.id}/udbetal`, { metode: 'kontant', reference: '' }));
    assert.ok(db_.id);
    // Afvist indbetaling tæller ikke.
    const afv = ok(await b.post('/api/kunde/indbetalinger', { beloeb_oere: 99900, metode: 'andet', reference: '' }));
    ok(await p.post(`/api/admin/indbetalinger/${afv.id}/afvis`, {}));

    const bestil = async (k, linjer) => ok(await k.post('/api/kunde/ordrer', { linjer, levering: 'hent', note: '' }));
    const lever = async (o) => {
      for (const s of ['laves', 'klar', 'leveret']) ok(await p.post(`/api/butik/ordrer/${o.id}/status`, { status: s }));
    };
    const o1 = await bestil(a, [{ vare_id: v1.id, antal: 2 }, { vare_id: v2.id, antal: 1 }]); // 5000
    const o2 = await bestil(b, [{ vare_id: v1.id, antal: 1 }]); // 2000 – annulleres
    const o3 = await bestil(b, [{ vare_id: v2.id, antal: 3 }]); // 3000
    ok(await b.post(`/api/kunde/ordrer/${o2.id}/annuller`, {}));
    await lever(o1);
    await lever(o3);

    const r = ok(await p.get('/api/admin/rapport'));
    assert.equal(r.omsaetning_oere, 8000);
    assert.equal(r.antal_ordrer, 2, 'Annullerede ordrer tæller ikke med');
    assert.equal(r.indbetalt_oere, 18000);
    assert.equal(r.udbetalt_oere, 3000);
    assert.equal(r.samlet_saldo_oere, 7000);
    assert.equal(r.omsaetning_oere + r.udbetalt_oere + r.samlet_saldo_oere, r.indbetalt_oere, 'Regnskabet går ikke op');
    const u = ok(await p.get('/api/admin/udbetalinger'));
    assert.deepEqual(u.mangler.map((d) => d.pc_nr).sort(), [1, 2]);
    assert.equal(u.udbetalt.length, 1);
    assert.equal(u.udbetalt[0].beloeb_oere, 3000);
    const pv = Object.fromEntries(r.pr_vare.map((x) => [x.navn, x]));
    assert.deepEqual({ antal: pv['Rapport-cola']?.antal, beloeb_oere: pv['Rapport-cola']?.beloeb_oere }, { antal: 2, beloeb_oere: 4000 });
    assert.deepEqual({ antal: pv['Rapport-vand']?.antal, beloeb_oere: pv['Rapport-vand']?.beloeb_oere }, { antal: 4, beloeb_oere: 4000 });
    assert.deepEqual(tjekSaldiIDb(server), []);
  });
});
