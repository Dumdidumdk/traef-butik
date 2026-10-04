// Butiksskærmen: live ordrer, indbetalinger og udsolgt
import { api, kr, esc, klokken, sand, besked, bekraeft, kraevLogin, liveForbindelse } from '/admin/faelles.js';

const AKTIVE = ['ny', 'laves', 'klar'];
const TO_TIMER = 2 * 60 * 60 * 1000;
const $ = (s) => document.querySelector(s);

const ordrer = new Map();       // id → { data, el, json }
const seneste = new Map();      // id → Ordre (leveret/annulleret)
const indbetalinger = new Map(); // id → Indbetaling (afventer)
let varer = [];
let filter = 'alle';
let soegning = '';
let titelNavn = 'Butiksskærm';
let foersteHentning = true;

const lister = {};
document.querySelectorAll('[data-liste]').forEach((el) => { lister[el.dataset.liste] = el; });
const taellere = {};
document.querySelectorAll('[data-antal]').forEach((el) => { taellere[el.dataset.antal] = el; });

// ---------- Lyd ----------
let lydTil = true;
try { lydTil = localStorage.getItem('butik-lyd') !== '0'; } catch { /* privat vindue */ }
let lydKontekst = null;

function kontekst() {
  if (!lydKontekst) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    lydKontekst = new AC();
  }
  return lydKontekst;
}

// Spil en række toner: [[frekvens, start, længde], ...]
function spil(toner, styrke = 0.25) {
  if (!lydTil) return;
  const ctx = kontekst();
  if (!ctx || ctx.state !== 'running') { visLydAdvarsel(); return; }
  const nu = ctx.currentTime;
  for (const [frekvens, start, laengde] of toner) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = frekvens;
    gain.gain.setValueAtTime(0.0001, nu + start);
    gain.gain.exponentialRampToValueAtTime(styrke, nu + start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, nu + start + laengde);
    osc.connect(gain).connect(ctx.destination);
    osc.start(nu + start);
    osc.stop(nu + start + laengde + 0.05);
  }
}
const lydNyOrdre = () => spil([[880, 0, 0.18], [1175, 0.16, 0.18], [1568, 0.32, 0.35]]);
const lydIndbetaling = () => spil([[660, 0, 0.15], [660, 0.2, 0.15], [990, 0.4, 0.3]], 0.2);

function visLydAdvarsel() {
  if (lydTil && lydKontekst?.state !== 'running') $('#lyd-advarsel').hidden = false;
}
function aktiverLyd() {
  const ctx = kontekst();
  if (!ctx) return;
  ctx.resume().then(() => { $('#lyd-advarsel').hidden = true; });
}
// Første klik/tast låser lyden op
addEventListener('pointerdown', aktiverLyd, { capture: true });
addEventListener('keydown', aktiverLyd, { capture: true });
$('#lyd-aktiver').addEventListener('click', () => { aktiverLyd(); lydNyOrdre(); });

function visLydKnap() {
  const k = $('#lyd-knap');
  k.textContent = lydTil ? '🔊 Lyd til' : '🔇 Lyd fra';
  k.setAttribute('aria-pressed', String(lydTil));
  k.classList.toggle('aktiv', !lydTil);
  if (!lydTil) $('#lyd-advarsel').hidden = true;
}
$('#lyd-knap').addEventListener('click', () => {
  lydTil = !lydTil;
  try { localStorage.setItem('butik-lyd', lydTil ? '1' : '0'); } catch { /* ligegyldigt */ }
  visLydKnap();
  if (lydTil) { aktiverLyd(); setTimeout(lydNyOrdre, 50); }
});
visLydKnap();

// ---------- Ordrekort ----------
function listeNoegle(o) {
  if (o.status === 'klar') return o.levering === 'bord' ? 'klar-bord' : 'klar-hent';
  return o.status;
}

