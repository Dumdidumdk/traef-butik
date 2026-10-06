# Træf-butik

Bestillingssystem til computertræf. Deltagerne bestiller sodavand, slik og toast fra deres egen computer
og betaler med en forudbetalt saldo. Butikken ser ordrerne live bag disken. Virker uden internet.

## Sådan kommer du i gang

1. Kopiér hele mappen `traef-butik` (inkl. `runtime`) over på bærbaren ved disken – eller hent den færdige pakke
   **traef-butik-klar-til-brug-vX.zip** under [Releases](https://github.com/Dumdidumdk/traef-butik/releases)
   (med Node.js indeni) og pak den ud.
2. Dobbeltklik på **`start-butik.cmd`**. Vinduet viser adresserne, fx:
   ```
   Kundesiden:   http://192.168.1.20:3000
   Butiksskærm:  http://192.168.1.20:3000/butik
   Admin:        http://192.168.1.20:3000/admin
   ```
   Lad vinduet stå åbent, så længe butikken skal køre. Windows spørger måske, om Node.js må bruge netværket –
   svar **Tillad** på private netværk.
3. Åbn **Admin** og opret den første admin (dit navn og en kode på min. 6 tegn).
4. Under **Personale**: opret en konto til hver medarbejder (navn, kode og rolle – se nedenfor).
5. Under **Indstillinger**: skriv træffets navn og butikkens MobilePay-nummer, og tjek grænsen for levering (100 kr.).
6. Under **Varer**: kryds af, hvilke af de 88 varer butikken sælger ("Vælg alle"/"Fravælg alle" pr. kategori),
   ret priser, upload egne billeder, eller tilføj nye varer med **"+ Ny vare"**.
7. Åbn **Butiksskærmen** på skærmen bag disken.

## Personale og roller

Hver medarbejder logger ind med sit eget navn og sin egen kode. Systemet husker, hvem der gjorde hvad.

| | Ekspedient | Admin |
|---|---|---|
| Butiksskærmen, udsolgt, check-in, godkende indbetalinger, annullere ordrer, nulstille PIN | ✅ | ✅ |
| Saldojustering, udbetaling, varer og priser, indstillinger, rapport, regneark, personale | ❌ | ✅ |

På den fælles skærm bag disken trykker man **"Skift bruger"**, når en anden overtager.

## Under træffet

- **Check-in ved indgangen:** Admin → Check-in. Skriv PC-nr og navn, vælg evt. startbeløb, tryk Opret.
  Deltageren får en seddel med PC-nr, PIN og adressen til kundesiden.
- **Deltageren** åbner kundesiden, logger ind med PC-nr og PIN, bestiller og vælger "Bring til min plads"
  (fra grænsen) eller "Jeg henter selv". Siden siger til med lyd, når ordren er klar.
- **Butikken** trykker Start → Klar → Leveret/Afhentet på butiksskærmen. Annullerer man, får kunden pengene tilbage.
- **Penge ind:** deltageren sender på MobilePay og trykker "Jeg har betalt" – butikken godkender på butiksskærmen
  eller under Admin → Indbetalinger. Kontant ved disken: check-in-startbeløb, eller Admin → Deltagere → justér saldo.
- **Glemt PIN:** Admin → Deltagere → Nulstil PIN.
- **Udsolgt:** knappen "Udsolgt" på butiksskærmen.

## Når træffet slutter

- Admin → **Udbetaling** viser alle med penge tilbage. Send pengene retur og tryk "Udbetalt".
- Admin → **Rapport** viser omsætning, salg pr. vare og om regnskabet går op.
- **"Hent salget som regneark (Excel)"** giver en fil med fanerne Oversigt, Salg pr. vare, Salg pr. time, Ordrer,
  Ordrelinjer, Indbetalinger, Udbetalinger, Deltagere og Personale.

Data ligger i `data/butik.db`. Tag en kopi af mappen `data` (og regnearket) efter træffet.

## Opdatering

Fra v1.2 tjekker `start-butik.cmd` selv, om der er en nyere version på GitHub (højst 3 sek.; uden internet starter
butikken bare som normalt). Findes der en, spørger den **"Ny version vX findes - opdatér nu? (J/N)"**. Svarer du J:

1. Den nye zip hentes, kontrolleres og pakkes ud.
2. Mappen `data` kopieres til `backup\data-DATO-TID`.
3. Programfilerne (server, public, scripts, README, varekataloget i `data\standard` osv.) udskiftes. Din database og
   dine egne billeder i `data` røres ikke, og `runtime` beholdes, medmindre udgivelsen har en ny Node.js.
4. Butikken starter med den nye version.

Går noget galt, beholdes den gamle version, og den starter i stedet. Admin-siden viser også et lille
**"Ny version vX findes"** med link til udgivelsen, når serveren kan nå GitHub. Tjekket slås fra med
miljøvariablen `TRAEF_OPDATERING=0`. Har du v1.0 eller v1.1, skal v1.2 hentes og pakkes ud manuelt én gang
(kopiér din `data`-mappe med over).

## For udviklere

- Byggeplanen står i [SPEC.md](SPEC.md), [SPEC-tillaeg-2.md](SPEC-tillaeg-2.md) og [SPEC-tillaeg-3.md](SPEC-tillaeg-3.md).
  Node.js 24 uden npm-pakker; database `node:sqlite`; live via SSE.
- Varekataloget ligger i `data/standard/katalog*.json` med billeder. Nye katalogvarer tilføjes automatisk ved start
  (som "sælges ikke"), uden at ændre varer, admin har rettet.
- Mangler `runtime\node`, så hent Node.js 24 (Windows x64 zip) fra nodejs.org og pak den ud som `runtime\node`.
- Tests: `test\koer-tests.cmd` (API, opdatering, belastning med 250 kunder og browser), se [test/README.md](test/README.md).

### Ny udgivelse (release)

1. Ret versionsnummeret i **`version.json`** (fx `"version": "1.3"`) og commit.
2. Lav zip'en **`traef-butik-klar-til-brug-v1.3.zip`** med én mappe `traef-butik\` indeni: hele projektet med
   `runtime\node\node.exe` (uden npm), men **uden** `data\butik.db*`, `data\billeder`, `backup` og `opdatering`.
3. Opret udgivelsen på GitHub med tagget **`v1.3`** (samme nummer som i `version.json`) og vedhæft zip'en.

Opdateringen finder zip'en på navnet (`traef-butik-klar-til-brug-v*.zip`) og afviser pakken, hvis `version.json`
ikke er nyere end den installerede – glemmer man trin 1, sker der altså ingenting. En ny Node.js i pakken
installeres kun, hvis `node.exe` er anderledes end brugerens. Opdateringen kan testes uden GitHub med
`TRAEF_OPDATERING_URL` (se [test/README.md](test/README.md)).
