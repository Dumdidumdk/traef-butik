# Træf-butik – byggeplan

Bestillingssystem til et computertræf med over 200 computere. Deltagerne bestiller sodavand, slik, toast
osv. fra deres egen computer og betaler med en forudbetalt saldo. Butikken ser ordrerne live på en skærm
bag disken. Alt er på dansk.

Systemet kører på én bærbar ved disken. Alle computere på træffets netværk åbner `http://<bærbarens-ip>:3000`.
Det skal virke **uden internet**: ingen CDN'er, ingen eksterne skrifttyper, ingen npm-pakker.

## Teknik

- **Node.js 24** (bærbar udgave i `runtime/node/node.exe`, ikke i git). Kun indbyggede moduler:
  `node:http`, `node:sqlite` (`DatabaseSync`), `node:crypto`, `node:fs`, `node:path`, `node:test`.
- Database: `data/butik.db` (SQLite, oprettes automatisk). Billeder: `data/billeder/`.
- Frontend: ren HTML, CSS og JavaScript (ES2020) uden byggetrin og uden biblioteker.
- Live-opdateringer: Server-Sent Events (`EventSource`). Ingen WebSockets.
- Alle beløb er **heltal i øre** (`pris_oere`, `saldo_oere`). Vis som `12,50 kr.` / `100 kr.`.
- Start: `start-butik.cmd` (Windows, dobbeltklik) → `runtime\node\node.exe server/server.js`. Port 3000 (env `PORT`).
  Ved start skrives adresserne i konsollen, fx `Kundesiden: http://192.168.1.20:3000`.

## Filer og ejere

| Del | Filer | Ejer |
|---|---|---|
| Server, database, API, standardvarer | `server/**`, `start-butik.cmd`, `data/standard/**` (standardbilleder) | hjælper 1 |
| Kundesiden | `public/kunde/**` | hjælper 2 |
| Butiksskærm og admin | `public/butik/**`, `public/admin/**` | hjælper 3 |
| Tests (API, belastning med 250 kunder, browser) | `test/**` | hjælper 4 |

Rør ikke andres filer. Mangler du noget i en andens del, så skriv det i dit svar til chefen.

## Datamodel (SQLite)

```
deltagere(id, pc_nr INTEGER UNIQUE, navn, pin_salt, pin_hash, saldo_oere INTEGER DEFAULT 0, oprettet)
varer(id, navn, beskrivelse, kategori, pris_oere, billede, aktiv 0/1, udsolgt 0/1, sortering, oprettet)
ordrer(id, deltager_id, total_oere, levering 'bord'|'hent', note, status, oprettet, opdateret)
   status: 'ny' → 'laves' → 'klar' → 'leveret'   (eller 'annulleret' fra 'ny'/'laves' – giver pengene tilbage)
ordrelinjer(id, ordre_id, vare_id, navn, pris_oere, antal)        -- navn og pris kopieres ved køb
indbetalinger(id, deltager_id, beloeb_oere, metode 'mobilepay'|'kontant'|'andet', reference, status 'afventer'|'godkendt'|'afvist', oprettet, behandlet)
saldo_bevaegelser(id, deltager_id, beloeb_oere (+/-), type 'indbetaling'|'koeb'|'refusion'|'justering', ordre_id, indbetaling_id, tekst, oprettet)
sessioner(token, type 'kunde'|'personale', deltager_id, oprettet, sidst_brugt)
indstillinger(noegle PRIMARY KEY, vaerdi)
```

Tider er ISO-strenge (UTC). `deltagere.saldo_oere` skal altid være lig summen af `saldo_bevaegelser` – alle
saldoændringer sker i én SQL-transaktion sammen med bevægelsen. Saldo må aldrig blive negativ.

Indstillinger og standardværdier:

| noegle | standard | betydning |
|---|---|---|
| `traef_navn` | `Træf-butikken` | vises øverst |
| `butik_aaben` | `1` | 0 = kunder kan se varer, men ikke bestille |
| `tilmelding_aaben` | `1` | 0 = kun personalet kan oprette deltagere |
| `levering_min_oere` | `10000` | mindste ordrebeløb for "bring til min plads" (0 = altid muligt) |
| `levering_aktiv` | `1` | 0 = kun afhentning |
| `mobilepay_nr` | `` | vises på kundens "Sæt penge ind"-side |
| `personale_kode` | – | hash+salt; sættes første gang `/admin` åbnes (`/api/personale/opsaet`) |

PIN og personalekode hashes med `crypto.scryptSync` og salt. Kunde-PIN: 4–6 cifre. PC-nr: 1–9999.

## API

JSON ind og ud. Fejl: HTTP 4xx med `{ "fejl": "dansk besked til brugeren", "kode": "kort_id" }`.
Login giver en cookie: `kunde=<token>` eller `personale=<token>` (HttpOnly, SameSite=Lax, Path=/, 30 dage).
Rate limit: maks 10 forkerte logins pr. PC-nr pr. 5 min (kode `for_mange_forsoeg`).

Objekter:
```
Deltager  { id, pc_nr, navn, saldo_oere }
Vare      { id, navn, beskrivelse, kategori, pris_oere, billede_url, aktiv, udsolgt, sortering }
Ordre     { id, nr, pc_nr, navn, total_oere, levering, note, status, oprettet, opdateret,
            linjer: [{ vare_id, navn, pris_oere, antal }] }        -- nr = id, vises som "#23"
Indbetaling { id, pc_nr, navn, beloeb_oere, metode, reference, status, oprettet, behandlet }
```

