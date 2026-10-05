'use strict';
// Database: oprettelse, standarddata og små hjælpere

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { nu } = require('./hjaelp');

let db = null;
const cache = new Map();

const SKEMA = `
CREATE TABLE IF NOT EXISTS deltagere (
  id INTEGER PRIMARY KEY,
  pc_nr INTEGER NOT NULL UNIQUE,
  navn TEXT NOT NULL,
  pin_salt TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  saldo_oere INTEGER NOT NULL DEFAULT 0 CHECK (saldo_oere >= 0),
  oprettet TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS varer (
  id INTEGER PRIMARY KEY,
  navn TEXT NOT NULL,
  beskrivelse TEXT NOT NULL DEFAULT '',
  kategori TEXT NOT NULL DEFAULT '',
  pris_oere INTEGER NOT NULL CHECK (pris_oere >= 0),
  billede TEXT,
  aktiv INTEGER NOT NULL DEFAULT 1,
  udsolgt INTEGER NOT NULL DEFAULT 0,
  sortering INTEGER NOT NULL DEFAULT 0,
  oprettet TEXT NOT NULL,
  katalog_id TEXT
);
CREATE TABLE IF NOT EXISTS ordrer (
  id INTEGER PRIMARY KEY,
  deltager_id INTEGER NOT NULL REFERENCES deltagere(id),
  total_oere INTEGER NOT NULL,
  levering TEXT NOT NULL CHECK (levering IN ('bord','hent')),
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ny' CHECK (status IN ('ny','laves','klar','leveret','annulleret')),
  oprettet TEXT NOT NULL,
  opdateret TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ordrer_status ON ordrer(status, opdateret);
CREATE INDEX IF NOT EXISTS ordrer_deltager ON ordrer(deltager_id);
CREATE TABLE IF NOT EXISTS ordrelinjer (
  id INTEGER PRIMARY KEY,
  ordre_id INTEGER NOT NULL REFERENCES ordrer(id),
  vare_id INTEGER NOT NULL,
  navn TEXT NOT NULL,
  pris_oere INTEGER NOT NULL,
  antal INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ordrelinjer_ordre ON ordrelinjer(ordre_id);
CREATE TABLE IF NOT EXISTS indbetalinger (
  id INTEGER PRIMARY KEY,
  deltager_id INTEGER NOT NULL REFERENCES deltagere(id),
  beloeb_oere INTEGER NOT NULL,
  metode TEXT NOT NULL CHECK (metode IN ('mobilepay','kontant','andet')),
  reference TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'afventer' CHECK (status IN ('afventer','godkendt','afvist')),
  oprettet TEXT NOT NULL,
  behandlet TEXT
);
CREATE INDEX IF NOT EXISTS indbetalinger_status ON indbetalinger(status);
CREATE INDEX IF NOT EXISTS indbetalinger_deltager ON indbetalinger(deltager_id);
CREATE TABLE IF NOT EXISTS saldo_bevaegelser (
  id INTEGER PRIMARY KEY,
  deltager_id INTEGER NOT NULL REFERENCES deltagere(id),
  beloeb_oere INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('indbetaling','koeb','refusion','justering','udbetaling')),
  ordre_id INTEGER,
  indbetaling_id INTEGER,
  tekst TEXT NOT NULL DEFAULT '',
  oprettet TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS bevaegelser_deltager ON saldo_bevaegelser(deltager_id);
CREATE TABLE IF NOT EXISTS udbetalinger (
  id INTEGER PRIMARY KEY,
  deltager_id INTEGER NOT NULL REFERENCES deltagere(id),
  beloeb_oere INTEGER NOT NULL,
  metode TEXT NOT NULL CHECK (metode IN ('mobilepay','kontant','andet')),
  reference TEXT NOT NULL DEFAULT '',
  oprettet TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS udbetalinger_deltager ON udbetalinger(deltager_id);
CREATE TABLE IF NOT EXISTS sessioner (
  token TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('kunde','personale')),
  deltager_id INTEGER,
  oprettet TEXT NOT NULL,
  sidst_brugt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS indstillinger (
  noegle TEXT PRIMARY KEY,
  vaerdi TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS personale (
  id INTEGER PRIMARY KEY,
  navn TEXT NOT NULL UNIQUE COLLATE NOCASE,
  rolle TEXT NOT NULL CHECK (rolle IN ('admin','ekspedient')),
  kode_salt TEXT NOT NULL,
  kode_hash TEXT NOT NULL,
  aktiv INTEGER NOT NULL DEFAULT 1,
  oprettet TEXT NOT NULL,
  sidst_logget_ind TEXT
);
CREATE TABLE IF NOT EXISTS ordre_haendelser (
  id INTEGER PRIMARY KEY,
  ordre_id INTEGER NOT NULL REFERENCES ordrer(id),
  status TEXT NOT NULL,
  personale_id INTEGER,
  deltager_id INTEGER,
  tid TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ordre_haendelser_ordre ON ordre_haendelser(ordre_id);
CREATE INDEX IF NOT EXISTS ordre_haendelser_personale ON ordre_haendelser(personale_id);
`;

