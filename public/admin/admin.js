// Admin: check-in, varer, deltagere, indbetalinger, udbetaling, personale, indstillinger og rapport
import { api, kr, tilOere, oereTilFelt, esc, datoTid, sand, besked, bekraeft, kraevLogin, brugerBjaelke, rolleNavn, liveForbindelse } from '/admin/faelles.js';

const $ = (s, rod = document) => rod.querySelector(s);
const FANER = ['checkin', 'varer', 'deltagere', 'indbetalinger', 'udbetaling', 'indstillinger', 'personale', 'rapport'];
const EKSPEDIENT_FANER = ['checkin', 'deltagere', 'indbetalinger'];
const BILLEDTYPER = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml'];
const MAKS_BILLEDE = 3 * 1024 * 1024;
let aktivFane = null;
let mig = null; // den indloggede { id, navn, rolle }
const erAdmin = () => mig?.rolle === 'admin';
const maaSe = (fane) => erAdmin() || EKSPEDIENT_FANER.includes(fane);

// Luk-knapper i dialoger
document.querySelectorAll('dialog [value=fortryd]').forEach((k) => k.addEventListener('click', () => k.closest('dialog').close()));

// ---------- Faner (kun dem rollen må) ----------
function visFane() {
  const oensket = location.hash.slice(1);
  const navn = FANER.includes(oensket) && maaSe(oensket) ? oensket : 'checkin';
  aktivFane = navn;
  for (const f of FANER) {
    $(`#fane-${f}`).hidden = f !== navn;
    const fane = $(`[data-fane=${f}]`);
    fane.hidden = !maaSe(f);
    fane.setAttribute('aria-selected', String(f === navn));
  }
  visAktivFane();
  ({ checkin: visCheckin, udbetaling: hentUdbetalinger, varer: hentVarer, deltagere: soegDeltagere, indbetalinger: hentIndbetalinger,
    indstillinger: hentIndstillinger, personale: hentPersonale, rapport: hentRapport })[navn]();
}
addEventListener('hashchange', visFane);

// Fanerækken kan rulle vandret på smalle skærme: fade i den kant, hvor der er flere faner
const fanerEl = $('.faner');
function fanerKanter() {
  const max = fanerEl.scrollWidth - fanerEl.clientWidth;
  fanerEl.classList.toggle('kan-venstre', fanerEl.scrollLeft > 2);
  fanerEl.classList.toggle('kan-hoejre', fanerEl.scrollLeft < max - 2);
}
fanerEl.addEventListener('scroll', fanerKanter, { passive: true });
addEventListener('resize', visAktivFane);
// Den aktive fane rulles helt frem – også forbi fade-kanten (56px i admin.css)
const FADE = 56;
function visAktivFane() {
  const a = $('.fane[aria-selected="true"]');
  const max = fanerEl.scrollWidth - fanerEl.clientWidth;
  if (a && max > 0) {
    const fr = fanerEl.getBoundingClientRect(), ar = a.getBoundingClientRect();
    const venstre = ar.left - fr.left + fanerEl.scrollLeft, hoejre = venstre + ar.width;
    let ny = fanerEl.scrollLeft;
    if (hoejre > ny + fanerEl.clientWidth - FADE) ny = hoejre - fanerEl.clientWidth + FADE;
    if (venstre < ny + FADE) ny = venstre - FADE;
    fanerEl.scrollLeft = Math.max(0, Math.min(max, ny));
  }
  fanerKanter();
}
// Fanernes bredde ændrer sig efter første visning (skrifttype, badge, faner der skjules for ekspedienter)
const fanerObs = new ResizeObserver(visAktivFane);
fanerObs.observe(fanerEl);
document.querySelectorAll('.fane').forEach((f) => fanerObs.observe(f));

// ================= VARER (katalog) =================
let varer = [];
let kategorier = [];
let vareFilter = 'alle';
const UDEN_KATEGORI = 'Uden kategori';
const skiftNr = new Map(); // vare-id → nyeste ændring, så et gammelt fejlsvar ikke overskriver en nyere

async function hentVarer() {
  try {
    const [v, k] = await Promise.all([api('/api/admin/varer'), api('/api/admin/kategorier').catch(() => [])]);
    varer = v || [];
    kategorier = Array.isArray(k) ? k : [];
    tegnVarer();
  } catch (err) { besked(err.message, true); }
}

// Kategorier i katalogets rækkefølge, derefter egne
function kategoriListe() {
  const liste = [...kategorier];
  for (const v of varer) {
    const k = v.kategori || UDEN_KATEGORI;
    if (!liste.includes(k)) liste.push(k);
  }
  return liste;
}

function vareSynlig(v) {
  if (vareFilter === 'saelges' && !sand(v.aktiv)) return false;
  if (vareFilter === 'ikke' && sand(v.aktiv)) return false;
  const q = $('#vare-soeg').value.trim().toLowerCase();
  if (!q) return true;
  return `${v.navn} ${v.kategori || ''} ${v.beskrivelse || ''}`.toLowerCase().includes(q);
}

function vareHtml(v) {
  const s = sand(v.aktiv);
  return `<div class="vare ${s ? 'saelges' : 'ikke-saelges'}" data-id="${v.id}">
      <label class="saelges-felt" title="Sælges">
        <input type="checkbox" data-saelg ${s ? 'checked' : ''} aria-label="${esc(v.navn)} sælges">
        <span class="flueben" aria-hidden="true"></span><span class="saelges-tekst">Sælges</span></label>
      ${v.billede_url ? `<img class="vare-billede" src="${esc(v.billede_url)}" alt="" loading="lazy">` : '<div class="vare-billede">Intet billede</div>'}
      <div class="vare-info">
        <div class="vare-navn">${esc(v.navn)}${sand(v.udsolgt) ? '<span class="maerkat roed">UDSOLGT</span>' : ''}</div>
        ${v.beskrivelse ? `<div class="vare-meta">${esc(v.beskrivelse)}</div>` : ''}
      </div>
      <div class="vare-pris">${kr(v.pris_oere)}</div>
      <div class="vare-knapper">
        <button class="knap lille" data-v="ret">Ret</button>
        <button class="knap lille" data-v="udsolgt">${sand(v.udsolgt) ? 'På lager' : 'Udsolgt'}</button>
      </div>
    </div>`;
}

