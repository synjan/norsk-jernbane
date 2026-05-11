# Arkitektur

Denne fila forklarer *hvor logikken bor*. For invarianter og konvensjoner, se
`CLAUDE.md` i repo-roten.

## Tre lag

```
┌──────────────────────────────────────────────────────────────┐
│  data/  (Python)                                              │
│  ─── fetch.py ────────────► data/raw.json (gitignored)       │
│  ─── fetch_places.py ─────► data/places.json                 │
│  ─── fetch_routes.py ─────► public/data/routes_osm.json      │
│  ─── fetch_wikidata_*.py ─► public/data/wikidata_stations.json│
│  ─── fetch_planoverg*.py ─► public/data/planoverganger.geojson│
│  ─── process.py ──────────► public/data/{railways,stations}.geojson + stats.json + routes/*.geojson
└──────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────────┐
│  public/  (statisk, ingen byggesteg)                          │
│   ▶ index.html       — hovedkart                             │
│   ▶ dashboard.html   — aggregerte tall                       │
│   ▶ bane.html        — én bane (?navn=)                      │
│   ▶ stasjon.html     — én stasjon (?navn=)                   │
│   ▶ tog.html         — ett tog (?id=, sanntid)               │
│   ▶ planovergang.html — én kryssing (?id=)                   │
│   ▶ onepager.html    — narrativ landingsside                 │
│   ▶ leaflet-demo.html — frittstående plugin-evaluering       │
└──────────────────────────────────────────────────────────────┘
                            │
                            ▼ (frontend kaller direkte)
┌──────────────────────────────────────────────────────────────┐
│  Eksterne live-APIer                                          │
│   ▶ Entur JourneyPlanner  — avganger, situasjoner            │
│   ▶ Entur Vehicles        — sanntidsposisjoner               │
└──────────────────────────────────────────────────────────────┘
```

## Data-pipeline (`data/`)

Hver script er idempotent og kan kjøres alene. `process.py` er sannhetskilden
for stats.

| Fil | Henter / produserer | Kjøretid | Avhengig av |
|-----|---------------------|----------|-------------|
| `fetch.py` | OSM railway-tagger via Overpass → `raw.json` | ~1-3 min | Overpass-tilgjengelighet |
| `fetch_places.py` | Norske tettsteder med population → `places.json` | <30 s | Overpass |
| `fetch_routes.py` | OSM `route=train`-relasjoner → `routes_osm.json` + `station_routes.json` | ~30 s | Overpass |
| `fetch_wikidata_stations.py` | Stasjonsmetadata (åpningsår, fredning, arkitekt, bilder) | ~1 min | Wikidata SPARQL |
| `fetch_planoverganger.py` | NVDB jernbanekryssinger → `planoverganger.geojson` | ~30 s | NVDB API |
| `process.py` | `raw.json` + `places.json` (+ valgfritt wikidata/routes) → `railways.geojson`, `railways-overview.geojson`, `stations.geojson`, `stats.json`, `routes/*.geojson` | ~30 s | Output av fetch* |

**Minste kjøring for fungerende app:** `fetch.py` + `fetch_places.py` + `process.py`.
Resten (wikidata, routes, planoverganger) berikende.

## Frontend-moduler (`public/`)

### Toppnivå-sider

| Side | JS | Lastes også |
|------|------|-------------|
| `index.html` | `app.js` | `helpers.js`, `charts.js`, `entur.js`, `isochrone.js`, `topbar.js` |
| `dashboard.html` | `dashboard.js` | `helpers.js`, `charts.js`, `topbar.js` |
| `bane.html` | `bane.js` | `helpers.js`, `charts.js`, `topbar.js` |
| `stasjon.html` | `stasjon.js` | `helpers.js`, `entur.js`, `topbar.js` |
| `tog.html` | `tog.js` | `entur.js`, `topbar.js` |
| `planovergang.html` | `planovergang.js` | `helpers.js`, `topbar.js` |
| `onepager.html` | (inline) | — |
| `leaflet-demo.html` | (inline) | — selv-inneholdt, eksperiment |

### Felles moduler