function minutterSiden(iso) {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
}
function tidTekst(min) {
  if (min < 1) return 'Lige nu';
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} t ${min % 60} min`;
}
function tidKlasse(min) {
  return min >= 10 ? 'kort-tid roed' : min >= 5 ? 'kort-tid gul' : 'kort-tid';
}

function knapperHtml(o) {
  const naeste = { ny: ['laves', 'Start'], laves: ['klar', 'Klar'], klar: ['leveret', o.levering === 'bord' ? 'Leveret' : 'Afhentet'] }[o.status];
  const tilbage = { laves: 'ny', klar: 'laves' }[o.status];
  return `<button class="knap groen naeste" data-handling="${naeste[0]}">${naeste[1]}</button>
    ${tilbage ? `<button class="knap lille" data-handling="${tilbage}">↩ Tilbage</button>` : ''}
    ${o.status !== 'klar' ? `<button class="knap lille fare" data-handling="annulleret">Annuller</button>` : ''}`;
}

function kortHtml(o) {
  const min = minutterSiden(o.oprettet);
  const bord = o.levering === 'bord';
  const linjer = (o.linjer || []).map((l) => `<li><span class="x">${l.antal}×</span> ${esc(l.navn)}</li>`).join('');
  return `<div class="kort-top"><span class="kort-nr">#${o.nr ?? o.id}</span>
      <span class="${tidKlasse(min)}" data-tid title="Bestilt kl. ${klokken(o.oprettet)}">${tidTekst(min)}</span></div>
    <div class="kort-pc">PC ${esc(o.pc_nr)}</div>
    <div class="kort-navn">${esc(o.navn)}</div>
    <span class="maerke ${bord ? 'bord' : 'hent'}">${bord ? 'BRING TIL PLADS' : 'AFHENTES'}</span>
    <ul class="linjer">${linjer}</ul>
    ${o.note ? `<div class="note">${esc(o.note)}</div>` : ''}
    <div class="kort-knapper">${knapperHtml(o)}</div>`;
}

// Indsæt kortet i rette liste sorteret efter id (ældste øverst)
function placer(el, liste) {
  const id = el._id;
  const forrige = el.previousElementSibling;
  const naeste = el.nextElementSibling;
  if (el.parentNode === liste && (!forrige || forrige._id < id) && (!naeste || naeste._id > id)) return;
  const sidste = liste.lastElementChild;
  if (!sidste || sidste._id < id) { liste.append(el); return; }
  for (const barn of liste.children) {
    if (barn._id > id && barn !== el) { liste.insertBefore(el, barn); return; }
  }
  liste.append(el);
}

function synlig(o) {
  if (filter !== 'alle' && o.levering !== filter) return false;
  if (!soegning) return true;
  const q = soegning;
  if (q.startsWith('#')) return String(o.nr ?? o.id).startsWith(q.slice(1));
  if (/^\d+$/.test(q)) return String(o.pc_nr).startsWith(q) || String(o.nr ?? o.id) === q;
  return String(o.navn || '').toLowerCase().includes(q);
}

// Opdater eller opret en ordre. live=true når den kommer fra SSE.
function modtagOrdre(o, live = false) {
  const kendt = ordrer.get(o.id);
  if (!AKTIVE.includes(o.status)) {
    if (kendt) { kendt.el.remove(); ordrer.delete(o.id); }
    if (Date.now() - new Date(o.opdateret || o.oprettet).getTime() < TO_TIMER) {
      seneste.set(o.id, o);
      tegnSenesteSnart();
    }
    planlaegTaelling();
    return;
  }
  seneste.delete(o.id);
  const json = JSON.stringify(o);
  if (kendt) {
    if (kendt.json === json) return;
    kendt.data = o;
    kendt.json = json;
    kendt.el.className = `kort ${o.levering === 'bord' ? 'bord' : 'hent'}`;
    kendt.el.innerHTML = kortHtml(o);
    kendt.el.hidden = !synlig(o);
    placer(kendt.el, lister[listeNoegle(o)]);
  } else {
    const el = document.createElement('article');
    el._id = o.id;
    el.dataset.id = o.id;
    el.className = `kort ${o.levering === 'bord' ? 'bord' : 'hent'}`;
    el.innerHTML = kortHtml(o);
    el.hidden = !synlig(o);
    ordrer.set(o.id, { data: o, el, json });
    placer(el, lister[listeNoegle(o)]);
    if (live && o.status === 'ny') nyOrdreAnkommet(el);
  }
  planlaegTaelling();
}

let blinkTimer = null;
function nyOrdreAnkommet(el) {
  el.classList.add('ny-ankommet');
  el.addEventListener('animationend', () => el.classList.remove('ny-ankommet'), { once: true });
  // Én lyd og ét blink selv om mange ordrer kommer på én gang
  if (!blinkTimer) {
    lydNyOrdre();
    const b = $('#blink');
    b.classList.remove('aktiv');
    void b.offsetWidth;
    b.classList.add('aktiv');
    blinkTimer = setTimeout(() => { blinkTimer = null; }, 700);
  }
}

// Tællere, tomme lister og fanetitel – samles i én opdatering pr. billede
let taelPlanlagt = false;
function planlaegTaelling() {
  if (taelPlanlagt) return;
  taelPlanlagt = true;
  requestAnimationFrame(() => { taelPlanlagt = false; taelOp(); });
}
function taelOp() {
  const antal = { ny: 0, laves: 0, 'klar-bord': 0, 'klar-hent': 0 };
  let nyeIalt = 0;
  for (const { data, el } of ordrer.values()) {
    if (data.status === 'ny') nyeIalt++;
    if (!el.hidden) antal[listeNoegle(data)]++;
  }
  antal.klar = antal['klar-bord'] + antal['klar-hent'];
  for (const [n, v] of Object.entries(antal)) if (taellere[n]) taellere[n].textContent = v;
  for (const [n, liste] of Object.entries(lister)) {
    let tom = liste.querySelector(':scope > .tom');
    const erTom = antal[n] === 0;
    if (erTom && !tom) {
      tom = document.createElement('p');
      tom.className = 'tom';
      tom._id = Infinity;
      tom.textContent = soegning || filter !== 'alle' ? 'Ingen der passer til søgningen' : 'Ingen ordrer';
      liste.append(tom);
    } else if (!erTom && tom) tom.remove();
  }
  document.title = `${nyeIalt ? `(${nyeIalt}) ` : ''}${titelNavn} – Butiksskærm`;
}

function anvendFilter() {
  for (const { data, el } of ordrer.values()) el.hidden = !synlig(data);
  document.querySelectorAll('.tavle .tom').forEach((t) => t.remove());
  planlaegTaelling();
}

// Opdater "x min" på alle kort
function opdaterTider() {
  for (const { data, el } of ordrer.values()) {
    const min = minutterSiden(data.oprettet);
    const t = el.querySelector('[data-tid]');
    const tekst = tidTekst(min);
    if (t.textContent !== tekst) {
      t.textContent = tekst;
      t.className = tidKlasse(min);
    }
  }
  let fjernet = false;
  for (const [id, o] of seneste) {
    if (Date.now() - new Date(o.opdateret || o.oprettet).getTime() > TO_TIMER) { seneste.delete(id); fjernet = true; }
  }
  if (fjernet) tegnSenesteSnart();
}
setInterval(opdaterTider, 15000);

// ---------- Knapper på kortene ----------
$('#tavle').addEventListener('click', async (e) => {
  const knap = e.target.closest('[data-handling]');
  if (!knap) return;
  const el = knap.closest('.kort');
  const post = ordrer.get(el._id);
  if (!post) return;
  const o = post.data;
  const status = knap.dataset.handling;
  if (status === 'annulleret') {
    const ok = await bekraeft(`Annuller ordre #${o.nr ?? o.id}?`,
      `PC ${o.pc_nr} (${o.navn}) får ${kr(o.total_oere)} tilbage på sin saldo. Det kan ikke fortrydes.`, 'Annuller ordre');
    if (!ok) return;
  }
  el.classList.add('travl');
  try {
    const ny = await api(`/api/butik/ordrer/${o.id}/status`, { metode: 'POST', data: { status } });
    if (ny && ny.id) modtagOrdre(ny);
    if (status === 'annulleret') besked(`Ordre #${o.nr ?? o.id} er annulleret – pengene er givet tilbage.`);
  } catch (err) {
    besked(err.message, true);
    if (err.kode === 'ugyldigt_skift') hentOrdrer();
  } finally {
    el.classList.remove('travl');
  }
});

