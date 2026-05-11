# CLAUDE.md

Kontekst for Claude (og andre lesere) som jobber i dette repoet. Hold denne
fila kortfattet — referer til kode for detaljer, dokumenter kun det som *ikke*
er åpenbart fra koden.

## Hva er dette

Statisk webapp for norsk jernbaneinfrastruktur. Tre lag:

1. **Python-pipeline** (`data/`): henter rådata fra OSM/Wikidata/NVDB,
   prosesserer til GeoJSON + et `stats.json`-aggregat.
2. **Statisk frontend** (`public/`): Leaflet-kart, Chart.js-dashbord, sub-sider
   per bane/stasjon/tog/planovergang. **Ingen byggesteg, ingen rammeverk** —
   vanilla JS via `<script>`-tagger.
3. **Live-integrasjoner**: Entur GraphQL (avganger + sanntidsposisjoner).
   Frontend kaller dem direkte; ingen backend.

## Viktige invarianter

**Py↔JS-paritet.** `data/process.py` og `public/helpers.js` har duplikate
implementasjoner av `slugify`, `bucket_speed`, `bucket_track`,
`co2_estimate_tonnes_per_year`. Hvis disse drifter, viser kart-siden (JS-
filtrert) andre tall enn dashbordet (Python-aggregert). Paritet håndheves av:
- `tests/slugify-parity.test.js`
- `tests/binning-parity.test.js`

**Endrer du én side, oppdater den andre samtidig** — eller forvent at CI
slår fast feilen.

**Slugs styrer file-locations.** `data/process.py` skriver per-rute-geojson
til `public/data/routes/<slug>.geojson`. Frontend leser via `slugify(name)`.
Skiller disse, og `bane.html?navn=Bergensbanen` finner ingenting.

**Datavolum-strategi.** `railways.geojson` er 8,4 MB. Vi serverer
`railways-overview.geojson` (4,5 MB, 100 m Douglas-Peucker-simplifisering) ved
oppstart og laster full geometri lazy ved zoom ≥ 10 eller når live tog
aktiveres. Se `app.js:loadData`, `ensureFullRailwaysLoaded`.

**Felles helpers, to lokasjoner.**
- `public/helpers.js`: subsete som sub-sider trenger (uten kart-state)
- `public/app.js`: samme funksjoner + kart-spesifikke (style*, popup*)

Kart-siden overstyrer `window.AppHelpers` med utvidet versjon. Trygt fordi
felles-delene er identiske. Hvis du legger til en helper begge trenger, legg
den i `helpers.js`.

## Navnekonvensjoner

- **Filer**: snake_case for Python (`fetch_routes.py`), kebab-case for HTML
  (`bane.html`), camelCase for JS-symboler.
- **Slug-fil-mapping**: norsk navn → `slugify()` → ASCII. Endrer du
  `slugify()`-regelen, **kjør `python data/process.py` og regenerér alt** —
  ellers ligger gamle filer igjen som ghost-content.
- **State**: én `state`-global per side (app.js, dashboard.js, …) — ikke
  duplikat-modul-state. Tester leser via `window.__app.state`.

## Hvor lever hvilken logikk

| Område            | Fil(er)                                          |
|-------------------|--------------------------------------------------|
| Kart + filter     | `public/app.js` (1700+ linjer; modulisering planlagt) |
| Dashbord          | `public/dashboard.js` + `public/charts.js`       |
| Sub-side baner    | `public/bane.js`, `public/bane.html`             |
| Sub-side stasjoner| `public/stasjon.js`, `public/stasjon.html`       |
| Sub-side tog      | `public/tog.js`, `public/tog.html`               |
| Sub-side planoverg| `public/planovergang.js`, `public/planovergang.html` |
| Live API-kall     | `public/entur.js` (window.Entur.\*)              |
| Isokrone-analyse  | `public/isochrone.js`                            |
| Topbar/dropdown   | `public/topbar.js` (lastet på alle sider)        |
| Onepager (om)     | `public/onepager.html` — selv-inkluderende       |
| Data-pipeline     | `data/process.py` (sannhetskilde for stats)      |
| Data-henting      | `data/fetch*.py` (én fil per ekstern kilde)      |

## Tester

23 testfiler i `tests/` kjøres med Playwright. To kategorier:

- **CI-trygge** (kjøres i `.github/workflows/ci.yml`):
  parity-tester + UI-smoketester + live-trains-snap (egen mocking).
- **Krever live Entur**: `entur*.test.js`, `live-trains.test.js`,
  `live-trains-lerp.test.js`, `tog-page.test.js`. Kjøres lokalt.

Alle tester forutsetter at en server lytter på `BASE_URL`
(default `http://localhost:5174`). Start: `npm start`.

## Demo-først-mønster

Frittstående demo-sider brukes til å evaluere endringer før vi integrerer i
hovedappen: `public/leaflet-demo.html` testet 8 Leaflet-plugins. Pattern:
ny side, vanilla, ingen avhengighet til `app.js`, ryddes når beslutningen er
tatt eller arkiveres til `docs/`.

## Endrer du noe brukerrettet?

Oppdater `public/onepager.html` samtidig. Den er prosjektets én-sides
narrativ — feilen "feature beskrevet der finnes ikke i kartet" er irritabelt
synlig.
