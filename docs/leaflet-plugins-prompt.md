# Oppgave: Utvid Leaflet-kart med UI-plugins

## Kontekst
Jeg har et eksisterende Leaflet-kart (vanilla JS, ingen React) som viser jernbanestasjoner i Norge med elektrifiseringsstatus (blå = elektrifisert, rød = ikke elektrifisert). Kartet har allerede et høyre-sidepanel og rundt 500+ stasjoner som markører. Punktene overlapper kraftig rundt Oslo, Drammen og Bergen.

## Mål
Legg til følgende plugins og integrer dem ryddig. Behold eksisterende funksjonalitet.

## Plugins som skal installeres

```bash
npm install leaflet-sidebar-v2 \
  leaflet.markercluster \
  leaflet-active-area \
  leaflet-control-geocoder \
  leaflet.fullscreen \
  leaflet.locatecontrol \
  @geoman-io/leaflet-geoman-free \
  leaflet-easyprint
```

## Implementasjonskrav

1. **leaflet-sidebar-v2** — Konverter eksisterende høyrepanel til sidebar-v2 med faner. Minst tre faner: "Stasjoner" (liste over stasjoner med søk/filter), "Lag" (toggle elektrifisert/ikke-elektrifisert/grunnkart), "Info" (om-tekst). Plasser sidebaren på høyre side.

2. **Leaflet.markercluster** — Cluster stasjonsmarkørene. Konfigurer med `disableClusteringAtZoom: 10` så individuelle stasjoner vises når man zoomer inn. Behold fargekoding (blå/rød) på cluster-ikonene basert på majoriteten i clusteret.

3. **leaflet-active-area** — Sett aktivt område slik at `fitBounds`, `flyTo` og `setView` tar høyde for sidebaren og ikke sentrerer kartet bak panelet.

4. **Leaflet.Control.Geocoder** — Søkefelt øverst til venstre. Bruk Nominatim som standard. Når bruker velger et resultat, zoom til lokasjonen og åpne nærmeste stasjon i sidebaren hvis det finnes en innen 5 km.

5. **Leaflet.fullscreen** — Fullscreen-knapp i øvre venstre kontrollgruppe.

6. **Leaflet.locatecontrol** — GPS "finn meg"-knapp under fullscreen-knappen. Strings på norsk.

7. **Leaflet-Geoman** — Aktiver tegneverktøy, men kun for admin-modus (sett en `isAdmin` flag øverst i koden, default `false`). Skal kunne tegne polygoner og linjer som kan eksporteres som GeoJSON via en knapp i sidebaren.

8. **leaflet-easyPrint** — Print/eksport-knapp i sidebaren under "Info"-fanen. A4-landskap som standard.

## CSS-rekkefølge (viktig)
Importer i denne rekkefølgen i `main.js` / `index.html`:
1. `leaflet/dist/leaflet.css`
2. Plugin-CSS (sidebar-v2, markercluster, geocoder, fullscreen, locatecontrol, geoman, easyprint)
3. Egen `styles.css` for overstyring

## Stasjonsmarkører
Bytt fra standard markører til `L.divIcon` med egen CSS. Hvit sirkel med farget border (blå/rød) — slik som nå, men som divIcon så hover/active-states kan styles. Hover skal vise stasjonsnavn i tooltip.

## Norsk språk
All UI-tekst på norsk: knapper, tooltips, geocoder-placeholder ("Søk adresse eller stasjon..."), locatecontrol-strings, sidebar-fanenavn.

## Akseptkriterier
- [ ] `npm run dev` starter uten konsollfeil
- [ ] Sidebar åpnes/lukkes uten at kartet "hopper"
- [ ] `fitBounds` på alle stasjoner sentrerer kartet i synlig område (ikke bak sidebar)
- [ ] Cluster oppdateres ved zoom og beholder elektrifiseringsfarge
- [ ] Geocoder-søk fungerer og fokuserer nærmeste stasjon
- [ ] Fullscreen, GPS, og print-knapper fungerer
- [ ] Geoman-verktøy vises kun når `isAdmin = true`
- [ ] Alle plugin-CSS-er lastet i riktig rekkefølge, ingen stilkonflikter
- [ ] Mobilvisning: sidebar går til full bredde under 768px

## Filer
Hold all plugin-initialisering i `src/map/plugins.js`. Sidebar-konfigurasjon i `src/map/sidebar.js`. Ikke rør eksisterende stasjons-data-loading.