function tegnVarer() {
  const sorter = (a, b) => (a.sortering ?? 0) - (b.sortering ?? 0) || String(a.navn).localeCompare(b.navn, 'da');
  const html = kategoriListe().map((k) => {
    const iKat = varer.filter((v) => (v.kategori || UDEN_KATEGORI) === k).sort(sorter);
    const vist = iKat.filter(vareSynlig);
    if (!vist.length) return '';
    return `<section class="kat" data-kat="${esc(k)}">
      <div class="kat-hoved">
        <h3>${esc(k)} <span class="kat-antal" data-kat-antal></span></h3>
        <div class="kat-knapper">
          <button class="knap lille" data-kat-saet="1">Vælg alle</button>
          <button class="knap lille" data-kat-saet="0">Fravælg alle</button>
        </div>
      </div>
      <div class="vare-gitter">${vist.map(vareHtml).join('')}</div>
    </section>`;
  }).join('');
  $('#vare-liste').innerHTML = html || `<p class="tom">${varer.length ? 'Ingen varer passer til søgningen.' : 'Ingen varer endnu.'}</p>`;
  $('#kategorier').innerHTML = kategoriListe().filter((k) => k !== UDEN_KATEGORI).map((k) => `<option value="${esc(k)}">`).join('');
  opdaterTaellere();
}

// Tællere øverst og pr. kategori – uden at tegne listen om
function opdaterTaellere() {
  const saelges = varer.filter((v) => sand(v.aktiv)).length;
  $('#vare-taeller').innerHTML = `<strong>${saelges}</strong> af ${varer.length} varer sælges`;
  for (const sek of document.querySelectorAll('.kat')) {
    const iKat = varer.filter((v) => (v.kategori || UDEN_KATEGORI) === sek.dataset.kat);
    $('[data-kat-antal]', sek).textContent = `${iKat.filter((v) => sand(v.aktiv)).length} af ${iKat.length} sælges`;
  }
}

function visSaelges(v) {
  const raekke = $(`.vare[data-id="${v.id}"]`);
  if (!raekke) return;
  const s = sand(v.aktiv);
  raekke.classList.toggle('saelges', s);
  raekke.classList.toggle('ikke-saelges', !s);
  $('[data-saelg]', raekke).checked = s;
}

// Sæt "sælges" for flere varer: vises med det samme, rulles tilbage ved fejl
async function saetSaelges(liste, aktiv) {
  const aendret = liste.filter((v) => sand(v.aktiv) !== aktiv);
  if (!aendret.length) return;
  const foer = new Map();
  for (const v of aendret) {
    foer.set(v, v.aktiv);
    skiftNr.set(v.id, (skiftNr.get(v.id) || 0) + 1);
    v.aktiv = aktiv ? 1 : 0;
    visSaelges(v);
  }
  const mine = new Map(aendret.map((v) => [v.id, skiftNr.get(v.id)]));
  opdaterTaellere();
  try {
    await api('/api/admin/varer/aktiv', { metode: 'POST', data: { ids: aendret.map((v) => v.id), aktiv } });
  } catch (err) {
    for (const v of aendret) {
      if (skiftNr.get(v.id) !== mine.get(v.id)) continue; // en nyere ændring vinder
      v.aktiv = foer.get(v);
      visSaelges(v);
    }
    opdaterTaellere();
    besked(`Kunne ikke gemme: ${err.message}`, true);
  }
}

$('#vare-soeg').addEventListener('input', tegnVarer);
document.querySelectorAll('[data-vfilter]').forEach((k) => k.addEventListener('click', () => {
  vareFilter = k.dataset.vfilter;
  document.querySelectorAll('[data-vfilter]').forEach((x) => {
    x.classList.toggle('aktiv', x === k);
    x.setAttribute('aria-pressed', String(x === k));
  });
  tegnVarer();
}));

$('#vare-liste').addEventListener('change', (e) => {
  if (!e.target.matches('[data-saelg]')) return;
  const v = varer.find((x) => x.id === Number(e.target.closest('.vare').dataset.id));
  if (v) saetSaelges([v], e.target.checked);
});

function vareData(v, aendring = {}) {
  return {
    navn: v.navn, beskrivelse: v.beskrivelse || '', kategori: v.kategori || '', pris_oere: v.pris_oere,
    aktiv: sand(v.aktiv) ? 1 : 0, udsolgt: sand(v.udsolgt) ? 1 : 0, sortering: Number(v.sortering) || 0, ...aendring,
  };
}

async function gemVare(v, aendring) {
  const svar = await api(`/api/admin/varer/${v.id}`, { metode: 'PUT', data: vareData(v, aendring) });
  Object.assign(v, svar && svar.id ? svar : aendring);
}

$('#vare-liste').addEventListener('click', async (e) => {
  // Vælg/fravælg alle (de viste) i en kategori
  const katKnap = e.target.closest('[data-kat-saet]');
  if (katKnap) {
    const sek = katKnap.closest('.kat');
    const ids = new Set([...sek.querySelectorAll('.vare')].map((r) => Number(r.dataset.id)));
    saetSaelges(varer.filter((v) => ids.has(v.id)), katKnap.dataset.katSaet === '1');
    return;
  }
  const knap = e.target.closest('[data-v]');
  if (!knap) return;
  const v = varer.find((x) => x.id === Number(knap.closest('.vare').dataset.id));
  if (!v) return;
  const h = knap.dataset.v;
  if (h === 'ret') return aabnVare(v);
  knap.disabled = true;
  try {
    if (h === 'udsolgt') await gemVare(v, { udsolgt: sand(v.udsolgt) ? 0 : 1 });
    tegnVarer();
  } catch (err) {
    besked(err.message, true);
    knap.disabled = false;
  }
});

// Træk billede direkte ind på en vare i listen
const vareListe = $('#vare-liste');
vareListe.addEventListener('dragover', (e) => {
  const raekke = e.target.closest('.vare');
  if (!raekke || !e.dataTransfer.types.includes('Files')) return;
  e.preventDefault();
  vareListe.querySelectorAll('.drop-over').forEach((r) => r !== raekke && r.classList.remove('drop-over'));
  raekke.classList.add('drop-over');
});
vareListe.addEventListener('dragleave', (e) => {
  const raekke = e.target.closest('.vare');
  if (raekke && !raekke.contains(e.relatedTarget)) raekke.classList.remove('drop-over');
});
vareListe.addEventListener('drop', async (e) => {
  const raekke = e.target.closest('.vare');
  if (!raekke) return;
  e.preventDefault();
  raekke.classList.remove('drop-over');
  const fil = e.dataTransfer.files[0];
  const v = varer.find((x) => x.id === Number(raekke.dataset.id));
  if (!fil || !v || !tjekBillede(fil)) return;
  try {
    await uploadBillede(v, fil);
    tegnVarer();
    besked(`Nyt billede på ${v.navn}.`);
  } catch (err) { besked(err.message, true); }
});