// Kolonner tilføjet i tillæg 3 (tilføjes til både nye og gamle databaser)
const NYE_KOLONNER = [
  ['sessioner', 'personale_id', 'INTEGER'],
  ['indbetalinger', 'behandlet_af', 'INTEGER'],
  ['udbetalinger', 'udfoert_af', 'INTEGER'],
  ['saldo_bevaegelser', 'personale_id', 'INTEGER'],
  ['deltagere', 'oprettet_af', 'INTEGER'],
];

// Indstillinger med type og standardværdi (personale_kode håndteres for sig)
const INDSTILLINGER = {
  traef_navn: { type: 'tekst', std: 'Træf-butikken', min: 1, max: 60 },
  butik_aaben: { type: 'bool', std: '1' },
  tilmelding_aaben: { type: 'bool', std: '0' }, // tillæg 1: crew opretter deltagerne
  levering_min_oere: { type: 'heltal', std: '10000', min: 0, max: 10000000 },
  levering_aktiv: { type: 'bool', std: '1' },
  mobilepay_nr: { type: 'tekst', std: '', min: 0, max: 40 },
};

// Faste kategorier i visningsrækkefølge (tillæg 2)
const KATEGORIER = ['Drikke', 'Energi', 'Varme drikke', 'Mad', 'Morgenmad', 'Slik og snacks', 'Frugt og sundt', 'Udstyr'];

const BILLED_EXT = /\.(svg|png|jpe?g|webp|gif)$/i;

// Læs alle katalog*.json i alfabetisk rækkefølge. Ugyldige poster springes over med en advarsel.
function laesKatalog(stdDir) {
  const ud = [];
  const set = new Set();
  if (!fs.existsSync(stdDir)) return ud;
  // Sortér på navnet uden .json, så katalog.json kommer før katalog-2.json
  const uden = (f) => f.replace(/\.json$/i, '').toLowerCase();
  const filer = fs.readdirSync(stdDir).filter((f) => /^katalog.*\.json$/i.test(f))
    .sort((a, b) => (uden(a) < uden(b) ? -1 : uden(a) > uden(b) ? 1 : 0));
  for (const f of filer) {
    let liste;
    try {
      liste = JSON.parse(fs.readFileSync(path.join(stdDir, f), 'utf8').replace(/^﻿/, ''));
    } catch (e) {
      console.warn(`  Advarsel: ${f} kunne ikke læses (${e.message})`);
      continue;
    }
    if (!Array.isArray(liste)) {
      console.warn(`  Advarsel: ${f} er ikke en liste`);
      continue;
    }
    for (const v of liste) {
      const ok = v && typeof v.katalog_id === 'string' && /^[a-z0-9-]{1,60}$/.test(v.katalog_id)
        && typeof v.navn === 'string' && v.navn.trim() && v.navn.length <= 60
        && Number.isSafeInteger(v.pris_oere) && v.pris_oere >= 0;
      if (!ok) {
        console.warn(`  Advarsel: ugyldig vare i ${f}: ${JSON.stringify(v).slice(0, 80)}`);
        continue;
      }
      if (set.has(v.katalog_id)) {
        console.warn(`  Advarsel: katalog_id "${v.katalog_id}" findes flere gange – første bruges`);
        continue;
      }
      set.add(v.katalog_id);
      ud.push({
        katalog_id: v.katalog_id,
        navn: v.navn.trim(),
        beskrivelse: typeof v.beskrivelse === 'string' ? v.beskrivelse.slice(0, 300) : '',
        kategori: typeof v.kategori === 'string' ? v.kategori.slice(0, 40) : '',
        pris_oere: v.pris_oere,
        billede: typeof v.billede === 'string' && BILLED_EXT.test(v.billede) && !/[\\/]/.test(v.billede) ? v.billede : null,
        aktiv: v.standard_aktiv === true ? 1 : 0,
        sortering: Number.isSafeInteger(v.sortering) ? v.sortering : null,
      });
    }
  }
  return ud;
}

