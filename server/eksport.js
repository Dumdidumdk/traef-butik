'use strict';
// Salg som regneark (tillæg 2, afsnit B)

const D = require('./db');
const { arbejdsbog, lokal } = require('./xlsx');

const { q } = D;

const kr = (oere) => (oere || 0) / 100;
const dato = (iso) => (iso ? new Date(iso) : null);
const UGEDAGE = ['søn', 'man', 'tir', 'ons', 'tor', 'fre', 'lør'];
const STATUS = { ny: 'Ny', laves: 'Laves', klar: 'Klar', leveret: 'Leveret', annulleret: 'Annulleret' };
const INDB_STATUS = { afventer: 'Afventer', godkendt: 'Godkendt', afvist: 'Afvist' };
const METODE = { mobilepay: 'MobilePay', kontant: 'Kontant', andet: 'Andet' };
const LEVERING = { bord: 'Bring til plads', hent: 'Afhentning' };
const to = (n) => String(n).padStart(2, '0');

// Samme tal som /api/admin/rapport
function noegletal() {
  const o = q("SELECT COALESCE(SUM(total_oere), 0) AS s, COUNT(*) AS n FROM ordrer WHERE status <> 'annulleret'").get();
  const ann = q("SELECT COUNT(*) AS n FROM ordrer WHERE status = 'annulleret'").get().n;
  const ind = q("SELECT COALESCE(SUM(beloeb_oere), 0) AS s FROM indbetalinger WHERE status = 'godkendt'").get().s;
  const udb = q('SELECT COALESCE(SUM(beloeb_oere), 0) AS s FROM udbetalinger').get().s;
  const saldo = q('SELECT COALESCE(SUM(saldo_oere), 0) AS s FROM deltagere').get().s;
  const just = q("SELECT COALESCE(SUM(beloeb_oere), 0) AS s FROM saldo_bevaegelser WHERE type = 'justering'").get().s;
  return { omsaetning: o.s, antal: o.n, annulleret: ann, indbetalt: ind, udbetalt: udb, saldo, justering: just };
}

