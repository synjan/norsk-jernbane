// Norsk jernbane — kart, filter og statistikk.
// Krever Leaflet og Chart.js (lastet via CDN i index.html).

const NORWAY_CENTER = [64.5, 13.0];
const NORWAY_ZOOM = 5;

// Datavolum-strategi: vi laster `railways-overview.geojson` (~330 KB gzipped,
// 100 m simplifisering) ved oppstart. Når brukeren zoomer inn til regionalt
// nivå eller mer, henter vi fullversjonen (~1.5 MB gzipped) i bakgrunnen
// og bytter rendring. Terskel valgt slik at simplifisering aldri er synlig.
const ZOOM_LOAD_FULL_THRESHOLD = 10;

// Banetyper i prosjektet — kun "ekte" tog/jernbane. T-bane, trikk,
// bybane, kabelbane og monorail er filtrert bort i `data/process.py`.
const ALL_TYPES = ["rail", "narrow_gauge", "preserved"];

const ALL_STATION_TYPES = ["station", "halt", "stop"];
const DEFAULT_STATION_TYPES = ["station", "halt"];

const state = {
  railwayLayer: null,
  stationLayer: null,
  planovergangerLayer: null,
  railwaysData: null,
  railwaysIsFull: false,        // false = overview, true = full
  railwaysFullPromise: null,    // memoisert in-flight/ferdig load
  stationsData: null,
  planovergangerData: null,
  stats: null,
  colorMode: "electrification",
  enabledTypes: new Set(ALL_TYPES),
  enabledOperators: new Set(),  // fylles fra data ved oppstart
  electrificationFilter: "all", // "all" | "yes" | "no"
  searchQuery: "",
  enabledStationTypes: new Set(DEFAULT_STATION_TYPES),
  onlyUicStations: false,
  showPlanoverganger: false,
  // Live tog
  showLiveTrains: false,
  liveTrainsLayer: null,        // L.layerGroup som beholder alle markørene
  liveTrainsTrains: null,       // Map<journeyId, { marker, from, to, tStart, tEnd, bearing }>
  liveTrainsTimer: null,        // setInterval for polling
  liveTrainsRaf: null,          // requestAnimationFrame for animasjon
  liveTrainsLastUpdate: null,
};

const LIVE_TRAINS_INTERVAL_MS = 15000;
// LERP-varigheten matcher poll-intervallet — markøren glir kontinuerlig
// mot siste rapporterte posisjon. Hvis poll forsinkes, sitter markøren
// ved målet til neste poll kommer.
const LIVE_LERP_MS = LIVE_TRAINS_INTERVAL_MS;

// ---------- Kart ----------

function initMap() {
  const map = L.map("map", { preferCanvas: true, zoomControl: true })
    .setView(NORWAY_CENTER, NORWAY_ZOOM);

  L.control.scale({ imperial: false, metric: true, position: "bottomright" }).addTo(map);

  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap-bidragsytere",
    maxZoom: 19,
  }).addTo(map);

  // Tidligere lå et OpenRailwayMap-tile-overlay her, men det viser ALLE
  // jernbanetyper (T-bane, trikk, bybane) som vi har filtrert bort —
  // forvirrende for et "kun tog"-prosjekt. Vår egen geojson-overlay
  // tegner togtraseene direkte fra `railways.geojson`.

  return map;
}

// ---------- Stilfunksjoner ----------

// Kart-fargene plukkes for at de skal sameksistere med modern-minimal UI-en
// (lyse paneler, én blå aksent). De er hentet fra OKLch så elektrifisert/
// ikke-elektrifisert har samme kromatiske vekt og blå ikke kolliderer med
// UI-aksenten — disse skinnene må kunne ligge på toppen av kartet og
// fortsatt være lesbare.
function styleForElectrification(props) {
  const e = (props.electrified || "").toLowerCase();
  const electrified = e && e !== "no";
  return {
    color: electrified ? "#2563eb" : "#9b2c2c",
    weight: 2.5,
    opacity: 0.85,
  };
}

function styleForSpeed(props) {
  const speed = props.maxspeed_kmh;
  if (speed == null) return { color: "#bbb", weight: 1.5, opacity: 0.55 };
  // Gradient fra dempet teal (lav fart) til varm rust (høy fart) — sterkere
  // wave-effekt enn den gamle blå→rød (som klasjet med UI-aksenten).
  const t = Math.max(0, Math.min(1, (speed - 40) / 160));
  const r = Math.round(56 + (200 - 56) * t);
  const g = Math.round(132 + (84 - 132) * t);
  const b = Math.round(148 + (52 - 148) * t);
  return { color: `rgb(${r}, ${g}, ${b})`, weight: 2.5, opacity: 0.9 };
}

const TYPE_COLORS = {
  rail: "#334155",
  narrow_gauge: "#0d9488",
  preserved: "#9b2c2c",
};

function styleForType(props) {
  return {
    color: TYPE_COLORS[props.railway] || "#94a3b8",
    weight: 2.5,
    opacity: 0.85,
  };
}

function styleForTracks(props) {
  const n = parseInt(props.passenger_lines, 10);
  if (Number.isNaN(n)) return { color: "#cbd5e1", weight: 1.5, opacity: 0.55 };
  if (n >= 3) return { color: "#1d4ed8", weight: 3, opacity: 0.95 };
  if (n === 2) return { color: "#0d9488", weight: 2.8, opacity: 0.9 };
  return { color: "#c2410c", weight: 2.2, opacity: 0.85 };
}

function currentStyleFn() {
  const base =
    state.colorMode === "speed" ? styleForSpeed
    : state.colorMode === "type" ? styleForType
    : state.colorMode === "tracks" ? styleForTracks
    : styleForElectrification;

  if (!state.searchQuery) return base;

  // Når søk er aktivt, fremhev treff (alt synlig matcher allerede pga. featureVisible,
  // men vi vil fortsatt gjøre treffene tjukkere så de er enkle å se).
  return (props) => ({ ...base(props), weight: 4, opacity: 1 });
}

// ---------- Filter-logikk ----------

function operatorKey(props) {
  return props.operator || "(ukjent)";
}

function matchesSearch(props) {
  if (!state.searchQuery) return true;
  const q = state.searchQuery;
  const fields = [props.name, props.ref, props.operator];
  return fields.some((v) => v && v.toLowerCase().includes(q));
}

function featureVisible(feat) {
  const props = feat.properties;
  if (!state.enabledTypes.has(props.railway)) return false;
  if (!state.enabledOperators.has(operatorKey(props))) return false;
  if (!matchesSearch(props)) return false;
  if (state.electrificationFilter === "yes" && !isElectrified(props)) return false;
  if (state.electrificationFilter === "no" && isElectrified(props)) return false;
  return true;
}

function stationVisible(feat) {
  // Søk overstyrer alt — hvis du leter etter en stasjon, vil du finne den
  // selv om kategorien er av.
  if (state.searchQuery) return matchesSearch(feat.properties);
  const props = feat.properties;
  // Operatør-filter: gjelder også stasjoner. Operator-settet er bygd fra
  // jernbanesegmenter — hvis stasjonens operator ikke finnes der, lar vi
  // den være synlig (fallback) for å unngå at f.eks. småstasjoner med
  // egne operator-tags forsvinner uten at brukeren vet hvorfor.
  const op = operatorKey(props);
  if (state.knownOperators?.has(op) && !state.enabledOperators.has(op)) {
    return false;
  }
  // UIC-bryteren er en "viktige stasjoner"-snarvei og overstyrer
  // kategorifilter (UIC-koder ligger ofte på railway=stop i OSM).
  if (state.onlyUicStations) return Boolean(props.uic_ref);
  return state.enabledStationTypes.has(props.railway);
}

// ---------- Popups (DOM-bygging, ingen innerHTML) ----------

// Sporsegment-popup: kuratert visning av nøkkelfelt (navn, hastighet, strøm,
// spor, lengde) med rå OSM-tagger kollapset bak en <details>-toggle for
// OSM-debugging. Brukerne ønsker primært vite hva slags spor de ser på,
// ikke å gå gjennom 12 OSM-tags.
const TRACK_LABELS = { 1: "Enkeltspor", 2: "Dobbeltspor" };

