# Tests

Alt køres med den bærbare Node (ingen npm-pakker). Hver test starter selv serveren (`server/server.js`) på en
ledig port med en ny midlertidig `DATA_DIR`, så den rigtige `data/` aldrig røres.

```
test\koer-tests.cmd           alle tests + kort oversigt (ca. 30 sek.)
test\koer-tests.cmd hurtig    uden belastningstesten
```

Enkeltvis (fra projektmappen):

```
runtime\node\node.exe --test test\api.test.js        API-tests efter SPEC.md + tillæg 1 (node:test)
runtime\node\node.exe --test test\katalog.test.js    tillæg 2: varekatalog
runtime\node\node.exe --test test\migration.test.js  tillæg 2+3: migration af en gammel database
runtime\node\node.exe --test test\eksport.test.js    tillæg 2+3: salg som regneark (.xlsx)
runtime\node\node.exe --test test\roller.test.js     tillæg 3: personale med roller
runtime\node\node.exe --test test\opdatering.test.js automatisk opdatering (falsk GitHub, ingen internet nødvendigt)
runtime\node\node.exe test\belastning.js         250 kunder, SSE, samtidige ordrer, udbetaling
runtime\node\node.exe test\browser.js            /, /butik, /admin i headless Chrome
```

Miljøvariabler:

| Variabel | Betydning |
|---|---|
| `TRAEF_ROD` | test en anden kopi af projektet (fx en anden worktree) |
| `NODE` | sti til node.exe (ellers findes den bærbare automatisk) |
| `CHROME` | sti til chrome.exe (standard `C:\Program Files\Google\Chrome\Application\chrome.exe`) |
| `KUNDER` | antal kunder i belastningstesten (standard 250) |
| `SPREDNING_MS` | hvor spredt kundernes klik er i belastningstesten (standard 500 ms) |

## Filer

- `hjaelp.js` – start/stop af serveren, "browsere" med egne cookies og forbindelsespulje, SSE-læser med
  `vent(...)` (venter på hændelser i stedet for faste pauser), databasetjek af saldi.
- `api.test.js` – tilmeld/login/logout, rate limit, check-in med tilfældig PIN og startbeløb, varer, ordrer
  (serverpris, tom kurv, udsolgt, butik lukket, levering, ikke nok penge, samtidige ordrer), annullering,
  statusskift, indbetalinger, justering, udbetaling, adgang, SSE til rette modtager, billeder, sti-traversal,
  rapport. Efter hver test tjekkes, at saldo = sum af kontoudtog, og at ingen saldo er negativ.
- `katalog.test.js` – katalogfilerne (gyldige, unikke id, billeder), første start, kun aktive for kunder, bulk-aktiv
  med ét `varer`-event, kategorier, admins rettelser overlever genstart.
- `migration.test.js` – database i det gamle format (`gammel-db.js`) migreres uden tab; personale_kode → "Admin".
- `eksport.test.js` – pakker xlsx-filen ud med `xlsx.js` (egen zip- og XML-læser), tjekker faner, tal mod rapporten,
  dansk tid, talformater, escaping af `& < > "` og æøå, "Udført af" og fanen Personale.
- `roller.test.js` – rettigheder for admin og ekspedient på alle endpoints, sidste_admin, spærring (også SSE),
  rate limit pr. navn, hvem-gjorde-hvad.
- `opdatering.test.js` – versionsnumre, zip-udpakning (stier med `\`, over 260 tegn, `..`), og `scripts\opdater.js`
  mod en falsk GitHub (`TRAEF_OPDATERING_URL`) på en kopi af installationen i en midlertidig mappe: uden internet,
  GitHub svarer ikke (3 sek.), svar N/J, data\ bevares og kopieres til backup\, ny/samme node.exe, beskadiget
  download, glemt versionsnummer, syntaksfejl, fejl midt i udskiftningen (alt rulles tilbage), butikken kører
  allerede. `start-butik.cmd` køres helt: uden internet, og med J, hvor filen udskifter sig selv og den nye
  version starter. Til sidst `/api/admin/version` med og uden "internet". Alle andre tests kører med
  `TRAEF_OPDATERING=0`, så de aldrig spørger GitHub.
- `belastning.js` – svartider (median/p95/maks) og tjek af 500-fejl, saldi, SSE og regnskab.
- `browser.js` – JavaScript-fejl, fejlede filer, eksterne forespørgsler (skal virke uden internet), vandret
  scroll ved 360 px, og at nye ordrer/status dukker op live.

## Godt at vide

- Windows-klienter afviser ~200+ HELT samtidige nye TCP-forbindelser på loopback (også mod en tom server).
  Belastningstesten bruger derfor keep-alive (som browsere) og spreder klikkene over 0,5 sek.
- "Omsætning" tolkes som summen af alle ikke-annullerede ordrer (også dem der ikke er leveret endnu) –
  ellers kan "indbetalt = omsætning + udbetalt + samlet saldo" ikke gå op.
