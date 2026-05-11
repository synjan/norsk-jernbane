# Norsk jernbane — kart, sanntid og innsikt

> 🌐 **Live versjon: [synjan.github.io/norsk-jernbane](https://synjan.github.io/norsk-jernbane/)**

Interaktivt kart over norsk jernbane med:

- Alle spor, stasjoner, holdeplasser (fra OpenStreetMap)
- Sanntids togposisjoner og avganger (fra Entur)
- Statistikk om elektrifisering, tunneler, broer, fart, dobbeltspor
- Egen side per bane og per stasjon med bilder og historikk

Alt er åpne data. Alt kjører i nettleseren — ingen backend, ingen brukere, ingen innlogging.

---

## 🗺 For deg som bare vil se kartet

Åpne **[synjan.github.io/norsk-jernbane](https://synjan.github.io/norsk-jernbane/)**.

Du trenger ikke installere noe. Det fungerer på telefon, nettbrett og PC.

---

## 👨‍💻 For deg som vil endre på prosjektet

Hele prosjektet består av tre deler:

1. **Datainnsamling** (Python) — henter data fra OpenStreetMap og lagrer som filer.
2. **Nettsider** (HTML + JavaScript) — viser dataene som kart og statistikk.
3. **Sanntid** (Entur API) — henter togposisjoner direkte fra nettleseren.

Du trenger ikke forstå alt for å gjøre små endringer. De fleste endringer skjer i `public/`-mappen.

### Installer nødvendige verktøy

Du må ha disse installert (gratis):

- **[Python 3.11+](https://www.python.org/downloads/)** — for å oppdatere data
- **[Node 20+](https://nodejs.org/)** — for å kjøre tester
- **[Git](https://git-scm.com/downloads)** — for å lagre endringer

På Windows får du Git Bash ved å installere Git. Bruk Git Bash som terminal under.

### Sett opp prosjektet (én gang)

```bash
# Last ned koden
git clone https://github.com/synjan/norsk-jernbane.git
cd norsk-jernbane

# Lag et eget Python-miljø for prosjektet
python -m venv .venv
. .venv/Scripts/activate          # Windows
# . .venv/bin/activate            # Mac / Linux
pip install -r requirements.txt

# Installer Node-verktøy (brukes til tester)
npm install
```

### Start nettsiden lokalt

```bash
npm start
```

Åpne `http://localhost:5174` i nettleseren. Endrer du en fil i `public/`, last siden på nytt for å se endringen — ingen omstart trengs.

---

## 🛠 Vanlige oppgaver

### "Jeg vil endre en tekst eller farge"

1. Finn fila i `public/`. F.eks. tekster på forsiden ligger i `public/index.html`, farger og layout i `public/style.css`.
2. Endre, lagre, last siden på nytt.
3. Når du er fornøyd: kjør `git commit` og `git push` (se nederst).

### "Jeg vil legge til en ny statistikk på innsikt-siden"

1. Sjekk at tallet finnes i `public/data/stats.json` — åpne fila og søk.
2. Hvis ja: legg til i `public/dashboard.js` etter mønster av andre `render*`-funksjoner. HTML-strukturen ligger i `public/dashboard.html`.
3. Hvis nei: tallet må beregnes i Python-pipelinen — se "Oppdater data" nedenfor.

### "Jeg vil oppdatere dataene (nyere stasjoner, nye spor)"

Data hentes fra OpenStreetMap. OSM endrer seg hele tiden (folk legger til/endrer data). For å hente fersk versjon:

```bash
# Slett gammel rådata
rm data/raw.json

# Hent på nytt fra OpenStreetMap (tar 1-3 minutter)
npm run fetch

# Konverter til kart-format
npm run process

# Bonus: oppdater bilder og fredning-info fra Wikidata
python data/fetch_wikidata_stations.py

# Bonus: oppdater planoverganger fra Statens vegvesen
python data/fetch_planoverganger.py
```

Etter dette har `public/data/`-mappen nye filer. Commit dem og push for å oppdatere live-siden.

### "Jeg vil teste at jeg ikke ødela noe"

```bash
# I én terminal: start siden
npm start

# I en annen terminal: kjør tester
npm test
```

Hvis alt sier "Alt OK" — du har ikke ødelagt noe. Hvis noe feiler, les feilmeldingen — den peker oftest til hvilken fil som har problemet.

### "Jeg vil lagre endringer og publisere"

Hver push til `main`-branchen oppdaterer live-siden automatisk (tar ~30 sekunder).

```bash
git add .                                   # marker alle endringer
git commit -m "Beskriv hva du endret"       # lagre lokalt
git push                                    # send til GitHub
```

Følg deployen på [Actions-fanen](https://github.com/synjan/norsk-jernbane/actions).

---

## 📁 Hva ligger hvor?

```
norsk-jernbane/
├── public/              ← nettsidene (HTML/JS/CSS)
│   ├── index.html         hovedkart
│   ├── dashboard.html     innsikt / statistikk
│   ├── bane.html          én bane (Bergensbanen, Nordlandsbanen ...)
│   ├── stasjon.html       én stasjon
│   ├── tog.html           ett tog (sanntid)
│   └── data/              genererte data-filer
├── data/                ← Python-skript som lager dataene
│   ├── fetch.py           henter spor og stasjoner fra OSM
│   ├── process.py         lager kart-filene fra rådata
│   └── fetch_*.py         hjelpe-skript for spesifikke kilder
├── tests/               ← automatiske tester
├── scripts/             ← verktøy (test-runner, skjermbilder)
├── docs/                ← teknisk dokumentasjon
└── README.md            ← du leser den nå
```

For utviklere som vil forstå mer, se:
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — modulkart og data-flyt
- [`CLAUDE.md`](CLAUDE.md) — invarianter og navnekonvensjoner

---

## 🗃 Datakilder og lisens

| Kilde | Hva |
|-------|-----|
| **OpenStreetMap** (ODbL) | Spor, stasjoner, signaler, sporveksler |
| **Entur** (NLOD) | Togavganger og sanntids togposisjoner |
| **Wikidata** (CC0) | Bilder, åpningsår, arkitekter, fredning |
| **Statens vegvesen NVDB** (NLOD) | Jernbanekryssinger |

Alle data er åpne og kan brukes — husk kildeattribusjon.

---

## ❓ Hva gjør jeg når noe ikke fungerer?

1. **Sjekk nettleserens konsoll** (F12 → Console-fanen). Feilmeldinger her peker som regel til hvilken fil som har problemet.
2. **Kjør `npm test`** — automatiske tester fanger mange feil før de når brukeren.
3. **Sjekk GitHub Actions** — hvis deploy feilet ser du det på [Actions-fanen](https://github.com/synjan/norsk-jernbane/actions).
4. **Spør** — opprett en [issue](https://github.com/synjan/norsk-jernbane/issues).