function buildPopup(props) {
  const wrap = document.createElement("div");
  wrap.className = "popup-station popup-segment";

  // Header: liten "Sporsegment"-etikett over banenavnet — gjør det tydelig
  // at brukeren har klikket ett enkelt segment, ikke hele banen. Et bane-
  // navn som "Bergensbanen" finnes på 100+ segmenter; uten etikett blir
  // popup-en forvirrende.
  const head = document.createElement("div");
  head.className = "popup-station-head";

  const kicker = document.createElement("div");
  kicker.className = "popup-segment-kicker";
  kicker.textContent = "Sporsegment";
  head.append(kicker);

  const title = document.createElement("h3");
  title.className = "popup-station-title";
  title.textContent = props.name || "(uten navn)";
  head.append(title);

  const metaParts = [];
  if (props.operator) metaParts.push(props.operator);
  if (props.length_km) metaParts.push(`${Math.round(props.length_km * 1000).toLocaleString("nb-NO")} m`);
  if (props.tunnel && props.tunnel !== "no") metaParts.push("tunnel");
  if (props.bridge && props.bridge !== "no") metaParts.push("bro");
  if (metaParts.length) {
    const meta = document.createElement("div");
    meta.className = "popup-station-meta";
    meta.textContent = metaParts.join(" · ");
    head.append(meta);
  }
  wrap.append(head);

  // Stats-grid: maks-hastighet, spor, elektrifisering.
  const stats = document.createElement("dl");
  stats.className = "popup-segment-stats";
  const addStat = (label, value) => {
    if (value == null || value === "") return;
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    stats.append(dt, dd);
  };
  if (props.maxspeed_kmh) addStat("Maks-hastighet", `${props.maxspeed_kmh} km/t`);

  const trackCount = parseInt(props.passenger_lines, 10);
  if (!Number.isNaN(trackCount)) {
    const lbl = TRACK_LABELS[trackCount] || `${trackCount} spor`;
    addStat("Spor", lbl);
  }

  const e = (props.electrified || "").toLowerCase();
  if (e && e !== "no") {
    let strom = "Elektrifisert";
    if (props.voltage) {
      const kV = Math.round(parseInt(props.voltage, 10) / 1000);
      if (Number.isFinite(kV)) strom = `${kV} kV`;
      if (props.frequency) strom += ` / ${props.frequency} Hz`;
    }
    addStat("Strøm", strom);
  } else if (e === "no") {
    addStat("Strøm", "Ikke elektrifisert");
  }

  if (stats.childElementCount > 0) wrap.append(stats);

  // Kollapsbar rå-tag-visning for OSM-debugging.
  const visibleKeys = new Set([
    "name", "operator", "maxspeed_kmh", "passenger_lines",
    "electrified", "voltage", "frequency", "length_km", "tunnel", "bridge",
  ]);
  const extraEntries = Object.entries(props).filter(
    ([k, v]) => !visibleKeys.has(k) && v != null && v !== ""
  );
  if (extraEntries.length > 0) {
    const det = document.createElement("details");
    det.className = "popup-segment-tags";
    const sum = document.createElement("summary");
    sum.textContent = `Vis OSM-tagger (${extraEntries.length})`;
    det.append(sum);
    const table = document.createElement("table");
    table.className = "popup-tags-table";
    for (const [k, v] of extraEntries) {
      const tr = document.createElement("tr");
      const tdK = document.createElement("td");
      tdK.textContent = k;
      const tdV = document.createElement("td");
      tdV.textContent = String(v);
      tr.append(tdK, tdV);
      table.append(tr);
    }
    det.append(table);
    wrap.append(det);
  }

  // Handling — lenker til full bane-side når banen har navn. Gir brukeren
  // klar vei fra "jeg klikket et tilfeldig segment" til "se hele banen".
  if (props.name) {
    const actions = document.createElement("div");
    actions.className = "popup-station-actions";
    const link = document.createElement("a");
    link.className = "btn btn-primary btn-sm";
    link.href = `bane.html?navn=${encodeURIComponent(props.name)}`;
    link.textContent = `Åpne ${props.name} →`;
    actions.append(link);
    wrap.append(actions);
  }

  return wrap;
}

// ---------- Datainnlasting ----------

async function loadData() {
  const [railways, stations, stats, wikidata, planoverganger] = await Promise.all([
    fetch("data/railways-overview.geojson").then((r) => r.json()),
    fetch("data/stations.geojson").then((r) => r.json()),
    fetch("data/stats.json").then((r) => r.json()),
    fetch("data/wikidata_stations.json").then((r) => r.ok ? r.json() : {}).catch(() => ({})),
    fetch("data/planoverganger.geojson").then((r) => r.ok ? r.json() : null).catch(() => null),
  ]);
  state.railwaysData = railways;
  state.railwaysIsFull = false;
  state.stationsData = stations;
  state.stats = stats;
  state.wikidata = wikidata;
  state.planovergangerData = planoverganger;

  // Bygg liste over operatører fra dataene, sortert etter total km.
  const opLengths = new Map();
  for (const f of railways.features) {
    const op = operatorKey(f.properties);
    opLengths.set(op, (opLengths.get(op) || 0) + (f.properties.length_km || 0));
  }
  const sorted = [...opLengths.entries()].sort((a, b) => b[1] - a[1]);
  state.operators = sorted; // for UI
  state.enabledOperators = new Set(sorted.map(([op]) => op));
  // Settet med "kjente" operatører (avledet av jernbanedata) — brukes av
  // stationVisible for å skille mellom operatør som er filtrert vekk vs.
  // operatør vi aldri har sett.
  state.knownOperators = new Set(sorted.map(([op]) => op));
}

// Last full-versjonen av railways.geojson ved første zoom-inn over terskelen.
// Idempotent: parallelle kall venter på samme Promise, og senere kall etter
// ferdig load gjør ingenting. Faller tilbake til overview hvis nettverket feiler.
async function ensureFullRailwaysLoaded(map) {
  if (state.railwaysIsFull) return;
  if (!state.railwaysFullPromise) {
    state.railwaysFullPromise = fetch("data/railways.geojson")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .catch((err) => {
        console.warn("Kunne ikke laste full railways.geojson:", err);
        state.railwaysFullPromise = null;  // tillat retry ved senere zoom
        return null;
      });
  }
  const full = await state.railwaysFullPromise;
  if (!full || state.railwaysIsFull) return;
  state.railwaysData = full;
  state.railwaysIsFull = true;
  renderRailways(map);
}

// ---------- Lag-rendering ----------

function renderRailways(map) {
  if (state.railwayLayer) map.removeLayer(state.railwayLayer);
  const visible = state.railwaysData.features.filter(featureVisible);
  const filtered = { type: "FeatureCollection", features: visible };
  const styleFn = currentStyleFn();
  state.railwayLayer = L.geoJSON(filtered, {
    style: (f) => styleFn(f.properties),
    onEachFeature: (f, layer) => layer.bindPopup(buildPopup(f.properties)),
  }).addTo(map);
  // Stasjoner og live tog skal ALLTID ligge over sporlinjer for klikk-priority.
  // Uten dette overtar jernbane-laget z-rekkefølgen ved re-render og småe
  // markører (stoppunkt, holdeplass) blir vanskelige å treffe — særlig der
  // linjen krysser markøren.
  state.stationLayer?.bringToFront();
  state.planovergangerLayer?.bringToFront();
  state.liveTrainsLayer?.bringToFront();
  updateLiveStats(visible);
  renderStats(visible);
  toggleFilterEmptyState(visible.length === 0 && isFilterActive());
}

// Vis/skjul "ingen treff"-overlay over kartet. Bare når filter er aktivt
// (ikke ved baseline 0). Gir CTA for tilbakestilling så brukeren ikke tror
// noe er ødelagt.
function toggleFilterEmptyState(show) {
  const el = document.getElementById("filter-empty-state");
  if (!el) return;
  el.hidden = !show;
}

// Planovergang-popup: bygges som DOM (ikke HTML-string-konkat) slik at
// NVDB-felter `tilleggsinfo` og `fare` ikke kan smugle HTML inn. Layout
// følger samme hierarki som stasjons-popupen: tittel → meta → varsel →
// handling.
function buildPlanovergangPopup(p) {
  const wrap = document.createElement("div");
  wrap.className = "popup-station popup-planovergang";

  // Header: type som tittel + NVDB ID som meta. "I plan"-typer markeres
  // med risiko-pill siden de er at-grade og statistisk farligere.
  const head = document.createElement("div");
  head.className = "popup-station-head";
  const title = document.createElement("h3");
  title.className = "popup-station-title";
  title.textContent = p.type || "Jernbanekryssing";
  head.append(title);

  if (typeof p.type === "string" && p.type.toLowerCase().startsWith("i plan")) {
    const pill = document.createElement("span");
    pill.className = "popup-risk-pill";
    pill.textContent = "I plan — kryssing i samme nivå";
    head.append(pill);
  }

  if (p.id) {
    const meta = document.createElement("div");
    meta.className = "popup-station-meta";
    meta.textContent = `NVDB ID ${p.id}`;
    head.append(meta);
  }
  wrap.append(head);

  // Fare og tilleggsinfo: varsel-styled boks når noe er satt.
  if (p.fare || p.tilleggsinfo) {
    const alert = document.createElement("div");
    alert.className = "popup-alert";
    if (p.fare) {
      const fareEl = document.createElement("div");
      fareEl.className = "popup-alert-line popup-alert-line-strong";
      fareEl.textContent = `⚠ ${p.fare}`;
      alert.append(fareEl);
    }
    if (p.tilleggsinfo) {
      const info = document.createElement("div");
      info.className = "popup-alert-line";
      info.textContent = p.tilleggsinfo;
      alert.append(info);
    }
    wrap.append(alert);
  }

  // Handling: lenk til full planovergang-side.
  const actions = document.createElement("div");
  actions.className = "popup-station-actions";
  const link = document.createElement("a");
  link.className = "btn btn-primary btn-sm";
  link.href = `planovergang.html?id=${encodeURIComponent(p.id ?? "")}`;
  link.textContent = "Åpne side →";
  actions.append(link);
  wrap.append(actions);

  return wrap;
}

function renderPlanoverganger(map) {
  if (state.planovergangerLayer) {
    map.removeLayer(state.planovergangerLayer);
    state.planovergangerLayer = null;
  }
  if (!state.showPlanoverganger || !state.planovergangerData) return;

  state.planovergangerLayer = L.geoJSON(state.planovergangerData, {
    pointToLayer: (_f, latlng) =>
      L.circleMarker(latlng, {
        radius: 4,
        color: "#dc2626",
        weight: 1,
        fillColor: "#fca5a5",
        fillOpacity: 0.85,
      }),
    onEachFeature: (f, layer) => layer.bindPopup(buildPlanovergangPopup(f.properties || {})),
  }).addTo(map);
}