function byg(nuTid = new Date()) {
  const ind = D.indstillinger();
  const n = noegletal();
  const gaarOp = n.indbetalt + n.justering === n.omsaetning + n.udbetalt + n.saldo;

  // 1. Oversigt
  const kol2 = [{ titel: 'Nøgletal', bredde: 34 }, { titel: 'Værdi', bredde: 26 }];
  const oversigt = {
    navn: 'Oversigt',
    kolonner: kol2,
    raekker: [
      ['Træf', ind.traef_navn],
      ['Udskrevet', { v: nuTid, stil: 'dato' }],
      ['Omsætning', { v: kr(n.omsaetning), stil: 'kr' }],
      ['Antal ordrer', { v: n.antal, stil: 'heltal' }],
      ['Annullerede ordrer', { v: n.annulleret, stil: 'heltal' }],
      ['Indbetalt', { v: kr(n.indbetalt), stil: 'kr' }],
      ['Udbetalt', { v: kr(n.udbetalt), stil: 'kr' }],
      ['Samlet saldo hos deltagerne', { v: kr(n.saldo), stil: 'kr' }],
      ...(n.justering ? [['Manuelle justeringer', { v: kr(n.justering), stil: 'kr' }]] : []),
      ['Regnskabet går op', { v: gaarOp ? 'Ja' : 'Nej', stil: 'fed' }],
    ],
  };

  // 2. Salg pr. vare (annullerede tæller ikke)
  const prVare = q(`SELECT l.navn, MAX(v.kategori) AS kategori, SUM(l.antal) AS antal, SUM(l.antal * l.pris_oere) AS beloeb
    FROM ordrelinjer l JOIN ordrer o ON o.id = l.ordre_id LEFT JOIN varer v ON v.id = l.vare_id
    WHERE o.status <> 'annulleret' GROUP BY l.navn ORDER BY beloeb DESC, l.navn`).all();
  const salgVare = {
    navn: 'Salg pr. vare',
    kolonner: [
      { titel: 'Vare', bredde: 32 }, { titel: 'Kategori', bredde: 18 },
      { titel: 'Antal solgt', bredde: 13, stil: 'heltal' }, { titel: 'Beløb', bredde: 16, stil: 'kr' },
    ],
    raekker: prVare.map((r) => [r.navn, r.kategori || '', r.antal, kr(r.beloeb)]),
    efter: [[
      { v: 'I alt', stil: 'fed' }, null,
      { v: prVare.reduce((s, r) => s + r.antal, 0), stil: 'fedheltal' },
      { v: kr(prVare.reduce((s, r) => s + r.beloeb, 0)), stil: 'fedkr' },
    ]],
  };

  // Alle ordrer med linjer
  const ordrer = q(`SELECT o.*, d.pc_nr, d.navn FROM ordrer o JOIN deltagere d ON d.id = o.deltager_id ORDER BY o.id`).all();
  const linjer = q(`SELECT l.*, v.kategori FROM ordrelinjer l LEFT JOIN varer v ON v.id = l.vare_id ORDER BY l.ordre_id, l.id`).all();
  const linjerPr = new Map();
  for (const l of linjer) {
    if (!linjerPr.has(l.ordre_id)) linjerPr.set(l.ordre_id, []);
    linjerPr.get(l.ordre_id).push(l);
  }

  // 3. Salg pr. time (dansk tid)
  const timer = new Map();
  for (const o of ordrer) {
    if (o.status === 'annulleret') continue;
    const l = lokal(new Date(o.oprettet));
    const noegle = `${l.aar}-${to(l.md)}-${to(l.dag)} ${to(l.time)}`;
    let t = timer.get(noegle);
    if (!t) timer.set(noegle, (t = { tekst: `${UGEDAGE[l.ugedag]} ${to(l.time)}:00`, antal: 0, beloeb: 0 }));
    t.antal++;
    t.beloeb += o.total_oere;
  }
  const salgTime = {
    navn: 'Salg pr. time',
    kolonner: [{ titel: 'Time', bredde: 14 }, { titel: 'Antal ordrer', bredde: 14, stil: 'heltal' }, { titel: 'Beløb', bredde: 16, stil: 'kr' }],
    raekker: [...timer.keys()].sort().map((k) => [timer.get(k).tekst, timer.get(k).antal, kr(timer.get(k).beloeb)]),
  };

  // Hvem leverede/annullerede (sidste afsluttende hændelse pr. ordre)
  const udfoertAf = new Map();
  for (const h of q(`SELECT h.ordre_id, COALESCE(p.navn, CASE WHEN h.deltager_id IS NOT NULL THEN 'Kunden' ELSE 'System' END) AS af
    FROM ordre_haendelser h LEFT JOIN personale p ON p.id = h.personale_id
    WHERE h.status IN ('leveret', 'annulleret') ORDER BY h.id`).all()) udfoertAf.set(h.ordre_id, h.af);

  // 4. Ordrer
  const ordreArk = {
    navn: 'Ordrer',
    kolonner: [
      { titel: 'Ordrenr', bredde: 10, stil: 'heltal' }, { titel: 'Tidspunkt', bredde: 17, stil: 'dato' },
      { titel: 'PC', bredde: 7, stil: 'heltal' }, { titel: 'Navn', bredde: 22 }, { titel: 'Levering', bredde: 16 },
      { titel: 'Status', bredde: 12 }, { titel: 'Varer', bredde: 50 }, { titel: 'Note', bredde: 28 },
      { titel: 'Total', bredde: 14, stil: 'kr' }, { titel: 'Udført af', bredde: 16 },
    ],
    raekker: ordrer.map((o) => [
      o.id, dato(o.oprettet), o.pc_nr, o.navn, LEVERING[o.levering] || o.levering, STATUS[o.status] || o.status,
      (linjerPr.get(o.id) || []).map((l) => `${l.antal} × ${l.navn}`).join(', '), o.note, kr(o.total_oere),
      udfoertAf.get(o.id) || '',
    ]),
  };

  // 5. Ordrelinjer
  const ordreInfo = new Map(ordrer.map((o) => [o.id, o]));
  const linjeArk = {
    navn: 'Ordrelinjer',
    kolonner: [
      { titel: 'Ordrenr', bredde: 10, stil: 'heltal' }, { titel: 'Tidspunkt', bredde: 17, stil: 'dato' },
      { titel: 'PC', bredde: 7, stil: 'heltal' }, { titel: 'Navn', bredde: 22 }, { titel: 'Vare', bredde: 30 },
      { titel: 'Kategori', bredde: 18 }, { titel: 'Antal', bredde: 8, stil: 'heltal' },
      { titel: 'Stykpris', bredde: 13, stil: 'kr' }, { titel: 'Beløb', bredde: 14, stil: 'kr' }, { titel: 'Status', bredde: 12 },
    ],
    raekker: linjer.map((l) => {
      const o = ordreInfo.get(l.ordre_id) || {};
      return [l.ordre_id, dato(o.oprettet), o.pc_nr, o.navn, l.navn, l.kategori || '', l.antal,
        kr(l.pris_oere), kr(l.pris_oere * l.antal), STATUS[o.status] || o.status];
    }),
  };

  // 6. Indbetalinger
  const indb = q(`SELECT i.*, d.pc_nr, d.navn, p.navn AS af FROM indbetalinger i JOIN deltagere d ON d.id = i.deltager_id
    LEFT JOIN personale p ON p.id = i.behandlet_af ORDER BY i.id`).all();
  const indbArk = {
    navn: 'Indbetalinger',
    kolonner: [
      { titel: 'Tidspunkt', bredde: 17, stil: 'dato' }, { titel: 'PC', bredde: 7, stil: 'heltal' }, { titel: 'Navn', bredde: 22 },
      { titel: 'Beløb', bredde: 14, stil: 'kr' }, { titel: 'Metode', bredde: 12 }, { titel: 'Reference', bredde: 28 },
      { titel: 'Status', bredde: 12 }, { titel: 'Godkendt af', bredde: 16 },
    ],
    raekker: indb.map((i) => [dato(i.oprettet), i.pc_nr, i.navn, kr(i.beloeb_oere), METODE[i.metode] || i.metode,
      i.reference, INDB_STATUS[i.status] || i.status, i.af || '']),
  };

  // 7. Udbetalinger
  const udb = q(`SELECT u.*, d.pc_nr, d.navn, p.navn AS af FROM udbetalinger u JOIN deltagere d ON d.id = u.deltager_id
    LEFT JOIN personale p ON p.id = u.udfoert_af ORDER BY u.id`).all();
  const udbArk = {
    navn: 'Udbetalinger',
    kolonner: [
      { titel: 'Tidspunkt', bredde: 17, stil: 'dato' }, { titel: 'PC', bredde: 7, stil: 'heltal' }, { titel: 'Navn', bredde: 22 },
      { titel: 'Beløb', bredde: 14, stil: 'kr' }, { titel: 'Metode', bredde: 12 }, { titel: 'Reference', bredde: 32 },
      { titel: 'Udført af', bredde: 16 },
    ],
    raekker: udb.map((u) => [dato(u.oprettet), u.pc_nr, u.navn, kr(u.beloeb_oere), METODE[u.metode] || u.metode, u.reference, u.af || '']),
  };

  // 8. Deltagere
  const delt = q(`SELECT d.pc_nr, d.navn, d.saldo_oere,
      (SELECT COALESCE(SUM(beloeb_oere), 0) FROM indbetalinger WHERE deltager_id = d.id AND status = 'godkendt') AS indbetalt,
      (SELECT COALESCE(SUM(total_oere), 0) FROM ordrer WHERE deltager_id = d.id AND status <> 'annulleret') AS brugt,
      (SELECT COALESCE(SUM(beloeb_oere), 0) FROM udbetalinger WHERE deltager_id = d.id) AS udbetalt
    FROM deltagere d ORDER BY d.pc_nr`).all();
  const deltArk = {
    navn: 'Deltagere',
    kolonner: [
      { titel: 'PC', bredde: 7, stil: 'heltal' }, { titel: 'Navn', bredde: 24 }, { titel: 'Indbetalt', bredde: 14, stil: 'kr' },
      { titel: 'Brugt', bredde: 14, stil: 'kr' }, { titel: 'Udbetalt', bredde: 14, stil: 'kr' }, { titel: 'Saldo nu', bredde: 14, stil: 'kr' },
    ],
    raekker: delt.map((d) => [d.pc_nr, d.navn, kr(d.indbetalt), kr(d.brugt), kr(d.udbetalt), kr(d.saldo_oere)]),
  };

  // 9. Personale (tillæg 3)
  const pers = q(`SELECT p.navn, p.rolle,
      (SELECT COUNT(DISTINCT ordre_id) FROM ordre_haendelser WHERE personale_id = p.id AND status = 'klar') AS klar,
      (SELECT COUNT(DISTINCT ordre_id) FROM ordre_haendelser WHERE personale_id = p.id AND status = 'leveret') AS leveret,
      (SELECT COUNT(DISTINCT ordre_id) FROM ordre_haendelser WHERE personale_id = p.id AND status = 'annulleret') AS annulleret,
      (SELECT COUNT(*) FROM indbetalinger WHERE behandlet_af = p.id AND status = 'godkendt') AS indb_antal,
      (SELECT COALESCE(SUM(beloeb_oere), 0) FROM indbetalinger WHERE behandlet_af = p.id AND status = 'godkendt') AS indb_beloeb,
      (SELECT COUNT(*) FROM deltagere WHERE oprettet_af = p.id) AS checkin
    FROM personale p ORDER BY p.navn COLLATE NOCASE`).all();
  const persArk = {
    navn: 'Personale',
    kolonner: [
      { titel: 'Navn', bredde: 20 }, { titel: 'Rolle', bredde: 12 },
      { titel: 'Ordrer flyttet til klar', bredde: 14, stil: 'heltal' }, { titel: 'Ordrer leveret', bredde: 14, stil: 'heltal' },
      { titel: 'Ordrer annulleret', bredde: 14, stil: 'heltal' }, { titel: 'Indbetalinger godkendt', bredde: 14, stil: 'heltal' },
      { titel: 'Indbetalinger godkendt (beløb)', bredde: 16, stil: 'kr' }, { titel: 'Deltagere checket ind', bredde: 14, stil: 'heltal' },
    ],
    raekker: pers.map((p) => [p.navn, p.rolle === 'admin' ? 'Admin' : 'Ekspedient', p.klar, p.leveret, p.annulleret,
      p.indb_antal, kr(p.indb_beloeb), p.checkin]),
  };

  return arbejdsbog([oversigt, salgVare, salgTime, ordreArk, linjeArk, indbArk, udbArk, deltArk, persArk]);
}

// Filnavn: <traef-navn>-salg-<YYYY-MM-DD>.xlsx (ASCII-udgave + UTF-8-udgave)
function filnavn(nuTid = new Date()) {
  const l = lokal(nuTid);
  const navn = D.indstillinger().traef_navn || 'traef';
  const fuld = `${navn}-salg-${l.aar}-${to(l.md)}-${to(l.dag)}.xlsx`;
  const ascii = fuld
    .replace(/æ/g, 'ae').replace(/ø/g, 'oe').replace(/å/g, 'aa')
    .replace(/Æ/g, 'Ae').replace(/Ø/g, 'Oe').replace(/Å/g, 'Aa')
    .replace(/[^A-Za-z0-9 ._-]/g, '_');
  return { fuld, ascii };
}

function send(res) {
  const nuTid = new Date();
  const buf = byg(nuTid);
  const f = filnavn(nuTid);
  res.writeHead(200, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${f.ascii}"; filename*=UTF-8''${encodeURIComponent(f.fuld)}`,
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

module.exports = { byg, send, filnavn, noegletal };
