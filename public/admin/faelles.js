// Fælles hjælpefunktioner til butiksskærm og admin

// Fejl fra API'et med dansk besked og kode
export class ApiFejl extends Error {
  constructor(besked, kode, status) {
    super(besked);
    this.kode = kode;
    this.status = status;
  }
}

// Kald API'et med JSON. Kaster ApiFejl ved 4xx/5xx.
export async function api(sti, { metode = 'GET', data, raa, type } = {}) {
  const valg = { method: metode, headers: {}, credentials: 'same-origin' };
  if (raa !== undefined) {
    valg.body = raa;
    valg.headers['Content-Type'] = type || 'application/octet-stream';
  } else if (data !== undefined) {
    valg.body = JSON.stringify(data);
    valg.headers['Content-Type'] = 'application/json';
  }
  let svar;
  try {
    svar = await fetch(sti, valg);
  } catch {
    throw new ApiFejl('Ingen forbindelse til serveren.', 'netvaerk', 0);
  }
  const tekst = await svar.text();
  let json = null;
  if (tekst) {
    try { json = JSON.parse(tekst); } catch { json = null; }
  }
  if (!svar.ok) {
    if (svar.status === 401 && sti !== '/api/personale/login' && sti !== '/api/personale/opsaet') {
      udloggetHaandterer?.();
    }
    throw new ApiFejl(json?.fejl || `Serverfejl (${svar.status}).`, json?.kode || 'ukendt', svar.status);
  }
  return json;
}

let udloggetHaandterer = null;

// Øre → "12,50 kr." / "100 kr."
export function kr(oere) {
  const n = Number(oere) || 0;
  const fortegn = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const hele = Math.floor(abs / 100).toLocaleString('da-DK');
  const rest = abs % 100;
  return `${fortegn}${hele}${rest ? ',' + String(rest).padStart(2, '0') : ''} kr.`;
}

// "12,50" / "12.5" / "-20" → øre. Giver NaN ved ugyldig tekst.
export function tilOere(tekst) {
  const t = String(tekst ?? '').trim().replace(/\s|kr\.?/gi, '').replace(',', '.');
  if (!/^[-+]?\d+(\.\d{0,2})?$/.test(t)) return NaN;
  return Math.round(parseFloat(t) * 100);
}

// Øre → "12,50" til inputfelter
export function oereTilFelt(oere) {
  const n = Number(oere) || 0;
  return n % 100 ? (n / 100).toFixed(2).replace('.', ',') : String(n / 100);
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function klokken(iso) {
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' });
}

export function datoTid(iso) {
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleString('da-DK', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

// Sand for 1, "1", true
export function sand(v) {
  return v === true || v === 1 || v === '1' || v === 'true';
}

// Kort besked nederst på skærmen
export function besked(tekst, fejl = false) {
  let boks = document.querySelector('.beskeder');
  if (!boks) {
    boks = document.createElement('div');
    boks.className = 'beskeder';
    boks.setAttribute('role', 'status');
    boks.setAttribute('aria-live', 'polite');
    document.body.append(boks);
  }
  const el = document.createElement('div');
  el.className = 'besked' + (fejl ? ' fejl' : '');
  el.textContent = tekst;
  boks.append(el);
  setTimeout(() => el.remove(), fejl ? 5000 : 2800);
}

// Bekræftelsesdialog. Resolver true/false.
export function bekraeft(titel, tekst, jaTekst = 'Ja', fare = true) {
  return new Promise((ok) => {
    const d = document.createElement('dialog');
    d.className = 'boks';
    d.innerHTML = `<div class="indhold"><h2>${esc(titel)}</h2><p>${esc(tekst)}</p>
      <div class="knapper"><button class="knap" value="nej">Fortryd</button>
      <button class="knap ${fare ? 'fare' : 'primaer'}" value="ja">${esc(jaTekst)}</button></div></div>`;
    document.body.append(d);
    let svar = false;
    d.addEventListener('click', (e) => {
      const k = e.target.closest('button');
      if (k) { svar = k.value === 'ja'; d.close(); }
      else if (e.target === d) d.close();
    });
    d.addEventListener('close', () => { d.remove(); ok(svar); });
    d.showModal();
    d.querySelector('[value=nej]').focus();
  });
}

// Viser login (navn + kode) – eller "Opret første admin" – indtil personalet er logget ind.
// Resolver med den indloggede { id, navn, rolle }.
export async function kraevLogin(titel) {
  udloggetHaandterer = () => location.reload();
  const mig = await hentMig();
  if (mig) return mig;
  let info = {};
  try { info = await api('/api/info'); } catch { /* vises uden navn */ }
  const opsat = sand(info.personale_opsat);
  let note = '';
  try { note = sessionStorage.getItem('login-note') || ''; sessionStorage.removeItem('login-note'); } catch { /* ligegyldigt */ }
  const skaerm = document.createElement('div');
  skaerm.className = 'login-skaerm';
  skaerm.innerHTML = `
    <form class="login-boks" novalidate autocomplete="off">
      <h1 class="neon-titel">${esc(titel)}</h1>
      <p class="undertitel">${esc(info.traef_navn || 'Træf-butikken')}</p>
      ${note ? `<p class="login-note">${esc(note)}</p>` : ''}
      ${opsat ? `
        <label class="felt"><span>Dit navn</span>
          <input name="navn" autocomplete="username" autocapitalize="words" maxlength="40" required></label>
        <label class="felt"><span>Kode</span>
          <input type="password" name="kode" autocomplete="current-password" required></label>
      ` : `
        <h2 class="login-h2">Opret første admin</h2>
        <p>Der er ingen personale endnu. Den første konto bliver admin og kan bagefter oprette resten under Personale.</p>
        <label class="felt"><span>Dit navn</span>
          <input name="navn" autocomplete="username" autocapitalize="words" maxlength="40" required></label>
        <label class="felt"><span>Kode</span>
          <input type="password" name="kode" autocomplete="new-password" minlength="6" required>
          <div class="hjaelp">Mindst 6 tegn.</div></label>
        <label class="felt"><span>Gentag koden</span>
          <input type="password" name="kode2" autocomplete="new-password" required></label>
      `}
      <p class="fejl-tekst" role="alert"></p>
      <button class="knap primaer" type="submit">${opsat ? 'Log ind' : 'Opret admin og log ind'}</button>
    </form>`;
  document.body.append(skaerm);
  const form = skaerm.querySelector('form');
  const fejl = skaerm.querySelector('.fejl-tekst');
  form.navn.focus();
  return new Promise((ok) => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      fejl.textContent = '';
      const navn = form.navn.value.trim();
      const kode = form.kode.value;
      if (!navn) { fejl.textContent = 'Skriv dit navn.'; form.navn.focus(); return; }
      if (!opsat) {
        if (kode.length < 6) { fejl.textContent = 'Koden skal være mindst 6 tegn.'; return; }
        if (kode !== form.kode2.value) { fejl.textContent = 'De to koder er ikke ens.'; return; }
      } else if (!kode) { fejl.textContent = 'Skriv din kode.'; form.kode.focus(); return; }
      const knap = form.querySelector('button');
      knap.disabled = true;
      try {
        await api(opsat ? '/api/personale/login' : '/api/personale/opsaet', { metode: 'POST', data: { navn, kode } });
        const mig = await hentMig();
        if (!mig) throw new Error('Login lykkedes ikke. Prøv igen.');
        skaerm.remove();
        ok(mig);
      } catch (err) {
        fejl.textContent = err.message;
        form.kode.value = '';
        form.kode.focus();
      } finally {
        knap.disabled = false;
      }
    });
  });
}