// Beregn nåværende rendret posisjon for en tween-entry.
// Hvis entry.snap er satt (begge endepunkter projisert på samme sporsegment)
// følges polylinjen med arc-length-parametrisering. Ellers ren LERP — visuelt
// "rett over" mellom GPS-rapporter (kutter kurver, fjorder).
function currentLerpLatLng(entry, now) {
  const span = entry.tEnd - entry.tStart;
  const t = span > 0 ? Math.max(0, Math.min(1, (now - entry.tStart) / span)) : 1;
  if (entry.snap) {
    return interpolateAlongPath(entry.snap, t);
  }
  return {
    lat: entry.from.lat + (entry.to.lat - entry.from.lat) * t,
    lon: entry.from.lon + (entry.to.lon - entry.from.lon) * t,
  };
}

// ---------- Snap-til-bane (live tog følger skinnegangen) ----------
//
// To-trinns: ved hver vehicle-update projiserer vi `from` og `to` ortogonalt
// på nærmeste sporsegment (innen 100 m). Hvis begge treffer SAMME segment
// lagrer vi en "path" (waypoints + kumulative meter) på entry.snap. Per
// animasjonsramme interpolerer `interpolateAlongPath` arc-length-mette langs
// denne pathen — så markøren krummer med banen i stedet for å kutte over
// fjord/fjell. Hvis snap ikke er trygt (segment-grense, dårlig prosjeksjon)
// faller vi tilbake til ren LERP — visuell degradering, ingen krasj.
//
// Distanseberegning bruker equirektangulær approksimasjon (cos(refLat)).
// Vi opererer med <100 m varierende relative posisjoner; Haversine er 3×
// tregere og overkill her.

const SNAP_MAX_DIST_M = 100;
const SNAP_GRID_CELL_DEG = 0.1;       // ~5 km × 11 km på lat 64°N
const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LON_BASE = 111320;

function llDistMeters(lat1, lon1, lat2, lon2) {
  const refLat = (lat1 + lat2) / 2;
  const dx = (lon2 - lon1) * M_PER_DEG_LON_BASE * Math.cos((refLat * Math.PI) / 180);
  const dy = (lat2 - lat1) * M_PER_DEG_LAT;
  return Math.hypot(dx, dy);
}

// Bygger grid-index én gang etter at full railways.geojson er lastet.
// Hver celle (0.1° × 0.1°) holder en liste over feature-indekser hvis
// bounding-box overlapper cellen. Lookup blir O(1) for nærliggende celler.
function buildRailwayIndex(features) {
  const cells = new Map();
  for (let fi = 0; fi < features.length; fi++) {
    const coords = features[fi].geometry?.coordinates;
    if (!coords || coords.length < 2) continue;
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (const [lon, lat] of coords) {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
    }
    const i0 = Math.floor(minLat / SNAP_GRID_CELL_DEG);
    const i1 = Math.floor(maxLat / SNAP_GRID_CELL_DEG);
    const j0 = Math.floor(minLon / SNAP_GRID_CELL_DEG);
    const j1 = Math.floor(maxLon / SNAP_GRID_CELL_DEG);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const key = `${i}:${j}`;
        let bucket = cells.get(key);
        if (!bucket) { bucket = []; cells.set(key, bucket); }
        bucket.push(fi);
      }
    }
  }
  return { cells, features };
}

// Projiser et lat/lon-punkt på en LineString-feature (alle koordinater i
// [lon, lat]-rekkefølge). Returnerer nærmeste segment-indeks `idx`, parameter
// `t` i [0,1] langs det segmentet, og avstand i meter. Returnerer null hvis
// LineString har <2 punkter.
function projectOntoLineString(lat, lon, coords) {
  if (!coords || coords.length < 2) return null;
  const refLat = lat;
  const cosLat = Math.cos((refLat * Math.PI) / 180);
  const toX = (lo) => lo * M_PER_DEG_LON_BASE * cosLat;
  const toY = (la) => la * M_PER_DEG_LAT;
  const px = toX(lon), py = toY(lat);

  let best = null;
  for (let i = 0; i < coords.length - 1; i++) {
    const ax = toX(coords[i][0]),     ay = toY(coords[i][1]);
    const bx = toX(coords[i + 1][0]), by = toY(coords[i + 1][1]);
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = 0;
    let sx = ax, sy = ay;
    if (len2 > 0) {
      t = ((px - ax) * dx + (py - ay) * dy) / len2;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      sx = ax + t * dx;
      sy = ay + t * dy;
    }
    const ddx = px - sx, ddy = py - sy;
    const distSq = ddx * ddx + ddy * ddy;
    if (best === null || distSq < best.distSq) {
      best = { idx: i, t, distSq };
    }
  }
  if (!best) return null;
  return { idx: best.idx, t: best.t, distM: Math.sqrt(best.distSq) };
}

// Finn nærmeste sporsegment til (lat, lon) innen maxDistM. Sjekker celle
// (i,j) + 8 nabo-celler. Returnerer `{feature, proj}` eller null.
function findNearestRailwayFeature(index, lat, lon, maxDistM) {
  if (!index) return null;
  const ci = Math.floor(lat / SNAP_GRID_CELL_DEG);
  const cj = Math.floor(lon / SNAP_GRID_CELL_DEG);
  const seen = new Set();
  let best = null;
  for (let di = -1; di <= 1; di++) {
    for (let dj = -1; dj <= 1; dj++) {
      const bucket = index.cells.get(`${ci + di}:${cj + dj}`);
      if (!bucket) continue;
      for (const fi of bucket) {
        if (seen.has(fi)) continue;
        seen.add(fi);
        const f = index.features[fi];
        const proj = projectOntoLineString(lat, lon, f.geometry.coordinates);
        if (!proj || proj.distM > maxDistM) continue;
        if (!best || proj.distM < best.proj.distM) best = { feature: f, proj };
      }
    }
  }
  return best;
}

