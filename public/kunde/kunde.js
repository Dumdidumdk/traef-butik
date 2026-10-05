// Træf-butik – kundesiden
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const STATUS_TEKST = { ny: 'Modtaget', laves: 'Laves', klar: 'Klar', leveret: 'Leveret', annulleret: 'Annulleret' };
const INDB_TEKST = { afventer: 'Afventer godkendelse', godkendt: 'Godkendt', afvist: 'Afvist' };
const METODE_TEKST = { mobilepay: 'MobilePay', kontant: 'Kontant', andet: 'Andet' };
const AKTIVE = ['ny', 'laves', 'klar'];

const tilstand = {
  info: null,
  mig: null,
  varer: [],
  kurv: new Map(), // vare_id → antal
  levering: 'hent',
  ordrer: [],
  ordreStatus: new Map(), // id → senest kendte status
  indbetalinger: [],
  es: null,
  esForsoeg: 0,
  esTimer: null,
  vareTimer: null,
};

// ---------- Hjælpere ----------
function kr(oere) {
  const neg = oere < 0;
  const a = Math.abs(Math.round(oere));
  const hele = Math.floor(a / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const rest = a % 100;
  return (neg ? '−' : '') + hele + (rest ? ',' + String(rest).padStart(2, '0') : '') + ' kr.';
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function tid(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const t = d.toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' });
  const idag = new Date().toDateString() === d.toDateString();
  return idag ? 'kl. ' + t : d.toLocaleDateString('da-DK', { day: 'numeric', month: 'short' }) + ' kl. ' + t;
}
function lagerHent(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lagerGem(k, v) { try { localStorage.setItem(k, v); } catch { /* ignorer */ } }

class ApiFejl extends Error {
  constructor(status, data) {
    super((data && data.fejl) || 'Noget gik galt. Prøv igen.');
    this.status = status;
    this.kode = data && data.kode;
  }
}

async function api(sti, { metode = 'GET', data, logind = false } = {}) {
  let svar;
  try {
    svar = await fetch(sti, {
      method: metode,
      headers: data !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: data !== undefined ? JSON.stringify(data) : undefined,
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiFejl(0, { fejl: 'Kan ikke komme i kontakt med butikken. Tjek netværket.', kode: 'netvaerk' });
  }
  let json = null;
  const tekst = await svar.text();
  if (tekst) { try { json = JSON.parse(tekst); } catch { /* ikke JSON */ } }
  if (!svar.ok) {
    const fejl = new ApiFejl(svar.status, json);
    if (svar.status === 401 && !logind) { tilLogin('Du er blevet logget ud. Log ind igen.'); }
    throw fejl;
  }
  return json;
}

function toast(tekst, type = '') {
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' toast-' + type : '');
  el.textContent = tekst;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), type === 'fejl' ? 6000 : 4000);
}

// ---------- Info ----------
function visInfo() {
  const i = tilstand.info;
  if (!i) return;
  $$('[data-traef-navn]').forEach(el => { el.textContent = i.traef_navn || 'Træf-butikken'; });
  document.title = i.traef_navn || 'Træf-butikken';
  normalTitel = document.title;

  // Login-faner
  const aaben = !!Number(i.tilmelding_aaben);
  // Tilmelding lukket (standard): kun log ind, ingen faner
  $('#fane-ny').hidden = !aaben;
  $('.faner').hidden = !aaben;
  $('#tilmelding-lukket').hidden = aaben;
  if (!aaben && $('#fane-ny').getAttribute('aria-selected') === 'true') vaelgFane('login');

  // MobilePay
  const nr = $('#mobilepay-nr');
  if (i.mobilepay_nr) { nr.textContent = i.mobilepay_nr; nr.classList.remove('ingen'); }
  else { nr.textContent = 'Spørg i butikken'; nr.classList.add('ingen'); }

  $('#lukket-banner').hidden = !!Number(i.butik_aaben);
  visKurv();
}

// ---------- Login ----------
function vaelgFane(navn) {
  const login = navn === 'login';
  $('#fane-login').setAttribute('aria-selected', login);
  $('#fane-ny').setAttribute('aria-selected', !login);
  $('#fane-login').tabIndex = login ? 0 : -1;
  $('#fane-ny').tabIndex = login ? -1 : 0;
  $('#panel-login').hidden = !login;
  $('#panel-ny').hidden = login;
}

function initLogin() {
  $('#fane-login').addEventListener('click', () => vaelgFane('login'));
  $('#fane-ny').addEventListener('click', () => vaelgFane('ny'));
  $('.faner').addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    if ($('#fane-ny').hidden) return;
    const tilNy = $('#fane-login').getAttribute('aria-selected') === 'true';
    vaelgFane(tilNy ? 'ny' : 'login');
    (tilNy ? $('#fane-ny') : $('#fane-login')).focus();
  });

  $('#panel-login').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.currentTarget;
    const fejl = $('[data-fejl]', f);
    fejl.textContent = '';
    const pc = f.pc_nr.value.trim();
    const pin = f.pin.value.trim();
    if (!/^\d{1,4}$/.test(pc) || +pc < 1) { fejl.textContent = 'Skriv dit PC-nummer (1–9999).'; f.pc_nr.focus(); return; }
    if (!/^\d{4,6}$/.test(pin)) { fejl.textContent = 'PIN-koden er 4–6 cifre.'; f.pin.focus(); return; }
    await sendLogin(f, '/api/kunde/login', { pc_nr: +pc, pin });
  });

  $('#panel-ny').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.currentTarget;
    const fejl = $('[data-fejl]', f);
    fejl.textContent = '';
    const pc = f.pc_nr.value.trim();
    const navn = f.navn.value.trim();
    const pin = f.pin.value.trim();
    if (!/^\d{1,4}$/.test(pc) || +pc < 1) { fejl.textContent = 'Skriv dit PC-nummer (1–9999).'; f.pc_nr.focus(); return; }
    if (!navn) { fejl.textContent = 'Skriv dit navn.'; f.navn.focus(); return; }
    if (!/^\d{4,6}$/.test(pin)) { fejl.textContent = 'Vælg en PIN-kode på 4–6 cifre.'; f.pin.focus(); return; }
    if (pin !== f.pin2.value.trim()) { fejl.textContent = 'De to PIN-koder er ikke ens.'; f.pin2.focus(); return; }
    await sendLogin(f, '/api/kunde/tilmeld', { pc_nr: +pc, navn, pin });
  });
}

