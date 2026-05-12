# Roadmap: nye åpne datakilder

Konkrete planer for fem datakilder som ville berike prosjektet uten å
endre kjerne-arkitekturen (statisk frontend + Python-pipeline). Hver
oppføring er selvstendig — plukk én når du har tid og lyst.

Sortert etter innsats, lavest først.

---

## 1. MET Frost API — vær per stasjon

**Verdiløfte:** stasjon.html viser "Bergen S — 4°C, lett regn, vind 6 m/s"
slik at brukeren får levende informasjon, ikke bare statisk metadata.

### Datakilde
- **Endepunkt:** `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=X&lon=Y`
- **Auth:** ingen — krever bare `User-Agent: norsk-jernbane (kontakt@eksempel.no)`
- **Lisens:** [NLOD](https://api.met.no/doc/License) — fri bruk med attribusjon
- **Rate-limit:** kreves cache-respekt (304-status), maks 20 req/s

### Implementasjon

**Hvor det skjer:** klient-side i `public/stasjon.js`. Ingen pipeline-endring.

**Ny fil:** `public/met.js` (window.MET.fetchWeather(lat, lon))
- Cache i `localStorage` med 1 t TTL (vær endrer seg ikke ofte)
- Returnerer `{ temperature, symbol, wind, time }`

**Endringer i `public/stasjon.js`:**
- I `init()`, etter at koordinater er hentet, kall MET API
- Render et lite vær-kort over hero-blokken: ikon + temperatur + vind

**Endringer i `public/stasjon.html`:**
- Plasshold-div for værmelding

**Ingen** nye Python-skript. MET henter alltid live.

### Estimert innsats: 2-3 timer

### Risiko
- MET kan returnere 304 (cached) — håndtere via stale-while-revalidate-mønster
- Symbol-mapping (MET-kodene → emoji eller SVG) trenger en liten tabell
- Attribusjon: "Vær: MET.no" må vises i UI

---

## 2. Wikimedia Commons — flere stasjons-bilder

**Verdiløfte:** stasjon.html får bildegalleri (3-5 bilder) i stedet for kun
hovedbilde. Bedre visuell rikdom på de viktigste stasjonene.

### Datakilde
- **Wikidata SPARQL** — vi henter allerede `image` (én fil); kan utvides til
  `?station wdt:P18 ?image; wdt:P373 ?commonsCategory` for å få Commons-kategorinavn
- **Commons API** — `https://commons.wikimedia.org/w/api.php?action=query&...` for å
  liste alle bilder i en kategori
- **Lisens:** CC-BY-SA / CC0 per bilde — må vises i bildet

### Implementasjon

**Hvor det skjer:** pipeline-utvidelse i `data/fetch_wikidata_stations.py`.

**Endringer i `data/fetch_wikidata_stations.py`:**
1. Utvid SPARQL-spørringen til å hente `commonsCategory` (P373) i tillegg til
   `image` (P18)
2. Hvis stasjonen har en Commons-kategori, gjør en oppfølgings-call til
   Commons API for å hente alle bilder i kategorien (begrenset til ~5)
3. Lagre `images: [{url, license, author}]` i `public/data/wikidata_stations.json`

**Endringer i `public/stasjon.js`:**
- I render-hero, hvis `wd.images.length > 1`, vis hovedbilde + thumb-galleri
- Klikk på thumb bytter hovedbilde inn (lightweight, ingen modal)

### Estimert innsats: 3-4 timer

### Risiko
- Commons-kategorier varierer i kvalitet — noen har 100+ bilder, andre kun
  hovedbilde. Trenger filtrering på "godt egnet" (eks: ikke uthus, tegninger
  fra arkiv, ...) — kan rangere på filmetadata
- Lisens-håndtering: vis CC-attribusjon i bildet (`title`/`caption`)

---

## 3. Wikipedia-utdrag per bane

**Verdiløfte:** bane.html får en "Om banen"-seksjon med 2-3 prosa-avsnitt
fra Wikipedia. Setter tekniske tall i historisk/kulturell kontekst.

### Datakilde
- **Wikipedia REST API:** `https://no.wikipedia.org/api/rest_v1/page/summary/Bergensbanen`
- **Returnerer:** `extract` (sammendrag, 2-3 setninger), `extract_html`, `thumbnail`, `description`
- **Lisens:** CC-BY-SA — krever attribusjon med lenke til artikkelen
- **Rate-limit:** mild (200 req/s), men cache uansett

### Implementasjon

**Hvor det skjer:** pipeline-fetch + statisk lagring som per-bane-fil.

**Ny fil:** `data/fetch_wikipedia_routes.py`
- For hver `route.name` i `stats.json`, slå opp Wikipedia-artikkel
- Fallback til norsk Wikipedia først, deretter engelsk
- Lagre resultat i `public/data/wikipedia_routes.json` som `{routeName: {extract, url, image}}`

**Endringer i `data/process.py`:**
- Bare en print i pipeline-output for at fetch_wikipedia_routes.py burde
  kjøres separat (matcher mønsteret for fetch_wikidata_stations.py)

**Endringer i `public/bane.js`:**
- Last `data/wikipedia_routes.json` parallelt med `stats.json` (lazy hvis
  banen finnes der)
- Render "Om [banenavn]"-blokken etter narrativ-blokken, før kart
- Inkluder "Les mer på Wikipedia →"-lenke

**Workflow-integrasjon:**
- Legg til `python data/fetch_wikipedia_routes.py` i `.github/workflows/refresh-data.yml`

### Estimert innsats: 4-6 timer

### Risiko
- Mange ruter har ikke egen Wikipedia-artikkel (eks. korte sidebaner) —
  fallback til null, ikke krasj
- Wikipedia-artiklene varierer i lengde og kvalitet — extract API gir
  bevisst 2-3 setninger, godt nivå for innledning
- HTML-extract kan inneholde tagger — saniter (eller bruk plain extract)

---

## 4. Kartverket DEM — høyde og stigning per km

**Verdiløfte:** "Bergensbanen klatrer fra 0 til 1237 m. 23 % av strekningen
har stigning > 15 ‰." Forklarer hvorfor norsk jernbane er langsom — fjell,
ikke teknologi.

### Datakilde
- **Kartverket Høgdedata:** [https://hoydedata.no/](https://hoydedata.no/)
- **Format:** DEM (digital elevation model) som GeoTIFF, 1m / 10m / 50m
  oppløsninger
- **Lisens:** [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/) —
  attribusjon Kartverket
- **Distribusjon:** lastes ned som filer (GB-størrelse for hele Norge) eller
  via WMS for spesifikke punkter

### Implementasjon

Dette er den mest pipeline-tunge integrasjonen.

**Strategi:** bruk **WMS / WCS-tjenesten** (ingen GB-nedlasting), sampler
høyde for hver koordinat i `railways.geojson`.

**Ny fil:** `data/fetch_elevation.py`
- Les `public/data/railways.geojson`
- For hvert segment, sampel hver koordinat mot Kartverket WCS:
  - `https://wcs.geonorge.no/skwms1/wcs.dtm` (eller tilsvarende — sjekk
    [geonorge.no/api](https://www.geonorge.no/Geonettverk/Geonettverk-API/) for nyeste endepunkt)
  - Returnerer høyde i meter
- Cache aggressivt — koordinater endres ikke ofte, kjøres månedlig
- Output: `data/elevations.json` med `{segmentId: [h1, h2, ...]}`

**Endringer i `data/process.py`:**
- I `split_features`, hvis `elevations.json` finnes, beriker hver feature med:
  - `elevation_min`, `elevation_max`, `elevation_gain` (sum av positive deltaer)
  - `max_gradient_promille` (maks stigning på 100 m)
  - `pct_steep_15` (andel av segmentet med stigning ≥ 15 ‰)
- Aggregér per route i `compute_routes`:
  - `route.elevation_gain_m`, `route.max_gradient_promille`, `route.highest_point_m`

**Endringer i `public/dashboard.js`:**
- Ny seksjon: "Brattheter" eller "Topografi II — stigning"
- Topp 5 bratteste baner, høyeste punkt på hver bane

**Endringer i `public/bane.js`:**
- Profil-graf med høyde langs banen (mini-chart, kunne brukt Chart.js line)
- Stats-kort: "Stigning fra X m til Y m, maks Z ‰"

### Estimert innsats: 1-2 dager

### Risiko
- **API-rate** kan være restriktiv for tusenvis av punkter — implementer
  cache + batch
- Kartverkets WCS har endret seg historisk — verifiser endepunkt før koding
- Stigning krever projisering til UTM33 (ikke lat/lon) for korrekt distanse
  — kan gjenbruke `TO_UTM33` fra `data/process.py`
- Datavolum: 100+ koordinater per segment × 13 000 segmenter = 1,3M lookups.
  Cache og batching kritisk — kan ta 30+ min første gang

### Alternativ: forhåndssamplet datasett
Hvis WMS er upålitelig, kan vi laste ned regionale DEM-filer (10 m oppløsning
ca. 200 MB per region) lokalt og sample med GDAL/rasterio. Mer arbeid å
sette opp, men deterministisk og fri for API-rate-limits.

---

## 5. Entur GTFS — faktiske avganger og frekvenser

**Verdiløfte:** "Bergensbanen: 6 daglige avganger Oslo→Bergen, første kl
07:25, lengste avbrudd 11:25-15:25 (4 t pause), søndag kun 4 avganger".
Brukerens viktigste manglende spørsmål: "hvor ofte går toget?"

### Datakilde
- **Entur GTFS Static:** [Static feed-list](https://developer.entur.org/stops-and-timetable-data)
  - Returns ZIP med stops.txt, routes.txt, trips.txt, stop_times.txt, calendar.txt
- **Oppdateres:** daglig
- **Lisens:** NLOD med attribusjon

### Implementasjon

**Ny fil:** `data/fetch_gtfs.py`
- Last ned ZIP fra Entur (cache med ETag)
- Pakk ut til `data/gtfs/`
- Filer er typisk store (routes 50k+, trips 500k+, stop_times 5M+) men
  tekstbaserte CSV — kan strømles

**Ny fil:** `data/process_gtfs.py` (separat fra prosess.py for å unngå at
hovedpipelinen blir treg når GTFS ikke trengs):
- Beregn per rute (matche `routes.txt` mot stats.routes ved navn):
  - Totalt antall trips per uke
  - Første og siste avgang per ukedag
  - Lengste avbrudd
- Beregn per stasjon (matche `stops.txt` til stations.geojson via
  UIC-kode eller koordinat):
  - Avganger per dag
  - Antall unike linjer som stopper
- Output: `public/data/gtfs_summary.json`

**Endringer i `public/dashboard.js`:**
- Ny seksjon: "Frekvens — hvor ofte går togene?"
- Topp 10 mest-trafikkerte stasjoner per ukedag (egen visualisering enn
  dagens `network.hubs` som teller unike linjer, ikke trips)

**Endringer i `public/bane.js`:**
- Stats-kort: "Trafikk: 18 daglige avganger, første 06:25, siste 22:30"
- Tids-heatmap (gjør med Chart.js eller eget canvas) som viser trafikk
  per time/ukedag

**Endringer i `public/stasjon.js`:**
- "Typisk dag her" — frekvens-stats i tillegg til live-avganger fra
  JourneyPlanner

### Estimert innsats: 1 uke (mye data-mapping og UI)

### Risiko
- GTFS-route-navn matcher ikke perfekt med våre `stats.routes`-navn (OSM
  vs Entur har ulike konvensjoner). Trenger fuzzy-matching eller manuell
  mapping-tabell
- Stop-mapping: noen Entur-stop-IDs har ikke UIC, må matches på koordinat
  innen ~50 m
- Datavolum: stop_times.txt er typisk 100+ MB — pipeline må håndtere
  streaming, ikke load-all-in-memory
- Lisensiering: GTFS-data er NLOD, men kombinasjonsavledet data bør også
  attribueres

---

## Avhengigheter

Mellom integrasjonene:

```
MET Frost ──────────┐
                    │  uavhengige
Wikipedia ──────────┤
                    │
Wikimedia Commons ──┘ — utvider eksisterende Wikidata-fetch

Kartverket DEM ─── uavhengig, men endrer process.py-output

Entur GTFS ─────── uavhengig, men stort
```

Ingen rekkefølge-tvang. Plukk det som matcher tilgjengelig tid og energi.

---

## Anbefalt rekkefølge

1. **MET Frost** — quick win, lav risk. Bygger selvtillit for senere arbeid.
2. **Wikipedia** — gir umiddelbart bedre bane-sider. Mønster brukt på flere
   datakilder (fetch-script + lagring + frontend-loading).
3. **Wikimedia Commons** — natural extension av Wikidata-pipelinen.
4. **Kartverket DEM** — strategisk dybde. Beste tidspunkt etter at de tre
   over er på plass og kodebasen er kjent.
5. **Entur GTFS** — størst og mest komplekst. Tas siste, gjerne på lenger
   sammenhengende tid.

---

## Generelle prinsipper når du legger til en ny kilde

1. **Egen fetch-fil** i `data/` — én per kilde, navn som starter med `fetch_`.
2. **Output i `public/data/`** som JSON (helst flat struktur som kan caches
   som statisk fil).
3. **Pipeline-integrasjon i `data/process.py`** kun hvis data må aggregeres
   inn i `stats.json`. Ellers la frontend lese fila direkte.
4. **Frontend laster lazy** — ikke blokker hovedlasten på en valgfri kilde.
5. **Lisens-attribusjon** synlig i UI (footer eller egen seksjon).
6. **Workflow-integrasjon i `.github/workflows/refresh-data.yml`** for
   automatisk månedlig refresh.
7. **Memory-note** i `CLAUDE.md` hvis kilden har et eget mønster
   (eks: "Kartverket WCS krever UTM33-koordinater").
