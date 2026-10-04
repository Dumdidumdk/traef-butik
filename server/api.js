'use strict';
// Alle /api-endpoints

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const D = require('./db');
const sse = require('./sse');
const {
  Fejl, fejl, nu, sendJson, sendFejl, laesBody, laesJson, laesCookies,
  saetCookie, sletCookie, heltal, tekst, bool, hash, tjekHash, nytToken,
} = require('./hjaelp');

const { q, tx } = D;
let billedDir = '';

const MAKS_ID = 2 ** 31;
const BILLEDE_MAKS = 3 * 1024 * 1024;

// ---------- Objekter ----------

const deltagerObj = (r) => ({ id: r.id, pc_nr: r.pc_nr, navn: r.navn, saldo_oere: r.saldo_oere });

const vareObj = (r) => ({
  id: r.id,
  navn: r.navn,
  beskrivelse: r.beskrivelse,
  kategori: r.kategori,
  pris_oere: r.pris_oere,
  billede_url: r.billede ? '/billeder/' + encodeURIComponent(r.billede) : null,
  aktiv: !!r.aktiv,
  udsolgt: !!r.udsolgt,
  sortering: r.sortering,
});

const ORDRE_SQL = `SELECT o.*, d.pc_nr, d.navn,
  (SELECT json_group_array(json_object('vare_id', l.vare_id, 'navn', l.navn, 'pris_oere', l.pris_oere, 'antal', l.antal))
     FROM ordrelinjer l WHERE l.ordre_id = o.id) AS linjer_json
  FROM ordrer o JOIN deltagere d ON d.id = o.deltager_id`;

const ordreObj = (r) => ({
  id: r.id,
  nr: r.id,
  pc_nr: r.pc_nr,
  navn: r.navn,
  total_oere: r.total_oere,
  levering: r.levering,
  note: r.note,
  status: r.status,
  oprettet: r.oprettet,
  opdateret: r.opdateret,
  linjer: JSON.parse(r.linjer_json || '[]'),
});

const hentOrdre = (id) => {
  const r = q(`${ORDRE_SQL} WHERE o.id = ?`).get(id);
  return r ? ordreObj(r) : null;
};

const INDB_SQL = `SELECT i.*, d.pc_nr, d.navn FROM indbetalinger i JOIN deltagere d ON d.id = i.deltager_id`;

const indbObj = (r) => ({
  id: r.id,
  pc_nr: r.pc_nr,
  navn: r.navn,
  beloeb_oere: r.beloeb_oere,
  metode: r.metode,
  reference: r.reference,
  status: r.status,
  oprettet: r.oprettet,
  behandlet: r.behandlet,
});

const hentIndb = (id) => {
  const r = q(`${INDB_SQL} WHERE i.id = ?`).get(id);
  return r ? indbObj(r) : null;
};

const hentDeltager = (id) => q('SELECT * FROM deltagere WHERE id = ?').get(id);

function info() {
  return { ...D.indstillinger(), personale_opsat: !!D.hentIndstilling('personale_kode') };
}

const aktiveVarer = () =>
  q('SELECT * FROM varer WHERE aktiv = 1 ORDER BY sortering, navn').all().map(vareObj);

// ---------- Saldo (altid sammen med en bevægelse; kaldes inde i tx) ----------

function aendrSaldo(deltagerId, beloeb, type, { ordreId = null, indbId = null, tekst: t = '' } = {}) {
  const r = q('UPDATE deltagere SET saldo_oere = saldo_oere + ? WHERE id = ? AND saldo_oere + ? >= 0')
    .run(beloeb, deltagerId, beloeb);
  if (r.changes === 0) {
    throw fejl(409, 'ikke_nok_penge', 'Der er ikke penge nok på kontoen.');
  }
  q(`INSERT INTO saldo_bevaegelser (deltager_id, beloeb_oere, type, ordre_id, indbetaling_id, tekst, oprettet)
     VALUES (?, ?, ?, ?, ?, ?, ?)`).run(deltagerId, beloeb, type, ordreId, indbId, t, nu());
}

function sendSaldo(deltagerId) {
  const d = hentDeltager(deltagerId);
  if (d) sse.tilKunde(deltagerId, 'saldo', { saldo_oere: d.saldo_oere });
}

// ---------- Sessioner og login-grænse ----------

const TI_MIN = 10 * 60e3;
const TREDIVE_DAGE = 30 * 24 * 3600e3;

function hentSession(req, type) {
  const token = laesCookies(req)[type];
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const s = q('SELECT * FROM sessioner WHERE token = ? AND type = ?').get(token, type);
  if (!s) return null;
  const alder = Date.now() - Date.parse(s.sidst_brugt);
  if (alder > TREDIVE_DAGE) {
    q('DELETE FROM sessioner WHERE token = ?').run(token);
    return null;
  }
  if (alder > TI_MIN) q('UPDATE sessioner SET sidst_brugt = ? WHERE token = ?').run(nu(), token);
  return s;
}

function kraevKunde(req) {
  const s = hentSession(req, 'kunde');
  const d = s && hentDeltager(s.deltager_id);
  if (!d) throw fejl(401, 'ikke_logget_ind', 'Du er ikke logget ind.');
  return d;
}

function kraevPersonale(req) {
  if (!hentSession(req, 'personale')) throw fejl(401, 'ikke_logget_ind', 'Personalet er ikke logget ind.');
}

function nySession(type, deltagerId) {
  const token = nytToken();
  const t = nu();
  q('INSERT INTO sessioner (token, type, deltager_id, oprettet, sidst_brugt) VALUES (?, ?, ?, ?, ?)')
    .run(token, type, deltagerId, t, t);
  return saetCookie(type, token);
}