// ---------- Seneste leverede ----------
let senestePlanlagt = false;
function tegnSenesteSnart() {
  if (senestePlanlagt) return;
  senestePlanlagt = true;
  requestAnimationFrame(() => { senestePlanlagt = false; tegnSeneste(); });
}
function tegnSeneste() {
  taellere.seneste.textContent = seneste.size;
  if (!$('#seneste').open) return;
  const liste = [...seneste.values()].sort((a, b) => (b.opdateret || '').localeCompare(a.opdateret || '') || b.id - a.id);
  $('#seneste-liste').innerHTML = liste.length ? liste.map((o) => `
    <div class="seneste-raekke">
      <span class="nr">#${o.nr ?? o.id}</span><span class="pc">PC ${esc(o.pc_nr)}</span>
      <span class="varer">${esc(o.navn)} · ${(o.linjer || []).map((l) => `${l.antal}× ${esc(l.navn)}`).join(', ')}</span>
      <span class="status-maerke ${o.status}">${o.status === 'annulleret' ? 'Annulleret' : o.levering === 'bord' ? 'Leveret' : 'Afhentet'}</span>
      <span class="tid">${klokken(o.opdateret)}</span>
    </div>`).join('') : '<p class="tom">Ingen endnu</p>';
}
$('#seneste').addEventListener('toggle', tegnSeneste);