// Bygg en eksplisitt waypoint-liste fra (fromIdx, fromT) til (toIdx, toT)
// langs en LineString. Returnerer [{lat, lon, cumDistM}] der første element
// er nøyaktig snapped-fra og siste er nøyaktig snapped-til. Håndterer både
// forover- og bakover-retning langs segmentene.
function buildSnapPath(coords, fromProj, toProj) {
  const pointOnSeg = (idx, t) => {
    const [lo1, la1] = coords[idx];
    const [lo2, la2] = coords[idx + 1];
    return { lat: la1 + (la2 - la1) * t, lon: lo1 + (lo2 - lo1) * t };
  };
  const start = pointOnSeg(fromProj.idx, fromProj.t);
  const end = pointOnSeg(toProj.idx, toProj.t);
  const points = [start];

  if (fromProj.idx === toProj.idx) {
    // Begge på samme segment — bare endepunktene.
  } else if (fromProj.idx < toProj.idx) {
    // Forover: gå gjennom toppunkter fra fromIdx+1 til toIdx (inkludert).
    for (let i = fromProj.idx + 1; i <= toProj.idx; i++) {
      points.push({ lat: coords[i][1], lon: coords[i][0] });
    }
  } else {
    // Bakover.
    for (let i = fromProj.idx; i >= toProj.idx + 1; i--) {
      points.push({ lat: coords[i][1], lon: coords[i][0] });
    }
  }
  points.push(end);

  let cum = 0;
  const path = [{ lat: points[0].lat, lon: points[0].lon, cumDistM: 0 }];
  for (let i = 1; i < points.length; i++) {
    const seg = llDistMeters(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
    cum += seg;
    path.push({ lat: points[i].lat, lon: points[i].lon, cumDistM: cum });
  }
  return path;
}

// Hovedinngang: forsøk å snappe en tween fra/til-par på et sporsegment.
// Returnerer en path (array) for `interpolateAlongPath`, eller null hvis
// snap ikke er trygt (ingen segment innen 100 m, eller fra/til projiserer
// på forskjellige features).
function computeSnapPath(from, to) {
  const idx = state.railwayIndex;
  if (!idx) return null;
  // Finn nærmeste segment til midt-punktet — gir robusthet hvis ett av
  // endepunktene tilfeldigvis ligger nærmest et helt annet (parallelt) spor.
  const midLat = (from.lat + to.lat) / 2;
  const midLon = (from.lon + to.lon) / 2;
  const seg = findNearestRailwayFeature(idx, midLat, midLon, SNAP_MAX_DIST_M);
  if (!seg) return null;
  const coords = seg.feature.geometry.coordinates;
  const fromProj = projectOntoLineString(from.lat, from.lon, coords);
  const toProj = projectOntoLineString(to.lat, to.lon, coords);
  if (!fromProj || !toProj) return null;
  if (fromProj.distM > SNAP_MAX_DIST_M || toProj.distM > SNAP_MAX_DIST_M) return null;
  return buildSnapPath(coords, fromProj, toProj);
}

// Interpolér en arc-length-parametrisering t∈[0,1] langs en pre-bygget path.
// Binærsøk er overkill for korte paths (<10 punkter typisk); lineær walk
// er enklere og raskt nok.
function interpolateAlongPath(path, t) {
  if (path.length === 0) return { lat: 0, lon: 0 };
  if (path.length === 1) return { lat: path[0].lat, lon: path[0].lon };
  const total = path[path.length - 1].cumDistM;
  if (total <= 0) return { lat: path[0].lat, lon: path[0].lon };
  const target = total * t;
  for (let i = 1; i < path.length; i++) {
    if (path[i].cumDistM >= target) {
      const segLen = path[i].cumDistM - path[i - 1].cumDistM;
      const local = segLen > 0 ? (target - path[i - 1].cumDistM) / segLen : 0;
      return {
        lat: path[i - 1].lat + (path[i].lat - path[i - 1].lat) * local,
        lon: path[i - 1].lon + (path[i].lon - path[i - 1].lon) * local,
      };
    }
  }
  const last = path[path.length - 1];
  return { lat: last.lat, lon: last.lon };
}

function ensureLiveTrainsRaf(map) {
  if (state.liveTrainsRaf) return;
  const tick = () => {
    if (!state.showLiveTrains || !state.liveTrainsTrains) {
      state.liveTrainsRaf = null;
      return;
    }
    const now = Date.now();
    for (const entry of state.liveTrainsTrains.values()) {
      const pos = currentLerpLatLng(entry, now);
      entry.marker.setLatLng([pos.lat, pos.lon]);
    }
    state.liveTrainsRaf = requestAnimationFrame(tick);
  };
  state.liveTrainsRaf = requestAnimationFrame(tick);
}

function buildLiveTrainMarker(v, latLng) {
  const code = v.line?.publicCode || "?";
  const lineName = v.line?.lineName || "";

  const marker = L.circleMarker(latLng, {
    radius: 6,
    color: "#fff",
    weight: 2,
    fillColor: "#16a34a",
    fillOpacity: 0.95,
  });

  // Tooltip: kompakt linje-info som DOM (samme XSS-trygge mønster som
  // popupen). Bearing vises bare når Entur faktisk har det.
  const tip = document.createElement("span");
  const tipCode = document.createElement("strong");
  tipCode.textContent = code;
  tip.append(tipCode);
  if (lineName) tip.append(document.createTextNode(` — ${lineName}`));
  if (v.bearing != null) {
    tip.append(document.createTextNode(` (${Math.round(v.bearing)}°)`));
  }
  marker.bindTooltip(tip, { direction: "top" });

  // Popup med follow-knapp når vi har en datedServiceJourney-id (alltid
  // tilgjengelig fra Entur, men vi guarder for sikkerhets skyld).
  const journeyId = v.datedServiceJourney?.id;
  if (journeyId) {
    const popup = document.createElement("div");
    popup.className = "popup-station popup-tog";

    const head = document.createElement("div");
    head.className = "popup-station-head";
    const title = document.createElement("h3");
    title.className = "popup-station-title";
    title.textContent = code;
    head.append(title);
    if (lineName) {
      const meta = document.createElement("div");
      meta.className = "popup-station-meta";
      meta.textContent = lineName;
      head.append(meta);
    }
    popup.append(head);

    const actions = document.createElement("div");
    actions.className = "popup-station-actions";
    const link = document.createElement("a");
    link.className = "btn btn-primary btn-sm";
    link.href = `tog.html?id=${encodeURIComponent(journeyId)}`;
    link.textContent = "Følg dette toget →";
    actions.append(link);
    popup.append(actions);

    marker.bindPopup(popup);
  }
  return marker;
}

async function refreshLiveTrains(map) {
  if (!window.Entur || !state.showLiveTrains) return;
  let vehicles;
  try {
    vehicles = await window.Entur.fetchVehicles();
  } catch (err) {
    console.warn("[live-tog] fetch feilet:", err.message);
    return;
  }
  if (!state.showLiveTrains) return; // bruker har slått av i mellomtiden

  // Initialiser layer-gruppe og tween-Map én gang.
  if (!state.liveTrainsLayer) {
    state.liveTrainsLayer = L.layerGroup().addTo(map);
  }
  if (!state.liveTrainsTrains) {
    state.liveTrainsTrains = new Map();
  }

  const now = Date.now();
  const seen = new Set();

  // Vehicles uten lastUpdated behandles som stale (Infinity), ikke som
  // "ferskest mulig" (0). Ellers ville et tog uten timestamp aldri blitt
  // prunet av age-filteret — den implisitte invarianten "Entur sender alltid
  // lastUpdated" er ikke noe vi vil stole på som en sikkerhetslinje.
  const STALE_MS = 5 * 60 * 1000;
  for (const v of vehicles) {
    const loc = v.location;
    const journeyId = v.datedServiceJourney?.id;
    if (!loc || !journeyId) continue;
    const ageMs = v.lastUpdated ? now - Date.parse(v.lastUpdated) : Infinity;
    if (ageMs > STALE_MS) continue;
    seen.add(journeyId);

    const newPos = { lat: loc.latitude, lon: loc.longitude };
    const existing = state.liveTrainsTrains.get(journeyId);

    if (existing) {
      // Steer eksisterende markør: ny `from` = der den faktisk er nå.
      const fromNow = currentLerpLatLng(existing, now);
      existing.from = fromNow;
      existing.to = newPos;
      existing.tStart = now;
      existing.tEnd = now + LIVE_LERP_MS;
      existing.bearing = v.bearing;
      // Snap er gyldig per tween-vindu — rekompute hver gang from/to endres.
      existing.snap = computeSnapPath(fromNow, newPos);
    } else {
      // Ny markør — start uten animasjon. Snap har ingen effekt her siden
      // tEnd === tStart (t=1 umiddelbart), men vi setter feltet for konsistens.
      const marker = buildLiveTrainMarker(v, [newPos.lat, newPos.lon]);
      state.liveTrainsLayer.addLayer(marker);
      state.liveTrainsTrains.set(journeyId, {
        marker,
        from: newPos,
        to: newPos,
        tStart: now,
        tEnd: now,
        bearing: v.bearing,
        snap: null,
      });
    }
  }

  // Fjern tog som ikke lenger rapporterer.
  for (const [id, entry] of state.liveTrainsTrains) {
    if (!seen.has(id)) {
      state.liveTrainsLayer.removeLayer(entry.marker);
      state.liveTrainsTrains.delete(id);
    }
  }

  state.liveTrainsLastUpdate = now;
  const cnt = document.getElementById("cnt-live-trains");
  if (cnt) cnt.textContent = `${state.liveTrainsTrains.size}`;

  ensureLiveTrainsRaf(map);
}

async function setLiveTrains(map, on) {
  state.showLiveTrains = on;
  if (state.liveTrainsTimer) {
    clearInterval(state.liveTrainsTimer);
    state.liveTrainsTimer = null;
  }
  if (state.liveTrainsRaf) {
    cancelAnimationFrame(state.liveTrainsRaf);
    state.liveTrainsRaf = null;
  }
  if (state.liveTrainsLayer) {
    map.removeLayer(state.liveTrainsLayer);
    state.liveTrainsLayer = null;
  }
  state.liveTrainsTrains = null;
  if (on) {
    // Tving lasting av full railways.geojson før første poll. Overview-fila
    // er simplifisert med 100 m toleranse — det matcher snap-distansen vår
    // og ville gitt høy "miss"-rate. Den ekstra ~5 MB-en er akseptabelt
    // UX-bytte når brukeren eksplisitt aktiverer live tog.
    await ensureFullRailwaysLoaded(map);
    // Bygg eller gjenbruk snap-index én gang etter at full data er klar.
    if (!state.railwayIndex && state.railwaysIsFull) {
      state.railwayIndex = buildRailwayIndex(state.railwaysData.features);
    }
    // Brukeren kan ha slått av igjen mens vi ventet på fullasting.
    if (!state.showLiveTrains) return;
    refreshLiveTrains(map);
    state.liveTrainsTimer = setInterval(() => refreshLiveTrains(map), LIVE_TRAINS_INTERVAL_MS);
  } else {
    const cnt = document.getElementById("cnt-live-trains");
    if (cnt) cnt.textContent = "";
  }
}

// Visuell hierarki for stasjonsmarkører — speiler informasjons-viktighet:
//   tog-stasjon m/ UIC > tog-stasjon > holdeplass > stoppunkt
// Søketreff overstyrer alt med amber-aksent slik at brukeren ser dem
// uavhengig av type.
function styleForStation(props) {
  if (state.searchQuery) {
    return {
      radius: 10, color: "#c2410c", weight: 3,
      fillColor: "#fef3c7", fillOpacity: 1,
    };
  }
  const type = props.railway;
  const hasUic = Boolean(props.uic_ref);

  if (type === "station") {
    return {
      radius: hasUic ? 9 : 7,
      color: "#fff",
      weight: hasUic ? 3 : 2,
      fillColor: "#1d4ed8",
      fillOpacity: 1,
    };
  }
  if (type === "halt") {
    return {
      radius: 6,
      color: "#0d9488",
      weight: 2.5,
      fillColor: "#fff",
      fillOpacity: 1,
    };
  }
  // stop (stoppunkt) — minimalt visuelt fotavtrykk siden de er tallrike (868),
  // men stor nok klikk-flate til å unngå at brukere må zoome langt inn for
  // å treffe markøren.
  return {
    radius: 5,
    color: "#64748b",
    weight: 1.5,
    fillColor: "#cbd5e1",
    fillOpacity: 0.95,
  };
}

function renderStations(map) {
  if (state.stationLayer) map.removeLayer(state.stationLayer);
  const filtered = {
    type: "FeatureCollection",
    features: state.stationsData.features.filter(stationVisible),
  };
  state.stationLayer = L.geoJSON(filtered, {
    pointToLayer: (f, latlng) => L.circleMarker(latlng, styleForStation(f.properties)),
    onEachFeature: (f, layer) => attachStationPopup(f, layer),
  }).addTo(map);
}

// Stasjons-popup: dedikert layout (ikke rå OSM-tag-tabell).
// Hierarki: tittel → meta-chips → driftsmeldinger → avganger → handlinger.
// Den rå tag-dumpen (som `buildPopup` bygger for sporsegmenter) er bevisst
// utelatt her — brukere åpner en stasjons-popup for å se avganger, ikke
// OSM-feltnavn. For full detaljer er det "Åpne stasjonsside"-knappen.
function attachStationPopup(feature, layer) {
  const props = feature.properties;
  const wd = state.wikidata?.[props.name];

  const content = document.createElement("div");
  content.className = "popup-station";

  // Header: navn + meta-linje (network · operator · UIC).
  const header = document.createElement("div");
  header.className = "popup-station-head";
  const title = document.createElement("h3");
  title.className = "popup-station-title";
  title.textContent = props.name || "(uten navn)";
  header.append(title);

  const metaParts = [];
  if (props.network) metaParts.push(props.network);
  if (props.operator) metaParts.push(props.operator);
  if (props.uic_ref) metaParts.push(`UIC ${props.uic_ref}`);
  else if (props.ref) metaParts.push(`Ref ${props.ref}`);
  if (metaParts.length) {
    const meta = document.createElement("div");
    meta.className = "popup-station-meta";
    meta.textContent = metaParts.join(" · ");
    header.append(meta);
  }

  // Vernestatus-badge — fra Wikidata. Vises inline i headeren slik at den
  // er knyttet til navnet, ikke til avgangs-listen.
  if (wd?.heritage?.length) {
    const badge = document.createElement("div");
    badge.className = "popup-heritage-badge";
    badge.textContent = `🏛 ${wd.heritage[0]}`;
    badge.title = wd.heritage.join(" · ");
    header.append(badge);
  }
  content.append(header);

  // Driftsmeldinger (slot — fylles av loadDepartures).
  const sit = document.createElement("div");
  sit.className = "situations";
  sit.dataset.role = "situations";
  content.append(sit);

  // Avgangsliste (slot — fylles av loadDepartures). Plassert FØR knappene
  // siden det er hovedinnholdet brukeren ønsker å se.
  const dep = document.createElement("div");
  dep.className = "departures";
  dep.dataset.role = "departures";
  const placeholder = document.createElement("div");
  placeholder.className = "dep-placeholder";
  placeholder.textContent = "Avganger lastes når popup åpnes…";
  dep.append(placeholder);
  content.append(dep);

  // Handlinger nederst: sekundære, like vekting.
  const actions = document.createElement("div");
  actions.className = "popup-station-actions";

  const isoBtn = document.createElement("button");
  isoBtn.type = "button";
  isoBtn.className = "btn btn-ghost btn-sm";
  isoBtn.textContent = "Reisetider herfra";
  isoBtn.addEventListener("click", () => {
    const [lon, lat] = feature.geometry.coordinates;
    if (window.Isochrone && window.__app?.map) {
      window.__app.map.closePopup();
      window.Isochrone.run(window.__app.map, lat, lon);
    }
  });
  actions.append(isoBtn);

  if (props.name) {
    const link = document.createElement("a");
    link.className = "btn btn-primary btn-sm";
    link.href = `stasjon.html?navn=${encodeURIComponent(props.name)}`;
    link.textContent = "Åpne stasjonsside →";
    actions.append(link);
  }
  content.append(actions);

  layer.bindPopup(content);
  layer.on("popupopen", () => loadDepartures(feature, dep, sit));
}

async function loadDepartures(feature, slot, sitSlot) {
  if (!window.Entur) return;
  // Unngå dobbelt-fetch hvis bruker åpner samme popup raskt to ganger.
  if (slot.dataset.loading === "1") return;
  slot.dataset.loading = "1";

  showDepStatus(slot, "Henter avganger fra Entur…");
  const [lng, lat] = feature.geometry.coordinates;

  try {
    const stop = await window.Entur.findStopPlace(lat, lng);
    if (!stop) {
      showDepStatus(slot, "Ingen Entur-data for denne stasjonen.", "muted");
      return;
    }
    // Hent avganger og avvik parallelt — én rundtur ekstra, ingen seriellisering.
    const [calls, situations] = await Promise.all([
      window.Entur.fetchDepartures(stop.id, 5),
      window.Entur.fetchSituations(stop.id).catch(() => []),
    ]);
    if (sitSlot) renderSituations(sitSlot, situations);
    if (calls.length === 0) {
      showDepStatus(slot, `${stop.name}: ingen togavganger neste 2 timer.`, "muted");
      return;
    }
    renderDepartures(slot, stop, calls);
  } catch (err) {
    showDepStatus(slot, `Klarte ikke hente avganger: ${err.message}`, "error");
  } finally {
    slot.dataset.loading = "";
  }
}

function renderSituations(slot, situations) {
  slot.replaceChildren();
  if (!situations || situations.length === 0) return;

  const heading = document.createElement("strong");
  heading.textContent = situations.length === 1
    ? "Driftsmelding"
    : `Driftsmeldinger (${situations.length})`;
  slot.append(heading);

  for (const s of situations) {
    const item = document.createElement("div");
    item.className = `sit-item sit-${s.severity}`;
    if (s.summary) {
      const sum = document.createElement("div");
      sum.className = "sit-summary";
      sum.textContent = s.summary;
      item.append(sum);
    }
    if (s.description && s.description !== s.summary) {
      const desc = document.createElement("div");
      desc.className = "sit-desc";
      desc.textContent = s.description;
      item.append(desc);
    }
    if (s.advice) {
      const adv = document.createElement("div");
      adv.className = "sit-advice";
      adv.textContent = s.advice;
      item.append(adv);
    }
    slot.append(item);
  }
}

function showDepStatus(slot, text, kind) {
  slot.replaceChildren();
  const p = document.createElement("p");
  p.className = `dep-status${kind ? " " + kind : ""}`;
  p.textContent = text;
  slot.append(p);
}

function renderDepartures(slot, stop, calls) {
  slot.replaceChildren();

  const heading = document.createElement("strong");
  heading.textContent = `${stop.name} — neste avganger`;
  slot.append(heading);

  const table = document.createElement("table");
  table.className = "dep-list";
  for (const call of calls) {
    const expected = new Date(call.expectedDepartureTime);
    const aimed = new Date(call.aimedDepartureTime);
    const delaySec = Math.round((expected - aimed) / 1000);

    const tr = document.createElement("tr");

    const tdTime = document.createElement("td");
    tdTime.textContent = expected.toLocaleTimeString("nb-NO", {
      hour: "2-digit", minute: "2-digit",
    });
    if (delaySec > 60) {
      tdTime.classList.add("dep-delayed");
      tdTime.title = `${Math.round(delaySec / 60)} min forsinket (planlagt ${
        aimed.toLocaleTimeString("nb-NO", { hour: "2-digit", minute: "2-digit" })
      })`;
    } else if (call.realtime) {
      tdTime.classList.add("dep-realtime");
      tdTime.title = "Sanntid";
    }

    const tdLine = document.createElement("td");
    tdLine.className = "dep-line";
    tdLine.textContent = call.serviceJourney?.line?.publicCode || "";

    const tdDest = document.createElement("td");
    tdDest.textContent = call.destinationDisplay?.frontText || "?";

    const tdQuay = document.createElement("td");
    tdQuay.className = "dep-quay";
    tdQuay.textContent = call.quay?.publicCode ? `Spor ${call.quay.publicCode}` : "";

    tr.append(tdTime, tdLine, tdDest, tdQuay);
    table.append(tr);
  }
  slot.append(table);
}

// ---------- Operatør-checkboxes ----------

function renderOperatorList() {
  const container = document.getElementById("operator-list");
  container.replaceChildren();
  // Vis topp 12 + slå sammen resten i "Andre (N)". I tillegg dyttes alle
  // operatører med <2 km over i tail-bøtta — de er typisk private spor og
  // gir bare visuell støy på filter-listen.
  const TOPN = 12;
  const MIN_KM = 2;
  const significant = state.operators.filter(([, km]) => km >= MIN_KM);
  const top = significant.slice(0, TOPN);
  const topNames = new Set(top.map(([op]) => op));
  const tail = state.operators.filter(([op]) => !topNames.has(op));
  const tailKm = tail.reduce((s, [, km]) => s + km, 0);
  // Lagre eksakt samme liste som tail-raden representerer, så bulk-toggle av
  // "Andre (N)" treffer nøyaktig de operatørene brukeren ser slått sammen.
  state.tailOperatorNames = tail.map(([op]) => op);

  for (const [op, km] of top) {
    container.append(buildOperatorRow(op, km));
  }
  if (tail.length) {
    const label = `Andre (${tail.length})`;
    const row = buildOperatorRow(label, tailKm);
    row.dataset.tail = "1";
    container.append(row);
  }
}

function buildOperatorRow(displayName, km) {
  const label = document.createElement("label");
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = true;
  cb.dataset.operator = displayName;
  // Grid: [checkbox] [navn (flex-grow + ellipsis ved overflow)] [km høyrejustert]
  const name = document.createElement("span");
  name.textContent = displayName;
  name.style.overflow = "hidden";
  name.style.textOverflow = "ellipsis";
  name.title = displayName;  // hover viser fullt navn ved trunkering
  const small = document.createElement("small");
  small.textContent = `${Math.round(km)} km`;
  label.append(cb, name, small);
  return label;
}

function tailOperators() {
  return state.tailOperatorNames || [];
}

// ---------- Live statistikk i filterpanelet ----------

// Oppdaterer statusbaren med segment-antall + filter-beskrivelse.
// KM og elektrifisert% rendres i Oversikt-gruppen via renderStatsSummary —
// statusbaren skal være lean nok til ikke å gjenta de samme tallene.
function updateLiveStats(visible) {
  if (!visible) visible = state.railwaysData.features.filter(featureVisible);
  updateStatusBar(visible);
}

function isElectrified(props) {
  const e = (props.electrified || "").toLowerCase();
  return Boolean(e) && e !== "no";
}

// ---------- Statistikkpanel (synkronisert med filter) ----------

function isFilterActive() {
  const defaultSt = new Set(DEFAULT_STATION_TYPES);
  const stDiffersFromDefault =
    state.enabledStationTypes.size !== defaultSt.size
    || [...state.enabledStationTypes].some((t) => !defaultSt.has(t));
  return (
    state.electrificationFilter !== "all"
    || state.enabledTypes.size !== ALL_TYPES.length
    || (state.operators && state.enabledOperators.size !== state.operators.length)
    || state.searchQuery
    || stDiffersFromDefault
    || state.onlyUicStations
  );
}

function computeFilteredStats(features) {
  // Kart-siden viser kun km + elektrifisert%-summary. Charts (banetyper,
  // hastighet, spor-kapasitet, voltage, fastest) er på dashboard og leses
  // direkte fra stats.json — ingen filtrert re-aggregering trengs her.
  let totalKm = 0;
  let elecKm = 0;
  for (const f of features) {
    const km = f.properties.length_km || 0;
    totalKm += km;
    if (isElectrified(f.properties)) elecKm += km;
  }
  return {
    total_km: totalKm,
    electrified_km: elecKm,
    electrified_pct: totalKm > 0 ? (elecKm / totalKm) * 100 : 0,
  };
}

function renderStatsSummary(stats) {
  const summary = document.getElementById("stats-summary");
  summary.replaceChildren();

  // Header row with filter pill
  const heading = document.createElement("p");
  heading.style.margin = "0 0 var(--sp-3) 0";
  heading.style.fontSize = "var(--fs-xs)";
  heading.style.color = "var(--c-muted)";
  heading.style.textTransform = "uppercase";
  heading.style.letterSpacing = "0.05em";
  heading.textContent = isFilterActive()
    ? "Filtrert utvalg" : "Hele datasettet";
  if (isFilterActive()) {
    const badge = document.createElement("span");
    badge.className = "pill pill-warning";
    badge.style.marginLeft = "var(--sp-2)";
    badge.textContent = "filter aktivt";
    heading.append(" ", badge);
  }
  summary.append(heading);

  const card = document.createElement("div");
  card.className = "stat-card";

  card.append(
    statCell(`${Math.round(stats.total_km).toLocaleString("nb-NO")} km`, "Banelengde"),
    statCell(
      `${stats.electrified_pct.toLocaleString("nb-NO", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`,
      "Elektrifisert"
    ),
  );

  summary.append(card);
}

function statCell(num, desc) {
  const wrap = document.createElement("div");
  wrap.className = "stat";
  const n = document.createElement("span");
  n.className = "num";
  n.textContent = num;
  const d = document.createElement("span");
  d.className = "desc";
  d.textContent = desc;
  wrap.append(n, d);
  return wrap;
}

function renderStats(visibleFeatures) {
  if (!visibleFeatures) {
    visibleFeatures = state.railwaysData.features.filter(featureVisible);
  }
  // Kart-siden viser kun "filtrert utvalg" som mini-summary. Charts og
  // breakdowns er flyttet til /dashboard.html for å unngå at samme tall
  // vises to steder. Lenke nederst i sidebar peker dit.
  const stats = computeFilteredStats(visibleFeatures);
  renderStatsSummary(stats);
}

// ---------- Legende ----------

function renderLegend() {
  const el = document.getElementById("legend");
  el.replaceChildren();

  const heading = document.createElement("h3");
  heading.textContent = legendTitle();
  el.append(heading);

  switch (state.colorMode) {
    case "electrification":
      el.append(swatchRow("#2563eb", "Elektrifisert"));
      el.append(swatchRow("#9b2c2c", "Ikke elektrifisert"));
      break;
    case "speed": {
      const grad = document.createElement("div");
      grad.className = "gradient";
      el.append(grad);
      const labels = document.createElement("div");
      labels.className = "gradient-labels";
      const lo = document.createElement("span"); lo.textContent = "40 km/h";
      const hi = document.createElement("span"); hi.textContent = "200+ km/h";
      labels.append(lo, hi);
      el.append(labels);
      el.append(swatchRow("#bbb", "Ukjent hastighet"));
      break;
    }
    case "type":
      for (const [type, color] of Object.entries(TYPE_COLORS)) {
        el.append(swatchRow(color, prettyType(type)));
      }
      break;
    case "tracks":
      el.append(swatchRow("#c2410c", "Enkeltspor"));
      el.append(swatchRow("#0d9488", "Dobbeltspor"));
      el.append(swatchRow("#1d4ed8", "Multispor (3+)"));
      el.append(swatchRow("#cbd5e1", "Ikke tagget"));
      break;
  }

  // Samle aktive filter-notater så legenden ikke "lyver" om hva kartet
  // faktisk viser. F.eks. i type-fargemodus kan legenden vise alle 8
  // farger selv om bare én type er hektet på.
  const notes = [];
  if (state.electrificationFilter !== "all") {
    notes.push(state.electrificationFilter === "yes"
      ? "Bare elektrifisert" : "Bare ikke-elektrifisert");
  }
  if (state.enabledTypes.size !== ALL_TYPES.length) {
    notes.push(`${state.enabledTypes.size} av ${ALL_TYPES.length} banetyper`);
  }
  if (state.operators && state.enabledOperators.size !== state.operators.length) {
    notes.push(`${state.enabledOperators.size} av ${state.operators.length} operatører`);
  }
  if (state.searchQuery) {
    notes.push(`Søk: «${state.searchQuery}»`);
  }
  for (const text of notes) {
    const note = document.createElement("div");
    note.className = "filtered-note";
    note.textContent = text;
    el.append(note);
  }
}

function legendTitle() {
  return state.colorMode === "speed" ? "Maks-hastighet"
    : state.colorMode === "type" ? "Banetype"
    : state.colorMode === "tracks" ? "Spor-kapasitet"
    : "Elektrifisering";
}

function swatchRow(color, label) {
  const row = document.createElement("div");
  row.className = "row";
  const sw = document.createElement("span");
  sw.className = "swatch";
  sw.style.background = color;
  const text = document.createElement("span");
  text.textContent = label;
  row.append(sw, text);
  return row;
}

function prettyType(type) {
  return ({
    rail: "Tog",
    narrow_gauge: "Smalspor",
    preserved: "Museumsbane",
  })[type] || type;
}

// ---------- Søkeresultat-håndtering ----------

let searchTimer = null;

function onSearchInput(map, e) {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => applySearch(map, e.target.value.trim().toLowerCase()), 200);
}