function sletSession(req, type) {
  const token = laesCookies(req)[type];
  if (token) q('DELETE FROM sessioner WHERE token = ? AND type = ?').run(token, type);
}

const FORSOEG_VINDUE = 5 * 60e3;
const MAKS_FORSOEG = 10;
const forsoeg = new Map(); // nøgle -> tidspunkter for forkerte logins

function tjekGraense(noegle) {
  const t = Date.now();
  const l = (forsoeg.get(noegle) || []).filter((x) => t - x < FORSOEG_VINDUE);
  if (l.length) forsoeg.set(noegle, l);
  else forsoeg.delete(noegle);
  if (l.length >= MAKS_FORSOEG) {
    throw fejl(429, 'for_mange_forsoeg', 'For mange forkerte forsøg. Vent et par minutter og prøv igen.');
  }
}

function forkertForsoeg(noegle) {
  const l = forsoeg.get(noegle) || [];
  l.push(Date.now());
  forsoeg.set(noegle, l);
}

setInterval(() => {
  const t = Date.now();
  for (const [k, l] of forsoeg) if (!l.some((x) => t - x < FORSOEG_VINDUE)) forsoeg.delete(k);
}, 60e3).unref();

// ---------- Validering ----------

const pcNr = (v) => heltal(v, 1, 9999, 'ugyldigt_pc_nr', 'PC-nummer skal være et tal mellem 1 og 9999.');
const navnV = (v) => tekst(v, 1, 40, 'ugyldigt_navn', 'Navn skal være 1–40 tegn.');
function pinV(v) {
  if (typeof v === 'number' && Number.isInteger(v)) v = String(v);
  if (typeof v !== 'string' || !/^\d{4,6}$/.test(v)) throw fejl(400, 'ugyldig_pin', 'PIN skal være 4–6 cifre.');
  return v;
}
const idV = (v, kode = 'findes_ikke', besked = 'Findes ikke.') => {
  if (!/^\d{1,10}$/.test(v) || Number(v) < 1 || Number(v) >= MAKS_ID) throw fejl(404, kode, besked);
  return Number(v);
};

// ---------- Kunde ----------

async function kundeTilmeld(req, res) {
  const k = await laesJson(req);
  if (!D.indstillinger().tilmelding_aaben) {
    throw fejl(403, 'tilmelding_lukket', 'Tilmeldingen er lukket. Kontakt butikken for at blive oprettet.');
  }
  const pc = pcNr(k.pc_nr);
  const navn = navnV(k.navn);
  const pin = pinV(k.pin);
  const d = await opretDeltager(pc, navn, pin);
  sendJson(res, 200, deltagerObj(d), { 'Set-Cookie': nySession('kunde', d.id) });
}

// Opret deltager; evt. startbeløb som godkendt indbetaling – alt i én transaktion
async function opretDeltager(pc, navn, pin, start = 0, metode = 'mobilepay') {
  const optaget = () => fejl(409, 'pc_optaget', `PC-nummer ${pc} er allerede tilmeldt.`);
  if (q('SELECT 1 FROM deltagere WHERE pc_nr = ?').get(pc)) throw optaget();
  const h = await hash(pin);
  let id;
  try {
    id = tx(() => {
      const t = nu();
      const r = q('INSERT INTO deltagere (pc_nr, navn, pin_salt, pin_hash, saldo_oere, oprettet) VALUES (?, ?, ?, ?, 0, ?)')
        .run(pc, navn, h.salt, h.hash, t);
      const did = Number(r.lastInsertRowid);
      if (start > 0) {
        const ir = q("INSERT INTO indbetalinger (deltager_id, beloeb_oere, metode, reference, status, oprettet, behandlet) VALUES (?, ?, ?, ?, 'godkendt', ?, ?)")
          .run(did, start, metode, 'Startbeløb ved check-in', t, t);
        aendrSaldo(did, start, 'indbetaling', { indbId: Number(ir.lastInsertRowid), tekst: `Startbeløb (${metode})` });
      }
      return did;
    });
  } catch (e) {
    if (/UNIQUE/.test(e.message)) throw optaget();
    throw e;
  }
  return hentDeltager(id);
}

const tilfaeldigPin = () => String(crypto.randomInt(0, 10000)).padStart(4, '0');
const METODER = ['mobilepay', 'kontant', 'andet'];
function metodeV(v) {
  if (v === undefined || v === null || v === '') return 'mobilepay';
  if (!METODER.includes(v)) throw fejl(400, 'ugyldig_metode', 'Vælg en gyldig betalingsmetode.');
  return v;
}

// Bruges når PC-nr ikke findes, så svartiden ligner et rigtigt forsøg
const DUMMY_SALT = crypto.randomBytes(16).toString('hex');
const DUMMY_HASH = crypto.randomBytes(32).toString('hex');

async function kundeLogin(req, res) {
  const k = await laesJson(req);
  const pc = pcNr(k.pc_nr);
  const noegle = 'pc:' + pc;
  tjekGraense(noegle);
  const pin = typeof k.pin === 'number' ? String(k.pin) : k.pin;
  const d = q('SELECT * FROM deltagere WHERE pc_nr = ?').get(pc);
  const gyldigForm = typeof pin === 'string' && /^\d{4,6}$/.test(pin);
  const ok = await tjekHash(gyldigForm ? pin : '0000', d ? d.pin_salt : DUMMY_SALT, d ? d.pin_hash : DUMMY_HASH);
  if (!d || !ok || !gyldigForm) {
    forkertForsoeg(noegle);
    throw fejl(401, 'forkert_login', 'Forkert PC-nummer eller PIN.');
  }
  sendJson(res, 200, deltagerObj(d), { 'Set-Cookie': nySession('kunde', d.id) });
}