async function sendLogin(form, sti, data) {
  const knap = $('button[type=submit]', form);
  knap.disabled = true;
  try {
    const mig = await api(sti, { metode: 'POST', data, logind: true });
    form.reset();
    await logIndMed(mig);
  } catch (e) {
    $('[data-fejl]', form).textContent = e.message;
    if (e.kode === 'tilmelding_lukket') hentInfo();
  } finally {
    knap.disabled = false;
  }
}

function tilLogin(besked) {
  lukStream();
  tilstand.mig = null;
  tilstand.ordrer = [];
  tilstand.ordreStatus.clear();
  tilstand.indbetalinger = [];
  $$('dialog[open]').forEach(d => d.close());
  $('#visning-butik').hidden = true;
  $('#notif-spoerg').hidden = true;
  $('#indlaeser').hidden = true;
  $('#visning-login').hidden = false;
  if (besked) $('[data-fejl]', $('#panel-login')).textContent = besked;
  vaelgFane('login');
  setTimeout(() => $('#panel-login').pc_nr.focus(), 0);
}

async function logIndMed(mig) {
  tilstand.mig = mig;
  hentKurv();
  $('#visning-login').hidden = true;
  $('#indlaeser').hidden = true;
  $('#visning-butik').hidden = false;
  $$('#visning-login [data-fejl]').forEach(el => { el.textContent = ''; });
  visMig();
  await Promise.all([hentVarer(), hentOrdrer(), hentIndbetalinger()]).catch(() => {});
  startStream();
}

// ---------- Deltager / saldo ----------
function visMig() {
  const m = tilstand.mig;
  if (!m) return;
  $('#top-bruger').textContent = `PC ${m.pc_nr} · ${m.navn}`;
  $('#bord-tekst').textContent = `Bring til min plads (PC ${m.pc_nr})`;
  visSaldo();
}
function visSaldo(blink) {
  const el = $('#saldo');
  el.textContent = kr(tilstand.mig ? tilstand.mig.saldo_oere : 0);
  if (blink) { el.classList.remove('blink'); void el.offsetWidth; el.classList.add('blink'); }
  visKurv();
}

// ---------- Varer ----------
async function hentVarer(liste) {
  try {
    tilstand.varer = Array.isArray(liste) ? liste : await api('/api/varer');
  } catch (e) {
    if (e.status !== 401) toast(e.message, 'fejl');
    return;
  }
  // Fjern ting fra kurven, der ikke længere findes
  for (const id of tilstand.kurv.keys()) {
    if (!tilstand.varer.some(v => v.id === id)) tilstand.kurv.delete(id);
  }
  visVarer();
  visKurv();
}

// Fast rækkefølge (tillæg 2); egne kategorier kommer bagefter i den rækkefølge, de optræder
const KATEGORI_ORDEN = ['Drikke', 'Energi', 'Varme drikke', 'Mad', 'Morgenmad', 'Slik og snacks', 'Frugt og sundt', 'Udstyr'];

function kategorier() {
  const grupper = new Map();
  for (const v of tilstand.varer) {
    const k = v.kategori || 'Andet';
    if (!grupper.has(k)) grupper.set(k, []);
    grupper.get(k).push(v);
  }
  const orden = k => { const i = KATEGORI_ORDEN.indexOf(k); return i < 0 ? KATEGORI_ORDEN.length : i; };
  return new Map([...grupper].sort((a, b) => orden(a[0]) - orden(b[0])));
}

function kategoriId(navn) { return 'kat-' + navn.toLowerCase().replace(/[^a-z0-9æøå]+/g, '-'); }

function visVarer() {
  const grupper = kategorier();
  const knapper = $('#kategori-knapper');
  knapper.innerHTML = '';
  $('#kategori-bjaelke').hidden = grupper.size < 2;
  for (const k of grupper.keys()) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'knap';
    b.dataset.kat = kategoriId(k);
    b.textContent = k;
    b.addEventListener('click', () => {
      // Den valgte kategori markeres, også hvis siden ikke kan scrolle helt derned
      valgtKat = { id: kategoriId(k), til: Date.now() + 1500 };
      markerAktivKategori();
      const mål = document.getElementById(kategoriId(k));
      if (mål) { mål.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    });
    knapper.append(b);
  }

  const liste = $('#vare-liste');
  if (!tilstand.varer.length) {
    liste.innerHTML = '<p class="tom-tekst">Der er ingen varer endnu.</p>';
    return;
  }
  liste.innerHTML = '';
  for (const [k, varer] of grupper) {
    const sek = document.createElement('section');
    sek.className = 'kategori';
    sek.id = kategoriId(k);
    sek.setAttribute('aria-labelledby', sek.id + '-t');
    sek.innerHTML = `<h2 id="${sek.id}-t">${esc(k)}</h2><div class="gitter"></div>`;
    const gitter = $('.gitter', sek);
    for (const v of varer) gitter.append(vareKort(v));
    liste.append(sek);
  }
  opdaterKategoriBjaelke();
  markerAktivKategori();
}