function tjekBillede(fil) {
  if (!BILLEDTYPER.includes(fil.type)) { besked('Filen skal være PNG, JPG, WebP, GIF eller SVG.', true); return false; }
  if (fil.size > MAKS_BILLEDE) { besked('Billedet må højst fylde 3 MB.', true); return false; }
  return true;
}

async function uploadBillede(v, fil) {
  const svar = await api(`/api/admin/varer/${v.id}/billede`, { metode: 'POST', raa: fil, type: fil.type });
  if (svar && svar.id) Object.assign(v, svar);
  else if (svar && svar.billede_url) v.billede_url = svar.billede_url;
  else await hentVarer();
  // Undgå gammelt billede i cachen
  if (v.billede_url && !v.billede_url.includes('?')) v.billede_url += `?v=${Date.now()}`;
}

// Vare-dialog
const vareDialog = $('#vare-dialog');
const vareForm = $('#vare-form');
let redigeret = null;
let ventendeFil = null;
let forhaandsUrl = null;

function aabnVare(v) {
  redigeret = v || null;
  ventendeFil = null;
  vareForm.reset();
  $('.fejl-tekst', vareForm).textContent = '';
  $('#vare-dialog-titel').textContent = v ? `Ret ${v.navn}` : 'Ny vare';
  const f = vareForm.elements;
  f.navn.value = v?.navn || '';
  f.beskrivelse.value = v?.beskrivelse || '';
  f.kategori.value = v?.kategori || '';
  f.pris.value = v ? oereTilFelt(v.pris_oere) : '';
  f.sortering.value = v?.sortering ?? (varer.reduce((m, x) => Math.max(m, Number(x.sortering) || 0), 0) + 10);
  f.aktiv.checked = v ? sand(v.aktiv) : true;
  f.udsolgt.checked = v ? sand(v.udsolgt) : false;
  visForhaand(v?.billede_url || null);
  vareDialog.showModal();
  f.navn.focus();
}
$('#ny-vare').addEventListener('click', () => aabnVare(null));

function visForhaand(url) {
  const img = $('#billede-vis');
  img.hidden = !url;
  if (url) img.src = url;
  $('#billede-tekst').innerHTML = url
    ? 'Træk et nyt billede hertil eller <u>vælg en fil</u>'
    : 'Træk et billede hertil eller <u>vælg en fil</u><br><small>PNG, JPG, WebP, GIF eller SVG – maks 3 MB</small>';
}

function vaelgFil(fil) {
  if (!fil || !tjekBillede(fil)) return;
  ventendeFil = fil;
  if (forhaandsUrl) URL.revokeObjectURL(forhaandsUrl);
  forhaandsUrl = URL.createObjectURL(fil);
  visForhaand(forhaandsUrl);
}
const drop = $('#billede-drop');
drop.addEventListener('click', () => $('#billede-fil').click());
drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#billede-fil').click(); } });
$('#billede-fil').addEventListener('change', (e) => { vaelgFil(e.target.files[0]); e.target.value = ''; });
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drop-over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('drop-over'));
drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('drop-over'); vaelgFil(e.dataTransfer.files[0]); });

vareForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = vareForm.elements;
  const fejl = $('.fejl-tekst', vareForm);
  const pris = tilOere(f.pris.value);
  if (!f.navn.value.trim()) { fejl.textContent = 'Skriv et navn.'; f.navn.focus(); return; }
  if (isNaN(pris) || pris < 0) { fejl.textContent = 'Skriv prisen i kroner, fx 12,50.'; f.pris.focus(); return; }
  const data = {
    navn: f.navn.value.trim(), beskrivelse: f.beskrivelse.value.trim(), kategori: f.kategori.value.trim(),
    pris_oere: pris, sortering: Math.round(Number(f.sortering.value) || 0),
    aktiv: f.aktiv.checked ? 1 : 0, udsolgt: f.udsolgt.checked ? 1 : 0,
  };
  const knap = $('[type=submit]', vareForm);
  knap.disabled = true;
  fejl.textContent = '';
  try {
    let v;
    if (redigeret) {
      v = await api(`/api/admin/varer/${redigeret.id}`, { metode: 'PUT', data });
      Object.assign(redigeret, v && v.id ? v : data);
      v = redigeret;
    } else {
      v = await api('/api/admin/varer', { metode: 'POST', data });
      varer.push(v);
    }
    if (ventendeFil) await uploadBillede(v, ventendeFil);
    vareDialog.close();
    tegnVarer();
    besked(`${v.navn} er gemt.`);
  } catch (err) {
    fejl.textContent = err.message;
  } finally {
    knap.disabled = false;
  }
});

// ================= DELTAGERE =================
let deltagere = [];
let valgtDeltager = null;
let soegTimer = null;
let soegNr = 0;
let vaelgPc = null; // PC der skal vælges, når søgningen svarer

$('#deltager-soeg').addEventListener('input', () => {
  clearTimeout(soegTimer);
  soegTimer = setTimeout(soegDeltagere, 200);
});

async function soegDeltagere() {
  const nr = ++soegNr;
  const q = $('#deltager-soeg').value.trim();
  try {
    const svar = await api(`/api/admin/deltagere?q=${encodeURIComponent(q)}`);
    if (nr !== soegNr) return; // et nyere søgesvar er på vej
    deltagere = (svar || []).sort((a, b) => a.pc_nr - b.pc_nr);
    if (vaelgPc) {
      valgtDeltager = deltagere.find((x) => x.pc_nr === vaelgPc) || null;
      vaelgPc = null;
      tegnDetalje();
    }
    tegnDeltagere();
  } catch (err) { besked(err.message, true); }
}

function tegnDeltagere() {
  $('#deltager-liste').innerHTML = deltagere.map((d) => `
    <button class="knap deltager ${valgtDeltager?.id === d.id ? 'valgt' : ''}" data-id="${d.id}">
      <span class="pc">PC ${esc(d.pc_nr)}</span><span class="navn">${esc(d.navn)}</span><span class="tal">${kr(d.saldo_oere)}</span>
    </button>`).join('') || '<p class="tom">Ingen deltagere fundet.</p>';
}

$('#deltager-liste').addEventListener('click', (e) => {
  const k = e.target.closest('.deltager');
  if (!k) return;
  valgtDeltager = deltagere.find((d) => d.id === Number(k.dataset.id));
  tegnDeltagere();
  tegnDetalje();
  if (matchMedia('(max-width: 800px)').matches) $('#deltager-detalje').scrollIntoView({ behavior: 'smooth' });
});

