'use strict';
// Tillæg 2: en database fra før kataloget migreres uden tab. Kør: node --test test/migration.test.js

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { ROD, startServer, nyMappe, sletMappe, tjekSaldiIDb } = require('./hjaelp.js');
const { lavGammelDb, GAMMEL, STANDARDVARER } = require('./gammel-db.js');

const ok = (r) => {
  assert.ok(r.status >= 200 && r.status < 300, `Uventet status ${r.status}: ${r.tekst.slice(0, 300)}`);
  return r.data;
};
const somTal = (v) => (v === true ? 1 : v === false ? 0 : Number(v));

function katalogVarer() {
  const dir = path.join(ROD, 'data', 'standard');
  return fs.readdirSync(dir).filter((f) => /^katalog.*\.json$/.test(f)).sort()
    .flatMap((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

// Øjebliksbillede af det, der ikke må ændre sig.
function snapshot(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, 'butik.db'), { readOnly: true });
  try {
    const alt = (sql) => JSON.stringify(db.prepare(sql).all());
    return {
      // Kun de gamle kolonner – tillæg 3 tilføjer nye (oprettet_af, behandlet_af, …).
      deltagere: alt('SELECT id, pc_nr, navn, pin_salt, pin_hash, saldo_oere, oprettet FROM deltagere ORDER BY id'),
      ordrer: alt('SELECT id, deltager_id, total_oere, levering, note, status, oprettet, opdateret FROM ordrer ORDER BY id'),
      ordrelinjer: alt('SELECT id, ordre_id, vare_id, navn, pris_oere, antal FROM ordrelinjer ORDER BY id'),
      indbetalinger: alt('SELECT id, deltager_id, beloeb_oere, metode, reference, status, oprettet, behandlet FROM indbetalinger ORDER BY id'),
      bevaegelser: alt('SELECT id, deltager_id, beloeb_oere, type, ordre_id, indbetaling_id, tekst, oprettet FROM saldo_bevaegelser ORDER BY id'),
      udbetalinger: alt('SELECT id, deltager_id, beloeb_oere, metode, reference, oprettet FROM udbetalinger ORDER BY id'),
      gamleVarer: alt('SELECT id, navn, beskrivelse, kategori, pris_oere, billede, aktiv, udsolgt, sortering, oprettet FROM varer ORDER BY id'),
      indstillinger: alt("SELECT * FROM indstillinger WHERE noegle IN ('traef_navn','mobilepay_nr','tilmelding_aaben') ORDER BY noegle"),
    };
  } finally {
    db.close();
  }
}

describe('Migration fra databasen før tillæg 2 og 3', () => {
  let dataDir;
  let server;
  let foer;
  let gammelKode; // "salt:hash" fra indstillinger.personale_kode
  const katalog = katalogVarer();

  before(async () => {
    dataDir = nyMappe('traef-migration-');
    lavGammelDb(dataDir);
    foer = snapshot(dataDir);
    const db = new DatabaseSync(path.join(dataDir, 'butik.db'), { readOnly: true });
    gammelKode = db.prepare("SELECT vaerdi FROM indstillinger WHERE noegle = 'personale_kode'").get().vaerdi;
    db.close();
    server = await startServer({ dataDir });
  });
  after(async () => {
    if (server) await server.stop();
    await sletMappe(dataDir);
  });

  it('tillæg 3: personale_kode bliver til admin-kontoen "Admin" med samme salt/hash, og indstillingen slettes', async () => {
    const db = new DatabaseSync(path.join(dataDir, 'butik.db'), { readOnly: true });
    try {
      const personale = db.prepare('SELECT * FROM personale').all();
      assert.equal(personale.length, 1, `Forventede én personalekonto efter migration, fandt ${personale.length}`);
      const [salt, hash] = gammelKode.split(':');
      assert.equal(personale[0].navn, 'Admin');
      assert.equal(personale[0].rolle, 'admin');
      assert.equal(personale[0].kode_salt, salt);
      assert.equal(personale[0].kode_hash, hash);
      assert.equal(personale[0].aktiv, 1);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM indstillinger WHERE noegle = 'personale_kode'").get().n, 0, 'personale_kode skal slettes fra indstillinger');
    } finally {
      db.close();
    }
    // Gamle personale-sessioner er udløbet.
    const gammel = server.browser('gammel session');
    gammel.cookies.set('personale', GAMMEL.personaleSession);
    assert.equal((await gammel.get('/api/butik/ordrer')).status, 401, 'En personale-session fra før tillæg 3 må ikke virke');
    assert.equal((await gammel.get('/api/personale/mig')).status, 401);
    // Login med navn "Admin" og den gamle kode virker og giver rollen admin.
    const p = server.browser('Admin');
    const mig = ok(await p.post('/api/personale/login', { navn: 'Admin', kode: GAMMEL.personaleKode }));
    assert.equal(mig.navn, 'Admin');
    assert.equal(mig.rolle, 'admin');
    assert.equal(ok(await p.get('/api/personale/mig')).rolle, 'admin');
    assert.equal(ok(await server.browser().get('/api/info')).personale_opsat, true);
    // Opsætning er ikke mulig, når der allerede er personale.
    const r = await server.browser().post('/api/personale/opsaet', { navn: 'Ny', kode: 'ny-kode-123' });
    assert.equal(r.status, 409);
  });

  it('serveren starter på den gamle database, og varer får kolonnen katalog_id (UNIQUE)', () => {
    const db = new DatabaseSync(path.join(dataDir, 'butik.db'), { readOnly: true });
    try {
      const kol = db.prepare('PRAGMA table_info(varer)').all();
      assert.ok(kol.some((k) => k.name === 'katalog_id'), 'Kolonnen varer.katalog_id mangler efter migration');
      const unik = db.prepare('PRAGMA index_list(varer)').all().filter((i) => i.unique)
        .some((i) => db.prepare(`PRAGMA index_info("${i.name}")`).all().some((c) => c.name === 'katalog_id'));
      assert.ok(unik, 'varer.katalog_id skal være UNIQUE');
    } finally {
      db.close();
    }
  });

  it('ordrer, ordrelinjer, saldi, indbetalinger, bevægelser og udbetalinger er uændrede', () => {
    const efter = snapshot(dataDir);
    for (const k of ['deltagere', 'ordrer', 'ordrelinjer', 'indbetalinger', 'bevaegelser', 'udbetalinger', 'indstillinger']) {
      assert.equal(efter[k], foer[k], `${k} ændrede sig ved migrationen`);
    }
    assert.deepEqual(tjekSaldiIDb(server), []);
  });

  it('de gamle varer er bevaret (samme id, pris, udsolgt) – også admins prisændring', () => {
    const gamle = JSON.parse(foer.gamleVarer);
    const db = new DatabaseSync(path.join(dataDir, 'butik.db'), { readOnly: true });
    try {
      for (const g of gamle) {
        const n = db.prepare('SELECT * FROM varer WHERE id = ?').get(g.id);
        assert.ok(n, `Varen ${g.navn} (id ${g.id}) forsvandt`);
        for (const f of ['navn', 'beskrivelse', 'pris_oere', 'billede', 'aktiv', 'udsolgt', 'sortering']) {
          assert.equal(n[f], g[f], `${g.navn}: ${f} ændrede sig (${g[f]} → ${n[f]})`);
        }
      }
      const cola = db.prepare("SELECT pris_oere FROM varer WHERE navn = 'Coca-Cola 0,5 l'").get();
      assert.equal(cola.pris_oere, GAMMEL.colaPris, 'Admins pris på Coca-Cola blev overskrevet af kataloget');
    } finally {
      db.close();
    }
  });

  it('de 14 standardvarer har fået deres katalog_id (matchet på navn), egne varer har NULL', () => {
    const db = new DatabaseSync(path.join(dataDir, 'butik.db'), { readOnly: true });
    try {
      for (const [navn] of STANDARDVARER) {
        const kv = katalog.find((k) => k.navn === navn);
        assert.ok(kv, `${navn} findes ikke i kataloget`);
        const rk = db.prepare('SELECT katalog_id FROM varer WHERE navn = ?').all(navn);
        assert.equal(rk.length, 1, `${navn} findes ${rk.length} gange efter migration (dublet?)`);
        assert.equal(rk[0].katalog_id, kv.katalog_id, `${navn} fik katalog_id ${rk[0].katalog_id}`);
      }
      const egen = db.prepare('SELECT katalog_id, aktiv FROM varer WHERE navn = ?').get(GAMMEL.egenVare);
      assert.equal(egen.katalog_id, null);
      assert.equal(egen.aktiv, 1);
    } finally {
      db.close();
    }
  });

  it('nye katalogvarer er tilføjet som ikke-aktive; kunderne ser kun de gamle', async () => {
    const db = new DatabaseSync(path.join(dataDir, 'butik.db'), { readOnly: true });
    try {
      const gamleNavne = new Set(STANDARDVARER.map(([n]) => n));
      for (const kv of katalog.filter((k) => !gamleNavne.has(k.navn))) {
        const r = db.prepare('SELECT aktiv FROM varer WHERE katalog_id = ?').get(kv.katalog_id);
        assert.ok(r, `Katalogvaren ${kv.katalog_id} blev ikke tilføjet`);
        assert.equal(r.aktiv, 0, `${kv.katalog_id} skal være ikke-aktiv efter migration`);
      }
      const n = db.prepare('SELECT COUNT(*) AS n FROM varer').get().n;
      assert.equal(n, katalog.length + 1, `Forventede ${katalog.length} katalogvarer + 1 egen, fandt ${n}`);
    } finally {
      db.close();
    }
    const off = ok(await server.browser().get('/api/varer'));
    assert.deepEqual(off.map((v) => v.navn).sort(), [...STANDARDVARER.map(([n]) => n), GAMMEL.egenVare].sort());
  });

  it('gamle logins virker, og kunden ser sine ordrer og sin saldo', async () => {
    const p = server.browser('personale');
    ok(await p.post('/api/personale/login', { navn: 'Admin', kode: GAMMEL.personaleKode }));
    const k = server.browser('Ole');
    const d = ok(await k.post('/api/kunde/login', { pc_nr: 7, pin: '7777' }));
    assert.equal(d.saldo_oere, 20000 - 5900);
    const ordrer = ok(await k.get('/api/kunde/ordrer'));
    assert.deepEqual(ordrer.map((o) => o.status).sort(), ['annulleret', 'leveret']);
    assert.equal(ok(await server.browser().get('/api/info')).traef_navn, GAMMEL.traefNavn);
    const r = ok(await p.get('/api/admin/rapport'));
    assert.equal(r.omsaetning_oere, 5900 + 9000 + 2000);
    assert.equal(r.indbetalt_oere, r.omsaetning_oere + r.udbetalt_oere + r.samlet_saldo_oere, 'Regnskabet går ikke op efter migration');
    // Butikken kan fortsætte med den gamle, ikke-færdige ordre.
    const nye = ok(await p.get('/api/butik/ordrer?status=ny'));
    assert.equal(nye.length, 1);
    ok(await p.post(`/api/butik/ordrer/${nye[0].id}/status`, { status: 'laves' }));
  });

  it('anden start: ingen dubletter og intet ændret', async () => {
    const db1 = new DatabaseSync(path.join(dataDir, 'butik.db'), { readOnly: true });
    const varerFoer = JSON.stringify(db1.prepare('SELECT * FROM varer ORDER BY id').all());
    db1.close();
    await server.stop();
    server = await startServer({ dataDir });
    const db2 = new DatabaseSync(path.join(dataDir, 'butik.db'), { readOnly: true });
    try {
      assert.equal(JSON.stringify(db2.prepare('SELECT * FROM varer ORDER BY id').all()), varerFoer, 'Varerne ændrede sig ved anden start');
      const dubletter = db2.prepare('SELECT navn, COUNT(*) AS n FROM varer GROUP BY navn HAVING n > 1').all();
      assert.deepEqual(dubletter, []);
    } finally {
      db2.close();
    }
    assert.deepEqual(tjekSaldiIDb(server), []);
  });
});