// ---------- Kategoribjælke: fade/pile når den kan scrolles, og markering af aktiv kategori ----------
function opdaterKategoriBjaelke() {
  const bj = $('#kategori-bjaelke');
  const k = $('#kategori-knapper');
  const rest = k.scrollWidth - k.clientWidth - k.scrollLeft;
  bj.classList.toggle('mere-venstre', k.scrollLeft > 4);
  bj.classList.toggle('mere-hoejre', rest > 4);
  document.documentElement.style.setProperty('--kat-hoejde', (bj.hidden ? 0 : bj.offsetHeight) + 'px');
}

let aktivKat = null;
let valgtKat = null;
function markerAktivKategori() {
  const bj = $('#kategori-bjaelke');
  if (bj.hidden) return;
  const sektioner = $$('#vare-liste .kategori');
  let aktiv = null;
  if (valgtKat && Date.now() < valgtKat.til) {
    aktiv = valgtKat.id;
  } else if (sektioner.length && innerHeight + scrollY >= document.documentElement.scrollHeight - 2 && scrollY > 0) {
    // Helt i bunden: de sidste korte kategorier kan ikke nå op under bjælken
    aktiv = (valgtKat && valgtKat.id) || sektioner[sektioner.length - 1].id;
  } else {
    valgtKat = null;
    const graense = bj.getBoundingClientRect().bottom + 20;
    for (const s of sektioner) {
      if (s.getBoundingClientRect().top <= graense) aktiv = s.id; else break;
    }
  }
  aktiv = aktiv || (sektioner[0] || {}).id;
  if (aktiv === aktivKat && $(`#kategori-knapper [aria-current="true"]`)) return;
  aktivKat = aktiv;
  const k = $('#kategori-knapper');
  for (const b of $$('button', k)) {
    const er = b.dataset.kat === aktiv;
    b.setAttribute('aria-current', er ? 'true' : 'false');
    // Hold den aktive kategori synlig i den vandrette række (kun mobil)
    if (er && k.scrollWidth > k.clientWidth) {
      const venstre = b.offsetLeft - k.offsetLeft;
      if (venstre < k.scrollLeft + 40 || venstre + b.offsetWidth > k.scrollLeft + k.clientWidth - 40) {
        k.scrollLeft = venstre - (k.clientWidth - b.offsetWidth) / 2;
      }
    }
  }
}

function initKategoriBjaelke() {
  const k = $('#kategori-knapper');
  k.addEventListener('scroll', opdaterKategoriBjaelke, { passive: true });
  window.addEventListener('resize', () => { opdaterKategoriBjaelke(); markerAktivKategori(); });
  $$('.kat-pil').forEach(p => p.addEventListener('click', () => {
    k.scrollBy({ left: +p.dataset.retning * k.clientWidth * 0.7 });
  }));
  let venter = false;
  window.addEventListener('scroll', () => {
    if (venter) return;
    venter = true;
    requestAnimationFrame(() => { venter = false; markerAktivKategori(); });
  }, { passive: true });
}

function vareKort(v) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'vare' + (v.udsolgt ? ' udsolgt' : '');
  b.dataset.id = v.id;
  const antal = tilstand.kurv.get(v.id) || 0;
  const billede = v.billede_url
    ? `<img src="${esc(v.billede_url)}" alt="" loading="lazy">`
    : `<span class="pladsholder" aria-hidden="true">${esc((v.navn || '?').charAt(0))}</span>`;
  b.innerHTML = `
    <span class="vare-billede">${billede}</span>
    <span class="vare-navn">${esc(v.navn)}${v.beskrivelse ? `<span class="vare-beskrivelse">${esc(v.beskrivelse)}</span>` : ''}</span>
    <span class="vare-pris">${kr(v.pris_oere)}</span>
    ${v.udsolgt ? '<span class="udsolgt-maerke">Udsolgt</span>' : ''}
    ${antal ? `<span class="vare-i-kurv" aria-hidden="true">${antal}</span>` : ''}`;
  b.setAttribute('aria-label', v.udsolgt
    ? `${v.navn}, ${kr(v.pris_oere)}, udsolgt`
    : `${v.navn}, ${kr(v.pris_oere)}. Læg i kurv${antal ? ` (${antal} i kurven)` : ''}`);
  if (v.udsolgt) b.setAttribute('aria-disabled', 'true');
  b.addEventListener('click', () => {
    if (v.udsolgt) { toast(`${v.navn} er desværre udsolgt.`); return; }
    aendrAntal(v.id, 1);
  });
  // Billede der ikke kan hentes → pladsholder
  const img = $('img', b);
  if (img) img.addEventListener('error', () => {
    img.parentElement.innerHTML = `<span class="pladsholder" aria-hidden="true">${esc((v.navn || '?').charAt(0))}</span>`;
  });
  return b;
}