async function tegnDetalje() {
  const d = valgtDeltager;
  const boks = $('#deltager-detalje');
  boks.hidden = !d;
  if (!d) return;
  boks.innerHTML = `
    <h3>PC ${esc(d.pc_nr)} · ${esc(d.navn)}</h3>
    <div class="saldo-stor">${kr(d.saldo_oere)}</div>
    <form class="formrad" data-f="navn" novalidate>
      <label class="felt"><span>Navn</span><input name="navn" value="${esc(d.navn)}" maxlength="40" required></label>
      <button class="knap">Gem navn</button>
    </form>
    <form class="formrad" data-f="pin" novalidate>
      <label class="felt"><span>Ny PIN</span><input name="pin" inputmode="numeric" maxlength="6" autocomplete="off" placeholder="Tom = tilfældig"></label>
      <button class="knap">Nulstil PIN</button>
    </form>
    <div class="ny-pin" id="ny-pin" hidden></div>
    <div class="detalje-afsnit" ${erAdmin() ? '' : 'hidden'}>
      <h4>Justér saldo</h4>
      <form data-f="saldo" novalidate>
        <div class="to-felter">
          <label class="felt"><span>Beløb (kr.)</span><input name="beloeb" inputmode="decimal" placeholder="fx 50 eller -20"></label>
          <label class="felt"><span>Tekst</span><input name="tekst" maxlength="80" placeholder="fx kontant ved disken" required></label>
        </div>
        <div class="knaprad"><button class="knap groen" data-fortegn="1">+ Læg til</button><button class="knap fare" data-fortegn="-1">– Træk fra</button></div>
      </form>
    </div>
    <div class="detalje-afsnit">
      <h4>Kontoudtog</h4>
      <div id="kontoudtog"><p class="tom">Henter…</p></div>
    </div>`;
  hentKontoudtog(d);
}

async function hentKontoudtog(d) {
  try {
    const liste = (await api(`/api/admin/deltagere/${d.id}/bevaegelser`)) || [];
    if (valgtDeltager?.id !== d.id) return;
    liste.sort((a, b) => String(b.oprettet).localeCompare(String(a.oprettet)) || b.id - a.id);
    const typer = { indbetaling: 'Indbetaling', koeb: 'Køb', refusion: 'Refusion', justering: 'Justering', udbetaling: 'Udbetaling' };
    $('#kontoudtog').innerHTML = liste.length ? `<div class="tabel-ramme"><table class="tabel">
      <thead><tr><th>Tid</th><th>Type</th><th>Tekst</th><th>Af</th><th class="tal">Beløb</th></tr></thead><tbody>
      ${liste.map((b) => `<tr><td>${datoTid(b.oprettet)}</td><td>${esc(typer[b.type] || b.type)}</td>
        <td>${esc(b.tekst || (b.ordre_id ? `Ordre #${b.ordre_id}` : ''))}</td><td>${esc(b.af || '')}</td>
        <td class="tal ${b.beloeb_oere < 0 ? 'minus' : 'plus'}">${b.beloeb_oere > 0 ? '+' : ''}${kr(b.beloeb_oere)}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="tom">Ingen bevægelser endnu.</p>';
  } catch (err) {
    $('#kontoudtog').innerHTML = `<p class="fejl-tekst">${esc(err.message)}</p>`;
  }
}

function opdaterDeltager(svar, aendring) {
  Object.assign(valgtDeltager, svar && svar.id ? svar : aendring);
  tegnDeltagere();
  tegnDetalje();
}

$('#deltager-detalje').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const d = valgtDeltager;
  const knap = e.submitter || $('button', form);
  const type = form.dataset.f;
  try {
    if (type === 'navn') {
      const navn = form.navn.value.trim();
      if (!navn) return besked('Skriv et navn.', true);
      knap.disabled = true;
      opdaterDeltager(await api(`/api/admin/deltagere/${d.id}`, { metode: 'PUT', data: { navn } }), { navn });
      besked('Navnet er gemt.');
    } else if (type === 'pin') {
      const pin = form.pin.value.trim();
      if (pin && !/^\d{4,6}$/.test(pin)) return besked('PIN skal være 4–6 cifre – eller lad feltet stå tomt for en tilfældig.', true);
      if (!(await bekraeft(`Nulstil PIN for PC ${d.pc_nr}?`, 'Den gamle PIN holder op med at virke. Den nye vises kun nu.', 'Nulstil PIN', false))) return;
      knap.disabled = true;
      const svar = await api(`/api/admin/deltagere/${d.id}`, { metode: 'PUT', data: pin ? { pin } : { nulstil_pin: true } });
      form.reset();
      // Den nye PIN vises kun her, én gang
      const nyPin = svar?.pin || pin;
      const boks = $('#ny-pin');
      boks.hidden = false;
      boks.innerHTML = nyPin
        ? `Ny PIN til PC ${esc(d.pc_nr)}: <strong>${esc(nyPin)}</strong><span class="hjaelp">Giv den til deltageren nu – den vises ikke igen.</span>`
        : 'PIN er nulstillet, men serveren sendte ikke den nye PIN med.';
    } else if (type === 'saldo') {
      const beloeb = Math.abs(tilOere(form.beloeb.value)) * Number(knap.dataset.fortegn || 1);
      const tekst = form.tekst.value.trim();
      if (!beloeb) return besked('Skriv et beløb i kroner.', true);
      if (!tekst) return besked('Skriv en tekst, så det kan ses i kontoudtoget.', true);
      if (d.saldo_oere + beloeb < 0) return besked(`Saldoen må ikke blive negativ (den er ${kr(d.saldo_oere)}).`, true);
      knap.disabled = true;
      const svar = await api(`/api/admin/deltagere/${d.id}/saldo`, { metode: 'POST', data: { beloeb_oere: beloeb, tekst } });
      opdaterDeltager(svar, { saldo_oere: d.saldo_oere + beloeb });
      besked(`${beloeb > 0 ? 'Lagt til' : 'Trukket fra'}: ${kr(Math.abs(beloeb))}`);
    }
  } catch (err) {
    besked(err.message, true);
  } finally {
    knap.disabled = false;
  }
});

// Vis en bestemt deltager under Deltagere (bruges fra check-in)
function visDeltager(pc) {
  vaelgPc = Number(pc);
  $('#deltager-soeg').value = String(pc);
  if (location.hash !== '#deltagere') location.hash = '#deltagere'; // fanen søger selv
  else soegDeltagere();
}

