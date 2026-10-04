# Tests

Alt køres med den bærbare Node (ingen npm-pakker). Hver test starter selv serveren (`server/server.js`) på en
ledig port med en ny midlertidig `DATA_DIR`, så den rigtige `data/` aldrig røres.

```
test\koer-tests.cmd           alle tests + kort oversigt (ca. 30 sek.)
test\koer-tests.cmd hurtig    uden belastningstesten
```

Enkeltvis (fra projektmappen):

```
runtime\node\node.exe --test test\api.test.js    API-tests efter SPEC.md + tillæg 1 (node:test)
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
- `belastning.js` – svartider (median/p95/maks) og tjek af 500-fejl, saldi, SSE og regnskab.
- `browser.js` – JavaScript-fejl, fejlede filer, eksterne forespørgsler (skal virke uden internet), vandret
  scroll ved 360 px, og at nye ordrer/status dukker op live.

## Godt at vide

- Windows-klienter afviser ~200+ HELT samtidige nye TCP-forbindelser på loopback (også mod en tom server).
  Belastningstesten bruger derfor keep-alive (som browsere) og spreder klikkene over 0,5 sek.
- "Omsætning" tolkes som summen af alle ikke-annullerede ordrer (også dem der ikke er leveret endnu) –
  ellers kan "indbetalt = omsætning + udbetalt + samlet saldo" ikke gå op.
