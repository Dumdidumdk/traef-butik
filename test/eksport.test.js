'use strict';
// Tillæg 2, del B: salget som regneark (/api/admin/eksport.xlsx). Kør: node --test test/eksport.test.js

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./hjaelp.js');
const { laesXlsx, serieTilVaegur, alle, barn, boern } = require('./xlsx.js');

const FANER = ['Oversigt', 'Salg pr. vare', 'Salg pr. time', 'Ordrer', 'Ordrelinjer', 'Indbetalinger', 'Udbetalinger', 'Deltagere'];
const KOLONNER = {
  'Salg pr. vare': ['Vare', 'Kategori', 'Antal solgt', 'Beløb'],
  'Salg pr. time': ['Time', 'Antal ordrer', 'Beløb'],
  Ordrer: ['Ordrenr', 'Tidspunkt', 'PC', 'Navn', 'Levering', 'Status', 'Varer', 'Note', 'Total'],
  Ordrelinjer: ['Ordrenr', 'Tidspunkt', 'PC', 'Navn', 'Vare', 'Kategori', 'Antal', 'Stykpris', 'Beløb', 'Status'],
  Indbetalinger: ['Tidspunkt', 'PC', 'Navn', 'Beløb', 'Metode', 'Reference', 'Status'],
  Udbetalinger: ['Tidspunkt', 'PC', 'Navn', 'Beløb', 'Metode', 'Reference'],
  Deltagere: ['PC', 'Navn', 'Indbetalt', 'Brugt', 'Udbetalt', 'Saldo nu'],
};
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// Navne med alt det, der skal escapes.
const SØREN = 'Søren "Ræven" <Ødegaard> & Co';
const ÅSE = 'Åse Æbelø';
const ULLA = 'Ulla Udbetaling';
const SÆRVARE = 'Rød & "sur" <øl>';
const SÆRKATEGORI = 'Øl & vin <18+>';
const NOTE = 'uden is & "is" <tak> æøå';
const UDB_REF = 'Kontant <i hånden> & "tak"';
const IND_REF = 'Åse & "mor"';
const CHEF = 'Chef Søs'; // admin
const EKSP = 'Mads & "Co" <ø>'; // ekspedient (tillæg 3) – navnet skal også escapes

const ok = (r) => {
  assert.ok(r.status >= 200 && r.status < 300, `Uventet status ${r.status}: ${r.tekst.slice(0, 300)}`);
  return r.data;
};
const kr = (oere) => oere / 100;
const naer = (a, b, besked) => assert.ok(Math.abs(Number(a) - Number(b)) < 0.005, `${besked}: ${a} ≠ ${b}`);