// ================= CHECK-IN =================
const ciForm = $('#checkin-form');
const ciAdvarsel = $('#checkin-advarsel');
let ciTjekTimer = null;
let ciTjekNr = 0;
let traefNavn = 'Træf-butikken';
let kundeAdresse = /^(localhost|127\.|\[::1\])/.test(location.hostname) ? '' : location.host; // localhost duer ikke for deltagerne

function visCheckin() {
  if ($('#kvittering').hidden) setTimeout(() => ciForm.pc_nr.focus(), 0);
}

function markerStart() {
  const v = tilOere(ciForm.start.value || '0');
  document.querySelectorAll('[data-start]').forEach((k) => k.classList.toggle('aktiv', Number(k.dataset.start) * 100 === v));
}
document.querySelectorAll('[data-start]').forEach((k) => k.addEventListener('click', () => {
  ciForm.start.value = k.dataset.start;
  markerStart();
}));
ciForm.start.addEventListener('input', markerStart);
markerStart();

// Advar med det samme, hvis PC-nr allerede er oprettet
function visOptaget(d) {
  ciAdvarsel.hidden = !d;
  if (d) ciAdvarsel.innerHTML = `⚠ PC ${esc(d.pc_nr)} findes allerede (${esc(d.navn)}, saldo ${kr(d.saldo_oere)}).
    <a href="#deltagere" data-vis-pc="${esc(d.pc_nr)}">Vis deltageren</a>`;
}
ciAdvarsel.addEventListener('click', (e) => {
  const a = e.target.closest('[data-vis-pc]');
  if (!a) return;
  e.preventDefault();
  visDeltager(a.dataset.visPc);
});
ciForm.pc_nr.addEventListener('input', () => {
  clearTimeout(ciTjekTimer);
  const pc = Number(ciForm.pc_nr.value.trim());
  if (!Number.isInteger(pc) || pc < 1) { visOptaget(null); return; }
  ciTjekTimer = setTimeout(async () => {
    const nr = ++ciTjekNr;
    try {
      const liste = await api(`/api/admin/deltagere?q=${pc}`);
      if (nr === ciTjekNr) visOptaget((liste || []).find((d) => d.pc_nr === pc) || null);
    } catch { /* tjekkes igen ved oprettelse */ }
  }, 250);
});

ciForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fejl = $('.fejl-tekst', ciForm);
  const pc = Number(ciForm.pc_nr.value.trim());
  const navn = ciForm.navn.value.trim();
  const start = tilOere(ciForm.start.value || '0');
  const metode = ciForm.metode.value;
  fejl.textContent = '';
  if (!Number.isInteger(pc) || pc < 1 || pc > 9999) { fejl.textContent = 'PC-nr skal være et tal fra 1 til 9999.'; ciForm.pc_nr.focus(); return; }
  if (!navn) { fejl.textContent = 'Skriv deltagerens navn.'; ciForm.navn.focus(); return; }
  if (isNaN(start) || start < 0) { fejl.textContent = 'Startbeløbet skal være i kroner, fx 200.'; ciForm.start.focus(); return; }
  const knap = $('[type=submit]', ciForm);
  knap.disabled = true;
  try {
    const data = { pc_nr: pc, navn };
    if (start > 0) Object.assign(data, { startbeloeb_oere: start, metode });
    const d = await api('/api/admin/deltagere', { metode: 'POST', data });
    visKvittering({ pc_nr: d?.pc_nr ?? pc, navn: d?.navn ?? navn, pin: d?.pin, saldo_oere: d?.saldo_oere ?? start });
  } catch (err) {
    fejl.textContent = err.message;
    if (err.kode === 'pc_optaget') {
      ciForm.pc_nr.dispatchEvent(new Event('input'));
      ciForm.pc_nr.select();
    }
  } finally {
    knap.disabled = false;
  }
});

function visKvittering(d) {
  ciForm.hidden = true;
  const k = $('#kvittering');
  $('#seddel').innerHTML = `
    <div class="seddel-traef">${esc(traefNavn)}</div>
    <div class="seddel-linje"><span>PC</span><strong>${esc(d.pc_nr)}</strong></div>
    <div class="seddel-navn">${esc(d.navn)}</div>
    <div class="seddel-pin"><span>PIN</span><strong>${esc(d.pin || '????')}</strong></div>
    <div class="seddel-linje"><span>Saldo</span><strong>${kr(d.saldo_oere)}</strong></div>
    <div class="seddel-adr">${kundeAdresse ? `Bestil på <strong>${esc(kundeAdresse)}</strong><br>` : ''}Log ind med PC-nr og PIN.</div>`;
  k.hidden = false;
  $('#naeste-deltager').focus();
}

function naesteDeltager() {
  $('#kvittering').hidden = true;
  ciForm.hidden = false;
  const metode = ciForm.metode.value; // samme betalingsmåde som sidst er det mest sandsynlige
  ciForm.reset();
  ciForm.metode.value = metode;
  visOptaget(null);
  markerStart();
  ciForm.pc_nr.focus();
}
$('#naeste-deltager').addEventListener('click', naesteDeltager);
$('#udskriv').addEventListener('click', () => window.print());
// Enter på kvitteringen = næste deltager
$('#kvittering').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.id !== 'udskriv') { e.preventDefault(); naesteDeltager(); }
});

// ================= UDBETALING =================
let udbMangler = [];

async function hentUdbetalinger() {
  try {
    const svar = await api('/api/admin/udbetalinger');
    udbMangler = (svar?.mangler || []).filter((d) => d.saldo_oere > 0).sort((a, b) => a.pc_nr - b.pc_nr);
    const udbetalt = (svar?.udbetalt || []).slice().sort((a, b) => String(b.oprettet).localeCompare(String(a.oprettet)));
    const tilbage = udbMangler.reduce((s, d) => s + d.saldo_oere, 0);
    const iAlt = udbetalt.reduce((s, u) => s + u.beloeb_oere, 0);
    $('#udb-tal').innerHTML = `
      <div class="magenta"><span>Tilbage hos ${udbMangler.length} deltagere</span><strong>${kr(tilbage)}</strong></div>
      <div class="groen"><span>Udbetalt til ${udbetalt.length}</span><strong>${kr(iAlt)}</strong></div>`;
    tegnUdbMangler();
    $('#udb-historik tbody').innerHTML = udbetalt.map((u) => `<tr>
      <td>${datoTid(u.oprettet)}</td><td>${esc(u.pc_nr)}</td><td>${esc(u.navn)}</td><td class="tal">${kr(u.beloeb_oere)}</td>
      <td>${esc(metodeNavn(u.metode))}</td><td>${esc(u.reference || '')}</td><td>${esc(u.udfoert_af || '')}</td></tr>`).join('')
      || '<tr><td colspan="7" class="tom">Intet udbetalt endnu.</td></tr>';
  } catch (err) { besked(err.message, true); }
}
$('#udb-opdater').addEventListener('click', hentUdbetalinger);
$('#udb-soeg').addEventListener('input', tegnUdbMangler);