function opdaterVareKort(id) {
  const gammel = $(`.vare[data-id="${id}"]`);
  const v = tilstand.varer.find(x => x.id === id);
  if (gammel && v) {
    const ny = vareKort(v);
    const fokus = document.activeElement === gammel;
    gammel.replaceWith(ny);
    if (fokus) ny.focus();
  }
}

// ---------- Kurv ----------
function gemKurv() {
  if (!tilstand.mig) return;
  lagerGem('kurv-' + tilstand.mig.pc_nr, JSON.stringify([...tilstand.kurv]));
}
function hentKurv() {
  tilstand.kurv = new Map();
  try {
    const d = JSON.parse(lagerHent('kurv-' + tilstand.mig.pc_nr) || '[]');
    for (const [id, antal] of d) if (antal > 0) tilstand.kurv.set(+id, Math.min(20, +antal));
  } catch { /* ignorer */ }
}

function aendrAntal(id, delta) {
  const nu = tilstand.kurv.get(id) || 0;
  const nyt = Math.max(0, Math.min(20, nu + delta));
  if (nu + delta > 20) toast('Højst 20 af samme vare pr. ordre.');
  if (nyt) tilstand.kurv.set(id, nyt); else tilstand.kurv.delete(id);
  $('#kvittering').hidden = true;
  $('#bestil-fejl').textContent = '';
  gemKurv();
  opdaterVareKort(id);
  visKurv();
  visKurvLinje(id);
}

// Vis "rul for flere", når varelisten i kurven ikke kan ses helt
function opdaterRulleHint() {
  const r = $('#kurv-rulle');
  const skjult = r.scrollHeight - r.clientHeight - r.scrollTop;
  const hint = $('#kurv-rulle-hint');
  hint.hidden = !(r.clientHeight > 0 && skjult > 6);
  if (!hint.hidden) hint.textContent = `↓ Rul for at se alle ${$$('#kurv-linjer li').length} varer i kurven`;
}

// Rul varelisten, så den ændrede linje kan ses
function visKurvLinje(id) {
  const r = $('#kurv-rulle');
  const li = $(`#kurv-linjer li[data-id="${id}"]`);
  if (!li || !r.clientHeight) return;
  const top = li.getBoundingClientRect().top - r.getBoundingClientRect().top + r.scrollTop;
  if (top < r.scrollTop) r.scrollTop = top;
  else if (top + li.offsetHeight > r.scrollTop + r.clientHeight) r.scrollTop = top + li.offsetHeight - r.clientHeight;
  opdaterRulleHint();
}

function kurvTotal() {
  let total = 0, antal = 0;
  for (const [id, n] of tilstand.kurv) {
    const v = tilstand.varer.find(x => x.id === id);
    if (v) { total += v.pris_oere * n; antal += n; }
  }
  return { total, antal };
}

function visKurv() {
  const i = tilstand.info;
  if (!i || !tilstand.mig) return;
  const ul = $('#kurv-linjer');
  const rulle = $('#kurv-rulle');
  const rullePos = rulle.scrollTop;
  ul.innerHTML = '';
  for (const [id, n] of tilstand.kurv) {
    const v = tilstand.varer.find(x => x.id === id);
    if (!v) continue;
    const li = document.createElement('li');
    li.className = 'kurv-linje';
    li.innerHTML = `
      <div><div class="kurv-linje-navn">${esc(v.navn).replace(/ (\d|l\b|cl\b|ml\b|g\b)/g, ' $1')}${v.udsolgt ? ' <small>(udsolgt)</small>' : ''}</div>
        <div class="kurv-linje-pris">${kr(v.pris_oere)} pr. stk.</div></div>
      <div class="antal">
        <button type="button" data-d="-1" aria-label="Én ${esc(v.navn)} mindre">−</button>
        <output aria-label="Antal ${esc(v.navn)}">${n}</output>
        <button type="button" data-d="1" aria-label="Én ${esc(v.navn)} mere" ${n >= 20 || v.udsolgt ? 'disabled' : ''}>+</button>
      </div>
      <div class="kurv-linje-sum">${kr(v.pris_oere * n)}</div>`;
    li.dataset.id = id;
    $$('button', li).forEach(b => b.addEventListener('click', () => {
      aendrAntal(id, +b.dataset.d);
      // Behold fokus på samme knap efter gentegning
      const ny = $(`#kurv-linjer li[data-id="${id}"] button[data-d="${b.dataset.d}"]`);
      (ny && !ny.disabled ? ny : $('#note')).focus();
    }));
    ul.append(li);
  }
  rulle.scrollTop = rullePos;
  opdaterRulleHint();

  const { total, antal } = kurvTotal();
  const tom = antal === 0;
  $('#kurv-tom').hidden = !tom;
  $('#kurv-total').textContent = kr(total);
  $('#kurv-antal').textContent = antal === 1 ? '1 vare' : antal + ' varer';
  $('#kurv-handtag-total').textContent = kr(total);

  // Levering
  const levAktiv = !!Number(i.levering_aktiv);
  const min = Number(i.levering_min_oere) || 0;
  $('#levering').hidden = !levAktiv;
  const bordRadio = $('input[name=levering][value=bord]');
  const bordMulig = levAktiv && total >= min;
  bordRadio.disabled = !bordMulig;
  $('#valg-bord').classList.toggle('deaktiv', !bordMulig);
  $('#bord-mangler').textContent = levAktiv && !bordMulig
    ? `Bringes kun ved køb fra ${kr(min)} – du mangler ${kr(min - total)}`
    : '';
  if (!bordMulig && tilstand.levering === 'bord') tilstand.levering = 'hent';
  $$('input[name=levering]').forEach(r => { r.checked = r.value === tilstand.levering; });

  // Bestil-knap
  const aaben = !!Number(i.butik_aaben);
  const saldo = tilstand.mig.saldo_oere;
  const mangler = total - saldo;
  const knap = $('#bestil');
  $('#lukket-note').hidden = aaben;
  $('#mangler').hidden = true;
  if (!aaben) {
    knap.disabled = true;
    knap.textContent = 'Butikken er lukket';
  } else if (tom) {
    knap.disabled = true;
    knap.textContent = 'Bestil';
  } else if (mangler > 0) {
    knap.disabled = true;
    knap.textContent = `Du mangler ${kr(mangler)}`;
    $('#mangler-tekst').textContent = `Din saldo er ${kr(saldo)}.`;
    $('#mangler').hidden = false;
  } else {
    knap.disabled = !!tilstand.bestiller;
    knap.textContent = `Bestil for ${kr(total)}`;
  }
}

