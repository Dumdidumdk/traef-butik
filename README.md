# Træf-butik

Bestillingssystem til computertræf. Deltagerne bestiller sodavand, slik og toast fra deres egen computer
og betaler med en forudbetalt saldo. Butikken ser ordrerne live bag disken. Virker uden internet.

## Sådan kommer du i gang

1. Kopiér hele mappen `traef-butik` (inkl. `runtime`) over på bærbaren ved disken.
2. Dobbeltklik på **`start-butik.cmd`**. Vinduet viser adresserne, fx:
   ```
   Kundesiden:   http://192.168.1.20:3000
   Butiksskærm:  http://192.168.1.20:3000/butik
   Admin:        http://192.168.1.20:3000/admin
   ```
   Lad vinduet stå åbent, så længe butikken skal køre. Windows spørger måske, om Node.js må bruge netværket –
   svar **Tillad** på private netværk.
3. Åbn **Admin** og opret en personalekode (min. 6 tegn). Den samme kode bruges på butiksskærmen.
4. Under **Indstillinger**: skriv træffets navn og butikkens MobilePay-nummer, og tjek grænsen for levering (100 kr.).
5. Under **Varer**: ret priser, slå varer fra og upload egne billeder.
6. Åbn **Butiksskærmen** på skærmen bag disken.

## Under træffet

- **Check-in ved indgangen:** Admin → Check-in. Skriv PC-nr og navn, vælg evt. startbeløb, tryk Opret.
  Deltageren får en seddel med PC-nr, PIN og adressen til kundesiden.
- **Deltageren** åbner kundesiden, logger ind med PC-nr og PIN, bestiller og vælger "Bring til min plads"
  (kun over grænsen) eller "Jeg henter selv". Siden siger til med lyd, når ordren er klar.
- **Butikken** trykker Start → Klar → Leveret/Afhentet på butiksskærmen. Annullerer man, får kunden pengene tilbage.
- **Penge ind:** deltageren sender på MobilePay og trykker "Jeg har betalt" – butikken godkender på butiksskærmen
  eller under Admin → Indbetalinger. Kontant ved disken: Admin → Deltagere → justér saldo, eller check-in-startbeløb.
- **Glemt PIN:** Admin → Deltagere → Nulstil PIN.

## Når træffet slutter

Admin → **Udbetaling** viser alle med penge tilbage. Send pengene retur og tryk "Udbetalt".
Admin → **Rapport** viser omsætning, salg pr. vare og om regnskabet går op.

Data ligger i `data/butik.db`. Tag en kopi af mappen `data` efter træffet, hvis du vil gemme regnskabet.

## For udviklere

- Byggeplanen står i [SPEC.md](SPEC.md). Node.js 24 uden npm-pakker; database `node:sqlite`; live via SSE.
- Mangler `runtime\node`, så hent Node.js 24 (Windows x64 zip) fra nodejs.org og pak den ud som `runtime\node`.
- Tests: `test\koer-tests.cmd` (API, belastning med 250 kunder og browser), se [test/README.md](test/README.md).