function applySearch(map, query) {
  state.searchQuery = query;
  renderRailways(map);
  renderStations(map);
  // applySearch er eneste vei søk når inn i URL-state — andre filter-endringer
  // går via applyFilterChange som også kaller updateUrl.
  updateUrl();

  const hint = document.getElementById("search-result");
  if (!query) { hint.textContent = ""; return; }

  const matchingFeatures = state.railwaysData.features.filter(featureVisible);
  const matchingStations = state.stationsData.features.filter(stationVisible);
  const total = matchingFeatures.length + matchingStations.length;

  if (total === 0) {
    hint.textContent = `Ingen treff for "${query}"`;
    return;
  }
  hint.textContent = `${total} treff (${matchingFeatures.length} spor, ${matchingStations.length} stasjoner)`;

  // Zoom til treffene.
  const allLayers = L.geoJSON({
    type: "FeatureCollection",
    features: [...matchingFeatures, ...matchingStations],
  });
  const bounds = allLayers.getBounds();
  if (bounds.isValid()) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 13 });
}

// ---------- Event-binding ----------

// Sentral re-render etter filter-endring. Kalles fra hver handler etter
// state-mutering, så vi slipper å huske å trigge legenden eller URL-en
// hvert sted. `affects` styrer hvilke lag som regenereres.
function applyFilterChange(map, affects = { railways: true, stations: true, legend: true }) {
  if (affects.railways) renderRailways(map);
  if (affects.stations) renderStations(map);
  if (affects.legend) renderLegend();
  // Filter-tekst i statusbaren må oppdateres uansett hvilken filter som
  // endret seg, fordi `filterSummary` leser fra hele state-en.
  refreshFilterStatus();
  updateUrl();
}