async function bestil() {
  const { total, antal } = kurvTotal();
  if (!antal || tilstand.bestiller) return;
  const linjer = [...tilstand.kurv].map(([vare_id, antal]) => ({ vare_id, antal }));
  const fejlEl = $('#bestil-fejl');
  fejlEl.textContent = '';
  tilstand.bestiller = true;
  const knap = $('#bestil');
  knap.disabled = true;
  knap.textContent = 'Sender …';
  try {
    const ordre = await api('/api/kunde/ordrer', {
      metode: 'POST',
      data: { linjer, levering: tilstand.levering, note: $('#note').value.trim() },
    });
    tilstand.kurv.clear();
    gemKurv();
    $('#note').value = '';
    tilstand.mig.saldo_oere = Math.max(0, tilstand.mig.saldo_oere - (ordre.total_oere ?? total));
    modtagOrdre(ordre);
    visSaldo(true);
    visVarer();
    visKvittering(ordre);
    api('/api/kunde/mig').then(m => { tilstand.mig = m; visMig(); }).catch(() => {});
    spoergOmNotifikation();
  } catch (e) {
    fejlEl.textContent = e.message;
    if (['vare_udsolgt', 'vare_findes_ikke'].includes(e.kode)) hentVarer();
    if (['butik_lukket', 'levering_ikke_mulig'].includes(e.kode)) hentInfo();
    if (e.kode === 'ikke_nok_penge') api('/api/kunde/mig').then(m => { tilstand.mig = m; visMig(); }).catch(() => {});
  } finally {
    tilstand.bestiller = false;
    visKurv();
  }
}

function visKvittering(o) {
  const k = $('#kvittering');
  k.innerHTML = `<strong>Ordre #${esc(o.nr ?? o.id)} er modtaget</strong>
    <p>${o.levering === 'bord' ? 'Vi bringer den til din plads, når den er klar.' : 'Du får besked her, når den er klar til afhentning.'}</p>
    <button type="button" class="link-knap" data-aabn="dlg-ordrer">Se mine ordrer</button>`;
  k.hidden = false;
  toast(`Ordre #${o.nr ?? o.id} er modtaget`, 'ok');
}

function initKurv() {
  $('#bestil').addEventListener('click', bestil);
  $$('input[name=levering]').forEach(r => r.addEventListener('change', () => {
    if (r.checked) tilstand.levering = r.value;
    visKurv();
  }));
  $('#kurv-rulle').addEventListener('scroll', opdaterRulleHint, { passive: true });
  window.addEventListener('resize', opdaterRulleHint);
  $('#kurv-handtag').addEventListener('click', () => {
    const aaben = $('#kurv').classList.toggle('aaben');
    $('#kurv-handtag').setAttribute('aria-expanded', aaben);
    opdaterRulleHint();
  });
}

// ---------- Ordrer ----------
async function hentOrdrer() {
  try {
    const liste = await api('/api/kunde/ordrer');
    tilstand.ordrer = liste;
    for (const o of liste) tilstand.ordreStatus.set(o.id, o.status);
    visOrdrer();
  } catch (e) {
    if (e.status !== 401) $('#ordrer-fejl').textContent = e.message;
  }
}

function modtagOrdre(o, fraStream) {
  const forrige = tilstand.ordreStatus.get(o.id);
  tilstand.ordreStatus.set(o.id, o.status);
  const idx = tilstand.ordrer.findIndex(x => x.id === o.id);
  if (idx >= 0) tilstand.ordrer[idx] = o; else tilstand.ordrer.unshift(o);
  tilstand.ordrer.sort((a, b) => (b.oprettet || '').localeCompare(a.oprettet || '') || b.id - a.id);
  visOrdrer();
  if (fraStream && forrige !== undefined && forrige !== o.status) {
    if (o.status === 'klar') ordreKlar(o);
    else if (o.status === 'laves') toast(`Ordre #${o.nr ?? o.id} bliver lavet nu`);
    else if (o.status === 'annulleret') toast(`Ordre #${o.nr ?? o.id} er annulleret – pengene er sat tilbage på din saldo.`);
  } else if (fraStream && forrige === undefined && o.status === 'klar') {
    ordreKlar(o);
  }
}

