'use strict';
// Lille xlsx-skriver uden pakker: OOXML-ark med inline strings, pakket som zip (deflate + crc32 fra node:zlib)

const zlib = require('node:zlib');

// ---------- Zip ----------

function dosTid(d) {
  const tid = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const dato = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { tid, dato };
}

// filer: [{ navn, data: Buffer|string }] → Buffer
function zip(filer) {
  const { tid, dato } = dosTid(new Date());
  const dele = [];
  const central = [];
  let offset = 0;
  for (const f of filer) {
    const navn = Buffer.from(f.navn, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const komp = zlib.deflateRawSync(data, { level: 6 });
    const crc = zlib.crc32(data) >>> 0;

    const lok = Buffer.alloc(30);
    lok.writeUInt32LE(0x04034b50, 0);
    lok.writeUInt16LE(20, 4); // version
    lok.writeUInt16LE(0x0800, 6); // UTF-8-navne
    lok.writeUInt16LE(8, 8); // deflate
    lok.writeUInt16LE(tid, 10);
    lok.writeUInt16LE(dato, 12);
    lok.writeUInt32LE(crc, 14);
    lok.writeUInt32LE(komp.length, 18);
    lok.writeUInt32LE(data.length, 22);
    lok.writeUInt16LE(navn.length, 26);
    lok.writeUInt16LE(0, 28);
    dele.push(lok, navn, komp);

    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(8, 10);
    c.writeUInt16LE(tid, 12);
    c.writeUInt16LE(dato, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(komp.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(navn.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, navn);

    offset += lok.length + navn.length + komp.length;
  }
  const cd = Buffer.concat(central);
  const slut = Buffer.alloc(22);
  slut.writeUInt32LE(0x06054b50, 0);
  slut.writeUInt16LE(filer.length, 8);
  slut.writeUInt16LE(filer.length, 10);
  slut.writeUInt32LE(cd.length, 12);
  slut.writeUInt32LE(offset, 16);
  return Buffer.concat([...dele, cd, slut]);
}

// ---------- XML ----------

// Escape & < > " ' og fjern tegn, der ikke er lovlige i XML
function esc(s) {
  return String(s)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function kolBogstav(n) {
  let s = '';
  for (n += 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

const HDR = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

// Stil-id'er i styles.xml
const STIL = { normal: 0, fed: 1, kr: 2, dato: 3, fedkr: 4, heltal: 5, fedheltal: 6 };

const STYLES = `${HDR}<styleSheet xmlns="${NS}">
<numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0.00 &quot;kr.&quot;"/><numFmt numFmtId="165" formatCode="dd-mm-yyyy hh:mm"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFDDEBF7"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="8">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="1" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
const OVERSKRIFT = 7;

// Celle: null/undefined (tom), tal, streng, Date, eller { v, stil }
function celle(ref, v, stil) {
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    stil = v.stil ?? stil;
    v = v.v;
  }
  const s = typeof stil === 'string' ? STIL[stil] : stil;
  const sAttr = s ? ` s="${s}"` : '';
  if (v === null || v === undefined || v === '') return s ? `<c r="${ref}"${sAttr}/>` : '';
  if (v instanceof Date) return `<c r="${ref}"${sAttr}><v>${datoSerial(v)}</v></c>`;
  if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${sAttr}><v>${v}</v></c>`;
  const t = esc(v);
  const bevar = /^\s|\s$|\n/.test(String(v)) ? ' xml:space="preserve"' : '';
  return `<c r="${ref}"${sAttr} t="inlineStr"><is><t${bevar}>${t}</t></is></c>`;
}

// Dato-celler gemmes som "lokal" tid i Europe/Copenhagen
const tzFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Copenhagen', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short',
});
function lokal(d) {
  const p = {};
  for (const x of tzFmt.formatToParts(d)) p[x.type] = x.value;
  return {
    aar: +p.year, md: +p.month, dag: +p.day, time: +p.hour, min: +p.minute, sek: +p.second,
    ugedag: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday),
  };
}
function datoSerial(d) {
  const l = lokal(d);
  const ms = Date.UTC(l.aar, l.md - 1, l.dag, l.time, l.min, l.sek);
  return Math.round((ms / 86400000 + 25569) * 1e8) / 1e8;
}

// ark: { navn, kolonner: [{ titel, bredde, stil }], raekker: [[...]], efter: [[...]] (fx totalrække uden for filter) }
function arkXml(ark, foerste) {
  const kol = ark.kolonner;
  const sidst = kolBogstav(kol.length - 1);
  const rows = [];
  rows.push(`<row r="1">${kol.map((k, i) => celle(kolBogstav(i) + '1', k.titel, OVERSKRIFT)).join('')}</row>`);
  let r = 1;
  const tilfoej = (raekke) => {
    r++;
    rows.push(`<row r="${r}">${raekke.map((v, i) => celle(kolBogstav(i) + r, v, kol[i] && kol[i].stil)).join('')}</row>`);
  };
  ark.raekker.forEach(tilfoej);
  const filterSlut = r;
  (ark.efter || []).forEach(tilfoej);
  const cols = kol.map((k, i) => `<col min="${i + 1}" max="${i + 1}" width="${k.bredde || 14}" customWidth="1"/>`).join('');
  return {
    xml: `${HDR}<worksheet xmlns="${NS}" xmlns:r="${NS_R}">
<dimension ref="A1:${sidst}${Math.max(r, 1)}"/>
<sheetViews><sheetView workbookViewId="0"${foerste ? ' tabSelected="1"' : ''}><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${cols}</cols>
<sheetData>${rows.join('\n')}</sheetData>
<autoFilter ref="A1:${sidst}${filterSlut}"/>
</worksheet>`,
    filter: `$A$1:$${sidst}$${filterSlut}`,
  };
}

// Byg hele arbejdsbogen → Buffer
function arbejdsbog(ark) {
  const filer = [];
  const ct = [];
  const rels = [];
  const sheets = [];
  const navne = [];
  ark.forEach((a, i) => {
    const n = i + 1;
    const { xml, filter } = arkXml(a, i === 0);
    filer.push({ navn: `xl/worksheets/sheet${n}.xml`, data: xml });
    ct.push(`<Override PartName="/xl/worksheets/sheet${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
    rels.push(`<Relationship Id="rId${n}" Type="${NS_R}/worksheet" Target="worksheets/sheet${n}.xml"/>`);
    sheets.push(`<sheet name="${esc(a.navn)}" sheetId="${n}" r:id="rId${n}"/>`);
    navne.push(`<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${esc(a.navn.replace(/'/g, "''"))}'!${filter}</definedName>`);
  });
  const nStyles = ark.length + 1;
  return zip([
    {
      navn: '[Content_Types].xml',
      data: `${HDR}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
${ct.join('\n')}
</Types>`,
    },
    {
      navn: '_rels/.rels',
      data: `${HDR}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="${NS_R}/officeDocument" Target="xl/workbook.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="${NS_R}/extended-properties" Target="docProps/app.xml"/>
</Relationships>`,
    },
    {
      navn: 'docProps/core.xml',
      data: `${HDR}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:creator>Træf-butik</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</dcterms:created>
</cp:coreProperties>`,
    },
    {
      navn: 'docProps/app.xml',
      data: `${HDR}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Træf-butik</Application></Properties>`,
    },
    {
      navn: 'xl/workbook.xml',
      data: `${HDR}<workbook xmlns="${NS}" xmlns:r="${NS_R}">
<bookViews><workbookView activeTab="0"/></bookViews>
<sheets>${sheets.join('')}</sheets>
<definedNames>${navne.join('')}</definedNames>
</workbook>`,
    },
    {
      navn: 'xl/_rels/workbook.xml.rels',
      data: `${HDR}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${rels.join('\n')}
<Relationship Id="rId${nStyles}" Type="${NS_R}/styles" Target="styles.xml"/>
</Relationships>`,
    },
    { navn: 'xl/styles.xml', data: STYLES },
    ...filer,
  ]);
}

module.exports = { arbejdsbog, zip, esc, kolBogstav, lokal, datoSerial };
