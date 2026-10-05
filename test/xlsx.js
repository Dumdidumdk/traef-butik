'use strict';
// Lille, streng læser til .xlsx-filer (kun til tests): zip, velformet XML og celler. Ingen npm-pakker.

const zlib = require('node:zlib');

// ---------- zip ----------

// Pakker en zip ud via den centrale mappe. Tjekker CRC og størrelser. Returnerer Map(navn → Buffer).
function pakUd(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('Ikke en zip-fil (for kort)');
  if (buf.readUInt32LE(0) !== 0x04034b50) throw new Error('Ikke en zip-fil (forkert signatur i starten)');
  // Find "end of central directory" bagfra (kommentar kan være op til 65535 byte).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Zip mangler "end of central directory"');
  const antal = buf.readUInt16LE(eocd + 10);
  const cdStoerrelse = buf.readUInt32LE(eocd + 12);
  let pos = buf.readUInt32LE(eocd + 16);
  if (pos + cdStoerrelse > eocd) throw new Error('Zip: central directory peger uden for filen');
  const filer = new Map();
  for (let n = 0; n < antal; n++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) throw new Error(`Zip: forkert signatur i central directory (post ${n})`);
    const flag = buf.readUInt16LE(pos + 8);
    const metode = buf.readUInt16LE(pos + 10);
    const crc = buf.readUInt32LE(pos + 16);
    const kompr = buf.readUInt32LE(pos + 20);
    const ukompr = buf.readUInt32LE(pos + 24);
    const navnLgd = buf.readUInt16LE(pos + 28);
    const ekstraLgd = buf.readUInt16LE(pos + 30);
    const kommLgd = buf.readUInt16LE(pos + 32);
    const lokal = buf.readUInt32LE(pos + 42);
    const navn = buf.toString(flag & 0x800 ? 'utf8' : 'latin1', pos + 46, pos + 46 + navnLgd);
    pos += 46 + navnLgd + ekstraLgd + kommLgd;

    if (buf.readUInt32LE(lokal) !== 0x04034b50) throw new Error(`Zip: forkert lokal header for ${navn}`);
    const lNavnLgd = buf.readUInt16LE(lokal + 26);
    const lEkstraLgd = buf.readUInt16LE(lokal + 28);
    const lNavn = buf.toString(flag & 0x800 ? 'utf8' : 'latin1', lokal + 30, lokal + 30 + lNavnLgd);
    if (lNavn !== navn) throw new Error(`Zip: navnet i lokal header (${lNavn}) ≠ central directory (${navn})`);
    const start = lokal + 30 + lNavnLgd + lEkstraLgd;
    const data = buf.subarray(start, start + kompr);
    let ud;
    if (metode === 0) ud = Buffer.from(data);
    else if (metode === 8) ud = zlib.inflateRawSync(data);
    else throw new Error(`Zip: ukendt komprimering ${metode} for ${navn}`);
    if (ud.length !== ukompr) throw new Error(`Zip: ${navn} har ${ud.length} byte, forventede ${ukompr}`);
    if ((zlib.crc32(ud) >>> 0) !== crc) throw new Error(`Zip: CRC passer ikke for ${navn}`);
    if (filer.has(navn)) throw new Error(`Zip: ${navn} findes to gange`);
    filer.set(navn, ud);
  }
  return filer;
}

// ---------- XML ----------