function visOrdrer() {
  const ul = $('#ordre-liste');
  ul.innerHTML = '';
  $('#ordrer-tom').hidden = tilstand.ordrer.length > 0;
  for (const o of tilstand.ordrer) {
    const li = document.createElement('li');
    li.className = 'ordre';
    const linjer = (o.linjer || []).map(l =>
      `<li><span>${esc(l.antal)} × ${esc(l.navn)}</span><span>${kr(l.pris_oere * l.antal)}</span></li>`).join('');
    li.innerHTML = `
      <div class="ordre-top">
        <span class="ordre-nr">#${esc(o.nr ?? o.id)}</span>
        <span class="status status-${esc(o.status)}">${esc(STATUS_TEKST[o.status] || o.status)}</span>
      </div>
      <div class="ordre-meta">${tid(o.oprettet)} · ${o.levering === 'bord' ? 'Bringes til din plads' : 'Afhentes i butikken'}</div>
      <ul class="ordre-linjer">${linjer}</ul>
      ${o.note ? `<p class="ordre-note">Note: ${esc(o.note)}</p>` : ''}
      <div class="ordre-bund">
        <span>Total ${kr(o.total_oere)}</span>
        ${o.status === 'ny' ? `<button type="button" class="knap knap-fare" data-annuller="${o.id}">Annuller</button>` : ''}
      </div>`;
    const ann = $('[data-annuller]', li);
    if (ann) ann.addEventListener('click', () => annuller(o, ann));
    ul.append(li);
  }

  // Aktive ordrer øverst
  const aktive = tilstand.ordrer.filter(o => AKTIVE.includes(o.status));
  const boks = $('#aktive-ordrer');
  boks.hidden = aktive.length === 0;
  boks.innerHTML = '';
  for (const o of aktive.slice().reverse()) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ordre-chip';
    b.innerHTML = `Ordre #${esc(o.nr ?? o.id)} <span class="status status-${esc(o.status)}">${esc(STATUS_TEKST[o.status])}</span>`;
    b.addEventListener('click', () => aabnDialog('dlg-ordrer'));
    boks.append(b);
  }
  const m = $('#ordre-maerke');
  m.hidden = aktive.length === 0;
  m.textContent = aktive.length;
}

async function annuller(o, knap) {
  if (!confirm(`Vil du annullere ordre #${o.nr ?? o.id}? Pengene sættes tilbage på din saldo.`)) return;
  knap.disabled = true;
  $('#ordrer-fejl').textContent = '';
  try {
    const ny = await api(`/api/kunde/ordrer/${o.id}/annuller`, { metode: 'POST' });
    modtagOrdre(ny);
    const m = await api('/api/kunde/mig');
    tilstand.mig = m;
    visSaldo(true);
    toast(`Ordre #${ny.nr ?? ny.id} er annulleret`, 'ok');
  } catch (e) {
    $('#ordrer-fejl').textContent = e.message;
    knap.disabled = false;
    hentOrdrer();
  }
}

// ---------- Ordre klar: besked, lyd, titel, notifikation ----------
let normalTitel = document.title;
let titelTimer = null;

function ordreKlar(o) {
  const nr = o.nr ?? o.id;
  const tekst = o.levering === 'bord'
    ? `Din ordre #${nr} er på vej til din plads!`
    : `Din ordre #${nr} er klar til afhentning!`;
  $('#klar-tekst').textContent = tekst;
  $('#klar-undertekst').textContent = o.levering === 'bord'
    ? 'Bliv siddende – vi kommer med den.'
    : 'Kom op til butikken og hent den.';
  const d = $('#dlg-klar');
  if (!d.open) d.showModal();
  spilLyd();
  blinkTitel(o.levering === 'bord' ? `🔔 #${nr} på vej!` : `🔔 #${nr} er klar!`);
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      const n = new Notification(tilstand.info?.traef_navn || 'Træf-butikken', { body: tekst, tag: 'ordre-' + nr, requireInteraction: true });
      n.onclick = () => { window.focus(); n.close(); };
    } catch { /* fx ikke understøttet */ }
  }
}

let lydKontekst = null;
function lydKlar() {
  try {
    if (!lydKontekst) lydKontekst = new (window.AudioContext || window.webkitAudioContext)();
    if (lydKontekst.state === 'suspended') lydKontekst.resume();
  } catch { /* ingen lyd */ }
}
function spilLyd() {
  lydKlar();
  const ctx = lydKontekst;
  if (!ctx) return;
  const start = ctx.currentTime + 0.05;
  // Tre stigende toner, to gange
  const toner = [784, 988, 1319, 784, 988, 1319];
  toner.forEach((f, i) => {
    const t = start + i * 0.16 + (i >= 3 ? 0.25 : 0);
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    osc.connect(g).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.32);
  });
}

function blinkTitel(tekst) {
  stopBlink();
  let vis = true;
  document.title = tekst;
  titelTimer = setInterval(() => {
    vis = !vis;
    document.title = vis ? tekst : normalTitel;
  }, 900);
}
function stopBlink() {
  if (titelTimer) { clearInterval(titelTimer); titelTimer = null; }
  document.title = normalTitel;
}