// Den indloggede medarbejder, eller null
async function hentMig() {
  const svar = await fetch('/api/personale/mig', { credentials: 'same-origin' });
  if (svar.status === 401) return null;
  if (!svar.ok) throw new ApiFejl(`Serverfejl (${svar.status}).`, 'ukendt', svar.status);
  return svar.json();
}

export const rolleNavn = (r) => ({ admin: 'admin', ekspedient: 'ekspedient' }[r] || r || '');

// "Logget ind som Mads (ekspedient)" + Skift bruger + Log ud
export function brugerBjaelke(mig, el) {
  el.innerHTML = `<span class="bruger-navn">Logget ind som <strong>${esc(mig.navn)}</strong> (${esc(rolleNavn(mig.rolle))})</span>
    <button class="knap lille" data-skift-bruger>Skift bruger</button>
    <button class="knap lille" data-log-ud>Log ud</button>`;
  el.querySelector('[data-skift-bruger]').addEventListener('click', () => logUd('Skift bruger: log ind med dit eget navn og din kode.'));
  el.querySelector('[data-log-ud]').addEventListener('click', () => logUd(`${mig.navn} er logget ud.`));
}

async function fetchProeve(sti) {
  const svar = await fetch(sti, { credentials: 'same-origin' });
  if (!svar.ok) throw new ApiFejl('', '', svar.status);
}

// Log ud og vis login med det samme (samme side)
export async function logUd(note = '') {
  try { await api('/api/personale/logout', { metode: 'POST' }); } catch { /* ligegyldigt */ }
  try { if (note) sessionStorage.setItem('login-note', note); } catch { /* ligegyldigt */ }
  location.reload();
}


// SSE med automatisk genopretning. `vedForbind` kaldes ved hver (gen)forbindelse.
export function liveForbindelse(sti, proeve, haandterere, vedForbind, vedStatus) {
  let kilde = null;
  let ventTimer = null;
  let forsinkelse = 1000;
  function start() {
    clearTimeout(ventTimer);
    kilde?.close();
    kilde = new EventSource(sti);
    kilde.addEventListener('open', () => {
      forsinkelse = 1000;
      vedStatus?.(true);
      vedForbind?.();
    });
    for (const [navn, fn] of Object.entries(haandterere)) {
      kilde.addEventListener(navn, (e) => {
        let data;
        try { data = JSON.parse(e.data); } catch { return; }
        fn(data);
      });
    }
    kilde.addEventListener('error', () => {
      vedStatus?.(false);
      // Browseren prøver selv igen, men hvis den har givet op, starter vi forfra
      if (kilde.readyState === EventSource.CLOSED) {
        ventTimer = setTimeout(async () => {
          // Er vi blevet logget ud, så vis login igen
          try { await fetchProeve(proeve); } catch (e) { if (e.status === 401) return location.reload(); }
          start();
        }, forsinkelse);
        forsinkelse = Math.min(forsinkelse * 2, 15000);
      }
    });
  }
  start();
  return { genstart: start };
}