// ---------- Indbetalinger ----------
function modtagIndbetaling(i, live = false) {
  const fandtes = indbetalinger.has(i.id);
  if (i.status === 'afventer') {
    indbetalinger.set(i.id, i);
    if (live && !fandtes) lydIndbetaling();
  } else {
    indbetalinger.delete(i.id);
  }
  tegnIndbetalinger();
}
function tegnIndbetalinger() {
  const n = indbetalinger.size;
  const badge = $('#indbetalinger-antal');
  badge.textContent = n;
  badge.hidden = n === 0;
  const liste = [...indbetalinger.values()].sort((a, b) => a.id - b.id);
  $('#indbetalinger-liste').innerHTML = liste.length ? liste.map((i) => `
    <div class="indb" data-id="${i.id}">
      <div class="indb-top"><span class="indb-pc">PC ${esc(i.pc_nr)}</span><span class="indb-beloeb">${kr(i.beloeb_oere)}</span></div>
      <div class="indb-info"><strong>${esc(i.navn)}</strong> · ${esc(metodeNavn(i.metode))} · kl. ${klokken(i.oprettet)}<br>
        Reference: <strong>${esc(i.reference || '–')}</strong></div>
      <div class="knapper"><button class="knap groen" data-indb="godkend">Godkend</button>
        <button class="knap fare" data-indb="afvis">Afvis</button></div>
    </div>`).join('') : '<p class="tom">Ingen afventende indbetalinger</p>';
}
function metodeNavn(m) {
  return { mobilepay: 'MobilePay', kontant: 'Kontant', andet: 'Andet' }[m] || m || '';
}
$('#indbetalinger-liste').addEventListener('click', async (e) => {
  const knap = e.target.closest('[data-indb]');
  if (!knap) return;
  const id = Number(knap.closest('.indb').dataset.id);
  const i = indbetalinger.get(id);
  if (!i) return;
  const handling = knap.dataset.indb;
  if (handling === 'afvis' && !(await bekraeft('Afvis indbetaling?',
    `${kr(i.beloeb_oere)} fra PC ${i.pc_nr} (${i.navn}) bliver ikke sat ind på saldoen.`, 'Afvis'))) return;
  knap.disabled = true;
  try {
    const svar = await api(`/api/admin/indbetalinger/${id}/${handling}`, { metode: 'POST' });
    modtagIndbetaling(svar && svar.id ? svar : { ...i, status: handling === 'godkend' ? 'godkendt' : 'afvist' });
    besked(handling === 'godkend' ? `${kr(i.beloeb_oere)} sat ind hos PC ${i.pc_nr}.` : 'Indbetalingen er afvist.');
  } catch (err) {
    besked(err.message, true);
    knap.disabled = false;
  }
});

// ---------- Udsolgt ----------
async function hentVarer() {
  try {
    varer = await api('/api/admin/varer');
    tegnVarer();
  } catch (err) { besked(err.message, true); }
}
function tegnVarer() {
  const aktive = varer.filter((v) => sand(v.aktiv));
  $('#udsolgt-liste').innerHTML = aktive.map((v) => `
    <button class="knap vare-skift ${sand(v.udsolgt) ? 'udsolgt' : ''}" data-vare="${v.id}" aria-pressed="${sand(v.udsolgt)}">
      <span class="navn">${esc(v.navn)}</span><span class="tilstand">${sand(v.udsolgt) ? 'UDSOLGT' : 'På lager'}</span>
    </button>`).join('') || '<p class="tom">Ingen varer</p>';
}
$('#udsolgt-liste').addEventListener('click', async (e) => {
  const knap = e.target.closest('[data-vare]');
  if (!knap) return;
  const v = varer.find((x) => x.id === Number(knap.dataset.vare));
  if (!v) return;
  knap.disabled = true;
  const udsolgt = sand(v.udsolgt) ? 0 : 1;
  try {
    const svar = await api(`/api/admin/varer/${v.id}`, { metode: 'PUT', data: {
      navn: v.navn, beskrivelse: v.beskrivelse, kategori: v.kategori, pris_oere: v.pris_oere,
      aktiv: sand(v.aktiv) ? 1 : 0, udsolgt, sortering: v.sortering,
    } });
    Object.assign(v, svar && svar.id ? svar : { udsolgt });
    tegnVarer();
  } catch (err) {
    besked(err.message, true);
    knap.disabled = false;
  }
});