function spoergOmNotifikation() {
  if (!('Notification' in window) || Notification.permission !== 'default') return;
  if (lagerHent('notif-spurgt')) return;
  $('#notif-spoerg').hidden = false;
}
function initNotif() {
  $('#notif-ja').addEventListener('click', async () => {
    lagerGem('notif-spurgt', '1');
    $('#notif-spoerg').hidden = true;
    try {
      const r = await Notification.requestPermission();
      toast(r === 'granted' ? 'Fint – du får besked, når din ordre er klar.' : 'Okay, du får kun besked her på siden.');
    } catch { /* ignorer */ }
  });
  $('#notif-nej').addEventListener('click', () => {
    lagerGem('notif-spurgt', '1');
    $('#notif-spoerg').hidden = true;
  });
  // Første klik låser lyden op (browsere kræver brugerhandling)
  document.addEventListener('pointerdown', lydKlar, { once: true });
  document.addEventListener('keydown', lydKlar, { once: true });
  // Stop blink når man kigger
  $('#dlg-klar').addEventListener('close', stopBlink);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !$('#dlg-klar').open) stopBlink();
  });
  window.addEventListener('focus', () => { if (!$('#dlg-klar').open) stopBlink(); });
}

// ---------- Indbetalinger ----------
async function hentIndbetalinger() {
  try {
    tilstand.indbetalinger = await api('/api/kunde/indbetalinger');
    visIndbetalinger();
  } catch { /* vises ved næste forsøg */ }
}

function modtagIndbetaling(ib, fraStream) {
  const idx = tilstand.indbetalinger.findIndex(x => x.id === ib.id);
  const forrige = idx >= 0 ? tilstand.indbetalinger[idx].status : undefined;
  if (idx >= 0) tilstand.indbetalinger[idx] = ib; else tilstand.indbetalinger.unshift(ib);
  visIndbetalinger();
  if (fraStream && forrige !== ib.status) {
    if (ib.status === 'godkendt') toast(`Din indbetaling på ${kr(ib.beloeb_oere)} er godkendt 🎉`, 'ok');
    if (ib.status === 'afvist') toast(`Din indbetaling på ${kr(ib.beloeb_oere)} blev afvist. Spørg i butikken.`, 'fejl');
  }
}

function visIndbetalinger() {
  const ul = $('#indbetaling-liste');
  ul.innerHTML = '';
  const liste = tilstand.indbetalinger.slice().sort((a, b) => (b.oprettet || '').localeCompare(a.oprettet || '') || b.id - a.id);
  $('#indbetalinger-tom').hidden = liste.length > 0;
  for (const ib of liste) {
    const li = document.createElement('li');
    li.className = 'indbetaling';
    li.innerHTML = `
      <div>
        <div class="indbetaling-beloeb">${kr(ib.beloeb_oere)}</div>
        <div class="indbetaling-meta">${esc(METODE_TEKST[ib.metode] || ib.metode)}${ib.reference ? ' · ' + esc(ib.reference) : ''} · ${tid(ib.oprettet)}</div>
      </div>
      <span class="status status-${esc(ib.status)}">${esc(INDB_TEKST[ib.status] || ib.status)}</span>`;
    ul.append(li);
  }
}

function initPenge() {
  const f = $('#penge-form');
  const hurtig = $$('[data-beloeb]', f);
  hurtig.forEach(b => {
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => {
      f.beloeb.value = b.dataset.beloeb;
      hurtig.forEach(x => x.setAttribute('aria-pressed', x === b));
    });
  });
  f.beloeb.addEventListener('input', () => {
    hurtig.forEach(x => x.setAttribute('aria-pressed', x.dataset.beloeb === f.beloeb.value.trim()));
  });
  const refLabel = { mobilepay: 'Dit navn i MobilePay', kontant: 'Reference (valgfri)', andet: 'Hvordan har du betalt?' };
  $$('input[name=metode]', f).forEach(r => r.addEventListener('change', () => {
    $('#reference-label').textContent = refLabel[r.value];
  }));

  f.addEventListener('submit', async e => {
    e.preventDefault();
    const fejl = $('[data-fejl]', f);
    const ok = $('[data-ok]', f);
    fejl.textContent = '';
    ok.textContent = '';
    const raa = f.beloeb.value.trim().replace(/\s|kr\.?/gi, '').replace(',', '.');
    const beloeb = Number(raa);
    if (!raa || !isFinite(beloeb) || beloeb <= 0) { fejl.textContent = 'Vælg eller skriv et beløb.'; f.beloeb.focus(); return; }
    if (beloeb > 10000) { fejl.textContent = 'Beløbet er for stort.'; f.beloeb.focus(); return; }
    const metode = f.metode.value;
    const reference = f.reference.value.trim();
    if (metode === 'mobilepay' && !reference) { fejl.textContent = 'Skriv det navn, der står på din MobilePay, så butikken kan finde betalingen.'; f.reference.focus(); return; }
    const knap = $('button[type=submit]', f);
    knap.disabled = true;
    try {
      const ib = await api('/api/kunde/indbetalinger', {
        metode: 'POST',
        data: { beloeb_oere: Math.round(beloeb * 100), metode, reference },
      });
      modtagIndbetaling(ib);
      ok.textContent = `Tak! ${kr(ib.beloeb_oere)} venter nu på, at butikken godkender det.`;
      f.beloeb.value = '';
      f.reference.value = metode === 'mobilepay' ? reference : '';
      hurtig.forEach(x => x.setAttribute('aria-pressed', 'false'));
    } catch (e2) {
      fejl.textContent = e2.message;
    } finally {
      knap.disabled = false;
    }
  });
}