function tegnUdbMangler() {
  const q = $('#udb-soeg').value.trim().toLowerCase();
  const liste = udbMangler.filter((d) => !q || String(d.pc_nr).startsWith(q) || String(d.navn).toLowerCase().includes(q));
  $('#udb-mangler').innerHTML = liste.map((d) => `
    <form class="udb-raekke" data-id="${d.id}" novalidate>
      <div class="udb-hvem"><span class="pc">PC ${esc(d.pc_nr)}</span> <span class="navn">${esc(d.navn)}</span></div>
      <div class="udb-beloeb">${kr(d.saldo_oere)}</div>
      <label class="udb-metode"><span class="skjult-visuelt">Metode</span>
        <select name="metode"><option value="mobilepay">MobilePay</option><option value="kontant">Kontant</option><option value="andet">Andet</option></select></label>
      <label class="udb-ref"><span class="skjult-visuelt">Reference</span>
        <input name="reference" maxlength="80" placeholder="fx MobilePay til 12345678"></label>
      <button class="knap groen">Udbetalt</button>
    </form>`).join('') || `<p class="tom">${udbMangler.length ? 'Ingen der passer til søgningen.' : 'Ingen deltagere har penge tilbage. 🎉'}</p>`;
}

$('#udb-mangler').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const d = udbMangler.find((x) => x.id === Number(form.dataset.id));
  if (!d) return;
  const metode = form.metode.value;
  const reference = form.reference.value.trim();
  if (!(await bekraeft(`Udbetal ${kr(d.saldo_oere)} til PC ${d.pc_nr}?`,
    `${d.navn} får hele restsaldoen udbetalt (${metodeNavn(metode)}${reference ? ', ' + reference : ''}). Saldoen bliver 0 kr.`, 'Ja, udbetalt', false))) return;
  const knap = $('button', form);
  knap.disabled = true;
  try {
    await api(`/api/admin/deltagere/${d.id}/udbetal`, { metode: 'POST', data: { metode, reference } });
    besked(`${kr(d.saldo_oere)} udbetalt til PC ${d.pc_nr}.`);
    await hentUdbetalinger();
  } catch (err) {
    besked(err.message, true);
    knap.disabled = false;
    if (err.kode === 'ingen_saldo') hentUdbetalinger();
  }
});

// ================= INDBETALINGER =================
const metodeNavn = (m) => ({ mobilepay: 'MobilePay', kontant: 'Kontant', andet: 'Andet' }[m] || m || '');
const statusNavn = (s) => ({ afventer: 'Afventer', godkendt: 'Godkendt', afvist: 'Afvist' }[s] || s);

function visBadge(n) {
  const b = $('#indb-badge');
  b.textContent = n;
  b.hidden = !n;
}

async function hentIndbetalinger() {
  try {
    const [afventer, alle] = await Promise.all([
      api('/api/admin/indbetalinger?status=afventer'),
      aktivFane === 'indbetalinger' ? api('/api/admin/indbetalinger') : null,
    ]);
    visBadge(afventer.length);
    if (aktivFane !== 'indbetalinger') return;
    afventer.sort((a, b) => a.id - b.id);
    $('#indb-afventer').innerHTML = afventer.map((i) => `
      <div class="indb-kort" data-id="${i.id}">
        <div><div class="hoved">PC ${esc(i.pc_nr)} · ${esc(i.navn)} <span class="beloeb">${kr(i.beloeb_oere)}</span></div>
          <div class="info">${esc(metodeNavn(i.metode))} · reference: <strong>${esc(i.reference || '–')}</strong> · ${datoTid(i.oprettet)}</div></div>
        <div class="knapper"><button class="knap groen" data-indb="godkend">Godkend</button><button class="knap fare" data-indb="afvis">Afvis</button></div>
      </div>`).join('') || '<p class="tom">Ingen afventende indbetalinger.</p>';
    const historik = (alle || []).filter((i) => i.status !== 'afventer')
      .sort((a, b) => String(b.behandlet || b.oprettet).localeCompare(String(a.behandlet || a.oprettet)));
    $('#indb-historik tbody').innerHTML = historik.map((i) => `<tr>
      <td>${datoTid(i.behandlet || i.oprettet)}</td><td>${esc(i.pc_nr)}</td><td>${esc(i.navn)}</td>
      <td class="tal">${kr(i.beloeb_oere)}</td><td>${esc(metodeNavn(i.metode))}</td><td>${esc(i.reference || '')}</td>
      <td class="status ${esc(i.status)}">${esc(statusNavn(i.status))}</td><td>${esc(i.behandlet_af || '')}</td></tr>`).join('')
      || '<tr><td colspan="8" class="tom">Ingen behandlede indbetalinger endnu.</td></tr>';
  } catch (err) { besked(err.message, true); }
}
$('#indb-opdater').addEventListener('click', hentIndbetalinger);

$('#indb-afventer').addEventListener('click', async (e) => {
  const knap = e.target.closest('[data-indb]');
  if (!knap) return;
  const kort = knap.closest('.indb-kort');
  const h = knap.dataset.indb;
  if (h === 'afvis' && !(await bekraeft('Afvis indbetaling?', 'Beløbet bliver ikke sat ind på deltagerens saldo.', 'Afvis'))) return;
  knap.disabled = true;
  try {
    await api(`/api/admin/indbetalinger/${kort.dataset.id}/${h}`, { metode: 'POST' });
    besked(h === 'godkend' ? 'Indbetalingen er godkendt og sat ind.' : 'Indbetalingen er afvist.');
    hentIndbetalinger();
  } catch (err) {
    besked(err.message, true);
    knap.disabled = false;
  }
});