function wireFilters(map) {
  // Søk
  document.getElementById("search").addEventListener("input", (e) => onSearchInput(map, e));

  // Fargemodus — påvirker kun jernbane-laget og legenden.
  document.getElementById("color-mode").addEventListener("change", (e) => {
    state.colorMode = e.target.value;
    applyFilterChange(map, { railways: true, stations: false, legend: true });
  });

  // Elektrifiseringsfilter — gjelder kun jernbane (stasjoner er fysiske strukturer).
  document.getElementById("electrification-filter").addEventListener("change", (e) => {
    state.electrificationFilter = e.target.value;
    applyFilterChange(map, { railways: true, stations: false, legend: true });
  });

  // Banetype-checkboxes — gjelder jernbane (stasjoner har egne typer).
  document.querySelectorAll('.sidebar input[type="checkbox"][data-type]')
    .forEach((cb) => {
      cb.addEventListener("change", () => {
        if (cb.checked) state.enabledTypes.add(cb.dataset.type);
        else state.enabledTypes.delete(cb.dataset.type);
        applyFilterChange(map, { railways: true, stations: false, legend: true });
      });
    });


  // Operatør-checkboxes (delegated, fordi de bygges dynamisk)
  document.getElementById("operator-list").addEventListener("change", (e) => {
    if (!e.target.matches('input[type="checkbox"][data-operator]')) return;
    const op = e.target.dataset.operator;
    if (op.startsWith("Andre (")) {
      // "Andre (X)"-raden styrer alle hale-operatører
      const tail = tailOperators();
      tail.forEach((t) => {
        if (e.target.checked) state.enabledOperators.add(t);
        else state.enabledOperators.delete(t);
      });
    } else {
      if (e.target.checked) state.enabledOperators.add(op);
      else state.enabledOperators.delete(op);
    }
    // Operatør-filter gjelder BÅDE jernbane og stasjoner.
    applyFilterChange(map, { railways: true, stations: true, legend: true });
  });

  // Bulk-knapper
  document.querySelectorAll('.sidebar button[data-bulk]').forEach((btn) => {
    btn.addEventListener("click", () => bulkAction(btn.dataset.bulk, map));
  });

  // Stasjonstyper — kun stasjons-laget.
  document.querySelectorAll('.sidebar input[data-station-type]').forEach((cb) => {
    cb.addEventListener("change", () => {
      if (cb.checked) state.enabledStationTypes.add(cb.dataset.stationType);
      else state.enabledStationTypes.delete(cb.dataset.stationType);
      applyFilterChange(map, { railways: false, stations: true, legend: false });
    });
  });

  // Kun UIC-kodede stasjoner
  document.getElementById("only-uic").addEventListener("change", (e) => {
    state.onlyUicStations = e.target.checked;
    applyFilterChange(map, { railways: false, stations: true, legend: false });
  });

  // Tilleggslag: planoverganger fra NVDB
  const planCheckbox = document.getElementById("show-planoverganger");
  if (planCheckbox) {
    planCheckbox.addEventListener("change", (e) => {
      state.showPlanoverganger = e.target.checked;
      renderPlanoverganger(map);
    });
    // Antall i sidebar
    const cnt = document.getElementById("cnt-planoverganger");
    if (cnt && state.planovergangerData) {
      cnt.textContent = `${state.planovergangerData.features.length}`;
    }
  }

  // Tilleggslag: live tog fra Entur Vehicles
  const liveCheckbox = document.getElementById("show-live-trains");
  if (liveCheckbox) {
    liveCheckbox.addEventListener("change", (e) => {
      setLiveTrains(map, e.target.checked);
    });
  }

  // Reset
  document.getElementById("reset-filter").addEventListener("click", () => resetFilter(map));
  document.getElementById("filter-empty-reset")?.addEventListener("click", () => resetFilter(map));
}

