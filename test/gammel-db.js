'use strict';
// Laver en database i formatet fra FØR tillæg 2 (som main ved commit 4c666bb): varer uden katalog_id,
// de 14 standardvarer, deltagere, indbetalinger, ordrer (leveret, annulleret, ny) og en udbetaling.

const crypto = require('node:crypto');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// Skemaet præcis som server/db.js før tillæg 2.
const GAMMELT_SKEMA = `
CREATE TABLE IF NOT EXISTS deltagere (
  id INTEGER PRIMARY KEY, pc_nr INTEGER NOT NULL UNIQUE, navn TEXT NOT NULL, pin_salt TEXT NOT NULL,
  pin_hash TEXT NOT NULL, saldo_oere INTEGER NOT NULL DEFAULT 0 CHECK (saldo_oere >= 0), oprettet TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS varer (
  id INTEGER PRIMARY KEY, navn TEXT NOT NULL, beskrivelse TEXT NOT NULL DEFAULT '', kategori TEXT NOT NULL DEFAULT '',
  pris_oere INTEGER NOT NULL CHECK (pris_oere >= 0), billede TEXT, aktiv INTEGER NOT NULL DEFAULT 1,
  udsolgt INTEGER NOT NULL DEFAULT 0, sortering INTEGER NOT NULL DEFAULT 0, oprettet TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ordrer (
  id INTEGER PRIMARY KEY, deltager_id INTEGER NOT NULL REFERENCES deltagere(id), total_oere INTEGER NOT NULL,
  levering TEXT NOT NULL CHECK (levering IN ('bord','hent')), note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ny' CHECK (status IN ('ny','laves','klar','leveret','annulleret')),
  oprettet TEXT NOT NULL, opdateret TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ordrer_status ON ordrer(status, opdateret);
CREATE INDEX IF NOT EXISTS ordrer_deltager ON ordrer(deltager_id);
CREATE TABLE IF NOT EXISTS ordrelinjer (
  id INTEGER PRIMARY KEY, ordre_id INTEGER NOT NULL REFERENCES ordrer(id), vare_id INTEGER NOT NULL,
  navn TEXT NOT NULL, pris_oere INTEGER NOT NULL, antal INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ordrelinjer_ordre ON ordrelinjer(ordre_id);
CREATE TABLE IF NOT EXISTS indbetalinger (
  id INTEGER PRIMARY KEY, deltager_id INTEGER NOT NULL REFERENCES deltagere(id), beloeb_oere INTEGER NOT NULL,
  metode TEXT NOT NULL CHECK (metode IN ('mobilepay','kontant','andet')), reference TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'afventer' CHECK (status IN ('afventer','godkendt','afvist')),
  oprettet TEXT NOT NULL, behandlet TEXT
);
CREATE INDEX IF NOT EXISTS indbetalinger_status ON indbetalinger(status);
CREATE INDEX IF NOT EXISTS indbetalinger_deltager ON indbetalinger(deltager_id);
CREATE TABLE IF NOT EXISTS saldo_bevaegelser (
  id INTEGER PRIMARY KEY, deltager_id INTEGER NOT NULL REFERENCES deltagere(id), beloeb_oere INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('indbetaling','koeb','refusion','justering','udbetaling')),
  ordre_id INTEGER, indbetaling_id INTEGER, tekst TEXT NOT NULL DEFAULT '', oprettet TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS bevaegelser_deltager ON saldo_bevaegelser(deltager_id);
CREATE TABLE IF NOT EXISTS udbetalinger (
  id INTEGER PRIMARY KEY, deltager_id INTEGER NOT NULL REFERENCES deltagere(id), beloeb_oere INTEGER NOT NULL,
  metode TEXT NOT NULL CHECK (metode IN ('mobilepay','kontant','andet')), reference TEXT NOT NULL DEFAULT '',
  oprettet TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS udbetalinger_deltager ON udbetalinger(deltager_id);
CREATE TABLE IF NOT EXISTS sessioner (
  token TEXT PRIMARY KEY, type TEXT NOT NULL CHECK (type IN ('kunde','personale')), deltager_id INTEGER,
  oprettet TEXT NOT NULL, sidst_brugt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS indstillinger (noegle TEXT PRIMARY KEY, vaerdi TEXT NOT NULL);
`;

// De 14 standardvarer som før: navn, beskrivelse, kategori, pris, billede.
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

// Samme hash som serveren: scrypt(hemmelig, salt-hex, 32) → hex.
function hash(hemmelig) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: crypto.scryptSync(String(hemmelig), salt, 32).toString('hex') };
}

const GAMMEL = {
  personaleKode: 'gammel-kode-2025',
  personaleSession: 'gammel-personale-session-0123456789abcdef',
  kundeSession: 'gammel-kunde-session-0123456789abcdef',
  traefNavn: 'GammelLAN 2025',
  colaPris: 2200, // admin har sat prisen op før opgraderingen
  egenVare: 'Hjemmebagt kage',
  deltagere: [
    { pc_nr: 7, navn: 'Ole Gammel', pin: '7777' },
    { pc_nr: 8, navn: 'Bente Før', pin: '8888' },
    { pc_nr: 9, navn: 'Udbetalt Ulla', pin: '9999' },
  ],
};

