# Norsk jernbane — kart + dashbord

Statisk webapp som viser norsk jernbaneinfrastruktur fra OpenStreetMap, med
filter-kart (elektrifisering, hastighet, sporvidde) og statistikkpanel.

## Komme i gang

```bash
# 1. Lag virtuelt miljø og installer avhengigheter
python -m venv .venv
. .venv/Scripts/activate     # Windows (Git Bash)
pip install -r requirements.txt

# 2. Hent data fra Overpass (én gang, tar 1–3 min)
python data/fetch.py

# 3. Prosesser til GeoJSON + stats
python data/process.py

# 4. (valgfritt) Hent berikende datasett
python data/fetch_routes.py            # OSM togrute-relasjoner
python data/fetch_wikidata_stations.py # bilder/fredningsstatus fra Wikidata
python data/fetch_planoverganger.py    # NVDB jernbanekryssinger

# 5. Server frontend
python -m http.server -d public 5174
# Åpne http://localhost:5174

# Annen port? Sett env-variabel for testene:
#   python -m http.server -d public 8080
#   BASE_URL=http://localhost:8080 npm test
```

## Struktur

- `data/` — Python-pipeline som henter og prosesserer OSM-data
- `public/` — Statisk webapp (Leaflet + Chart.js, ingen byggesteg)
- `public/data/` — Genererte GeoJSON- og JSON-filer (output fra pipelinen)

## Datakilder
- OpenStreetMap via Overpass API — spor, stasjoner, togrute-relasjoner (ODbL)
- Entur JourneyPlanner GraphQL — togavganger og driftsmeldinger (NLOD)
- Entur Vehicles GraphQL — sanntid togposisjoner (NLOD)
- Wikidata SPARQL — bilder, åpningsår, arkitekt, kulturminnestatus (CC0; bilder CC-BY/CC-BY-SA)
- Statens vegvesen NVDB — jernbanekryssinger (NLOD)

Data er lisensiert under ODbL / NLOD / CC. Husk attribusjon ved bruk.