| Fil | Rolle | Eksponerer |
|-----|-------|-----------|
| `helpers.js` | Rene funksjoner brukt av sub-sider (slugify, buckets, formatters, BENCHMARKS) | `window.AppHelpers` |
| `charts.js` | Chart.js doughnut/bar-wrapper med aria-labels og destroy-and-recreate | `window.AppCharts` |
| `entur.js` | GraphQL-klient mot Entur (avganger, situasjoner, vehicles) | `window.Entur` |
| `isochrone.js` | Bygg graf fra `railways.geojson` + Dijkstra fra valgt stasjon | `window.Isochrone` |
| `topbar.js` | Aktiv-side-markering, bane-velger-dropdown, mobilmeny | (auto-init på DOMContentLoaded) |

### Tilstands-globals

Hver side har én lokal `state`-variabel. Tester leser den via `window.__app`:

```js
window.__app = { state, map }      // index.html
window.__dashboard = { ready, stats }  // dashboard.html
```

Disse er **kun for tester** — ikke bruk dem på tvers av sider.

## Data-flyt eksempler

**"Vis Bergensbanen":**
```
bane.html?navn=Bergensbanen
  └─ bane.js leser ?navn=
      └─ fetch("data/stats.json") → finn route i routes-arrayet
      └─ fetch("data/routes/bergensbanen.geojson") → kart-geometri
      └─ rendrer KPI, kart, stasjonsliste
```

**"Live tog":**
```
index.html → app.js setLiveTrains(true)
  └─ ensureFullRailwaysLoaded() (force-load 8.4MB hvis ikke allerede)
  └─ buildRailwayIndex() (engangs grid-index for snap-til-bane)
  └─ setInterval (15s): window.Entur.fetchVehicles()
      └─ per tog: computeSnapPath() → entry.snap eller null
      └─ requestAnimationFrame-loop: interpoler langs snap eller LERP
```

**"Filtrert kart":**
```
checkbox change → applyFilterChange()
  └─ renderRailways() — filter på enabledTypes/Operators/etc, ny L.geoJSON
  └─ renderStations() — filter på stasjonstyper
  └─ renderLegend() — oppdater swatches og notes
  └─ updateUrl() — hash-state slik at refresh restorer
```

## Hvordan legge til en ny side

1. **Side-HTML** i `public/<navn>.html` — kopier `bane.html` som mal (har
   topbar, page-header, page-container).
2. **Side-JS** i `public/<navn>.js` — bruk IIFE-pattern + `"use strict"`,
   importer helpers via `window.AppHelpers`.
3. **Lenk inn fra topbar** hvis relevant — endre `<nav class="topnav">`-blokken
   i alle HTML-filer (det er duplikat; en build-step finnes ikke).
4. **Skriv en test** i `tests/<navn>-page.test.js` etter mønster fra
   `station-page.test.js`. Legg den til i `scripts/run-tests.mjs` i rett
   kategori (CI-trygg / lokal / Entur).
5. **Oppdater `public/onepager.html`** hvis siden er brukerrettet (memory-note).

## Test-strategi

Tre kategorier (se `scripts/run-tests.mjs`):

- **CI** — paritet (py↔js) + lette UI-smoketester. Kjøres i GitHub Actions
  på hver push/PR. Skal alltid passere.
- **local** — bredere UI-dekning, ingen ekstern API. Kjøres manuelt.
- **Entur** — krever live Entur-tilgang. Kjøres lokalt før release.

`npm test` = CI-kategorien. `npm run test:all` = alt.

## Render-strategi for kart

- `state.railwaysData` byttes UT av lazy-load (overview → full). All filter-
  rendering bygger `L.geoJSON` på nytt fra filtrert featureset. Det er
  ineffektivt for store filter-endringer; differential rendering er et planlagt
  optimaliseringspunkt.
- Canvas-renderer (`preferCanvas: true`) brukes for at 13180 sporsegmenter
  ikke skal lage 13180 SVG-elementer.
- Live tog er **layer-group + circle-markers** — ikke Canvas, fordi tooltip
  og popup må være interaktive.