function bulkAction(action, map) {
  switch (action) {
    case "types-all":
    case "types-none": {
      const checked = action === "types-all";
      state.enabledTypes = new Set(checked ? ALL_TYPES : []);
      document.querySelectorAll('.sidebar input[data-type]')
        .forEach((cb) => { cb.checked = checked; });
      applyFilterChange(map, { railways: true, stations: false, legend: true });
      break;
    }
    case "ops-all":
    case "ops-none": {
      const checked = action === "ops-all";
      state.enabledOperators = new Set(
        checked ? state.operators.map(([op]) => op) : []
      );
      document.querySelectorAll('#operator-list input[data-operator]')
        .forEach((cb) => { cb.checked = checked; });
      applyFilterChange(map, { railways: true, stations: true, legend: true });
      break;
    }
    case "stations-all":
    case "stations-none":
    case "stations-default": {
      const target =
        action === "stations-all" ? new Set(ALL_STATION_TYPES)
        : action === "stations-default" ? new Set(DEFAULT_STATION_TYPES)
        : new Set();
      state.enabledStationTypes = target;
      document.querySelectorAll('.sidebar input[data-station-type]')
        .forEach((cb) => { cb.checked = target.has(cb.dataset.stationType); });
      applyFilterChange(map, { railways: false, stations: true, legend: false });
      break;
    }
  }
}

function resetFilter(map) {
  state.colorMode = "electrification";
  state.electrificationFilter = "all";
  state.enabledTypes = new Set(ALL_TYPES);
  state.enabledOperators = new Set(state.operators.map(([op]) => op));
  state.searchQuery = "";
  state.enabledStationTypes = new Set(DEFAULT_STATION_TYPES);
  state.onlyUicStations = false;

  document.getElementById("color-mode").value = "electrification";
  document.getElementById("electrification-filter").value = "all";
  document.getElementById("search").value = "";
  document.getElementById("search-result").textContent = "";
  document.getElementById("only-uic").checked = false;

  // Banetype + operatør: alt på
  document.querySelectorAll(
    '.sidebar input[data-type], #operator-list input[data-operator]'
  ).forEach((cb) => { cb.checked = true; });

  // Stasjonstyper: standard-utvalg
  document.querySelectorAll('.sidebar input[data-station-type]')
    .forEach((cb) => {
      cb.checked = state.enabledStationTypes.has(cb.dataset.stationType);
    });

  renderRailways(map);
  renderStations(map);
  renderLegend();
  updateUrl();  // tøm URL-hash slik at refresh ikke restaurerer gammel state
}

function showLoadError(message) {
  const summary = document.getElementById("stats-summary");
  summary.replaceChildren();
  const p = document.createElement("p");
  p.style.color = "#c00";
  p.textContent = `Kunne ikke laste data. Har du kjørt data/process.py? (${message})`;
  summary.append(p);
}

// ---------- Statusbar ----------

// Oppdaterer kun det som finnes i den slanke statusbaren: segment-antall
// + filter-beskrivelse. KM og elektrifisert%-tall vises i Oversikt-gruppen
// i sidebar — denne fila er bevisst tøm for redundante tall.
function updateStatusBar(visible) {
  const segEl = document.getElementById("status-segments");
  if (segEl) segEl.textContent = visible.length.toLocaleString("nb-NO");
  refreshFilterStatus();
}

// Oppdaterer kun filter-tekstdelen av statusbar — billig nok til å kjøre
// på hver filterendring (også når kun stasjoner endres).
function refreshFilterStatus() {
  const el = document.getElementById("status-filter");
  if (el) el.textContent = isFilterActive() ? filterSummary() : "Standardvisning";
  refreshGroupChips();
}

// Hver sidebar-gruppe får en kompakt chip i sin <summary> som viser
// nåværende tilstand når gruppen er lukket. Sparer brukeren for å åpne
// hver enkelt for å se hva som er valgt. CSS skjuler chip-en automatisk
// når <details> er åpen (innholdet er da canonical kilde).
function refreshGroupChips() {
  const cmLabel = {
    electrification: "Elektrifisering",
    speed: "Hastighet",
    type: "Banetype",
    tracks: "Spor",
  }[state.colorMode] || state.colorMode;
  const efSuffix = state.electrificationFilter === "yes" ? " · elek."
    : state.electrificationFilter === "no" ? " · ikke-elek." : "";
  setChip("display", `${cmLabel}${efSuffix}`,
    state.electrificationFilter !== "all" || state.colorMode !== "electrification");

  const allTypes = ALL_TYPES.length;
  const onTypes = state.enabledTypes.size;
  setChip("types",
    onTypes === allTypes ? `Alle ${allTypes}` : `${onTypes} av ${allTypes}`,
    onTypes !== allTypes);

  const allOps = (state.operators || []).length;
  const onOps = state.enabledOperators ? state.enabledOperators.size : allOps;
  if (allOps > 0) {
    setChip("operators",
      onOps === allOps ? `Alle ${allOps}` : `${onOps} av ${allOps}`,
      onOps !== allOps);
  } else {
    setChip("operators", "", false);
  }

  const defaultSt = new Set(DEFAULT_STATION_TYPES);
  const stDiffers = state.enabledStationTypes.size !== defaultSt.size
    || [...state.enabledStationTypes].some((t) => !defaultSt.has(t));
  const stSize = state.enabledStationTypes.size;
  let stTxt;
  if (stSize === 0) stTxt = "Av";
  else if (state.onlyUicStations) stTxt = `${stSize} typer · UIC`;
  else stTxt = `${stSize} av ${ALL_STATION_TYPES.length} typer`;
  setChip("stations", stTxt, stDiffers || state.onlyUicStations);

  const extras = [];
  if (state.showPlanoverganger) extras.push("Kryssinger");
  if (state.showLiveTrains) extras.push("Live tog");
  setChip("extras", extras.length ? extras.join(" + ") : "", extras.length > 0);
}

function setChip(name, text, isActive) {
  const el = document.querySelector(`[data-chip="${name}"]`);
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("is-active", Boolean(isActive));
}

function filterSummary() {
  const parts = [];
  if (state.searchQuery) parts.push(`søk «${state.searchQuery}»`);
  if (state.electrificationFilter !== "all") {
    parts.push(state.electrificationFilter === "yes"
      ? "kun elektrifisert" : "kun ikke-elektrifisert");
  }
  if (state.enabledTypes.size !== ALL_TYPES.length) {
    parts.push(`${state.enabledTypes.size}/${ALL_TYPES.length} banetyper`);
  }
  if (state.operators && state.enabledOperators.size !== state.operators.length) {
    parts.push(`${state.enabledOperators.size}/${state.operators.length} operatører`);
  }
  // Stasjons-filterstatus — sammenlikn med default (station+halt), ikke
  // mot ALL_STATION_TYPES, siden default ikke inkluderer alle.
  const defaultSt = new Set(DEFAULT_STATION_TYPES);
  const stDiffersFromDefault =
    state.enabledStationTypes.size !== defaultSt.size
    || [...state.enabledStationTypes].some((t) => !defaultSt.has(t));
  if (stDiffersFromDefault) {
    parts.push(`${state.enabledStationTypes.size}/${ALL_STATION_TYPES.length} stasjonstyper`);
  }
  if (state.onlyUicStations) parts.push("kun UIC-stasjoner");
  return parts.length ? `Filter: ${parts.join(" · ")}` : "Standardvisning";
}

function setDataDate(iso) {
  if (!iso) return;
  try {
    const d = new Date(iso);
    document.getElementById("data-date").textContent =
      d.toLocaleDateString("nb-NO", { year: "numeric", month: "long", day: "numeric" });
  } catch {
    document.getElementById("data-date").textContent = iso;
  }
}