// Tabel fra et ark: første række er overskrifter. Returnerer { kol(navn) → indeks, raekker: [[...]] }.
function tabel(ark) {
  const [hoved = [], ...resten] = ark.raekker;
  const navne = hoved.map((h) => (h == null ? '' : String(h).trim()));
  const kol = (n) => {
    const i = navne.indexOf(n);
    assert.ok(i >= 0, `Arket "${ark.navn}" mangler kolonnen "${n}" (har: ${navne.join(', ')})`);
    return i;
  };
  const raekker = resten.filter((r) => r && r.some((c) => c !== null && c !== undefined && c !== ''));
  return { navne, kol, raekker };
}
// Totalrækker kendes på "Total"/"I alt" i første kolonne.
const erTotal = (r) => /^(total|i alt|sum)/i.test(String(r[0] ?? '').trim());
const ordreNr = (v) => Number(String(v).replace(/^#/, ''));

// Find værdien til højre for en etiket i Oversigt.
function vaerdiEfter(ark, re) {
  for (const r of ark.raekker) {
    const i = r.findIndex((c) => typeof c === 'string' && re.test(c));
    if (i >= 0) {
      for (let j = i + 1; j < r.length; j++) if (r[j] !== null && r[j] !== undefined && r[j] !== '') return { v: r[j], kol: j, raek: ark.raekker.indexOf(r) };
    }
  }
  assert.fail(`Oversigt mangler en linje der matcher ${re}`);
}
// Celle-objekt ud fra række/kolonne.
function celle(ark, raek, kol) {
  for (const c of ark.celler.values()) if (c.raek === raek && c.kol === kol) return c;
  return null;
}
// Dansk vægurstid for et ISO-tidspunkt (Europe/Copenhagen), som "Date" hvor UTC-felterne er vægurstiden.
function koebenhavnVaegur(iso) {
  const dele = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Copenhagen', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return new Date(Date.UTC(+dele.year, +dele.month - 1, +dele.day, +dele.hour, +dele.minute, +dele.second));
}

describe('Regneark: /api/admin/eksport.xlsx', () => {
  let server;
  let p;
  let rapport;
  let svar;
  let bog;
  let ordrer; // alle ordrer fra butikkens liste
  const ark = (navn) => bog.ark.find((a) => a.navn === navn);
  const kunder = {};
  let e; // ekspedienten
  const forventPersonale = { klar: 0, annulleret: 0, indAntal: 0, indBeloeb: 0, checkin: 0 };

  before(async () => {
    server = await startServer();
    p = server.browser('personale');
    ok(await p.post('/api/personale/opsaet', { navn: CHEF, kode: 'eksport-test-1' }));
    ok(await p.post('/api/admin/personale', { navn: EKSP, rolle: 'ekspedient', kode: 'mads-kode-1' }));
    e = server.browser('ekspedient');
    ok(await e.post('/api/personale/login', { navn: EKSP, kode: 'mads-kode-1' }));
    ok(await p.put('/api/admin/indstillinger', { traef_navn: 'Søndervang LAN & Co' }));
    const saer = ok(await p.post('/api/admin/varer', { navn: SÆRVARE, beskrivelse: 'Særtegn', kategori: SÆRKATEGORI, pris_oere: 3550, aktiv: 1, udsolgt: 0, sortering: 1 }));
    const varer = ok(await server.browser().get('/api/varer'));
    const v = (n) => varer.find((x) => x.navn.startsWith(n)).id;

    const opret = async (navn, body, af = p) => {
      const d = ok(await af.post('/api/admin/deltagere', { navn, ...body, pin: body.pin || '1234' }));
      const b = server.browser(navn);
      ok(await b.post('/api/kunde/login', { pc_nr: body.pc_nr, pin: body.pin || '1234' }));
      kunder[navn] = { d, b };
      return b;
    };
    const a = await opret(SØREN, { pc_nr: 1, startbeloeb_oere: 30000, metode: 'kontant' });
    const b = await opret(ÅSE, { pc_nr: 2 }, e); // ekspedienten checker Åse ind
    forventPersonale.checkin++;
    const c = await opret(ULLA, { pc_nr: 3, startbeloeb_oere: 10000 });

    // Åse: godkendt, afvist og afventende indbetaling.
    const i1 = ok(await b.post('/api/kunde/indbetalinger', { beloeb_oere: 20000, metode: 'mobilepay', reference: IND_REF }));
    ok(await e.post(`/api/admin/indbetalinger/${i1.id}/godkend`, {}));
    forventPersonale.indAntal++;
    forventPersonale.indBeloeb += 200;
    const i2 = ok(await b.post('/api/kunde/indbetalinger', { beloeb_oere: 5000, metode: 'kontant', reference: 'afvist' }));
    ok(await p.post(`/api/admin/indbetalinger/${i2.id}/afvis`, {}));
    ok(await b.post('/api/kunde/indbetalinger', { beloeb_oere: 1000, metode: 'andet', reference: 'venter' }));

    const lever = async (o) => {
      for (const s of ['laves', 'klar', 'leveret']) ok(await p.post(`/api/butik/ordrer/${o.id}/status`, { status: s }));
    };
    const bestil = (k, linjer, levering = 'hent', note = '') => k.post('/api/kunde/ordrer', { linjer, levering, note });
    // Søren: ekspedienten laver og melder klar, chefen leverer.
    const o1 = ok(await bestil(a, [{ vare_id: saer.id, antal: 3 }, { vare_id: v('Coca-Cola 0,5'), antal: 1 }], 'bord', NOTE));
    ok(await e.post(`/api/butik/ordrer/${o1.id}/status`, { status: 'laves' }));
    ok(await e.post(`/api/butik/ordrer/${o1.id}/status`, { status: 'klar' }));
    forventPersonale.klar++;
    ok(await p.post(`/api/butik/ordrer/${o1.id}/status`, { status: 'leveret' }));
    const ann = ok(await bestil(a, [{ vare_id: v('Snickers'), antal: 3 }]));
    ok(await a.post(`/api/kunde/ordrer/${ann.id}/annuller`, {}));
    const ann2 = ok(await bestil(b, [{ vare_id: saer.id, antal: 1 }]));
    ok(await e.post(`/api/butik/ordrer/${ann2.id}/status`, { status: 'laves' }));
    ok(await e.post(`/api/butik/ordrer/${ann2.id}/status`, { status: 'annulleret' }));
    forventPersonale.annulleret++;
    await lever(ok(await bestil(b, [{ vare_id: v('Toast med ost'), antal: 2 }])));
    ok(await bestil(b, [{ vare_id: v('Pizza'), antal: 1 }])); // står som ny
    await lever(ok(await bestil(c, [{ vare_id: v('Vand'), antal: 1 }])));
    // Kontroltegn i en note: enten afvises den, eller også skal den escapes/fjernes i regnearket.
    const kontrol = await bestil(c, [{ vare_id: v('Vand'), antal: 1 }], 'hent', 'bip\u0007\u0001 slut');
    if (kontrol.status < 300) await lever(kontrol.data);
    ok(await p.post(`/api/admin/deltagere/${kunder[ULLA].d.id}/udbetal`, { metode: 'kontant', reference: UDB_REF }));

    rapport = ok(await p.get('/api/admin/rapport'));
    ordrer = ok(await p.get('/api/butik/ordrer'));
    svar = await p.get('/api/admin/eksport.xlsx');
  });
  after(async () => {
    if (server) await server.stop();
  });

  it('svarer med en xlsx-fil som vedhæftning med rigtigt filnavn', () => {
    assert.equal(svar.status, 200, `Status ${svar.status}: ${svar.tekst.slice(0, 200)}`);
    assert.equal((svar.headers['content-type'] || '').split(';')[0].trim(), XLSX_TYPE);
    const cd = svar.headers['content-disposition'] || '';
    const idag = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Copenhagen' }).format(new Date());
    assert.match(cd, /^attachment;/i, `Content-Disposition: ${cd}`);
    const m = /filename="([^"]*)"/.exec(cd);
    assert.ok(m, `Content-Disposition mangler filename="…": ${cd}`);
    assert.ok(m[1].endsWith(`-salg-${idag}.xlsx`), `Filnavnet ${m[1]} skal ende på -salg-${idag}.xlsx`);
    const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
    const fuldt = star ? decodeURIComponent(star[1]) : m[1];
    assert.ok(/s.ndervang/i.test(fuldt), `Filnavnet skal indeholde træffets navn: ${fuldt}`);
  });

  it('zip og XML er gyldige, og alle påkrævede dele findes', () => {
    bog = laesXlsx(svar.buffer); // kaster ved ugyldig zip, CRC eller XML
    for (const n of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml']) {
      assert.ok(bog.filer.has(n), `Mangler ${n}`);
    }
    const harShared = bog.filer.has('xl/sharedStrings.xml');
    const harInline = bog.ark.some((a) => [...a.celler.values()].some((c) => c.t === 'inlineStr'));
    assert.ok(harShared || harInline, 'Tekst skal ligge i sharedStrings.xml eller som inline strings');
    // _rels/.rels peger på projektmappen.
    const rels = boern(bog.xml.get('_rels/.rels'), 'Relationship');
    assert.ok(rels.some((r) => /officeDocument$/.test(r.attr.Type) && /^\/?xl\/workbook\.xml$/.test(r.attr.Target)), '_rels/.rels peger ikke på xl/workbook.xml');
    // [Content_Types].xml dækker alle dele.
    const ct = bog.contentTypes;
    const overrides = new Map(boern(ct, 'Override').map((o) => [o.attr.PartName, o.attr.ContentType]));
    const defaults = new Map(boern(ct, 'Default').map((d) => [d.attr.Extension.toLowerCase(), d.attr.ContentType]));
    assert.equal(overrides.get('/xl/workbook.xml'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml');
    assert.equal(overrides.get('/xl/styles.xml'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml');
    if (harShared) assert.equal(overrides.get('/xl/sharedStrings.xml'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml');
    for (const a of bog.ark) {
      assert.equal(overrides.get(`/${a.sti}`), 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml', `${a.sti} mangler i [Content_Types].xml`);
    }
    assert.ok(defaults.has('rels'), '[Content_Types].xml mangler Default for .rels');
    for (const navn of bog.filer.keys()) {
      if (navn.endsWith('/') || navn === '[Content_Types].xml') continue;
      const ext = navn.split('.').pop().toLowerCase();
      assert.ok(overrides.has(`/${navn}`) || defaults.has(ext), `${navn} har ingen content type`);
    }
  });

  it('har de 8 faner i rigtig rækkefølge plus Personale (tillæg 3)', () => {
    assert.deepEqual(bog.ark.map((a) => a.navn), [...FANER, 'Personale']);
  });

  it('fanerne har fede overskrifter, frosset første række, autofilter og kolonnebredder', () => {
    for (const a of bog.ark.slice(1)) {
      const t = tabel(a);
      for (const n of KOLONNER[a.navn] || []) t.kol(n);
      for (let k = 0; k < t.navne.length; k++) {
        const c = celle(a, 0, k);
        if (c && c.v) assert.ok(c.stil.fed, `"${a.navn}": overskriften "${c.v}" er ikke fed`);
      }
      const pane = alle(a.xml, 'pane')[0];
      assert.ok(pane, `"${a.navn}" har ingen frosne ruder`);
      assert.equal(Number(pane.attr.ySplit), 1, `"${a.navn}": første række skal være frosset`);
      assert.match(pane.attr.state || '', /frozen/, `"${a.navn}": pane skal være frozen`);
      assert.ok(barn(a.xml, 'autoFilter'), `"${a.navn}" mangler autofilter`);
      const cols = alle(a.xml, 'col');
      assert.ok(cols.length > 0 && cols.every((c) => Number(c.attr.width) > 0), `"${a.navn}" mangler kolonnebredder`);
    }
  });

  it('Oversigt passer med /api/admin/rapport', () => {
    const o = ark('Oversigt');
    const tekster = o.raekker.flat().filter((c) => typeof c === 'string');
    assert.ok(tekster.includes('Søndervang LAN & Co'), 'Oversigt skal vise træffets navn');
    assert.ok(tekster.some((t) => /udskrevet/i.test(t)), 'Oversigt skal vise udskrevet tidspunkt');
    const tjek = (re, forventet, navn) => {
      const { v, kol, raek } = vaerdiEfter(o, re);
      naer(v, forventet, `Oversigt: ${navn}`);
      return celle(o, raek, kol);
    };
    const oms = tjek(/omsætning/i, kr(rapport.omsaetning_oere), 'omsætning');
    assert.match(oms.stil.format || '', /kr\./, 'Omsætning skal have talformatet med "kr."');
    tjek(/^antal ordrer/i, rapport.antal_ordrer, 'antal ordrer');
    tjek(/annullerede/i, 2, 'annullerede ordrer');
    tjek(/^indbetalt/i, kr(rapport.indbetalt_oere), 'indbetalt');
    tjek(/^udbetalt/i, kr(rapport.udbetalt_oere), 'udbetalt');
    tjek(/saldo/i, kr(rapport.samlet_saldo_oere), 'samlet saldo');
    assert.equal(String(vaerdiEfter(o, /regnskabet går op/i).v), 'Ja');
  });

  it('Salg pr. vare passer med rapporten, er sorteret efter beløb og har en totalrække', () => {
    const a = ark('Salg pr. vare');
    const t = tabel(a);
    const data = t.raekker.filter((r) => !erTotal(r));
    const total = t.raekker.find(erTotal);
    const forventet = new Map(rapport.pr_vare.map((x) => [x.navn, x]));
    assert.equal(data.length, forventet.size, `Salg pr. vare har ${data.length} rækker, rapporten ${forventet.size}`);
    for (const r of data) {
      const f = forventet.get(r[t.kol('Vare')]);
      assert.ok(f, `Uventet vare i Salg pr. vare: ${r[t.kol('Vare')]}`);
      assert.equal(r[t.kol('Antal solgt')], f.antal, `${f.navn}: antal`);
      naer(r[t.kol('Beløb')], kr(f.beloeb_oere), `${f.navn}: beløb`);
    }
    const beloeb = data.map((r) => r[t.kol('Beløb')]);
    assert.deepEqual(beloeb, [...beloeb].sort((x, y) => y - x), 'Skal være sorteret efter beløb, størst først');
    assert.ok(total, 'Salg pr. vare mangler en totalrække');
    naer(total[t.kol('Beløb')], kr(rapport.omsaetning_oere), 'Totalrækken');
    // Annullerede tæller ikke: Snickers blev kun købt i en annulleret ordre.
    assert.ok(!data.some((r) => r[t.kol('Vare')] === 'Snickers'), 'Snickers (kun annulleret) må ikke stå som solgt');
    const saer = data.find((r) => r[t.kol('Vare')] === SÆRVARE);
    assert.ok(saer, `Varen ${SÆRVARE} mangler eller er escapet forkert`);
    assert.equal(saer[t.kol('Antal solgt')], 3, 'Den annullerede særvare må ikke tælle med');
    assert.equal(saer[t.kol('Kategori')], SÆRKATEGORI);
    const c = celle(a, t.raekker.indexOf(saer) + 1, t.kol('Beløb'));
    assert.match(c.stil.format || '', /kr\./, 'Beløb skal have talformatet med "kr."');
  });

  it('Salg pr. time summerer til omsætningen', () => {
    const t = tabel(ark('Salg pr. time'));
    const data = t.raekker.filter((r) => !erTotal(r));
    assert.ok(data.length >= 1);
    for (const r of data) assert.match(String(r[t.kol('Time')]), /^(man|tir|ons|tor|fre|lør|søn)\.? \d{2}:00$/, `Time skal ligne "fre 18:00": ${r[t.kol('Time')]}`);
    naer(data.reduce((s, r) => s + r[t.kol('Beløb')], 0), kr(rapport.omsaetning_oere), 'Sum af Beløb');
    assert.equal(data.reduce((s, r) => s + r[t.kol('Antal ordrer')], 0), rapport.antal_ordrer, 'Sum af antal ordrer');
  });

  it('Ordrer: alle ordrer med status, dansk tid og korrekt escapede tekster', () => {
    const a = ark('Ordrer');
    const t = tabel(a);
    const data = t.raekker.filter((r) => !erTotal(r));
    assert.deepEqual(data.map((r) => ordreNr(r[t.kol('Ordrenr')])).sort((x, y) => x - y), ordrer.map((o) => o.id).sort((x, y) => x - y));
    for (const o of ordrer) {
      const r = data.find((x) => ordreNr(x[t.kol('Ordrenr')]) === o.id);
      naer(r[t.kol('Total')], kr(o.total_oere), `Ordre ${o.id}: total`);
      assert.equal(r[t.kol('PC')], o.pc_nr);
      assert.equal(r[t.kol('Navn')], o.navn, `Ordre ${o.id}: navn`);
      assert.equal(r[t.kol('Levering')], o.levering === 'bord' ? 'Bring til plads' : 'Afhentning');
      if (o.status === 'annulleret') assert.match(String(r[t.kol('Status')]), /annul/i, `Ordre ${o.id} skal stå som annulleret`);
      // Tidspunkt: dato-celle i dansk tid.
      const ri = t.raekker.indexOf(r) + 1;
      const tc = celle(a, ri, t.kol('Tidspunkt'));
      assert.equal(typeof tc.v, 'number', `Tidspunkt i ordre ${o.id} skal være en dato-celle (tal), ikke "${tc.v}"`);
      assert.match(tc.stil.format || '', /dd-mm-yyyy hh:mm/, `Tidspunkt skal have formatet dd-mm-yyyy hh:mm (har ${tc.stil.format})`);
      const forskel = Math.abs(serieTilVaegur(tc.v) - koebenhavnVaegur(o.oprettet));
      assert.ok(forskel < 61000, `Tidspunkt for ordre ${o.id} er ikke dansk tid (forskel ${Math.round(forskel / 60000)} min)`);
      const totC = celle(a, ri, t.kol('Total'));
      assert.match(totC.stil.format || '', /kr\./, 'Total skal have talformatet med "kr."');
    }
    const soeren = data.find((r) => r[t.kol('Note')] === NOTE);
    assert.ok(soeren, `Noten "${NOTE}" kom ikke korrekt igennem`);
    assert.equal(soeren[t.kol('Navn')], SØREN);
    assert.ok(String(soeren[t.kol('Varer')]).includes(SÆRVARE), `Varer-teksten skal indeholde ${SÆRVARE}`);
  });

  it('Ordrelinjer: beløb = antal × stykpris, og ikke-annullerede summerer til omsætningen', () => {
    const t = tabel(ark('Ordrelinjer'));
    const data = t.raekker.filter((r) => !erTotal(r));
    let sum = 0;
    for (const r of data) {
      naer(r[t.kol('Beløb')], r[t.kol('Antal')] * r[t.kol('Stykpris')], `Linje i ordre ${r[t.kol('Ordrenr')]}`);
      if (!/annul/i.test(String(r[t.kol('Status')]))) sum += r[t.kol('Beløb')];
    }
    naer(sum, kr(rapport.omsaetning_oere), 'Sum af ikke-annullerede linjer');
    assert.ok(data.some((r) => /annul/i.test(String(r[t.kol('Status')]))), 'Annullerede linjer skal stå med status');
    assert.ok(data.some((r) => r[t.kol('Vare')] === SÆRVARE && r[t.kol('Kategori')] === SÆRKATEGORI));
  });

  it('Indbetalinger og Udbetalinger har alle rækker med rigtige tekster', () => {
    const ti = tabel(ark('Indbetalinger'));
    const ind = ti.raekker.filter((r) => !erTotal(r));
    assert.equal(ind.length, 5, 'Forventede 5 indbetalinger (2 startbeløb, godkendt, afvist, afventer)');
    assert.ok(ind.some((r) => r[ti.kol('Reference')] === IND_REF && r[ti.kol('Navn')] === ÅSE), `Referencen "${IND_REF}" kom ikke korrekt igennem`);
    const tu = tabel(ark('Udbetalinger'));
    const ud = tu.raekker.filter((r) => !erTotal(r));
    assert.equal(ud.length, 1);
    assert.equal(ud[0][tu.kol('Reference')], UDB_REF);
    assert.equal(ud[0][tu.kol('Navn')], ULLA);
    naer(ud[0][tu.kol('Beløb')], kr(rapport.udbetalt_oere), 'Udbetalt beløb');
  });

  it('Deltagere: saldo nu = indbetalt − brugt − udbetalt og passer med serveren', async () => {
    const t = tabel(ark('Deltagere'));
    const data = t.raekker.filter((r) => !erTotal(r));
    assert.equal(data.length, 3);
    for (const [navn, { d }] of Object.entries(kunder)) {
      const r = data.find((x) => x[t.kol('Navn')] === navn);
      assert.ok(r, `Deltageren "${navn}" mangler eller er escapet forkert`);
      assert.equal(r[t.kol('PC')], d.pc_nr);
      naer(r[t.kol('Saldo nu')], r[t.kol('Indbetalt')] - r[t.kol('Brugt')] - r[t.kol('Udbetalt')], `${navn}: saldo`);
      const nu = ok(await p.get(`/api/admin/deltagere?q=${d.pc_nr}`)).find((x) => x.id === d.id);
      naer(r[t.kol('Saldo nu')], kr(nu.saldo_oere), `${navn}: saldo nu`);
    }
    naer(data.reduce((s, r) => s + r[t.kol('Brugt')], 0), kr(rapport.omsaetning_oere), 'Sum af brugt');
  });

  // Kolonne ud fra et mønster (tillæg 3 giver ikke de præcise overskrifter).
  const kolMed = (t, re, hvad) => {
    const i = t.navne.findIndex((n) => re.test(n));
    assert.ok(i >= 0, `Mangler kolonnen ${hvad} (har: ${t.navne.join(', ')})`);
    return i;
  };

  it('tillæg 3: "Udført af"/"Godkendt af" i Ordrer, Indbetalinger og Udbetalinger', () => {
    const to = tabel(ark('Ordrer'));
    const af = kolMed(to, /udført af|leveret af|af$/i, '"Udført af" i Ordrer');
    const raek = (id) => to.raekker.find((r) => ordreNr(r[to.kol('Ordrenr')]) === id);
    const soeren = to.raekker.find((r) => r[to.kol('Note')] === NOTE);
    assert.equal(soeren[af], CHEF, 'Søren-ordren blev leveret af chefen');
    const annulleretAfEksp = ordrer.find((o) => o.status === 'annulleret' && o.pc_nr === 2);
    assert.equal(raek(annulleretAfEksp.id)[af], EKSP, 'Åses ordre blev annulleret af ekspedienten (navnet skal escapes korrekt)');
    const annulleretAfKunde = ordrer.find((o) => o.status === 'annulleret' && o.pc_nr === 1);
    assert.equal(raek(annulleretAfKunde.id)[af], 'Kunden');

    const ti = tabel(ark('Indbetalinger'));
    const gaf = kolMed(ti, /godkendt af|behandlet af|udført af/i, '"Godkendt af" i Indbetalinger');
    assert.equal(ti.raekker.find((r) => r[ti.kol('Reference')] === IND_REF)[gaf], EKSP);

    const tu = tabel(ark('Udbetalinger'));
    const uaf = kolMed(tu, /udført af|udbetalt af/i, '"Udført af" i Udbetalinger');
    assert.equal(tu.raekker.filter((r) => !erTotal(r))[0][uaf], CHEF);
  });

  it('tillæg 3: fanen Personale tæller pr. medarbejder', () => {
    const a = ark('Personale');
    assert.ok(a, 'Fanen Personale mangler');
    const t = tabel(a);
    const navn = kolMed(t, /^navn/i, 'Navn');
    const rolle = kolMed(t, /rolle/i, 'Rolle');
    const klar = kolMed(t, /klar/i, 'ordrer flyttet til klar');
    const lev = kolMed(t, /leveret/i, 'ordrer leveret');
    const ann = kolMed(t, /annull/i, 'ordrer annulleret');
    const check = kolMed(t, /check|tjek/i, 'deltagere checket ind');
    const indKol = t.navne.map((n, i) => (/indbetal|godkend/i.test(n) ? i : -1)).filter((i) => i >= 0);
    assert.equal(indKol.length, 2, `Forventede to kolonner for godkendte indbetalinger (antal og beløb), fandt: ${indKol.map((i) => t.navne[i]).join(', ')}`);
    const r = (n) => t.raekker.find((x) => x[navn] === n);
    const m = r(EKSP);
    assert.ok(m, `Ekspedienten "${EKSP}" mangler i Personale (eller er escapet forkert)`);
    assert.match(String(m[rolle]), /ekspedient/i);
    assert.match(String(r(CHEF)[rolle]), /admin/i);
    assert.equal(m[klar], forventPersonale.klar, 'Ekspedienten: ordrer flyttet til klar');
    assert.equal(m[lev] || 0, 0, 'Ekspedienten leverede ingen ordrer');
    assert.equal(m[ann], forventPersonale.annulleret, 'Ekspedienten: annullerede ordrer');
    assert.equal(m[check], forventPersonale.checkin, 'Ekspedienten: deltagere checket ind');
    // Antal og beløb: beløbskolonnen har kr.-format.
    const ri = t.raekker.indexOf(m) + 1;
    const [antalI, beloebI] = /kr\./.test(celle(a, ri, indKol[0])?.stil.format || '') ? [indKol[1], indKol[0]] : indKol;
    assert.equal(m[antalI], forventPersonale.indAntal, 'Ekspedienten: antal godkendte indbetalinger');
    naer(m[beloebI], forventPersonale.indBeloeb, 'Ekspedienten: beløb af godkendte indbetalinger');
    const leveretIalt = ordrer.filter((o) => o.status === 'leveret').length;
    assert.equal(r(CHEF)[lev], leveretIalt, 'Chefen leverede alle leverede ordrer');
  });

  it('kunder og ikke-logget-ind får 401/403', async () => {
    const k = kunder[SØREN].b;
    const r1 = await k.get('/api/admin/eksport.xlsx');
    assert.ok(r1.status === 401 || r1.status === 403, `Kunde fik ${r1.status}`);
    assert.ok(!r1.buffer.subarray(0, 2).equals(Buffer.from('PK')), 'Kunden må ikke få filen');
    const r2 = await server.browser().get('/api/admin/eksport.xlsx');
    assert.equal(r2.status, 401);
    // Tillæg 3: en ekspedient må heller ikke hente regnearket.
    const r3 = await e.get('/api/admin/eksport.xlsx');
    assert.equal(r3.status, 403);
    assert.equal(r3.data && r3.data.kode, 'kraever_admin');
  });
});

describe('Regneark uden salg', () => {
  let server;
  before(async () => {
    server = await startServer();
  });
  after(async () => {
    if (server) await server.stop();
  });

  it('en tom butik giver også et gyldigt regneark med alle faner og nul i Oversigt', async () => {
    const p = server.browser();
    ok(await p.post('/api/personale/opsaet', { navn: 'Tom', kode: 'eksport-tom-1' }));
    const r = await p.get('/api/admin/eksport.xlsx');
    assert.equal(r.status, 200);
    const bog = laesXlsx(r.buffer);
    assert.deepEqual(bog.ark.map((a) => a.navn), [...FANER, 'Personale']);
    const o = bog.ark[0];
    naer(vaerdiEfter(o, /omsætning/i).v, 0, 'Omsætning');
    assert.equal(String(vaerdiEfter(o, /regnskabet går op/i).v), 'Ja');
  });
});
