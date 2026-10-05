# Tillæg 3 – personale med roller (admin og ekspedient)

Brugeren har besluttet: hver medarbejder har sin egen konto (navn + kode), og der er to roller.

## Rettigheder

| Opgave | Ekspedient | Admin |
|---|---|---|
| Butiksskærmen: se ordrer, Start → Klar → Leveret, Tilbage | ✅ | ✅ |
| Markere varer udsolgt / på lager | ✅ | ✅ |
| Check-in (opret deltager med PIN og startbeløb), søg deltagere, ret navn | ✅ | ✅ |
| Se en deltagers kontoudtog | ✅ | ✅ |
| Godkende / afvise indbetalinger | ✅ | ✅ |
| Annullere ordrer (refusion) | ✅ | ✅ |
| Nulstille PIN | ✅ | ✅ |
| Manuel saldojustering, udbetaling af restsaldo, udbetalingsliste | ❌ | ✅ |
| Varer: opret, ret, billede, sælges/sælges ikke, kategorier | ❌ | ✅ |
| Indstillinger, rapport, regneark (`eksport.xlsx`) | ❌ | ✅ |
| Personale: opret, ret, skift rolle/kode, spær | ❌ | ✅ |

Kald uden rettighed: 403 `{ fejl: "Det kræver admin-rettigheder.", kode: "kraever_admin" }`.

## Data

```
personale(id, navn UNIQUE COLLATE NOCASE, rolle 'admin'|'ekspedient', kode_salt, kode_hash, aktiv 0/1, oprettet, sidst_logget_ind)
sessioner: + personale_id (for type 'personale')
ordre_haendelser(id, ordre_id, status, personale_id NULL, deltager_id NULL, tid)   -- hver statusændring, også kundens egen annullering
indbetalinger: + behandlet_af (personale_id)
udbetalinger: + udfoert_af (personale_id)
saldo_bevaegelser: + personale_id NULL
deltagere: + oprettet_af NULL
```

Migration: findes `personale_kode` i indstillinger fra før, oprettes en admin-konto med navnet "Admin" og samme
salt/hash, og indstillingen slettes. Gamle personale-sessioner udløber (alle logger ind igen).

## API

- `GET  /api/info`: `personale_opsat` = der findes mindst én aktiv admin.
- `POST /api/personale/opsaet { navn, kode }` – kun når der ikke findes nogen personale; opretter første admin og logger ind.
- `POST /api/personale/login { navn, kode }` → `{ id, navn, rolle }` + cookie. Forkert: 401 `forkert_login` (samme
  besked uanset om navnet findes). Spærret konto: 401 `forkert_login`. Rate limit 10 forsøg pr. navn pr. 5 min.
- `GET  /api/personale/mig` → `{ id, navn, rolle }`.
- `GET  /api/admin/personale` → `[{ id, navn, rolle, aktiv, oprettet, sidst_logget_ind }]` (admin)
- `POST /api/admin/personale { navn, rolle, kode }` (admin), `PUT /api/admin/personale/:id { navn?, rolle?, kode?, aktiv? }` (admin).
  Man kan ikke fjerne/spærre/nedgradere den sidste aktive admin (409 `sidste_admin`). Spærring logger kontoen ud med det samme.
  Kode: min. 6 tegn.
- Ekspedienter bruger: `GET /api/butik/varer` (alle aktive varer inkl. udsolgt) og
  `POST /api/butik/varer/:id/udsolgt { udsolgt }` til udsolgt-listen på butiksskærmen. `PUT /api/admin/varer/:id` er admin.
- Ekspedienter må: `GET /api/admin/deltagere`, `POST /api/admin/deltagere` (check-in), `PUT /api/admin/deltagere/:id`
  med `navn`, `pin` eller `nulstil_pin`, `GET …/bevaegelser`, alle `/api/admin/indbetalinger*`, alle `/api/butik/*`.
  Alt andet under `/api/admin/` er admin.

## Hvem gjorde hvad

- Ordre-objektet får `haendelser: [{ status, af, tid }]` (af = personalets navn, "Kunden" eller "System").
- Indbetaling får `behandlet_af` (navn), udbetaling `udfoert_af`, kontoudtog `af`.
- Regnearket (tillæg 2) får kolonnen "Udført af"/"Godkendt af" i Ordrer (leveret af / annulleret af), Indbetalinger og
  Udbetalinger, og en ekstra fane **Personale**: navn, rolle, ordrer flyttet til klar, ordrer leveret, ordrer annulleret,
  indbetalinger godkendt (antal og beløb), deltagere checket ind.

## Sider

- Login på `/butik` og `/admin`: navn + kode. Første gang: "Opret første admin" (navn, kode, gentag kode).
- Topbjælke viser "Logget ind som Mads (ekspedient)" og knapperne **"Skift bruger"** (log ud og direkte til login – til
  den fælles skærm bag disken) og "Log ud".
- `/admin` viser kun de faner, rollen må: ekspedient → Check-in, Deltagere (uden saldojustering), Indbetalinger.
  Admin → alle + ny fane **Personale** (liste, opret, ret, skift rolle, ny kode, spær/genaktivér).
- Butiksskærmen: knappen "Admin" vises for begge (ekspedienten kommer til sine faner). Ordrekort kan vise "af Mads" i
  et værktøjstip / foldet ud.