function kundeLogout(req, res) {
  sletSession(req, 'kunde');
  sendJson(res, 200, { ok: true }, { 'Set-Cookie': sletCookie('kunde') });
}

function kundeMig(req, res) {
  sendJson(res, 200, deltagerObj(kraevKunde(req)));
}

async function kundeNyOrdre(req, res) {
  const d = kraevKunde(req);
  const k = await laesJson(req);
  const ind = D.indstillinger();
  if (!ind.butik_aaben) throw fejl(409, 'butik_lukket', 'Butikken er lukket for bestillinger lige nu.');
  if (k.linjer !== undefined && !Array.isArray(k.linjer)) throw fejl(400, 'ugyldig_kurv', 'Kurven kunne ikke læses.');
  if (!Array.isArray(k.linjer) || k.linjer.length === 0) throw fejl(400, 'tom_kurv', 'Kurven er tom.');
  if (k.linjer.length > 50) throw fejl(400, 'ugyldig_kurv', 'Der er for mange linjer i kurven.');

  // Saml linjer med samme vare
  const samlet = new Map();
  for (const l of k.linjer) {
    if (!l || typeof l !== 'object') throw fejl(400, 'ugyldig_kurv', 'Kurven kunne ikke læses.');
    const vid = heltal(l.vare_id, 1, MAKS_ID, 'vare_findes_ikke', 'En af varerne findes ikke længere.');
    const antal = heltal(l.antal, 1, 20, 'ugyldigt_antal', 'Antal skal være mellem 1 og 20.');
    samlet.set(vid, (samlet.get(vid) || 0) + antal);
  }
  for (const a of samlet.values()) {
    if (a > 20) throw fejl(400, 'ugyldigt_antal', 'Du kan højst bestille 20 af samme vare.');
  }
  const levering = k.levering === undefined || k.levering === null || k.levering === '' ? 'hent' : k.levering;
  if (levering !== 'bord' && levering !== 'hent') {
    throw fejl(400, 'ugyldig_levering', 'Vælg enten levering til bordet eller afhentning.');
  }
  const note = tekst(k.note, 0, 200, 'ugyldig_note', 'Bemærkningen må højst være 200 tegn.');

  const ordreId = tx(() => {
    let total = 0;
    const linjer = [];
    for (const [vid, antal] of samlet) {
      const v = q('SELECT * FROM varer WHERE id = ?').get(vid);
      if (!v || !v.aktiv) throw fejl(409, 'vare_findes_ikke', 'En af varerne findes ikke længere. Opdater siden.');
      if (v.udsolgt) throw fejl(409, 'vare_udsolgt', `${v.navn} er desværre udsolgt.`);
      total += v.pris_oere * antal;
      linjer.push([v.id, v.navn, v.pris_oere, antal]);
    }
    if (levering === 'bord') {
      if (!ind.levering_aktiv) {
        throw fejl(409, 'levering_ikke_mulig', 'Levering til bordet er slået fra lige nu. Vælg afhentning.');
      }
      if (total < ind.levering_min_oere) {
        throw fejl(409, 'levering_ikke_mulig',
          `Levering til bordet kræver mindst ${kr(ind.levering_min_oere)}. Vælg afhentning eller køb lidt mere.`);
      }
    }
    const t = nu();
    const r = q('INSERT INTO ordrer (deltager_id, total_oere, levering, note, status, oprettet, opdateret) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(d.id, total, levering, note, 'ny', t, t);
    const id = Number(r.lastInsertRowid);
    const indL = q('INSERT INTO ordrelinjer (ordre_id, vare_id, navn, pris_oere, antal) VALUES (?, ?, ?, ?, ?)');
    for (const l of linjer) indL.run(id, ...l);
    // Betinget opdatering – fejler hvis saldoen er brugt i mellemtiden
    aendrSaldo(d.id, -total, 'koeb', { ordreId: id, tekst: `Ordre #${id}` });
    return id;
  });

  const o = hentOrdre(ordreId);
  sse.tilButik('ordre', o);
  sse.tilKunde(d.id, 'ordre', o);
  sendSaldo(d.id);
  sendJson(res, 200, o);
}

function kr(oere) {
  const k = Math.floor(oere / 100);
  const o = oere % 100;
  return o ? `${k},${String(o).padStart(2, '0')} kr.` : `${k} kr.`;
}

function kundeOrdrer(req, res) {
  const d = kraevKunde(req);
  sendJson(res, 200, q(`${ORDRE_SQL} WHERE o.deltager_id = ? ORDER BY o.id DESC LIMIT 200`).all(d.id).map(ordreObj));
}

function kundeAnnuller(req, res, p) {
  const d = kraevKunde(req);
  const id = idV(p.id, 'ordre_findes_ikke', 'Ordren findes ikke.');
  const o = q('SELECT * FROM ordrer WHERE id = ?').get(id);
  if (!o || o.deltager_id !== d.id) throw fejl(404, 'ordre_findes_ikke', 'Ordren findes ikke.');
  if (o.status !== 'ny') {
    throw fejl(409, 'kan_ikke_annulleres', 'Ordren kan ikke annulleres, fordi butikken allerede er i gang med den.');
  }
  skiftStatus(id, 'annulleret', ['ny']);
  efterStatus(id);
  sendJson(res, 200, hentOrdre(id));
}

// Skift status i én transaktion; refunder ved annullering
function skiftStatus(id, ny, tilladteFra) {
  tx(() => {
    const o = q('SELECT * FROM ordrer WHERE id = ?').get(id);
    if (!o) throw fejl(404, 'ordre_findes_ikke', 'Ordren findes ikke.');
    if (!tilladteFra.includes(o.status)) {
      throw fejl(409, 'ugyldigt_skift', `Ordren kan ikke skifte fra "${o.status}" til "${ny}".`);
    }
    q('UPDATE ordrer SET status = ?, opdateret = ? WHERE id = ?').run(ny, nu(), id);
    if (ny === 'annulleret' && o.total_oere > 0) {
      aendrSaldo(o.deltager_id, o.total_oere, 'refusion', { ordreId: id, tekst: `Refusion for annulleret ordre #${id}` });
    }
  });
}

function efterStatus(id) {
  const o = hentOrdre(id);
  sse.tilButik('ordre', o);
  const r = q('SELECT deltager_id FROM ordrer WHERE id = ?').get(id);
  sse.tilKunde(r.deltager_id, 'ordre', o);
  if (o.status === 'annulleret') sendSaldo(r.deltager_id);
  return o;
}

async function kundeNyIndbetaling(req, res) {
  const d = kraevKunde(req);
  const k = await laesJson(req);
  const beloeb = heltal(k.beloeb_oere, 100, 1000000, 'ugyldigt_beloeb', 'Beløbet skal være mellem 1 og 10.000 kr.');
  const metode = k.metode === undefined ? 'mobilepay' : k.metode;
  if (!['mobilepay', 'kontant', 'andet'].includes(metode)) throw fejl(400, 'ugyldig_metode', 'Vælg en gyldig betalingsmetode.');
  const ref = tekst(k.reference, 0, 100, 'ugyldig_reference', 'Referencen må højst være 100 tegn.');
  const afv = q("SELECT COUNT(*) AS n FROM indbetalinger WHERE deltager_id = ? AND status = 'afventer'").get(d.id).n;
  if (afv >= 5) {
    throw fejl(409, 'for_mange_afventende', 'Du har allerede 5 indbetalinger, der venter på godkendelse.');
  }
  const r = q('INSERT INTO indbetalinger (deltager_id, beloeb_oere, metode, reference, status, oprettet) VALUES (?, ?, ?, ?, ?, ?)')
    .run(d.id, beloeb, metode, ref, 'afventer', nu());
  const i = hentIndb(Number(r.lastInsertRowid));
  sse.tilButik('indbetaling', i);
  sse.tilKunde(d.id, 'indbetaling', i);
  sendJson(res, 200, i);
}

function kundeIndbetalinger(req, res) {
  const d = kraevKunde(req);
  sendJson(res, 200, q(`${INDB_SQL} WHERE i.deltager_id = ? ORDER BY i.id DESC LIMIT 200`).all(d.id).map(indbObj));
}

function kundeStream(req, res) {
  const d = kraevKunde(req);
  sse.tilfoejKunde(d.id, req, res);
  sse.sendEn(res, 'saldo', { saldo_oere: d.saldo_oere });
}

// ---------- Personale ----------

async function personaleOpsaet(req, res) {
  const k = await laesJson(req);
  if (D.hentIndstilling('personale_kode')) throw fejl(409, 'allerede_opsat', 'Personalekoden er allerede sat.');
  const kode = tekst(k.kode, 6, 100, 'ugyldig_kode', 'Koden skal være mindst 6 tegn.');
  const h = await hash(kode);
  // Tjek igen efter hashing (to samtidige opsætninger)
  if (D.hentIndstilling('personale_kode')) throw fejl(409, 'allerede_opsat', 'Personalekoden er allerede sat.');
  D.saetIndstilling('personale_kode', `${h.salt}:${h.hash}`);
  sse.tilAlleKunder('info', info());
  sendJson(res, 200, { ok: true }, { 'Set-Cookie': nySession('personale', null) });
}

async function personaleLogin(req, res) {
  const k = await laesJson(req);
  const gemt = D.hentIndstilling('personale_kode');
  if (!gemt) throw fejl(409, 'ikke_opsat', 'Personalekoden er ikke sat endnu. Åbn /admin for at sætte den.');
  const noegle = 'personale:' + (req.socket.remoteAddress || '');
  tjekGraense(noegle);
  const [salt, h] = gemt.split(':');
  const ok = typeof k.kode === 'string' && k.kode.length <= 200 && (await tjekHash(k.kode, salt, h));
  if (!ok) {
    forkertForsoeg(noegle);
    throw fejl(401, 'forkert_login', 'Forkert personalekode.');
  }
  sendJson(res, 200, { ok: true }, { 'Set-Cookie': nySession('personale', null) });
}

function personaleLogout(req, res) {
  sletSession(req, 'personale');
  sendJson(res, 200, { ok: true }, { 'Set-Cookie': sletCookie('personale') });
}

function personaleMig(req, res) {
  kraevPersonale(req);
  sendJson(res, 200, { ok: true });
}

const AKTIVE = ['ny', 'laves', 'klar'];
const ALLE_STATUS = ['ny', 'laves', 'klar', 'leveret', 'annulleret'];

function statusListe(v, lovlige) {
  const l = String(v).split(',').map((s) => s.trim()).filter(Boolean);
  if (!l.length || l.some((s) => !lovlige.includes(s))) throw fejl(400, 'ugyldig_status', 'Ukendt status.');
  return [...new Set(l)];
}

function butikOrdrer(req, res, p, url) {
  kraevPersonale(req);
  const s = url.searchParams.get('status');
  let rows;
  if (s !== null) {
    const l = statusListe(s, ALLE_STATUS);
    rows = q(`${ORDRE_SQL} WHERE o.status IN (${l.map(() => '?').join(',')}) ORDER BY o.id LIMIT 2000`).all(...l);
  } else {
    const graense = new Date(Date.now() - 2 * 3600e3).toISOString();
    rows = q(`${ORDRE_SQL} WHERE o.status IN ('ny','laves','klar')
      OR (o.status IN ('leveret','annulleret') AND o.opdateret >= ?) ORDER BY o.id LIMIT 2000`).all(graense);
  }
  sendJson(res, 200, rows.map(ordreObj));
}

const SKIFT = {
  laves: ['ny', 'klar'],
  klar: ['laves'],
  leveret: ['klar'],
  ny: ['laves'],
  annulleret: ['ny', 'laves'],
};

async function butikStatus(req, res, p) {
  kraevPersonale(req);
  const id = idV(p.id, 'ordre_findes_ikke', 'Ordren findes ikke.');
  const k = await laesJson(req);
  if (!ALLE_STATUS.includes(k.status)) throw fejl(400, 'ugyldig_status', 'Ukendt status.');
  skiftStatus(id, k.status, SKIFT[k.status]);
  sendJson(res, 200, efterStatus(id));
}

function butikStream(req, res) {
  kraevPersonale(req);
  sse.tilfoejButik(req, res);
}

// ---------- Admin: varer ----------

function vareFelter(k, ny) {
  const f = {};
  if (ny || k.navn !== undefined) f.navn = tekst(k.navn, 1, 60, 'ugyldigt_navn', 'Varenavn skal være 1–60 tegn.');
  if (k.beskrivelse !== undefined) f.beskrivelse = tekst(k.beskrivelse, 0, 300, 'ugyldig_beskrivelse', 'Beskrivelsen må højst være 300 tegn.');
  if (k.kategori !== undefined) f.kategori = tekst(k.kategori, 0, 40, 'ugyldig_kategori', 'Kategorien må højst være 40 tegn.');
  if (ny || k.pris_oere !== undefined) f.pris_oere = heltal(k.pris_oere, 0, 1000000, 'ugyldig_pris', 'Prisen skal være et helt antal øre mellem 0 og 1.000.000.');
  if (k.aktiv !== undefined) f.aktiv = bool(k.aktiv, 'ugyldig_vaerdi', 'Aktiv skal være sand/falsk.') ? 1 : 0;
  if (k.udsolgt !== undefined) f.udsolgt = bool(k.udsolgt, 'ugyldig_vaerdi', 'Udsolgt skal være sand/falsk.') ? 1 : 0;
  if (k.sortering !== undefined) f.sortering = heltal(k.sortering, -1000000, 1000000, 'ugyldig_sortering', 'Sortering skal være et heltal.');
  return f;
}

const sendVarer = () => sse.tilAlleKunder('varer', aktiveVarer());

function adminVarer(req, res) {
  kraevPersonale(req);
  sendJson(res, 200, q('SELECT * FROM varer ORDER BY sortering, navn').all().map(vareObj));
}

async function adminNyVare(req, res) {
  kraevPersonale(req);
  const f = vareFelter(await laesJson(req), true);
  const sort = f.sortering ?? (q('SELECT COALESCE(MAX(sortering), 0) AS m FROM varer').get().m + 10);
  const r = q('INSERT INTO varer (navn, beskrivelse, kategori, pris_oere, billede, aktiv, udsolgt, sortering, oprettet) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)')
    .run(f.navn, f.beskrivelse ?? '', f.kategori ?? '', f.pris_oere, f.aktiv ?? 1, f.udsolgt ?? 0, sort, nu());
  sendVarer();
  sendJson(res, 200, vareObj(q('SELECT * FROM varer WHERE id = ?').get(Number(r.lastInsertRowid))));
}

function findVare(idTekst) {
  const id = idV(idTekst, 'vare_findes_ikke', 'Varen findes ikke.');
  const v = q('SELECT * FROM varer WHERE id = ?').get(id);
  if (!v) throw fejl(404, 'vare_findes_ikke', 'Varen findes ikke.');
  return v;
}

async function adminRetVare(req, res, p) {
  kraevPersonale(req);
  const v = findVare(p.id);
  const f = vareFelter(await laesJson(req), false);
  const n = Object.keys(f);
  if (n.length) {
    q(`UPDATE varer SET ${n.map((x) => `${x} = ?`).join(', ')} WHERE id = ?`).run(...n.map((x) => f[x]), v.id);
  }
  sendVarer();
  sendJson(res, 200, vareObj(q('SELECT * FROM varer WHERE id = ?').get(v.id)));
}

function adminSletVare(req, res, p) {
  kraevPersonale(req);
  const v = findVare(p.id);
  q('UPDATE varer SET aktiv = 0 WHERE id = ?').run(v.id);
  sendVarer();
  sendJson(res, 200, vareObj(q('SELECT * FROM varer WHERE id = ?').get(v.id)));
}

const BILLEDTYPER = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
};