// ================= INDSTILLINGER =================
const indForm = $('#indstillinger-form');
async function hentIndstillinger() {
  try {
    const s = await api('/api/admin/indstillinger');
    const f = indForm.elements;
    f.traef_navn.value = s.traef_navn ?? '';
    f.butik_aaben.checked = sand(s.butik_aaben);
    f.tilmelding_aaben.checked = sand(s.tilmelding_aaben);
    f.levering_aktiv.checked = sand(s.levering_aktiv);
    f.levering_min.value = oereTilFelt(s.levering_min_oere ?? 0);
    f.mobilepay_nr.value = s.mobilepay_nr ?? '';
    $('.fejl-tekst', indForm).textContent = '';
  } catch (err) { besked(err.message, true); }
}
indForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = indForm.elements;
  const fejl = $('.fejl-tekst', indForm);
  const min = tilOere(f.levering_min.value || '0');
  if (!f.traef_navn.value.trim()) { fejl.textContent = 'Træffet skal have et navn.'; return; }
  if (isNaN(min) || min < 0) { fejl.textContent = 'Skriv "levering fra" i kroner, fx 100.'; return; }
  const data = {
    traef_navn: f.traef_navn.value.trim(),
    butik_aaben: f.butik_aaben.checked ? 1 : 0,
    tilmelding_aaben: f.tilmelding_aaben.checked ? 1 : 0,
    levering_aktiv: f.levering_aktiv.checked ? 1 : 0,
    levering_min_oere: min,
    mobilepay_nr: f.mobilepay_nr.value.trim(),
  };
  fejl.textContent = '';
  try {
    await api('/api/admin/indstillinger', { metode: 'PUT', data });
    traefNavn = data.traef_navn;
    $('#traef-navn').textContent = data.traef_navn;
    besked('Indstillingerne er gemt.');
  } catch (err) { fejl.textContent = err.message; }
});

// ================= RAPPORT =================
async function hentRapport() {
  try {
    const r = await api('/api/admin/rapport');
    const pr = (r.pr_vare || []).slice().sort((a, b) => b.beloeb_oere - a.beloeb_oere);
    const maks = Math.max(1, ...pr.map((v) => v.beloeb_oere));
    $('#rapport').innerHTML = `
      <div class="noegletal">
        <div class="cyan"><span>Omsætning</span><strong>${kr(r.omsaetning_oere)}</strong></div>
        <div><span>Antal ordrer</span><strong>${(r.antal_ordrer ?? 0).toLocaleString('da-DK')}</strong></div>
        <div class="groen"><span>Indbetalt i alt</span><strong>${kr(r.indbetalt_oere)}</strong></div>
        <div><span>Udbetalt i alt</span><strong>${kr(r.udbetalt_oere)}</strong></div>
        <div class="magenta"><span>Samlet saldo hos deltagerne</span><strong>${kr(r.samlet_saldo_oere)}</strong></div>
      </div>
      ${regnskab(r)}
      <h3 class="afsnit">Salg pr. vare</h3>
      <div class="tabel-ramme"><table class="tabel">
        <thead><tr><th>Vare</th><th class="tal">Antal</th><th class="tal">Beløb</th><th class="bjaelke-celle"><span class="skjult-visuelt">Andel</span></th></tr></thead>
        <tbody>${pr.map((v) => `<tr><td>${esc(v.navn)}</td><td class="tal">${v.antal}</td><td class="tal">${kr(v.beloeb_oere)}</td>
          <td class="bjaelke-celle"><div class="bjaelke" style="width:${(v.beloeb_oere / maks * 100).toFixed(1)}%"></div></td></tr>`).join('')
          || '<tr><td colspan="4" class="tom">Intet solgt endnu.</td></tr>'}</tbody>
      </table></div>`;
  } catch (err) { besked(err.message, true); }
}
$('#rapport-opdater').addEventListener('click', hentRapport);

// Hent salget som regneark. Hentes med fetch, så en fejl vises som besked i stedet for at blive gemt som fil.
async function hentRegneark(knap) {
  const tekst = knap.textContent;
  knap.disabled = true;
  knap.textContent = 'Laver regnearket…';
  try {
    const svar = await fetch('/api/admin/eksport.xlsx', { credentials: 'same-origin' });
    if (svar.status === 401) return location.reload();
    if (!svar.ok) {
      const j = await svar.json().catch(() => null);
      throw new Error(j?.fejl || `Serverfejl (${svar.status}).`);
    }
    const blob = await svar.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filnavn(svar.headers.get('Content-Disposition'));
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    besked('Regnearket er hentet – se under Overførsler.');
  } catch (err) {
    besked(err.message === 'Failed to fetch' ? 'Ingen forbindelse til serveren.' : err.message, true);
  } finally {
    knap.disabled = false;
    knap.textContent = tekst;
  }
}

// Filnavn fra Content-Disposition (filename*=UTF-8''… eller filename="…")
function filnavn(cd) {
  const utf = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(cd || '');
  if (utf) { try { return decodeURIComponent(utf[1].trim().replace(/^"|"$/g, '')); } catch { /* brug næste */ } }
  const alm = /filename\s*=\s*"?([^";]+)"?/i.exec(cd || '');
  return alm ? alm[1].trim() : `salg-${new Date().toISOString().slice(0, 10)}.xlsx`;
}
document.querySelectorAll('[data-eksport]').forEach((k) => k.addEventListener('click', () => hentRegneark(k)));

// Indbetalt = omsætning + udbetalt + samlet saldo
function regnskab(r) {
  const ind = r.indbetalt_oere || 0;
  const ud = (r.omsaetning_oere || 0) + (r.udbetalt_oere || 0) + (r.samlet_saldo_oere || 0);
  const ok = ind === ud;
  return `<p class="regnskab ${ok ? 'ok' : 'fejl'}">${ok ? '✔ Regnskabet går op' : '⚠ Regnskabet går ikke op'}:
    indbetalt ${kr(ind)} = omsætning ${kr(r.omsaetning_oere)} + udbetalt ${kr(r.udbetalt_oere)} + saldo ${kr(r.samlet_saldo_oere)}${ok ? '' : ` (forskel ${kr(ind - ud)})`}</p>`;
}

// ================= PERSONALE (kun admin) =================
let personale = [];
let redigeretPersonale = null;
const persDialog = $('#personale-dialog');
const persForm = $('#personale-form');

async function hentPersonale() {
  try {
    personale = (await api('/api/admin/personale')) || [];
    tegnPersonale();
  } catch (err) { besked(err.message, true); }
}

function tegnPersonale() {
  const liste = personale.slice().sort((a, b) => (sand(b.aktiv) - sand(a.aktiv)) || (a.rolle === b.rolle ? 0 : a.rolle === 'admin' ? -1 : 1)
    || String(a.navn).localeCompare(b.navn, 'da'));
  $('#personale-tabel tbody').innerHTML = liste.map((p) => `<tr data-id="${p.id}" class="${sand(p.aktiv) ? '' : 'spaerret'}">
      <td><strong>${esc(p.navn)}</strong>${p.id === mig.id ? ' <span class="maerkat graa">dig</span>' : ''}</td>
      <td><span class="rolle ${esc(p.rolle)}">${esc(rolleNavn(p.rolle))}</span></td>
      <td class="status ${sand(p.aktiv) ? 'godkendt' : 'afvist'}">${sand(p.aktiv) ? 'Aktiv' : 'Spærret'}</td>
      <td>${p.sidst_logget_ind ? datoTid(p.sidst_logget_ind) : '–'}</td>
      <td class="handlinger"><button class="knap lille" data-p="ret">Ret</button>${spaerKnap(p)}</td>
    </tr>`).join('') || '<tr><td colspan="5" class="tom">Ingen medarbejdere.</td></tr>';
}

