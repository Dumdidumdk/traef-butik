'use strict';
// Tillæg 3: personale med roller (admin og ekspedient). Kør: node --test test/roller.test.js

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, aabnDb, tjekSaldiIDb } = require('./hjaelp.js');

const ok2xx = (s) => s >= 200 && s < 300;
function vis(r) {
  return `status ${r.status}: ${r.tekst.slice(0, 300)}`;
}
function ok(r) {
  assert.ok(ok2xx(r.status), `Uventet ${vis(r)}`);
  return r.data;
}
function fejl(r, status, kode) {
  assert.equal(r.status, status, `Forventede ${status} ${kode || ''}, fik ${vis(r)}`);
  if (kode) assert.equal(r.data && r.data.kode, kode, `Forventede kode ${kode}, fik ${vis(r)}`);
  return r.data;
}
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

describe('Personale med roller', () => {
  let server;
  let admin; // browser for "Chef Søs" (admin)
  let eksp; // browser for "Mads" (ekspedient)
  let kunde;
  let deltager;
  let vare;
  const KODE_ADMIN = 'chef-kode-123';
  const KODE_EKSP = 'mads-kode-456';

  before(async () => {
    server = await startServer();
  });
  after(async () => {
    if (server) await server.stop();
  });

  // ---------------------------------------------------------------
  describe('opsætning og login', () => {
    it('før opsætning: personale_opsat er false, og opsaet kræver en kode på min. 6 tegn', async () => {
      assert.equal(ok(await server.browser().get('/api/info')).personale_opsat, false);
      fejl(await server.browser().post('/api/personale/opsaet', { navn: 'Chef Søs', kode: '12345' }), 400);
      assert.equal(ok(await server.browser().get('/api/info')).personale_opsat, false);
    });

    it('opsaet opretter første admin og logger ind', async () => {
      admin = server.browser('Chef Søs');
      ok(await admin.post('/api/personale/opsaet', { navn: 'Chef Søs', kode: KODE_ADMIN }));
      assert.ok(admin.cookies.has('personale'));
      const mig = ok(await admin.get('/api/personale/mig'));
      assert.equal(mig.navn, 'Chef Søs');
      assert.equal(mig.rolle, 'admin');
      assert.ok(Number.isInteger(mig.id));
      assert.equal(ok(await server.browser().get('/api/info')).personale_opsat, true);
    });

    it('opsaet virker kun, når der ikke findes personale', async () => {
      const r = await server.browser().post('/api/personale/opsaet', { navn: 'Indtrænger', kode: 'indtraenger-1' });
      assert.ok(r.status === 409 || r.status === 403, `Anden opsætning gav ${r.status}`);
      fejl(await server.browser().post('/api/personale/login', { navn: 'Indtrænger', kode: 'indtraenger-1' }), 401, 'forkert_login');
    });

    it('admin opretter en ekspedient, som kan logge ind', async () => {
      const ny = ok(await admin.post('/api/admin/personale', { navn: 'Mads', rolle: 'ekspedient', kode: KODE_EKSP }));
      assert.equal(ny.navn, 'Mads');
      assert.equal(ny.rolle, 'ekspedient');
      assert.ok(!('kode_hash' in ny) && !('kode_salt' in ny) && !('kode' in ny), 'Koden må ikke sendes ud');
      eksp = server.browser('Mads');
      const mig = ok(await eksp.post('/api/personale/login', { navn: 'Mads', kode: KODE_EKSP }));
      assert.deepEqual({ navn: mig.navn, rolle: mig.rolle }, { navn: 'Mads', rolle: 'ekspedient' });
      assert.ok(Number.isInteger(mig.id));
      const ck = eksp.sidsteSetCookie.find((c) => c.startsWith('personale='));
      assert.ok(ck && /HttpOnly/i.test(ck) && /SameSite=Lax/i.test(ck), 'Personale-cookien skal være HttpOnly og SameSite=Lax');
    });

    it('forkert kode og ukendt navn giver samme 401 forkert_login', async () => {
      const a = fejl(await server.browser().post('/api/personale/login', { navn: 'Mads', kode: 'forkert-kode' }), 401, 'forkert_login');
      const b = fejl(await server.browser().post('/api/personale/login', { navn: 'Findes Ikke', kode: 'forkert-kode' }), 401, 'forkert_login');
      assert.equal(a.fejl, b.fejl, 'Beskeden må ikke afsløre, om navnet findes');
    });

    it('navne er unikke uden hensyn til store/små bogstaver; kode min. 6 tegn; gyldig rolle', async () => {
      const r = await admin.post('/api/admin/personale', { navn: 'mads', rolle: 'ekspedient', kode: 'en-anden-kode' });
      assert.equal(r.status, 409, `"mads" ved siden af "Mads" skal afvises, fik ${vis(r)}`);
      fejl(await admin.post('/api/admin/personale', { navn: 'Kort Kode', rolle: 'ekspedient', kode: '12345' }), 400);
      fejl(await admin.post('/api/admin/personale', { navn: 'Konge', rolle: 'konge', kode: 'gyldig-kode' }), 400);
    });

    it('GET /api/admin/personale viser konti uden koder', async () => {
      const liste = ok(await admin.get('/api/admin/personale'));
      assert.deepEqual(liste.map((x) => x.navn).sort(), ['Chef Søs', 'Mads']);
      for (const x of liste) {
        for (const f of ['id', 'navn', 'rolle', 'aktiv', 'oprettet', 'sidst_logget_ind']) assert.ok(f in x, `Personale mangler ${f}`);
        assert.ok(!JSON.stringify(x).match(/kode_hash|kode_salt/), 'Koder må ikke sendes ud');
      }
      assert.ok(liste.find((x) => x.navn === 'Mads').sidst_logget_ind, 'sidst_logget_ind skal være sat efter login');
    });

    it('testdata: en deltager, en vare og en ordre', async () => {
      deltager = ok(await admin.post('/api/admin/deltagere', { pc_nr: 17, navn: 'Kunde Karl', pin: '1717', startbeloeb_oere: 50000 }));
      kunde = server.browser('Karl');
      ok(await kunde.post('/api/kunde/login', { pc_nr: 17, pin: '1717' }));
      vare = ok(await server.browser().get('/api/varer')).find((v) => v.pris_oere === 2000);
      assert.ok(vare);
    });
  });

  // ---------------------------------------------------------------
  describe('rettigheder', () => {
    // [metode, sti, body | () => body, beskrivelse]. Alle kræver admin.
    const kunAdmin = () => [
      ['POST', `/api/admin/deltagere/${deltager.id}/saldo`, { beloeb_oere: 100, tekst: 'test' }],
      ['POST', `/api/admin/deltagere/${deltager.id}/udbetal`, { metode: 'kontant', reference: '' }],
      ['GET', '/api/admin/udbetalinger'],
      ['GET', '/api/admin/varer'],
      ['POST', '/api/admin/varer', { navn: 'Hack', beskrivelse: '', kategori: 'Test', pris_oere: 100, aktiv: 1, udsolgt: 0, sortering: 0 }],
      ['PUT', `/api/admin/varer/${vare.id}`, { ...vare, pris_oere: 1 }],
      ['DELETE', `/api/admin/varer/${vare.id}`],
      ['POST', `/api/admin/varer/${vare.id}/billede`, PNG, 'image/png'],
      ['POST', '/api/admin/varer/aktiv', { ids: [vare.id], aktiv: false }],
      ['GET', '/api/admin/kategorier'],
      ['GET', '/api/admin/indstillinger'],
      ['PUT', '/api/admin/indstillinger', { butik_aaben: false }],
      ['GET', '/api/admin/rapport'],
      ['GET', '/api/admin/eksport.xlsx'],
      ['GET', '/api/admin/personale'],
      ['POST', '/api/admin/personale', { navn: 'Hacker', rolle: 'admin', kode: 'hacker-kode' }],
      ['PUT', '/api/admin/personale/1', { rolle: 'ekspedient' }],
    ];
    const kald = (b, [m, sti, body, type]) =>
      Buffer.isBuffer(body) ? b.kald(m, sti, undefined, { headers: { 'content-type': type }, raa: body }) : b.kald(m, sti, body);

    it('ekspedienten får 403 kraever_admin på alt, der kræver admin – og intet ændres', async () => {
      const saldoFoer = ok(await kunde.get('/api/kunde/mig')).saldo_oere;
      for (const k of kunAdmin()) {
        const r = await kald(eksp, k);
        assert.equal(r.status, 403, `${k[0]} ${k[1]} gav ${vis(r)}`);
        assert.equal(r.data && r.data.kode, 'kraever_admin', `${k[0]} ${k[1]}: forkert kode ${vis(r)}`);
        assert.equal(r.data.fejl, 'Det kræver admin-rettigheder.');
      }
      assert.equal(ok(await kunde.get('/api/kunde/mig')).saldo_oere, saldoFoer, 'Saldoen blev ændret af en ekspedient');
      const v = ok(await admin.get('/api/admin/varer')).find((x) => x.id === vare.id);
      assert.equal(v.pris_oere, vare.pris_oere, 'Prisen blev ændret af en ekspedient');
      assert.equal(Number(v.aktiv) || v.aktiv === true ? 1 : 0, 1, 'Varen blev slået fra af en ekspedient');
      assert.ok(!ok(await admin.get('/api/admin/personale')).some((x) => x.navn === 'Hacker'));
      assert.equal(ok(await server.browser().get('/api/info')).butik_aaben, true);
      assert.equal(ok(await admin.get('/api/admin/personale')).find((x) => x.id === 1)?.rolle ?? 'admin', 'admin');
    });

    it('ekspedienten må ikke ændre andet end navn og PIN på en deltager', async () => {
      // Felter ud over navn/pin/nulstil_pin (fx saldo) må ikke kunne smugles ind.
      const r = await eksp.put(`/api/admin/deltagere/${deltager.id}`, { navn: 'Kunde Karl', saldo_oere: 999999 });
      assert.ok(r.status === 403 || r.status === 400 || ok2xx(r.status));
      assert.equal(ok(await kunde.get('/api/kunde/mig')).saldo_oere, 50000);
    });

    it('ekspedienten må det, tabellen siger (butik, check-in, deltagere, indbetalinger, annullering)', async () => {
      const tjek = async (r, hvad) => {
        assert.ok(ok2xx(r.status), `Ekspedienten skal kunne ${hvad}: ${vis(r)}`);
        return r.data;
      };
      await tjek(await eksp.get('/api/butik/ordrer'), 'se ordrer');
      const butikVarer = await tjek(await eksp.get('/api/butik/varer'), 'se butikkens varer');
      assert.ok(butikVarer.some((v) => v.id === vare.id));
      const udsolgt = await tjek(await eksp.post(`/api/butik/varer/${vare.id}/udsolgt`, { udsolgt: true }), 'markere udsolgt');
      void udsolgt;
      assert.ok(ok(await server.browser().get('/api/varer')).find((v) => v.id === vare.id).udsolgt, 'Varen blev ikke udsolgt');
      const butikVarer2 = ok(await eksp.get('/api/butik/varer'));
      assert.ok(butikVarer2.some((v) => v.id === vare.id), '/api/butik/varer skal også vise udsolgte varer');
      await tjek(await eksp.post(`/api/butik/varer/${vare.id}/udsolgt`, { udsolgt: false }), 'markere på lager');

      const ny = await tjek(await eksp.post('/api/admin/deltagere', { pc_nr: 18, navn: 'Ny Nina', startbeloeb_oere: 10000, metode: 'kontant' }), 'checke ind med startbeløb');
      assert.match(String(ny.pin), /^\d{4}$/);
      await tjek(await eksp.get('/api/admin/deltagere?q=18'), 'søge deltagere');
      await tjek(await eksp.put(`/api/admin/deltagere/${ny.id}`, { navn: 'Nina Ny' }), 'rette navn');
      await tjek(await eksp.put(`/api/admin/deltagere/${ny.id}`, { pin: '4321' }), 'sætte PIN');
      const np = await tjek(await eksp.put(`/api/admin/deltagere/${ny.id}`, { nulstil_pin: true }), 'nulstille PIN');
      assert.match(String(np.pin), /^\d{4}$/);
      await tjek(await eksp.get(`/api/admin/deltagere/${ny.id}/bevaegelser`), 'se kontoudtog');

      const ind = ok(await kunde.post('/api/kunde/indbetalinger', { beloeb_oere: 5000, metode: 'mobilepay', reference: 'Karl' }));
      await tjek(await eksp.get('/api/admin/indbetalinger?status=afventer'), 'se indbetalinger');
      await tjek(await eksp.post(`/api/admin/indbetalinger/${ind.id}/godkend`, {}), 'godkende indbetaling');
      const ind2 = ok(await kunde.post('/api/kunde/indbetalinger', { beloeb_oere: 7000, metode: 'mobilepay', reference: 'Karl 2' }));
      await tjek(await eksp.post(`/api/admin/indbetalinger/${ind2.id}/afvis`, {}), 'afvise indbetaling');

      const o = ok(await kunde.post('/api/kunde/ordrer', { linjer: [{ vare_id: vare.id, antal: 1 }], levering: 'hent', note: '' }));
      for (const s of ['laves', 'klar', 'leveret']) await tjek(await eksp.post(`/api/butik/ordrer/${o.id}/status`, { status: s }), `sætte ordren til ${s}`);
      const o2 = ok(await kunde.post('/api/kunde/ordrer', { linjer: [{ vare_id: vare.id, antal: 1 }], levering: 'hent', note: '' }));
      await tjek(await eksp.post(`/api/butik/ordrer/${o2.id}/status`, { status: 'annulleret' }), 'annullere med refusion');

      const s = await eksp.stroem('/api/butik/stream');
      assert.equal(s.status, 200, 'Ekspedienten skal kunne åbne butikkens SSE');
      s.luk();
      assert.deepEqual(tjekSaldiIDb(server), []);
    });

    it('admin må alt', async () => {
      for (const k of kunAdmin()) {
        if (k[0] === 'PUT' && k[1].startsWith('/api/admin/personale/')) continue; // sidste admin – testes for sig
        if (k[1].includes('/udbetal')) continue; // tømmer saldoen – testes i eksport/api
        const r = await kald(admin, k);
        assert.ok(ok2xx(r.status), `Admin fik ${vis(r)} på ${k[0]} ${k[1]}`);
      }
      // Ryd op efter kaldene ovenfor.
      ok(await admin.put('/api/admin/indstillinger', { butik_aaben: true }));
      ok(await admin.put(`/api/admin/varer/${vare.id}`, { ...vare, aktiv: 1 }));
      ok(await admin.post('/api/admin/varer/aktiv', { ids: [vare.id], aktiv: true }));
      const hacker = ok(await admin.get('/api/admin/personale')).find((x) => x.navn === 'Hacker');
      if (hacker) ok(await admin.put(`/api/admin/personale/${hacker.id}`, { aktiv: false }));
    });

    it('kunder og ikke-logget-ind får 401 på personale-endpoints', async () => {
      for (const sti of ['/api/personale/mig', '/api/admin/personale', '/api/butik/varer', '/api/admin/deltagere?q=']) {
        assert.equal((await kunde.get(sti)).status, 401, `Kunde på ${sti}`);
        assert.equal((await server.browser().get(sti)).status, 401, `Anonym på ${sti}`);
      }
      assert.equal((await kunde.post(`/api/butik/varer/${vare.id}/udsolgt`, { udsolgt: true })).status, 401);
    });
  });

  // ---------------------------------------------------------------
  describe('sidste admin, spærring og koder', () => {
    let chefId;
    before(async () => {
      chefId = ok(await admin.get('/api/personale/mig')).id;
    });

    it('den sidste aktive admin kan ikke nedgraderes eller spærres (409 sidste_admin)', async () => {
      fejl(await admin.put(`/api/admin/personale/${chefId}`, { rolle: 'ekspedient' }), 409, 'sidste_admin');
      fejl(await admin.put(`/api/admin/personale/${chefId}`, { aktiv: false }), 409, 'sidste_admin');
      assert.equal(ok(await admin.get('/api/personale/mig')).rolle, 'admin');
    });

    it('med to admins kan den ene nedgraderes – derefter er den anden igen den sidste', async () => {
      const b = ok(await admin.post('/api/admin/personale', { navn: 'Næstformand', rolle: 'admin', kode: 'naest-kode-1' }));
      const nb = server.browser('Næstformand');
      ok(await nb.post('/api/personale/login', { navn: 'Næstformand', kode: 'naest-kode-1' }));
      ok(await nb.put(`/api/admin/personale/${chefId}`, { rolle: 'ekspedient' }));
      // Chefen er nu ekspedient – også i den eksisterende session.
      fejl(await admin.get('/api/admin/rapport'), 403, 'kraever_admin');
      assert.equal(ok(await admin.get('/api/personale/mig')).rolle, 'ekspedient');
      fejl(await nb.put(`/api/admin/personale/${b.id}`, { rolle: 'ekspedient' }), 409, 'sidste_admin');
      fejl(await nb.put(`/api/admin/personale/${b.id}`, { aktiv: false }), 409, 'sidste_admin');
      // Tilbage som før.
      ok(await nb.put(`/api/admin/personale/${chefId}`, { rolle: 'admin' }));
      ok(await admin.get('/api/admin/rapport'));
      ok(await admin.put(`/api/admin/personale/${b.id}`, { aktiv: false }));
    });

    it('spærring logger ud med det samme – også butikkens SSE – og login giver forkert_login', async () => {
      const madsId = ok(await eksp.get('/api/personale/mig')).id;
      const s = await eksp.stroem('/api/butik/stream');
      assert.equal(s.status, 200);
      ok(await admin.put(`/api/admin/personale/${madsId}`, { aktiv: false }));
      fejl(await eksp.get('/api/butik/ordrer'), 401);
      fejl(await eksp.get('/api/personale/mig'), 401);
      await new Promise((resolve, reject) => {
        if (s.lukket) return resolve();
        const t = setTimeout(() => reject(new Error('Butikkens SSE blev ikke lukket ved spærring')), 5000);
        s.res.once('close', () => { clearTimeout(t); resolve(); });
      }).finally(() => s.luk());
      fejl(await server.browser().post('/api/personale/login', { navn: 'Mads', kode: KODE_EKSP }), 401, 'forkert_login');
      assert.equal(ok(await admin.get('/api/admin/personale')).find((x) => x.id === madsId).aktiv ? 1 : 0, 0);
      // Genaktivér.
      ok(await admin.put(`/api/admin/personale/${madsId}`, { aktiv: true }));
      ok(await eksp.post('/api/personale/login', { navn: 'Mads', kode: KODE_EKSP }));
    });

    it('ny kode via PUT: den gamle virker ikke længere', async () => {
      const madsId = ok(await eksp.get('/api/personale/mig')).id;
      fejl(await admin.put(`/api/admin/personale/${madsId}`, { kode: 'kort' }), 400);
      ok(await admin.put(`/api/admin/personale/${madsId}`, { kode: 'mads-ny-kode-789' }));
      fejl(await server.browser().post('/api/personale/login', { navn: 'Mads', kode: KODE_EKSP }), 401, 'forkert_login');
      ok(await eksp.post('/api/personale/login', { navn: 'Mads', kode: 'mads-ny-kode-789' }));
    });

    it('rate limit: 10 forkerte forsøg pr. navn, også rigtig kode blokeres, andre navne er fri', async () => {
      ok(await admin.post('/api/admin/personale', { navn: 'Glemsom Gert', rolle: 'ekspedient', kode: 'gert-kode-1' }));
      const b = server.browser();
      for (let i = 0; i < 10; i++) fejl(await b.post('/api/personale/login', { navn: 'Glemsom Gert', kode: `forkert-${i}` }), 401, 'forkert_login');
      const r = await b.post('/api/personale/login', { navn: 'Glemsom Gert', kode: 'gert-kode-1' });
      assert.ok(r.status >= 400 && r.data && r.data.kode === 'for_mange_forsoeg', `11. forsøg: ${vis(r)}`);
      ok(await server.browser().post('/api/personale/login', { navn: 'Mads', kode: 'mads-ny-kode-789' }));
    });

    it('personale-logout', async () => {
      const b = server.browser();
      ok(await b.post('/api/personale/login', { navn: 'Mads', kode: 'mads-ny-kode-789' }));
      ok(await b.post('/api/personale/logout', {}));
      fejl(await b.get('/api/personale/mig'), 401);
    });
  });

  // ---------------------------------------------------------------
  describe('hvem gjorde hvad', () => {
    it('ordrens haendelser viser personalets navn og "Kunden"', async () => {
      const o = ok(await kunde.post('/api/kunde/ordrer', { linjer: [{ vare_id: vare.id, antal: 1 }], levering: 'hent', note: '' }));
      ok(await eksp.post(`/api/butik/ordrer/${o.id}/status`, { status: 'laves' }));
      ok(await eksp.post(`/api/butik/ordrer/${o.id}/status`, { status: 'klar' }));
      const lev = ok(await admin.post(`/api/butik/ordrer/${o.id}/status`, { status: 'leveret' }));
      assert.ok(Array.isArray(lev.haendelser), 'Ordren mangler haendelser');
      const h = lev.haendelser.filter((x) => x.status !== 'ny');
      assert.deepEqual(h.map((x) => [x.status, x.af]), [['laves', 'Mads'], ['klar', 'Mads'], ['leveret', 'Chef Søs']]);
      for (const x of lev.haendelser) assert.ok(!Number.isNaN(Date.parse(x.tid)), `Ugyldig tid: ${x.tid}`);

      const o2 = ok(await kunde.post('/api/kunde/ordrer', { linjer: [{ vare_id: vare.id, antal: 1 }], levering: 'hent', note: '' }));
      const ann = ok(await kunde.post(`/api/kunde/ordrer/${o2.id}/annuller`, {}));
      assert.deepEqual(ann.haendelser.filter((x) => x.status === 'annulleret').map((x) => x.af), ['Kunden']);
      const iButik = ok(await admin.get('/api/butik/ordrer')).find((x) => x.id === o2.id);
      assert.equal(iButik.haendelser.find((x) => x.status === 'annulleret').af, 'Kunden');

      const db = aabnDb(server);
      try {
        const rk = db.prepare('SELECT status, personale_id, deltager_id FROM ordre_haendelser WHERE ordre_id = ? ORDER BY id').all(o.id);
        assert.ok(rk.filter((x) => x.status !== 'ny').every((x) => x.personale_id), 'ordre_haendelser skal have personale_id ved personalets skift');
        const k = db.prepare("SELECT personale_id, deltager_id FROM ordre_haendelser WHERE ordre_id = ? AND status = 'annulleret'").get(o2.id);
        assert.equal(k.personale_id, null);
        assert.equal(k.deltager_id, deltager.id);
      } finally {
        db.close();
      }
    });

    it('indbetaling: behandlet_af; udbetaling: udfoert_af; kontoudtog: af; check-in: oprettet_af', async () => {
      const ind = ok(await kunde.post('/api/kunde/indbetalinger', { beloeb_oere: 2500, metode: 'kontant', reference: '' }));
      const g = ok(await eksp.post(`/api/admin/indbetalinger/${ind.id}/godkend`, {}));
      assert.equal(g.behandlet_af, 'Mads');
      assert.equal(ok(await admin.get('/api/admin/indbetalinger')).find((x) => x.id === ind.id).behandlet_af, 'Mads');

      ok(await admin.post(`/api/admin/deltagere/${deltager.id}/saldo`, { beloeb_oere: -500, tekst: 'Retning' }));
      const bev = ok(await admin.get(`/api/admin/deltagere/${deltager.id}/bevaegelser`));
      const liste = Array.isArray(bev) ? bev : bev.bevaegelser;
      assert.equal(liste.find((b) => b.type === 'justering').af, 'Chef Søs');
      assert.equal(liste.find((b) => b.indbetaling_id === ind.id).af, 'Mads');

      ok(await admin.post(`/api/admin/deltagere/${deltager.id}/udbetal`, { metode: 'mobilepay', reference: 'MP' }));
      const u = ok(await admin.get('/api/admin/udbetalinger')).udbetalt.find((x) => x.pc_nr === 17);
      assert.equal(u.udfoert_af, 'Chef Søs');

      const d = ok(await eksp.post('/api/admin/deltagere', { pc_nr: 19, navn: 'Indtjekket Ida' }));
      const db = aabnDb(server);
      try {
        const madsId = db.prepare("SELECT id FROM personale WHERE navn = 'Mads'").get().id;
        assert.equal(db.prepare('SELECT oprettet_af FROM deltagere WHERE id = ?').get(d.id).oprettet_af, madsId);
        assert.equal(db.prepare('SELECT behandlet_af FROM indbetalinger WHERE id = ?').get(ind.id).behandlet_af, madsId);
      } finally {
        db.close();
      }
      assert.deepEqual(tjekSaldiIDb(server), []);
    });
  });
});