const ENTITETER = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function afkod(tekst, hvor) {
  return tekst.replace(/&([^;&\s]*);?/g, (hele, navn) => {
    if (!hele.endsWith(';')) throw new Error(`Ugyldigt & (mangler ;) i ${hvor}: ...${hele}`);
    if (navn in ENTITETER) return ENTITETER[navn];
    let kode;
    if (/^#x[0-9a-fA-F]+$/.test(navn)) kode = parseInt(navn.slice(2), 16);
    else if (/^#[0-9]+$/.test(navn)) kode = parseInt(navn.slice(1), 10);
    else throw new Error(`Ukendt entitet &${navn}; i ${hvor}`);
    if (!gyldigtTegn(kode)) throw new Error(`Ulovligt tegn &${navn}; i ${hvor}`);
    return String.fromCodePoint(kode);
  });
}

// XML 1.0: tab, LF, CR og alt fra 0x20 (undtagen surrogater og FFFE/FFFF).
function gyldigtTegn(k) {
  return k === 0x9 || k === 0xa || k === 0xd || (k >= 0x20 && k <= 0xd7ff) || (k >= 0xe000 && k <= 0xfffd) || (k >= 0x10000 && k <= 0x10ffff);
}

// Streng parser: fejler ved ubalancerede tags, råt "<" eller "&", ulovlige tegn, dårlige attributter.
// Returnerer roden som { navn, attr, boern: [element | tekst] }.
function parseXml(xml, hvor = 'XML') {
  if (typeof xml !== 'string') xml = xml.toString('utf8');
  if (xml.charCodeAt(0) === 0xfeff) xml = xml.slice(1);
  for (const tegn of xml) {
    if (!gyldigtTegn(tegn.codePointAt(0))) throw new Error(`Ulovligt tegn U+${tegn.codePointAt(0).toString(16)} i ${hvor}`);
  }
  let i = 0;
  const stak = [];
  let rod = null;
  const navnRe = /^[A-Za-z_:][\w.:-]*/;
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    const tekst = lt < 0 ? xml.slice(i) : xml.slice(i, lt);
    if (tekst) {
      if (tekst.includes('>') && /\]\]>/.test(tekst)) throw new Error(`"]]>" i tekst i ${hvor}`);
      const afkodet = afkod(tekst, hvor);
      if (stak.length) stak[stak.length - 1].boern.push(afkodet);
      else if (tekst.trim()) throw new Error(`Tekst uden for rodelementet i ${hvor}: ${tekst.trim().slice(0, 40)}`);
    }
    if (lt < 0) break;
    if (xml.startsWith('<?', lt)) {
      const slut = xml.indexOf('?>', lt);
      if (slut < 0) throw new Error(`Uafsluttet <? i ${hvor}`);
      i = slut + 2;
    } else if (xml.startsWith('<!--', lt)) {
      const slut = xml.indexOf('-->', lt);
      if (slut < 0) throw new Error(`Uafsluttet kommentar i ${hvor}`);
      i = slut + 3;
    } else if (xml.startsWith('<![CDATA[', lt)) {
      const slut = xml.indexOf(']]>', lt);
      if (slut < 0 || !stak.length) throw new Error(`Ugyldig CDATA i ${hvor}`);
      stak[stak.length - 1].boern.push(xml.slice(lt + 9, slut));
      i = slut + 3;
    } else if (xml.startsWith('<!', lt)) {
      throw new Error(`DOCTYPE/erklæringer er ikke tilladt i ${hvor}`);
    } else if (xml.startsWith('</', lt)) {
      const slut = xml.indexOf('>', lt);
      const navn = xml.slice(lt + 2, slut).trim();
      const top = stak.pop();
      if (!top || top.navn !== navn) throw new Error(`Slut-tag </${navn}> passer ikke til <${top ? top.navn : '–'}> i ${hvor}`);
      if (!stak.length) rod = top;
      i = slut + 1;
    } else {
      // Start-tag: læs navn og attributter tegn for tegn (">" må gerne stå i attributværdier).
      let j = lt + 1;
      const m = navnRe.exec(xml.slice(j));
      if (!m) throw new Error(`Ugyldigt tag-navn ved position ${lt} i ${hvor}: ${xml.slice(lt, lt + 30)}`);
      const el = { navn: m[0], attr: {}, boern: [] };
      j += m[0].length;
      for (;;) {
        const ws = /^\s*/.exec(xml.slice(j))[0];
        j += ws.length;
        if (xml.startsWith('/>', j)) {
          j += 2;
          if (stak.length) stak[stak.length - 1].boern.push(el);
          else if (rod) throw new Error(`To rodelementer i ${hvor}`);
          else rod = el;
          break;
        }
        if (xml[j] === '>') {
          j += 1;
          if (!stak.length && rod) throw new Error(`To rodelementer i ${hvor}`);
          if (stak.length) stak[stak.length - 1].boern.push(el);
          stak.push(el);
          break;
        }
        if (!ws) throw new Error(`Mangler mellemrum før attribut i <${el.navn}> i ${hvor}`);
        const a = navnRe.exec(xml.slice(j));
        if (!a) throw new Error(`Ugyldig attribut i <${el.navn}> i ${hvor}: ${xml.slice(j, j + 30)}`);
        j += a[0].length;
        const lig = /^\s*=\s*/.exec(xml.slice(j));
        if (!lig) throw new Error(`Attribut ${a[0]} uden værdi i ${hvor}`);
        j += lig[0].length;
        const q = xml[j];
        if (q !== '"' && q !== "'") throw new Error(`Attribut ${a[0]} uden anførselstegn i ${hvor}`);
        const slut = xml.indexOf(q, j + 1);
        if (slut < 0) throw new Error(`Uafsluttet attribut ${a[0]} i ${hvor}`);
        const raa = xml.slice(j + 1, slut);
        if (raa.includes('<')) throw new Error(`Råt "<" i attributten ${a[0]} i ${hvor}`);
        if (a[0] in el.attr) throw new Error(`Dobbelt attribut ${a[0]} i <${el.navn}> i ${hvor}`);
        el.attr[a[0]] = afkod(raa, hvor);
        j = slut + 1;
      }
      i = j;
    }
  }
  if (stak.length) throw new Error(`Uafsluttet <${stak[stak.length - 1].navn}> i ${hvor}`);
  if (!rod) throw new Error(`Intet rodelement i ${hvor}`);
  return rod;
}

// Navn uden namespace-præfiks.
const lokalNavn = (n) => n.slice(n.indexOf(':') + 1);
const elementer = (el) => el.boern.filter((b) => typeof b === 'object');
function boern(el, navn) {
  return elementer(el).filter((b) => lokalNavn(b.navn) === navn);
}
function barn(el, navn) {
  return boern(el, navn)[0] || null;
}
function alle(el, navn, ud = []) {
  for (const b of elementer(el)) {
    if (lokalNavn(b.navn) === navn) ud.push(b);
    alle(b, navn, ud);
  }
  return ud;
}
function tekstAf(el) {
  return el.boern.map((b) => (typeof b === 'string' ? b : tekstAf(b))).join('');
}