// Den sidste aktive admin kan ikke spærres eller gøres til ekspedient
const SIDSTE_ADMIN = 'Der skal være mindst én aktiv admin. Gør en anden til admin først.';
function erSidsteAdmin(p) {
  return p.rolle === 'admin' && sand(p.aktiv) && personale.filter((x) => x.rolle === 'admin' && sand(x.aktiv)).length === 1;
}
function spaerKnap(p) {
  if (p.id === mig.id) return ''; // man spærrer ikke sig selv
  if (!sand(p.aktiv)) return '<button class="knap lille" data-p="aktiv">Genaktivér</button>';
  if (erSidsteAdmin(p)) return `<button class="knap lille" data-p="aktiv" aria-disabled="true" title="${esc(SIDSTE_ADMIN)}">Spær</button>`;
  return '<button class="knap lille fare" data-p="aktiv">Spær</button>';
}

function aabnPersonale(p) {
  redigeretPersonale = p || null;
  persForm.reset();
  $('.fejl-tekst', persForm).textContent = '';
  $('#personale-dialog-titel').textContent = p ? `Ret ${p.navn}` : 'Ny medarbejder';
  $('#kode-titel').textContent = p ? 'Ny kode' : 'Kode';
  $('#kode-hjaelp').textContent = p ? 'Lad stå tomt for at beholde koden. Ellers mindst 6 tegn.' : 'Mindst 6 tegn.';
  persForm.navn.value = p?.navn || '';
  persForm.rolle.value = p?.rolle || 'ekspedient';
  // Sidste aktive admin kan ikke gøres til ekspedient
  const laast = !!p && erSidsteAdmin(p);
  const eksp = persForm.querySelector('[name=rolle][value=ekspedient]');
  eksp.disabled = laast;
  eksp.closest('.valg').title = laast ? SIDSTE_ADMIN : '';
  $('#rolle-hjaelp').textContent = laast ? SIDSTE_ADMIN : '';
  $('#rolle-hjaelp').hidden = !laast;
  persDialog.showModal();
  persForm.navn.focus();
}
$('#ny-personale').addEventListener('click', () => aabnPersonale(null));

persForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fejl = $('.fejl-tekst', persForm);
  const navn = persForm.navn.value.trim();
  const rolle = persForm.rolle.value;
  const kode = persForm.kode.value;
  const p = redigeretPersonale;
  if (!navn) { fejl.textContent = 'Skriv et navn.'; return; }
  if ((!p || kode) && kode.length < 6) { fejl.textContent = 'Koden skal være mindst 6 tegn.'; return; }
  if (kode !== persForm.kode2.value) { fejl.textContent = 'De to koder er ikke ens.'; return; }
  const data = { navn, rolle };
  if (kode) data.kode = kode;
  const knap = $('[type=submit]', persForm);
  knap.disabled = true;
  fejl.textContent = '';
  try {
    if (p) await api(`/api/admin/personale/${p.id}`, { metode: 'PUT', data });
    else await api('/api/admin/personale', { metode: 'POST', data: { navn, rolle, kode } });
    persDialog.close();
    besked(p ? `${navn} er gemt.` : `${navn} er oprettet som ${rolleNavn(rolle)}.`);
    // Har man taget admin fra sig selv, skal siden vise ekspedient-fanerne
    if (p && p.id === mig.id && rolle !== mig.rolle) return location.reload();
    hentPersonale();
  } catch (err) {
    fejl.textContent = err.message;
  } finally {
    knap.disabled = false;
  }
});

$('#personale-tabel').addEventListener('click', async (e) => {
  const knap = e.target.closest('[data-p]');
  if (!knap) return;
  const p = personale.find((x) => x.id === Number(knap.closest('tr').dataset.id));
  if (!p) return;
  if (knap.dataset.p === 'ret') return aabnPersonale(p);
  if (knap.getAttribute('aria-disabled') === 'true') return besked(SIDSTE_ADMIN, true);
  const spaer = sand(p.aktiv);
  if (spaer && !(await bekraeft(`Spær ${p.navn}?`, `${p.navn} bliver logget ud med det samme og kan ikke logge ind, før kontoen genaktiveres.`, 'Spær'))) return;
  knap.disabled = true;
  try {
    await api(`/api/admin/personale/${p.id}`, { metode: 'PUT', data: { aktiv: !spaer } });
    besked(spaer ? `${p.navn} er spærret.` : `${p.navn} er genaktiveret.`);
    if (spaer && p.id === mig.id) return location.reload();
    hentPersonale();
  } catch (err) {
    besked(err.message, true);
    knap.disabled = false;
  }
});

// ================= START =================
mig = await kraevLogin('Admin');
brugerBjaelke(mig, $('#bruger'));
document.body.classList.toggle('er-admin', erAdmin());
api('/api/info').then((i) => {
  if (i?.traef_navn) { traefNavn = i.traef_navn; $('#traef-navn').textContent = i.traef_navn; }
  if (i?.kunde_url) kundeAdresse = String(i.kunde_url).replace(/^https?:\/\//, '').replace(/\/$/, '');
}).catch(() => {});
// Nyere version på GitHub? Serveren tjekker selv i baggrunden; uden internet sker der ingenting.
if (erAdmin()) {
  api('/api/admin/version').then((v) => {
    if (!v?.ny || !/^https:\/\/github\.com\//.test(v.ny.url || '')) return;
    const a = document.createElement('a');
    a.className = 'ny-version';
    a.href = v.ny.url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.title = `Du har v${v.version}. Den nye version kan installeres, næste gang start-butik.cmd startes.`;
    a.innerHTML = `<span class="lang">Ny version </span><b>v${esc(v.ny.version)}</b><span class="lang"> findes</span>`;
    $('.top-knapper').prepend(a);
  }).catch(() => {});
}
visFane();
if (aktivFane !== 'indbetalinger') hentIndbetalinger();
// Live: nye indbetalinger opdaterer badge og listen
liveForbindelse('/api/butik/stream', '/api/personale/mig', {
  indbetaling: () => hentIndbetalinger(),
}, null, null);
