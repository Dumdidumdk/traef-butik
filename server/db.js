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
  oprettet TEXT NOT NULL
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
`;

// Indstillinger med type og standardværdi (personale_kode håndteres for sig)
const INDSTILLINGER = {
  traef_navn: { type: 'tekst', std: 'Træf-butikken', min: 1, max: 60 },
  butik_aaben: { type: 'bool', std: '1' },
  tilmelding_aaben: { type: 'bool', std: '0' }, // tillæg 1: crew opretter deltagerne
  levering_min_oere: { type: 'heltal', std: '10000', min: 0, max: 10000000 },
  levering_aktiv: { type: 'bool', std: '1' },
  mobilepay_nr: { type: 'tekst', std: '', min: 0, max: 40 },
};

// Navn, beskrivelse, kategori, pris i øre, billedfil
const STANDARDVARER = [
  ['Coca-Cola 0,5 l', 'Iskold klassiker', 'Drikke', 2000, 'coca-cola.svg'],
  ['Coca-Cola Zero 0,5 l', 'Uden sukker', 'Drikke', 2000, 'coca-cola-zero.svg'],
  ['Fanta 0,5 l', 'Appelsinsodavand', 'Drikke', 2000, 'fanta.svg'],
  ['Faxe Kondi 0,5 l', 'Citron-lime sodavand', 'Drikke', 2000, 'faxe-kondi.svg'],
  ['Monster Energy', 'Energidrik 0,5 l', 'Energi', 2500, 'monster.svg'],
  ['Red Bull', 'Energidrik 0,25 l', 'Energi', 2500, 'red-bull.svg'],
  ['Vand', 'Kildevand 0,5 l', 'Drikke', 1000, 'vand.svg'],
  ['Kaffe', 'Sort kaffe', 'Drikke', 1000, 'kaffe.svg'],
  ['Toast med skinke og ost', 'Varm toast', 'Mad', 2500, 'toast-skinke-ost.svg'],
  ['Toast med ost', 'Varm toast', 'Mad', 2000, 'toast-ost.svg'],
  ['Pose vingummi', 'Blandede vingummier', 'Slik og snacks', 1500, 'vingummi.svg'],
  ['Chips', 'Pose chips', 'Slik og snacks', 2000, 'chips.svg'],
  ['Snickers', 'Chokoladebar', 'Slik og snacks', 1200, 'snickers.svg'],
  ['Pizza-slice', 'Varm pizza', 'Mad', 3000, 'pizza.svg'],
];

function init(dataDir, projektDir) {
  const billedDir = path.join(dataDir, 'billeder');
  fs.mkdirSync(billedDir, { recursive: true });

  db = new DatabaseSync(path.join(dataDir, 'butik.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SKEMA);

  const tid = nu();
  const saetStd = db.prepare('INSERT OR IGNORE INTO indstillinger (noegle, vaerdi) VALUES (?, ?)');
  for (const [k, d] of Object.entries(INDSTILLINGER)) saetStd.run(k, d.std);

  // Standardbilleder kopieres, hvis de mangler
  const stdDir = path.join(projektDir, 'data', 'standard');
  if (fs.existsSync(stdDir)) {
    for (const f of fs.readdirSync(stdDir)) {
      const maal = path.join(billedDir, f);
      if (!fs.existsSync(maal)) fs.copyFileSync(path.join(stdDir, f), maal);
    }
  }

  // Standardvarer kun når tabellen er tom (første start)
  if (db.prepare('SELECT COUNT(*) AS n FROM varer').get().n === 0) {
    const ind = db.prepare(
      'INSERT INTO varer (navn, beskrivelse, kategori, pris_oere, billede, aktiv, udsolgt, sortering, oprettet) VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)'
    );
    tx(() => STANDARDVARER.forEach(([n, b, k, p, f], i) => ind.run(n, b, k, p, f, (i + 1) * 10, tid)));
  }

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

module.exports = { init, q, tx, hentIndstilling, saetIndstilling, indstillinger, INDSTILLINGER, luk };