// ---------- Dialoger ----------
function aabnDialog(id) {
  const d = document.getElementById(id);
  if (!d) return;
  $$('dialog[open]').forEach(x => { if (x !== d && x.id !== 'dlg-klar') x.close(); });
  if (id === 'dlg-ordrer') hentOrdrer();
  if (id === 'dlg-penge') {
    hentIndbetalinger();
    const f = $('#penge-form');
    $('[data-ok]', f).textContent = '';
    $('[data-fejl]', f).textContent = '';
  }
  if (!d.open) d.showModal();
}
function initDialoger() {
  document.addEventListener('click', e => {
    const aabn = e.target.closest('[data-aabn]');
    if (aabn) aabnDialog(aabn.dataset.aabn);
    const luk = e.target.closest('[data-luk]');
    if (luk) luk.closest('dialog').close();
  });
  // Klik udenfor lukker
  $$('dialog').forEach(d => d.addEventListener('click', e => { if (e.target === d) d.close(); }));
}

// ---------- Live (SSE) ----------
function startStream() {
  lukStream();
  if (!('EventSource' in window) || !tilstand.mig) return;
  const es = new EventSource('/api/kunde/stream');
  tilstand.es = es;
  let foersteAabning = true;
  es.addEventListener('open', () => {
    $('#forbindelse').hidden = true;
    if (!foersteAabning || tilstand.esForsoeg > 0) {
      // Indhent hvad vi kan have misset
      genopfrisk();
    }
    foersteAabning = false;
    tilstand.esForsoeg = 0;
  });
  es.addEventListener('ordre', e => { const o = laes(e); if (o) modtagOrdre(o, true); });
  es.addEventListener('saldo', e => {
    const d = laes(e);
    if (d && tilstand.mig && typeof d.saldo_oere === 'number') {
      const steg = d.saldo_oere !== tilstand.mig.saldo_oere;
      tilstand.mig.saldo_oere = d.saldo_oere;
      visSaldo(steg);
    }
  });
  es.addEventListener('indbetaling', e => { const d = laes(e); if (d) modtagIndbetaling(d, true); });
  // Serveren sender alle aktive varer, når en vare ændres (fx bliver udsolgt)
  es.addEventListener('varer', e => { const d = laes(e); if (Array.isArray(d)) hentVarer(d); });
  es.addEventListener('info', e => {
    const d = laes(e);
    if (d) {
      const varerFoer = tilstand.info;
      tilstand.info = d;
      visInfo();
      if (varerFoer) hentVarer();
    }
  });
  es.addEventListener('error', () => {
    if (es.readyState === EventSource.CLOSED) {
      // Browseren giver op (fx 401) – tjek login og prøv selv igen
      lukStream();
      planlaegGenforbind();
    } else {
      $('#forbindelse').hidden = false;
      tilstand.esForsoeg++;
    }
  });
}
function laes(e) { try { return JSON.parse(e.data); } catch { return null; } }
function lukStream() {
  if (tilstand.es) { tilstand.es.close(); tilstand.es = null; }
  clearTimeout(tilstand.esTimer);
}
function planlaegGenforbind() {
  $('#forbindelse').hidden = false;
  tilstand.esForsoeg++;
  const vent = Math.min(15000, 1000 * 2 ** Math.min(tilstand.esForsoeg, 4));
  tilstand.esTimer = setTimeout(async () => {
    try {
      tilstand.mig = await api('/api/kunde/mig');
      visMig();
      startStream();
    } catch (e) {
      if (e.status !== 401) planlaegGenforbind();
    }
  }, vent);
}
async function genopfrisk() {
  try {
    const [mig, info] = await Promise.all([api('/api/kunde/mig'), api('/api/info')]);
    tilstand.mig = mig;
    tilstand.info = info;
    visInfo();
    visMig();
    // Ordrer: sammenlign status, så "klar" ikke går tabt
    const liste = await api('/api/kunde/ordrer');
    for (const o of liste) modtagOrdre(o, true);
    hentVarer();
    hentIndbetalinger();
  } catch { /* næste forsøg klarer det */ }
}

async function hentInfo() {
  try {
    tilstand.info = await api('/api/info');
    visInfo();
  } catch { /* ignorer */ }
}

// ---------- Start ----------
async function start() {
  initLogin();
  initKurv();
  initKategoriBjaelke();
  initNotif();
  initPenge();
  initDialoger();
  $('#log-ud').addEventListener('click', async () => {
    try { await api('/api/kunde/logout', { metode: 'POST', logind: true }); } catch { /* ignorer */ }
    tilLogin();
  });

  // Varer (fx udsolgt) har ingen SSE-hændelse – hent dem jævnligt
  tilstand.vareTimer = setInterval(() => { if (tilstand.mig && !document.hidden) hentVarer(); }, 30000);

  while (!tilstand.info) {
    try {
      tilstand.info = await api('/api/info', { logind: true });
    } catch (e) {
      $('#indlaeser').textContent = 'Kan ikke komme i kontakt med butikken – prøver igen …';
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  visInfo();
  try {
    const mig = await api('/api/kunde/mig', { logind: true });
    await logIndMed(mig);
  } catch {
    tilLogin();
  }
}

start();