// ---------- URL-state ----------

function updateUrl() {
  const p = new URLSearchParams();
  if (state.colorMode !== "electrification") p.set("cm", state.colorMode);
  if (state.electrificationFilter !== "all") p.set("ef", state.electrificationFilter);
  if (state.enabledTypes.size !== ALL_TYPES.length)
    p.set("t", [...state.enabledTypes].join(","));
  // Operatør-filter persisteres bare hvis brukeren har avhuket noe.
  // Vi sjekker mot kjente operatører (ikke `enabledOperators` selv) for
  // å unngå at en URL bygd fra dataen blir altfor lang.
  if (state.knownOperators &&
      state.enabledOperators.size !== state.knownOperators.size) {
    p.set("op", [...state.enabledOperators].join("|"));
  }
  if (
    state.enabledStationTypes.size !== DEFAULT_STATION_TYPES.length ||
    [...state.enabledStationTypes].some((x) => !DEFAULT_STATION_TYPES.includes(x))
  ) {
    p.set("st", [...state.enabledStationTypes].join(","));
  }
  if (state.onlyUicStations) p.set("uic", "1");
  if (state.searchQuery) p.set("q", state.searchQuery);
  if (document.body.classList.contains("sidebar-hidden")) p.set("sb", "0");

  const hash = p.toString();
  const target = hash ? `#${hash}` : "";
  if (location.hash !== target) {
    history.replaceState(null, "", target || location.pathname);
  }
}

function restoreFromUrl() {
  const hash = location.hash.replace(/^#/, "");
  if (!hash) return;
  const p = new URLSearchParams(hash);
  if (p.has("cm")) state.colorMode = p.get("cm");
  if (p.has("ef")) state.electrificationFilter = p.get("ef");
  if (p.has("t")) state.enabledTypes = new Set(p.get("t").split(",").filter(Boolean));
  if (p.has("op")) {
    // Operatør-navn kan inneholde komma (f.eks. "Sporveien, AS"); bruker | som separator.
    state.enabledOperators = new Set(p.get("op").split("|").filter(Boolean));
  }
  if (p.has("st")) state.enabledStationTypes = new Set(p.get("st").split(",").filter(Boolean));
  if (p.has("uic")) state.onlyUicStations = p.get("uic") === "1";
  if (p.has("q")) state.searchQuery = p.get("q");
  if (p.get("sb") === "0") document.body.classList.add("sidebar-hidden");

  // Sync UI to restored state
  document.getElementById("color-mode").value = state.colorMode;
  document.getElementById("electrification-filter").value = state.electrificationFilter;
  document.getElementById("only-uic").checked = state.onlyUicStations;
  document.getElementById("search").value = state.searchQuery;
  document.querySelectorAll('.sidebar input[data-type]').forEach((cb) => {
    cb.checked = state.enabledTypes.has(cb.dataset.type);
  });
  document.querySelectorAll('.sidebar input[data-station-type]').forEach((cb) => {
    cb.checked = state.enabledStationTypes.has(cb.dataset.stationType);
  });
  // Operatør-checkboxer (renderOperatorList må allerede ha bygget dem).
  document.querySelectorAll('#operator-list input[data-operator]').forEach((cb) => {
    cb.checked = state.enabledOperators.has(cb.dataset.operator);
  });
}

// ---------- Hurtigtaster + hjelp ----------

function setupKeyboard(map) {
  document.addEventListener("keydown", (e) => {
    // Ikke fang taster når brukeren skriver i et felt (unntatt Esc).
    const inField = e.target.matches("input, select, textarea");
    if (e.key === "Escape") {
      if (document.getElementById("help-modal").classList.contains("open")) {
        closeHelp();
        e.preventDefault();
        return;
      }
      if (state.searchQuery) {
        document.getElementById("search").value = "";
        applySearch(map, "");
        e.preventDefault();
      }
      return;
    }
    if (inField) return;

    if (e.key === "/") { e.preventDefault(); document.getElementById("search").focus(); return; }
    if (e.key === "?") { e.preventDefault(); openHelp(); return; }
    if (e.key === "r" || e.key === "R") { resetFilter(map); return; }
    if (e.key === "1") setColorModeFromKey(map, "electrification");
    if (e.key === "2") setColorModeFromKey(map, "speed");
    if (e.key === "3") setColorModeFromKey(map, "type");
    if (e.key === "e" || e.key === "E") exportGeoJSON();
    if (e.key === "[") { e.preventDefault(); togglePanel(map, "sidebar"); return; }
  });
}

function setColorModeFromKey(map, mode) {
  state.colorMode = mode;
  document.getElementById("color-mode").value = mode;
  renderRailways(map);
  renderLegend();
  updateUrl();
}

function openHelp() {
  document.getElementById("help-modal").classList.add("open");
}
function closeHelp() {
  document.getElementById("help-modal").classList.remove("open");
}

// ---------- Eksport ----------

function exportGeoJSON() {
  const visibleRailways = state.railwaysData.features.filter(featureVisible);
  const visibleStations = state.stationsData.features.filter(stationVisible);
  const collection = {
    type: "FeatureCollection",
    features: [...visibleRailways, ...visibleStations],
    metadata: {
      generated_at: new Date().toISOString(),
      filter: filterSummary(),
      counts: {
        railway_segments: visibleRailways.length,
        stations: visibleStations.length,
      },
    },
  };
  const blob = new Blob([JSON.stringify(collection, null, 2)],
    { type: "application/geo+json" });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const a = document.createElement("a");
  a.href = url;
  a.download = `norsk-jernbane-${stamp}.geojson`;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---------- Oppstart ----------

(async function main() {
  const map = initMap();
  try {
    await loadData();
  } catch (err) {
    showLoadError(err.message);
    document.getElementById("loading")?.classList.add("hidden");
    return;
  }
  renderOperatorList();
  renderStationCategoryCounts();
  setDataDate(state.stats.generated_at);

  restoreFromUrl();

  window.__app = { state, map };
  renderRailways(map);
  renderStations(map);
  renderLegend();
  wireFilters(map);
  setupKeyboard(map);

  // Bytt til full railways.geojson når brukeren zoomer inn til regionalt nivå.
  // Sjekk også her, ikke bare ved zoomend, for å dekke deep-link-URL-er
  // (?z=12&...) som åpner kartet allerede zoomet inn.
  const maybeLoadFull = () => {
    if (map.getZoom() >= ZOOM_LOAD_FULL_THRESHOLD) ensureFullRailwaysLoaded(map);
  };
  map.on("zoomend", maybeLoadFull);
  maybeLoadFull();

  // URL-oppdatering kjøres nå inline via applyFilterChange (alle filter-handlers)
  // og applySearch (søk). Tidligere lå det duplikate listeners her — fjernet.

  // Top-bar-knapper
  document.getElementById("btn-export").addEventListener("click", exportGeoJSON);
  document.getElementById("btn-help").addEventListener("click", openHelp);
  document.getElementById("help-close").addEventListener("click", closeHelp);
  document.getElementById("help-modal").addEventListener("click", (e) => {
    if (e.target.id === "help-modal") closeHelp();
  });

  document.getElementById("toggle-sidebar").addEventListener("click", () => togglePanel(map, "sidebar"));

  // Icon-rail: klikk på en seksjons-ikon mens panelet er kollapset skal
  // ekspandere panelet og åpne den seksjonen — i stedet for å bare toggle
  // den (som er default <details>-oppførsel).
  bindRailClicks(map, document.querySelector(".sidebar"), "sidebar-hidden");

  document.getElementById("loading").classList.add("hidden");
})();

function togglePanel(map, which) {
  if (which !== "sidebar") return;
  document.body.classList.toggle("sidebar-hidden");
  updateUrl();
  // Leaflet må få vite at containeren har endret bredde, ellers blir kartet
  // klippet eller blankt til neste resize-event.
  setTimeout(() => map.invalidateSize(), 220);
}

function bindRailClicks(map, panel, hiddenClass) {
  if (!panel) return;
  panel.addEventListener("click", (e) => {
    if (!document.body.classList.contains(hiddenClass)) return;
    const summary = e.target.closest("summary");
    if (!summary) return;
    e.preventDefault();
    // Sørg for at den klikkede seksjonen blir åpen før vi ekspanderer panelet.
    summary.parentElement.open = true;
    document.body.classList.remove(hiddenClass);
    updateUrl();
    setTimeout(() => map.invalidateSize(), 220);
  });
}

function renderStationCategoryCounts() {
  const counts = { station: 0, halt: 0, stop: 0, uic: 0 };
  for (const f of state.stationsData.features) {
    const t = f.properties.railway;
    if (counts[t] != null) counts[t]++;
    if (f.properties.uic_ref) counts.uic++;
  }
  for (const [k, n] of Object.entries(counts)) {
    const el = document.getElementById(`cnt-${k}`);
    if (el) el.textContent = `(${n})`;
  }
}


// ---------- Felles helpers eksponert til andre sider (bane.html, dashboard.html) ----------
// Vanilla JS uten build-step → vi henger Leaflet-stilfunksjonene på
// `window.AppHelpers` så andre sider potensielt kan gjenbruke dem.
// Felles datamotstykker (isElectrified, buildSpeedProfile, bucketSpeed,
// bucketTrack, co2EstimateTonnesPerYear, fmtNum, ...) bor i helpers.js
// og charts.js — lastet før app.js og dermed allerede tilgjengelig.
Object.assign(window.AppHelpers || (window.AppHelpers = {}), {
  styleForElectrification,
  styleForSpeed,
  styleForType,
  styleForTracks,
  statCell,
});