// ---------- Paneler ----------
function aabnPanel(navn) {
  for (const p of ['indbetalinger', 'udsolgt']) {
    const aaben = p === navn && $(`#${p}-panel`).hidden;
    $(`#${p}-panel`).hidden = !aaben;
    $(`#${p}-knap`).setAttribute('aria-expanded', String(aaben));
    $(`#${p}-knap`).classList.toggle('aktiv', aaben);
  }
  if (navn === 'udsolgt' && !$('#udsolgt-panel').hidden) hentVarer();
}
$('#indbetalinger-knap').addEventListener('click', () => aabnPanel('indbetalinger'));
$('#udsolgt-knap').addEventListener('click', () => aabnPanel('udsolgt'));
document.querySelectorAll('[data-luk]').forEach((k) => k.addEventListener('click', () => aabnPanel(null)));
addEventListener('keydown', (e) => { if (e.key === 'Escape' && !document.querySelector('dialog[open]')) aabnPanel(null); });

// ---------- Søgning og filter ----------
$('#soeg').addEventListener('input', (e) => {
  soegning = e.target.value.trim().toLowerCase();
  anvendFilter();
});
document.querySelectorAll('[data-filter]').forEach((k) => k.addEventListener('click', () => {
  filter = k.dataset.filter;
  document.querySelectorAll('[data-filter]').forEach((x) => {
    x.classList.toggle('aktiv', x === k);
    x.setAttribute('aria-pressed', String(x === k));
  });
  anvendFilter();
}));

// ---------- Fuldskærm ----------
const fsKnap = $('#fuldskaerm-knap');
if (!document.documentElement.requestFullscreen) fsKnap.hidden = true;
fsKnap.addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => besked('Fuldskærm er ikke tilladt her.', true));
});
document.addEventListener('fullscreenchange', () => {
  fsKnap.textContent = document.fullscreenElement ? '⛶ Afslut fuldskærm' : '⛶ Fuldskærm';
});

// ---------- Hent alt (ved start og efter genforbindelse) ----------
async function hentOrdrer() {
  const alle = await api('/api/butik/ordrer');
  const set = new Set();
  // Nye ordrer der kom mens forbindelsen var nede, giver lyd (ikke ved første indlæsning)
  const harNye = !foersteHentning && alle.some((o) => o.status === 'ny' && !ordrer.has(o.id));
  for (const o of alle) { set.add(o.id); modtagOrdre(o, harNye); }
  for (const [id, post] of ordrer) if (!set.has(id)) { post.el.remove(); ordrer.delete(id); }
  foersteHentning = false;
  planlaegTaelling();
}
async function hentAlt() {
  try {
    const [info, indb] = await Promise.all([api('/api/info'), api('/api/admin/indbetalinger?status=afventer'), hentOrdrer()]);
    if (info?.traef_navn) { titelNavn = info.traef_navn; $('#traef-navn').textContent = info.traef_navn; }
    indbetalinger.clear();
    for (const i of indb || []) if (i.status === 'afventer') indbetalinger.set(i.id, i);
    tegnIndbetalinger();
    tegnSeneste();
    planlaegTaelling();
  } catch (err) {
    besked(err.message, true);
  }
}

function visForbindelse(ok) {
  const f = $('#forbindelse');
  f.classList.toggle('ok', ok);
  f.querySelector('.tekst').textContent = ok ? 'Live' : 'Forbinder igen…';
}

// ---------- Start ----------
await kraevLogin('/api/butik/ordrer?status=ny', 'Butiksskærm');
await hentAlt();
if (lydTil && kontekst()?.state !== 'running') visLydAdvarsel();
liveForbindelse('/api/butik/stream', '/api/butik/ordrer?status=ny', {
  ordre: (o) => modtagOrdre(o, true),
  indbetaling: (i) => modtagIndbetaling(i, true),
}, hentAlt, visForbindelse); // hent alt igen ved hver (gen)forbindelse, så intet går tabt
