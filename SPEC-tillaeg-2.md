# Tillæg 2 – varekatalog og regneark

Brugerens ønsker: (1) admin kan hente salget som regneark, (2) admin kan tilføje varer, (3) der skal være mange flere
varer at vælge imellem, og admin kan krydse af, hvilke butikken vil sælge.

## A. Varekatalog

Varer kommer fra katalogfiler i `data/standard/`: alle filer der matcher `katalog*.json` læses i alfabetisk rækkefølge.
Hver fil er et array af:

```json
{ "katalog_id": "pepsi-max-05", "navn": "Pepsi Max 0,5 l", "beskrivelse": "Uden sukker", "kategori": "Drikke",
  "pris_oere": 2000, "billede": "pepsi-max.svg", "standard_aktiv": false, "sortering": 140 }
```

- `katalog_id`: unik, små bogstaver, tal og bindestreger. Ændres aldrig.
- `billede`: filnavn i `data/standard/` (SVG, ca. 200×200 viewBox, samme stil som de eksisterende 14).
- `standard_aktiv`: om varen sælges fra start. De 14 eksisterende er `true`, alle nye er `false`.
- Kategorier, i denne rækkefølge: `Drikke`, `Energi`, `Varme drikke`, `Mad`, `Morgenmad`, `Slik og snacks`,
  `Frugt og sundt`, `Udstyr`. (Kaffe flyttes til `Varme drikke`.)
- `katalog.json` (hjælper 1) indeholder de 14 eksisterende varer. `katalog-2.json` (hjælper 2) indeholder de nye.

Database: ny kolonne `varer.katalog_id TEXT UNIQUE` (NULL for varer, admin selv opretter).
Ved hver start: varer fra katalogfilerne, hvis `katalog_id` ikke findes i databasen, oprettes med `aktiv = standard_aktiv`.
Eksisterende varer ændres aldrig af kataloget (admin kan have rettet pris, navn eller billede). Eksisterende databaser
fra før tillæg 2 migreres: tilføj kolonnen, og giv de 14 standardvarer deres `katalog_id` ved at matche på navn.
Kun billedfiler (svg, png, jpg, jpeg, webp, gif) kopieres fra `data/standard/` til `<DATA_DIR>/billeder/`.

"Aktiv" betyder nu **"sælges"**. Kunderne ser kun varer, der sælges. Admin ser alle.

API:
- `GET  /api/admin/varer` → alle varer inkl. dem, der ikke sælges, med `katalog_id`.
- `POST /api/admin/varer/aktiv { ids: [..], aktiv: true|false }` → `{ opdateret: n }` – sæt "sælges" for mange på én
  gang i én transaktion; kunderne får ét `event: varer`.
- `GET  /api/admin/kategorier` → `["Drikke", …]` i rækkefølgen ovenfor, efterfulgt af evt. egne kategorier.
- Opret/ret vare som før (admin kan vælge en kategori fra listen eller skrive en ny).

## B. Salg som regneark

- `GET /api/admin/eksport.xlsx` (personale) → en rigtig Excel-fil (`.xlsx`) bygget uden npm-pakker (zip via
  `node:zlib` `deflateRawSync` og `zlib.crc32`). `Content-Disposition: attachment; filename="<traef-navn>-salg-<YYYY-MM-DD>.xlsx"`.
- Faner (kolonneoverskrifter fede, frosset første række, fornuftige kolonnebredder, autofilter):
  1. **Oversigt**: træffets navn, udskrevet tidspunkt, omsætning, antal ordrer, annullerede ordrer, indbetalt,
     udbetalt, samlet saldo hos deltagerne, og "Regnskabet går op: Ja/Nej".
  2. **Salg pr. vare**: Vare, Kategori, Antal solgt, Beløb – sorteret efter beløb, med totalrække.
  3. **Salg pr. time**: Time (fx "fre 18:00"), Antal ordrer, Beløb.
  4. **Ordrer**: Ordrenr, Tidspunkt, PC, Navn, Levering (Bring til plads/Afhentning), Status, Varer (tekst), Note, Total.
  5. **Ordrelinjer**: Ordrenr, Tidspunkt, PC, Navn, Vare, Kategori, Antal, Stykpris, Beløb, Status.
  6. **Indbetalinger**: Tidspunkt, PC, Navn, Beløb, Metode, Reference, Status.
  7. **Udbetalinger**: Tidspunkt, PC, Navn, Beløb, Metode, Reference.
  8. **Deltagere**: PC, Navn, Indbetalt, Brugt, Udbetalt, Saldo nu.
- Beløb er tal-celler i kroner med talformatet `#,##0.00 "kr."`; tidspunkter er dato-celler i dansk tid
  (Europe/Copenhagen) med formatet `dd-mm-yyyy hh:mm`. Annullerede ordrer står med status, men tæller ikke med i salg.
- Filen skal kunne åbnes uden fejl i Excel, LibreOffice og Google Sheets (gyldig OOXML: `[Content_Types].xml`,
  `_rels/.rels`, `xl/workbook.xml`, `xl/_rels/workbook.xml.rels`, `xl/styles.xml`, `xl/sharedStrings.xml` eller
  inline strings, `xl/worksheets/sheetN.xml`). Escape XML korrekt (&, <, >, " og kontroltegn).