function init(dataDir, projektDir) {
  const billedDir = path.join(dataDir, 'billeder');
  fs.mkdirSync(billedDir, { recursive: true });

  db = new DatabaseSync(path.join(dataDir, 'butik.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SKEMA);

  const tid = nu();

  // Tillæg 3: nye kolonner + personale_kode → admin-konto "Admin"
  tx(() => {
    for (const [tabel, kol, type] of NYE_KOLONNER) {
      if (!db.prepare(`PRAGMA table_info(${tabel})`).all().some((k) => k.name === kol)) {
        db.exec(`ALTER TABLE ${tabel} ADD COLUMN ${kol} ${type}`);
      }
    }
    const gammel = db.prepare("SELECT vaerdi FROM indstillinger WHERE noegle = 'personale_kode'").get();
    if (gammel) {
      const [salt, hash] = gammel.vaerdi.split(':');
      if (salt && hash && !db.prepare("SELECT 1 FROM personale WHERE navn = 'Admin'").get()) {
        db.prepare("INSERT INTO personale (navn, rolle, kode_salt, kode_hash, aktiv, oprettet) VALUES ('Admin', 'admin', ?, ?, 1, ?)")
          .run(salt, hash, tid);
      }
      db.prepare("DELETE FROM indstillinger WHERE noegle = 'personale_kode'").run();
    }
    // Gamle personale-sessioner uden konto udløber
    db.prepare("DELETE FROM sessioner WHERE type = 'personale' AND personale_id IS NULL").run();
  });
  const saetStd = db.prepare('INSERT OR IGNORE INTO indstillinger (noegle, vaerdi) VALUES (?, ?)');
  for (const [k, d] of Object.entries(INDSTILLINGER)) saetStd.run(k, d.std);

  // Kun billedfiler kopieres fra data/standard, hvis de mangler
  const stdDir = path.join(projektDir, 'data', 'standard');
  if (fs.existsSync(stdDir)) {
    for (const f of fs.readdirSync(stdDir)) {
      if (!BILLED_EXT.test(f)) continue;
      const maal = path.join(billedDir, f);
      if (!fs.existsSync(maal)) fs.copyFileSync(path.join(stdDir, f), maal);
    }
  }

  const katalog = laesKatalog(stdDir);

  // Migration fra før tillæg 2: kolonnen katalog_id + match af standardvarer på navn (ellers billede)
  const harKolonne = db.prepare('PRAGMA table_info(varer)').all().some((k) => k.name === 'katalog_id');
  tx(() => {
    if (!harKolonne) {
      db.exec('ALTER TABLE varer ADD COLUMN katalog_id TEXT');
      const fri = db.prepare('SELECT id FROM varer WHERE katalog_id IS NULL AND navn = ? ORDER BY id LIMIT 1');
      const friB = db.prepare('SELECT id FROM varer WHERE katalog_id IS NULL AND billede = ? ORDER BY id LIMIT 1');
      const saet = db.prepare('UPDATE varer SET katalog_id = ? WHERE id = ?');
      const umatchede = [];
      for (const k of katalog) {
        const r = fri.get(k.navn);
        if (r) saet.run(k.katalog_id, r.id);
        else umatchede.push(k);
      }
      for (const k of umatchede) {
        const r = k.billede && friB.get(k.billede);
        if (r) saet.run(k.katalog_id, r.id);
      }
    }
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS varer_katalog_id ON varer(katalog_id)');

    // Opret katalogvarer, der mangler. Eksisterende varer røres aldrig.
    const findes = db.prepare('SELECT 1 FROM varer WHERE katalog_id = ?');
    const ind = db.prepare(`INSERT INTO varer (navn, beskrivelse, kategori, pris_oere, billede, aktiv, udsolgt, sortering, oprettet, katalog_id)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`);
    const maks = db.prepare('SELECT COALESCE(MAX(sortering), 0) AS m FROM varer');
    for (const k of katalog) {
      if (findes.get(k.katalog_id)) continue;
      const sort = k.sortering ?? maks.get().m + 10;
      ind.run(k.navn, k.beskrivelse, k.kategori, k.pris_oere, k.billede, k.aktiv, sort, tid, k.katalog_id);
    }
  });

  // Ryd gamle sessioner
  const graense = new Date(Date.now() - 30 * 24 * 3600e3).toISOString();
  db.prepare('DELETE FROM sessioner WHERE sidst_brugt < ?').run(graense);
  return db;
}

// Cachede prepared statements
function q(sql) {
  let s = cache.get(sql);
  if (!s) {
    s = db.prepare(sql);
    cache.set(sql, s);
  }
  return s;
}

// Kør fn i én transaktion (alt er synkront, så intet kan blande sig imellem)
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function hentIndstilling(noegle) {
  const r = q('SELECT vaerdi FROM indstillinger WHERE noegle = ?').get(noegle);
  return r ? r.vaerdi : null;
}

function saetIndstilling(noegle, vaerdi) {
  q('INSERT INTO indstillinger (noegle, vaerdi) VALUES (?, ?) ON CONFLICT(noegle) DO UPDATE SET vaerdi = excluded.vaerdi')
    .run(noegle, String(vaerdi));
}

// Alle offentlige indstillinger med rigtige typer
function indstillinger() {
  const raa = {};
  for (const r of q('SELECT noegle, vaerdi FROM indstillinger').all()) raa[r.noegle] = r.vaerdi;
  const ud = {};
  for (const [k, d] of Object.entries(INDSTILLINGER)) {
    const v = raa[k] ?? d.std;
    ud[k] = d.type === 'bool' ? v === '1' : d.type === 'heltal' ? Number(v) : v;
  }
  return ud;
}

function luk() {
  if (db) {
    try { db.close(); } catch { /* ignorer */ }
    db = null;
  }
  cache.clear();
}

module.exports = { init, q, tx, hentIndstilling, saetIndstilling, indstillinger, INDSTILLINGER, KATEGORIER, luk };