// ---------- regneark ----------

// "B12" → { kol: 1, raek: 11 }
function cellePos(ref) {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!m) throw new Error(`Ugyldig cellereference ${ref}`);
  let kol = 0;
  for (const c of m[1]) kol = kol * 26 + (c.charCodeAt(0) - 64);
  return { kol: kol - 1, raek: Number(m[2]) - 1 };
}

// Excel-serienummer (1900-system) → Date for "væguret" (UTC-felterne = den viste tid).
function serieTilVaegur(serie) {
  return new Date(Math.round((serie - 25569) * 86400000));
}

// Læser hele projektmappen. Returnerer { filer, xml, ark: [{ navn, sti, celler, raekker, xml }], stil }.
function laesXlsx(buf) {
  const filer = pakUd(buf);
  const xml = new Map();
  for (const [navn, data] of filer) {
    if (/\.(xml|rels)$/.test(navn)) xml.set(navn, parseXml(data.toString('utf8'), navn));
  }
  const kraev = (n) => {
    if (!xml.has(n)) throw new Error(`Mangler ${n} i xlsx-filen`);
    return xml.get(n);
  };
  kraev('[Content_Types].xml');
  kraev('_rels/.rels');
  const wb = kraev('xl/workbook.xml');
  const wbRels = kraev('xl/_rels/workbook.xml.rels');
  const stylesXml = kraev('xl/styles.xml');

  const rels = new Map(boern(wbRels, 'Relationship').map((r) => [r.attr.Id, r.attr.Target]));
  const shared = xml.has('xl/sharedStrings.xml') ? boern(xml.get('xl/sharedStrings.xml'), 'si').map((si) => alle(si, 't').map(tekstAf).join('')) : [];

  // Talformater pr. stil-indeks (cellXfs).
  const numFmts = new Map();
  const nf = barn(stylesXml, 'numFmts');
  if (nf) for (const f of boern(nf, 'numFmt')) numFmts.set(Number(f.attr.numFmtId), f.attr.formatCode);
  const fonts = boern(barn(stylesXml, 'fonts') || { boern: [] }, 'font').map((f) => !!barn(f, 'b') && barn(f, 'b').attr.val !== '0');
  const xfs = boern(barn(stylesXml, 'cellXfs') || { boern: [] }, 'xf').map((x) => ({
    numFmtId: Number(x.attr.numFmtId || 0),
    format: numFmts.get(Number(x.attr.numFmtId || 0)) || null,
    fed: !!fonts[Number(x.attr.fontId || 0)],
  }));

  const ark = boern(barn(wb, 'sheets'), 'sheet').map((s) => {
    const rid = s.attr['r:id'] || Object.entries(s.attr).find(([k]) => k.endsWith(':id'))?.[1];
    let maal = rels.get(rid);
    if (!maal) throw new Error(`Arket ${s.attr.name} peger på ukendt relation ${rid}`);
    maal = maal.startsWith('/') ? maal.slice(1) : `xl/${maal}`;
    const ws = kraev(maal);
    const celler = new Map(); // "A1" → { v, t, s, stil }
    const raekker = [];
    for (const row of alle(ws, 'row')) {
      for (const c of boern(row, 'c')) {
        const ref = c.attr.r;
        if (!ref) throw new Error(`Celle uden r-attribut i ${maal}`);
        const t = c.attr.t || 'n';
        const vEl = barn(c, 'v');
        let v = null;
        if (t === 's') v = shared[Number(tekstAf(vEl))];
        else if (t === 'inlineStr') v = alle(barn(c, 'is'), 't').map(tekstAf).join('');
        else if (t === 'str' || t === 'e') v = vEl ? tekstAf(vEl) : '';
        else if (t === 'b') v = vEl ? tekstAf(vEl) === '1' : null;
        else if (vEl) {
          v = Number(tekstAf(vEl));
          if (!Number.isFinite(v)) throw new Error(`Celle ${ref} i ${maal} har ikke et tal: ${tekstAf(vEl)}`);
        }
        const stil = xfs[Number(c.attr.s || 0)] || { numFmtId: 0, format: null, fed: false };
        const { kol, raek } = cellePos(ref);
        (raekker[raek] ||= [])[kol] = v;
        celler.set(ref, { v, t, stil, kol, raek });
      }
    }
    return { navn: s.attr.name, sti: maal, celler, raekker: Array.from(raekker, (r) => r || []), xml: ws };
  });
  return { filer, xml, ark, xfs, contentTypes: xml.get('[Content_Types].xml') };
}

// Kolonne-indeks → bogstaver (0 → A).
function kolBogstav(k) {
  let s = '';
  for (k += 1; k > 0; k = Math.floor((k - 1) / 26)) s = String.fromCharCode(65 + ((k - 1) % 26)) + s;
  return s;
}

module.exports = { pakUd, parseXml, laesXlsx, serieTilVaegur, cellePos, kolBogstav, alle, barn, boern, tekstAf };