Offentligt:
- `GET  /api/info` → `{ traef_navn, butik_aaben, tilmelding_aaben, levering_aktiv, levering_min_oere, mobilepay_nr, personale_opsat }`
- `GET  /api/varer` → `[Vare]` kun aktive, sorteret efter `sortering`, `navn`
- `GET  /billeder/<fil>` → billedfil

Kunde (kræver `kunde`-cookie, ellers 401 `ikke_logget_ind`):
- `POST /api/kunde/tilmeld { pc_nr, navn, pin }` → `Deltager` + cookie. 409 `pc_optaget` hvis PC-nr findes.
- `POST /api/kunde/login { pc_nr, pin }` → `Deltager` + cookie. 401 `forkert_login`.
- `POST /api/kunde/logout`
- `GET  /api/kunde/mig` → `Deltager`
- `POST /api/kunde/ordrer { linjer: [{ vare_id, antal }], levering, note }` → `Ordre`
  Serveren regner selv prisen ud. Fejl: `butik_lukket`, `tom_kurv`, `vare_findes_ikke`, `vare_udsolgt`,
  `levering_ikke_mulig` (under grænsen eller levering slået fra), `ikke_nok_penge`. Antal 1–20 pr. linje.
- `GET  /api/kunde/ordrer` → `[Ordre]` nyeste først
- `POST /api/kunde/ordrer/:id/annuller` → `Ordre` – kun egen ordre med status `ny`
- `POST /api/kunde/indbetalinger { beloeb_oere, metode, reference }` → `Indbetaling` (status `afventer`)
- `GET  /api/kunde/indbetalinger` → `[Indbetaling]`
- `GET  /api/kunde/stream` (SSE) → `event: ordre` data=`Ordre` · `event: saldo` data=`{ saldo_oere }` ·
  `event: indbetaling` data=`Indbetaling` · `event: info` data=`/api/info`-svar. Kommentar `: ping` hvert 20. sek.

Personale (kræver `personale`-cookie, ellers 401):
- `POST /api/personale/opsaet { kode }` – kun hvis ingen kode er sat. Min. 6 tegn. Logger ind.
- `POST /api/personale/login { kode }` / `POST /api/personale/logout`
- `GET  /api/butik/ordrer?status=ny,laves,klar` → `[Ordre]` ældste først. Uden `status`: alle aktive + leveret/annulleret fra de sidste 2 timer.
- `POST /api/butik/ordrer/:id/status { status }` → `Ordre`. Lovlige skift: ny→laves, laves→klar, klar→leveret,
  ny/laves→annulleret (refunderer), samt ét skridt tilbage (laves→ny, klar→laves). Ellers 409 `ugyldigt_skift`.
- `GET  /api/butik/stream` (SSE) → `event: ordre` data=`Ordre` · `event: indbetaling` data=`Indbetaling`
- `GET/POST /api/admin/varer`, `PUT/DELETE /api/admin/varer/:id` (DELETE = sæt aktiv 0)
- `POST /api/admin/varer/:id/billede` – rå billeddata i body, `Content-Type: image/png|jpeg|webp|gif|svg+xml`, maks 3 MB
- `GET  /api/admin/deltagere?q=` → `[Deltager]` (søg på pc_nr eller navn)
- `POST /api/admin/deltagere { pc_nr, navn, pin }`, `PUT /api/admin/deltagere/:id { navn?, pin? }`
- `POST /api/admin/deltagere/:id/saldo { beloeb_oere, tekst }` – manuel justering (+/-)
- `GET  /api/admin/deltagere/:id/bevaegelser` → kontoudtog
- `GET  /api/admin/indbetalinger?status=afventer` → `[Indbetaling]`
- `POST /api/admin/indbetalinger/:id/godkend` / `.../afvis`
- `GET/PUT /api/admin/indstillinger` (alle undtagen `personale_kode`)
- `GET  /api/admin/rapport` → `{ omsaetning_oere, antal_ordrer, pr_vare: [{ navn, antal, beloeb_oere }], indbetalt_oere, samlet_saldo_oere }`

Sider: `/` → `public/kunde/index.html`, `/butik` → `public/butik/index.html`, `/admin` → `public/admin/index.html`.

## Standardvarer (første start)

Coca-Cola 0,5 l 20 kr · Coca-Cola Zero 0,5 l 20 kr · Fanta 0,5 l 20 kr · Faxe Kondi 0,5 l 20 kr ·
Monster Energy 25 kr · Red Bull 25 kr · Vand 10 kr · Kaffe 10 kr · Toast med skinke og ost 25 kr ·
Toast med ost 20 kr · Pose vingummi 15 kr · Chips 20 kr · Snickers 12 kr · Pizza-slice 30 kr.
Kategorier: `Drikke`, `Energi`, `Mad`, `Slik og snacks`. Hver får et simpelt, flot SVG-billede i `data/standard/`.

## Udseende

Mørkt gamer-/LAN-look med neonaccenter, stor tydelig tekst. Kundesiden skal være hurtig at bruge midt i et
spil: få klik, store knapper, varebilleder i et gitter, kurv i siden. Butiksskærmen læses på afstand:
store PC-numre, kolonner pr. status, nye ordrer med lyd og blink. Begge virker ned til 360 px bredde.