// Opretter <dataDir>/butik.db i det gamle format. Returnerer en beskrivelse af indholdet.
function lavGammelDb(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, 'butik.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(GAMMELT_SKEMA);
  const t = (min) => new Date(Date.UTC(2025, 9, 3, 18, 0) + min * 60000).toISOString();
  db.exec('BEGIN');
  const ind = db.prepare('INSERT INTO indstillinger (noegle, vaerdi) VALUES (?, ?)');
  const k = hash(GAMMEL.personaleKode);
  for (const [n, v] of [['traef_navn', GAMMEL.traefNavn], ['butik_aaben', '1'], ['tilmelding_aaben', '0'], ['levering_min_oere', '10000'],
    ['levering_aktiv', '1'], ['mobilepay_nr', '11 22 33 44'], ['personale_kode', `${k.salt}:${k.hash}`]]) ind.run(n, v);

  const vare = db.prepare('INSERT INTO varer (navn, beskrivelse, kategori, pris_oere, billede, aktiv, udsolgt, sortering, oprettet) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  STANDARDVARER.forEach(([n, b, kat, p, f], i) => vare.run(n, b, kat, n === 'Coca-Cola 0,5 l' ? GAMMEL.colaPris : p, f, 1, n === 'Chips' ? 1 : 0, (i + 1) * 10, t(-600)));
  vare.run(GAMMEL.egenVare, 'Bagt af crewet', 'Kage', 1500, null, 1, 0, 200, t(-500));
  const id = (navn) => db.prepare('SELECT id FROM varer WHERE navn = ?').get(navn).id;

  const delt = db.prepare('INSERT INTO deltagere (pc_nr, navn, pin_salt, pin_hash, saldo_oere, oprettet) VALUES (?, ?, ?, ?, 0, ?)');
  const ids = GAMMEL.deltagere.map((d) => {
    const h = hash(d.pin);
    return Number(delt.run(d.pc_nr, d.navn, h.salt, h.hash, t(0)).lastInsertRowid);
  });
  const saldo = db.prepare('UPDATE deltagere SET saldo_oere = saldo_oere + ? WHERE id = ?');
  const bev = db.prepare('INSERT INTO saldo_bevaegelser (deltager_id, beloeb_oere, type, ordre_id, indbetaling_id, tekst, oprettet) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const indb = db.prepare("INSERT INTO indbetalinger (deltager_id, beloeb_oere, metode, reference, status, oprettet, behandlet) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const saetInd = (d, beloeb, status, min) => {
    const r = indb.run(d, beloeb, 'mobilepay', 'før', status, t(min), status === 'afventer' ? null : t(min + 1));
    if (status === 'godkendt') {
      saldo.run(beloeb, d);
      bev.run(d, beloeb, 'indbetaling', null, Number(r.lastInsertRowid), 'Indbetaling', t(min + 1));
    }
  };
  saetInd(ids[0], 20000, 'godkendt', 1);
  saetInd(ids[1], 10000, 'godkendt', 2);
  saetInd(ids[2], 5000, 'godkendt', 3);
  saetInd(ids[1], 5000, 'afventer', 4);

  const ordre = db.prepare('INSERT INTO ordrer (deltager_id, total_oere, levering, note, status, oprettet, opdateret) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const linje = db.prepare('INSERT INTO ordrelinjer (ordre_id, vare_id, navn, pris_oere, antal) VALUES (?, ?, ?, ?, ?)');
  const koeb = (d, linjer, status, min, levering = 'hent') => {
    const total = linjer.reduce((s, [, p, a]) => s + p * a, 0);
    const o = Number(ordre.run(d, total, levering, 'gammel note', status, t(min), t(min + 5)).lastInsertRowid);
    for (const [n, p, a] of linjer) linje.run(o, id(n), n, p, a);
    saldo.run(-total, d);
    bev.run(d, -total, 'koeb', o, null, `Ordre #${o}`, t(min));
    if (status === 'annulleret') {
      saldo.run(total, d);
      bev.run(d, total, 'refusion', o, null, `Ordre #${o} annulleret`, t(min + 2));
    }
    return o;
  };
  koeb(ids[0], [['Coca-Cola 0,5 l', GAMMEL.colaPris, 2], [GAMMEL.egenVare, 1500, 1]], 'leveret', 10);
  koeb(ids[0], [['Toast med ost', 2000, 1]], 'annulleret', 20);
  koeb(ids[1], [['Pizza-slice', 3000, 3]], 'ny', 30);
  koeb(ids[2], [['Vand', 1000, 2]], 'leveret', 40);

  // Ulla får resten udbetalt.
  const rest = db.prepare('SELECT saldo_oere FROM deltagere WHERE id = ?').get(ids[2]).saldo_oere;
  db.prepare('INSERT INTO udbetalinger (deltager_id, beloeb_oere, metode, reference, oprettet) VALUES (?, ?, ?, ?, ?)').run(ids[2], rest, 'kontant', '', t(50));
  saldo.run(-rest, ids[2]);
  bev.run(ids[2], -rest, 'udbetaling', null, null, 'Udbetaling', t(50));
  // En gammel personale-session (skal udløbe ved tillæg 3) og en kundesession.
  const ses = db.prepare('INSERT INTO sessioner (token, type, deltager_id, oprettet, sidst_brugt) VALUES (?, ?, ?, ?, ?)');
  const nu = new Date().toISOString();
  ses.run(GAMMEL.personaleSession, 'personale', null, nu, nu);
  ses.run(GAMMEL.kundeSession, 'kunde', ids[0], nu, nu);
  db.exec('COMMIT');
  db.close();
  return GAMMEL;
}

module.exports = { lavGammelDb, GAMMEL, STANDARDVARER, GAMMELT_SKEMA };