function tjekBilledIndhold(ext, b) {
  const start = (s, o = 0) => b.subarray(o, o + s.length).toString('latin1') === s;
  switch (ext) {
    case 'png': return start('\x89PNG\r\n\x1a\n');
    case 'jpg': return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case 'gif': return start('GIF87a') || start('GIF89a');
    case 'webp': return start('RIFF') && start('WEBP', 8);
    case 'svg': {
      const t = b.toString('utf8');
      return /<svg[\s>]/i.test(t) && !/<script|\bon\w+\s*=|javascript:|<foreignObject/i.test(t);
    }
    default: return false;
  }
}

async function adminVareBillede(req, res, p) {
  kraevPersonale(req);
  const v = findVare(p.id);
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const ext = BILLEDTYPER[type];
  if (!ext) throw fejl(415, 'ugyldig_billedtype', 'Billedet skal være PNG, JPEG, WebP, GIF eller SVG.');
  const b = await laesBody(req, BILLEDE_MAKS, 'billede_for_stort', 'Billedet må højst fylde 3 MB.');
  if (b.length === 0 || !tjekBilledIndhold(ext, b)) {
    throw fejl(400, 'ugyldigt_billede', 'Filen ligner ikke et gyldigt billede af den valgte type.');
  }
  const fil = `vare-${v.id}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(billedDir, fil), b);
  q('UPDATE varer SET billede = ? WHERE id = ?').run(fil, v.id);
  // Fjern gammelt uploadet billede (standardbilleder bevares)
  if (v.billede && /^vare-\d+-[0-9a-f]{8}\.\w+$/.test(v.billede)) {
    fs.rm(path.join(billedDir, v.billede), { force: true }, () => {});
  }
  sendVarer();
  sendJson(res, 200, vareObj(q('SELECT * FROM varer WHERE id = ?').get(v.id)));
}

// ---------- Admin: deltagere ----------

function adminDeltagere(req, res, p, url) {
  kraevPersonale(req);
  const s = (url.searchParams.get('q') || '').trim().slice(0, 40);
  let rows;
  if (!s) {
    rows = q('SELECT * FROM deltagere ORDER BY pc_nr').all();
  } else {
    const like = '%' + s.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
    const pc = /^\d{1,4}$/.test(s) ? Number(s) : -1;
    rows = q("SELECT * FROM deltagere WHERE pc_nr = ? OR navn LIKE ? ESCAPE '\\' ORDER BY pc_nr LIMIT 500").all(pc, like);
  }
  sendJson(res, 200, rows.map(deltagerObj));
}

async function adminNyDeltager(req, res) {
  kraevPersonale(req);
  const k = await laesJson(req);
  const pc = pcNr(k.pc_nr);
  const navn = navnV(k.navn);
  const pin = k.pin === undefined || k.pin === null || k.pin === '' ? tilfaeldigPin() : pinV(k.pin);
  const start = k.startbeloeb_oere === undefined || k.startbeloeb_oere === null || k.startbeloeb_oere === ''
    ? 0
    : heltal(k.startbeloeb_oere, 0, 1000000, 'ugyldigt_beloeb', 'Startbeløbet skal være mellem 0 og 10.000 kr.');
  const metode = metodeV(k.metode);
  const d = await opretDeltager(pc, navn, pin, start, metode);
  if (start > 0) sse.tilButik('indbetaling', hentIndb(q('SELECT MAX(id) AS id FROM indbetalinger WHERE deltager_id = ?').get(d.id).id));
  // PIN i klartekst returneres kun her og ved nulstilling
  sendJson(res, 200, { ...deltagerObj(d), pin });
}

function findDeltager(idTekst) {
  const id = idV(idTekst, 'deltager_findes_ikke', 'Deltageren findes ikke.');
  const d = hentDeltager(id);
  if (!d) throw fejl(404, 'deltager_findes_ikke', 'Deltageren findes ikke.');
  return d;
}

async function adminRetDeltager(req, res, p) {
  kraevPersonale(req);
  const d = findDeltager(p.id);
  const k = await laesJson(req);
  const navn = k.navn !== undefined ? navnV(k.navn) : null;
  const nulstil = k.nulstil_pin !== undefined && bool(k.nulstil_pin, 'ugyldig_vaerdi', 'nulstil_pin skal være sand/falsk.');
  let pin = k.pin !== undefined && k.pin !== null && k.pin !== '' ? pinV(k.pin) : null;
  if (nulstil) pin = tilfaeldigPin();
  if (navn !== null) q('UPDATE deltagere SET navn = ? WHERE id = ?').run(navn, d.id);
  if (pin !== null) {
    const h = await hash(pin);
    q('UPDATE deltagere SET pin_salt = ?, pin_hash = ? WHERE id = ?').run(h.salt, h.hash, d.id);
  }
  const ud = deltagerObj(hentDeltager(d.id));
  // Ny tilfældig PIN vises én gang
  if (nulstil) ud.pin = pin;
  sendJson(res, 200, ud);
}

// ---------- Admin: udbetaling af restsaldo (tillæg 1) ----------

function adminUdbetalinger(req, res) {
  kraevPersonale(req);
  const mangler = q('SELECT * FROM deltagere WHERE saldo_oere > 0 ORDER BY pc_nr').all().map(deltagerObj);
  const udbetalt = q(`SELECT u.id, d.pc_nr, d.navn, u.beloeb_oere, u.metode, u.reference, u.oprettet
    FROM udbetalinger u JOIN deltagere d ON d.id = u.deltager_id ORDER BY u.id DESC`).all();
  sendJson(res, 200, { mangler, udbetalt });
}

async function adminUdbetal(req, res, p) {
  kraevPersonale(req);
  const d = findDeltager(p.id);
  const k = await laesJson(req);
  const metode = metodeV(k.metode);
  const ref = tekst(k.reference, 0, 100, 'ugyldig_reference', 'Referencen må højst være 100 tegn.');
  const u = tx(() => {
    const saldo = hentDeltager(d.id).saldo_oere;
    if (saldo <= 0) throw fejl(409, 'ingen_saldo', 'Der er ingen penge at udbetale.');
    const t = nu();
    const r = q('INSERT INTO udbetalinger (deltager_id, beloeb_oere, metode, reference, oprettet) VALUES (?, ?, ?, ?, ?)')
      .run(d.id, saldo, metode, ref, t);
    aendrSaldo(d.id, -saldo, 'udbetaling', { tekst: `Udbetaling af restsaldo (${metode})${ref ? ': ' + ref : ''}` });
    return { id: Number(r.lastInsertRowid), pc_nr: d.pc_nr, navn: d.navn, beloeb_oere: saldo, metode, reference: ref, oprettet: t };
  });
  sendSaldo(d.id);
  sendJson(res, 200, u);
}

async function adminSaldo(req, res, p) {
  kraevPersonale(req);
  const d = findDeltager(p.id);
  const k = await laesJson(req);
  const beloeb = heltal(k.beloeb_oere, -10000000, 10000000, 'ugyldigt_beloeb', 'Beløbet skal være et helt antal øre.');
  if (beloeb === 0) throw fejl(400, 'ugyldigt_beloeb', 'Beløbet må ikke være 0.');
  const t = tekst(k.tekst, 0, 200, 'ugyldig_tekst', 'Teksten må højst være 200 tegn.') || 'Manuel justering';
  try {
    tx(() => aendrSaldo(d.id, beloeb, 'justering', { tekst: t }));
  } catch (e) {
    if (e instanceof Fejl && e.kode === 'ikke_nok_penge') {
      throw fejl(409, 'ikke_nok_penge', 'Saldoen kan ikke blive negativ.');
    }
    throw e;
  }
  sendSaldo(d.id);
  sendJson(res, 200, deltagerObj(hentDeltager(d.id)));
}

function adminBevaegelser(req, res, p) {
  kraevPersonale(req);
  const d = findDeltager(p.id);
  sendJson(res, 200, q(`SELECT id, beloeb_oere, type, ordre_id, indbetaling_id, tekst, oprettet
    FROM saldo_bevaegelser WHERE deltager_id = ? ORDER BY id DESC`).all(d.id));
}

// ---------- Admin: indbetalinger ----------

function adminIndbetalinger(req, res, p, url) {
  kraevPersonale(req);
  const s = url.searchParams.get('status');
  let rows;
  if (s !== null && s !== '') {
    const l = statusListe(s, ['afventer', 'godkendt', 'afvist']);
    // Køen (kun afventer) vises ældste først, ellers nyeste først
    const ord = l.length === 1 && l[0] === 'afventer' ? 'ASC' : 'DESC';
    rows = q(`${INDB_SQL} WHERE i.status IN (${l.map(() => '?').join(',')}) ORDER BY i.id ${ord} LIMIT 2000`).all(...l);
  } else {
    rows = q(`${INDB_SQL} ORDER BY i.id DESC LIMIT 2000`).all();
  }
  sendJson(res, 200, rows.map(indbObj));
}

function behandlIndb(godkend) {
  return (req, res, p) => {
    kraevPersonale(req);
    const id = idV(p.id, 'indbetaling_findes_ikke', 'Indbetalingen findes ikke.');
    const deltagerId = tx(() => {
      const i = q('SELECT * FROM indbetalinger WHERE id = ?').get(id);
      if (!i) throw fejl(404, 'indbetaling_findes_ikke', 'Indbetalingen findes ikke.');
      if (i.status !== 'afventer') throw fejl(409, 'allerede_behandlet', 'Indbetalingen er allerede behandlet.');
      q('UPDATE indbetalinger SET status = ?, behandlet = ? WHERE id = ?').run(godkend ? 'godkendt' : 'afvist', nu(), id);
      if (godkend) {
        aendrSaldo(i.deltager_id, i.beloeb_oere, 'indbetaling', { indbId: id, tekst: `Indbetaling (${i.metode})` });
      }
      return i.deltager_id;
    });
    const i = hentIndb(id);
    sse.tilButik('indbetaling', i);
    sse.tilKunde(deltagerId, 'indbetaling', i);
    if (godkend) sendSaldo(deltagerId);
    sendJson(res, 200, i);
  };
}

// ---------- Admin: indstillinger og rapport ----------

function adminIndstillinger(req, res) {
  kraevPersonale(req);
  sendJson(res, 200, D.indstillinger());
}

async function adminRetIndstillinger(req, res) {
  kraevPersonale(req);
  const k = await laesJson(req);
  const nye = {};
  for (const [n, v] of Object.entries(k)) {
    const d = D.INDSTILLINGER[n];
    if (!d) throw fejl(400, 'ukendt_indstilling', `Ukendt indstilling: ${n}`);
    if (d.type === 'bool') nye[n] = bool(v, 'ugyldig_vaerdi', `Ugyldig værdi for ${n}.`) ? '1' : '0';
    else if (d.type === 'heltal') nye[n] = String(heltal(v, d.min, d.max, 'ugyldig_vaerdi', `Ugyldig værdi for ${n}.`));
    else nye[n] = tekst(v, d.min, d.max, 'ugyldig_vaerdi', `${n} skal være ${d.min}–${d.max} tegn.`);
  }
  tx(() => { for (const [n, v] of Object.entries(nye)) D.saetIndstilling(n, v); });
  const i = info();
  sse.tilAlleKunder('info', i);
  sse.tilButik('info', i);
  sendJson(res, 200, D.indstillinger());
}

function adminRapport(req, res) {
  kraevPersonale(req);
  const o = q("SELECT COALESCE(SUM(total_oere), 0) AS s, COUNT(*) AS n FROM ordrer WHERE status <> 'annulleret'").get();
  const pr = q(`SELECT l.navn, SUM(l.antal) AS antal, SUM(l.antal * l.pris_oere) AS beloeb_oere
    FROM ordrelinjer l JOIN ordrer o ON o.id = l.ordre_id WHERE o.status <> 'annulleret'
    GROUP BY l.navn ORDER BY beloeb_oere DESC, l.navn`).all();
  const ind = q("SELECT COALESCE(SUM(beloeb_oere), 0) AS s FROM indbetalinger WHERE status = 'godkendt'").get().s;
  const saldo = q('SELECT COALESCE(SUM(saldo_oere), 0) AS s FROM deltagere').get().s;
  const udb = q('SELECT COALESCE(SUM(beloeb_oere), 0) AS s FROM udbetalinger').get().s;
  sendJson(res, 200, {
    omsaetning_oere: o.s,
    antal_ordrer: o.n,
    pr_vare: pr.map((r) => ({ navn: r.navn, antal: r.antal, beloeb_oere: r.beloeb_oere })),
    indbetalt_oere: ind,
    samlet_saldo_oere: saldo,
    udbetalt_oere: udb,
  });
}

// ---------- Router ----------

const RUTER = [
  ['GET', '/api/info', (req, res) => sendJson(res, 200, info())],
  ['GET', '/api/varer', (req, res) => sendJson(res, 200, aktiveVarer())],

  ['POST', '/api/kunde/tilmeld', kundeTilmeld],
  ['POST', '/api/kunde/login', kundeLogin],
  ['POST', '/api/kunde/logout', kundeLogout],
  ['GET', '/api/kunde/mig', kundeMig],
  ['POST', '/api/kunde/ordrer', kundeNyOrdre],
  ['GET', '/api/kunde/ordrer', kundeOrdrer],
  ['POST', '/api/kunde/ordrer/:id/annuller', kundeAnnuller],
  ['POST', '/api/kunde/indbetalinger', kundeNyIndbetaling],
  ['GET', '/api/kunde/indbetalinger', kundeIndbetalinger],
  ['GET', '/api/kunde/stream', kundeStream],

  ['POST', '/api/personale/opsaet', personaleOpsaet],
  ['POST', '/api/personale/login', personaleLogin],
  ['POST', '/api/personale/logout', personaleLogout],
  ['GET', '/api/personale/mig', personaleMig],

  ['GET', '/api/butik/ordrer', butikOrdrer],
  ['POST', '/api/butik/ordrer/:id/status', butikStatus],
  ['GET', '/api/butik/stream', butikStream],

  ['GET', '/api/admin/varer', adminVarer],
  ['POST', '/api/admin/varer', adminNyVare],
  ['PUT', '/api/admin/varer/:id', adminRetVare],
  ['DELETE', '/api/admin/varer/:id', adminSletVare],
  ['POST', '/api/admin/varer/:id/billede', adminVareBillede],
  ['GET', '/api/admin/deltagere', adminDeltagere],
  ['POST', '/api/admin/deltagere', adminNyDeltager],
  ['PUT', '/api/admin/deltagere/:id', adminRetDeltager],
  ['POST', '/api/admin/deltagere/:id/saldo', adminSaldo],
  ['GET', '/api/admin/deltagere/:id/bevaegelser', adminBevaegelser],
  ['POST', '/api/admin/deltagere/:id/udbetal', adminUdbetal],
  ['GET', '/api/admin/udbetalinger', adminUdbetalinger],
  ['GET', '/api/admin/indbetalinger', adminIndbetalinger],
  ['POST', '/api/admin/indbetalinger/:id/godkend', behandlIndb(true)],
  ['POST', '/api/admin/indbetalinger/:id/afvis', behandlIndb(false)],
  ['GET', '/api/admin/indstillinger', adminIndstillinger],
  ['PUT', '/api/admin/indstillinger', adminRetIndstillinger],
  ['GET', '/api/admin/rapport', adminRapport],
].map(([metode, sti, fn]) => {
  const navne = [];
  const re = new RegExp('^' + sti.replace(/:(\w+)/g, (_, n) => (navne.push(n), '([^/]+)')) + '/?$');
  return { metode, re, navne, fn };
});

async function haandter(req, res, url) {
  try {
    let sti = url.pathname;
    let fundetSti = false;
    for (const r of RUTER) {
      const m = r.re.exec(sti);
      if (!m) continue;
      fundetSti = true;
      if (r.metode !== req.method && !(r.metode === 'GET' && req.method === 'HEAD')) continue;
      const p = {};
      r.navne.forEach((n, i) => (p[n] = m[i + 1]));
      await r.fn(req, res, p, url);
      return;
    }
    if (fundetSti) throw fejl(405, 'forkert_metode', 'Metoden er ikke tilladt her.');
    throw fejl(404, 'findes_ikke', 'Den efterspurgte adresse findes ikke.');
  } catch (e) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (e instanceof Fejl) {
      if (e.status === 413) res.setHeader('Connection', 'close');
      sendFejl(res, e);
    } else {
      console.error('Serverfejl:', e);
      sendFejl(res, fejl(500, 'serverfejl', 'Der skete en fejl på serveren. Prøv igen.'));
    }
  }
}

function init(dir) {
  billedDir = dir;
}

module.exports = { init, haandter, info };
