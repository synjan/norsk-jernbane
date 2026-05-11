# Norsk jernbane — kart + dashbord

Statisk webapp som viser norsk jernbaneinfrastruktur fra OpenStreetMap, med
filter-kart (elektrifisering, hastighet, sporvidde), statistikk-dashbord og
sub-sider per bane, stasjon og tog (sanntid).

> **For utviklere:** se [`CLAUDE.md`](CLAUDE.md) for invarianter og
> konvensjoner, og [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for
> modulkart og data-flyt.

## Komme i gang

```bash
# 1. Lag virtuelt miljø og installer Python-avhengigheter
python -m venv .venv
. .venv/Scripts/activate          # Windows (Git Bash)
# . .venv/bin/activate            # macOS/Linux
pip install -r requirements.txt

# 2. Installer Node-avhengigheter (kun for tester)
npm install

# 3. Hent data fra Overpass (én gang, tar 1–3 min)
npm run fetch
# (eller direkte: python data/fetch.py)

# 4. Prosesser til GeoJSON + stats
npm run process

# 5. (valgfritt) Hent berikende datasett
python data/fetch_routes.py             # OSM togrute-relasjoner
python data/fetch_wikidata_stations.py  # bilder/fredning/arkitekt fra Wikidata
python data/fetch_planoverganger.py     # NVDB jernbanekryssinger

# 6. Server frontend (i ett terminalvindu)
npm start
# Åpne http://localhost:5174
```

## Tester

23 testfiler i `tests/` bruker Playwright. Start serveren først, så:

```bash
npm test            # CI-trygge tester (~60 s, ingen ekstern API)
npm run test:local  # alle som ikke krever Entur
npm run test:all    # alle, inkludert Entur-baserte
```

Andre port?

```bash
python -m http.server -d public 8080
BASE_URL=http://localhost:8080 npm test
```

CI kjører automatisk på push/PR via `.github/workflows/ci.yml`. Se
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#test-strategi) for kategorier.

## Struktur

```
data/             Python-pipeline (henter + prosesserer OSM-data)
public/           Statisk webapp (Leaflet + Chart.js, ingen byggesteg)
public/data/      Generert GeoJSON + stats.json (output av pipelinen)
tests/            Playwright-tester (.test.js)
scripts/          CLI-skript (test-runner, screenshot/demo-skript)
docs/             Arkitektur og bakgrunnsdokumenter
.github/workflows/ CI-workflows
```

For detaljert modulkart, se [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Datakilder
- **OpenStreetMap** via Overpass API — spor, stasjoner, togrute-relasjoner (ODbL)
- **Entur JourneyPlanner** GraphQL — togavganger og driftsmeldinger (NLOD)
- **Entur Vehicles** GraphQL — sanntid togposisjoner (NLOD)
- **Wikidata** SPARQL — bilder, åpningsår, arkitekt, kulturminnestatus
  (CC0; bilder CC-BY/CC-BY-SA)
- **Statens vegvesen NVDB** — jernbanekryssinger (NLOD)

Data er lisensiert under ODbL / NLOD / CC. Husk attribusjon ved bruk.

## Forventet versjoner
- **Python** 3.11+ (CI bruker 3.11)
- **Node** 20 (se `.nvmrc`)
