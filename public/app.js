// Norsk jernbane — kart, filter og statistikk.
// Krever Leaflet og Chart.js (lastet via CDN i index.html).

const NORWAY_CENTER = [64.5, 13.0];
const NORWAY_ZOOM = 5;

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

function styleForElectrification(props) {
  const e = (props.electrified || "").toLowerCase();
  const electrified = e && e !== "no";
  return {
    color: electrified ? "#2563eb" : "#d23f3f",
    weight: 2.5,
    opacity: 0.85,
  };
}

function styleForSpeed(props) {
  const speed = props.maxspeed_kmh;
  if (speed == null) return { color: "#aaa", weight: 1.5, opacity: 0.6 };
  const t = Math.max(0, Math.min(1, (speed - 40) / 160));
  const r = Math.round(43 + (229 - 43) * t);
  const g = Math.round(108 + (62 - 108) * t);
  const b = Math.round(176 + (62 - 176) * t);
  return { color: `rgb(${r}, ${g}, ${b})`, weight: 2.5, opacity: 0.9 };
}

const TYPE_COLORS = {
  rail: "#1a3a52",
  narrow_gauge: "#38a169",
  preserved: "#9b2c2c",
};

function styleForType(props) {
  return {
    color: TYPE_COLORS[props.railway] || "#888",
    weight: 2.5,
    opacity: 0.85,
  };
}

function styleForTracks(props) {
  const n = parseInt(props.passenger_lines, 10);
  if (Number.isNaN(n)) return { color: "#bbb", weight: 1.5, opacity: 0.55 };
  if (n >= 3) return { color: "#1d4ed8", weight: 3, opacity: 0.95 };
  if (n === 2) return { color: "#16a34a", weight: 2.8, opacity: 0.9 };
  return { color: "#ea580c", weight: 2.2, opacity: 0.85 };
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

function buildPopup(props) {
  const wrapper = document.createElement("div");
  wrapper.className = "popup-tags";
  const table = document.createElement("table");
  for (const [key, value] of Object.entries(props)) {
    if (key === "length_km" && !value) continue;
    const tr = document.createElement("tr");
    const tdKey = document.createElement("td");
    tdKey.textContent = key;
    const tdVal = document.createElement("td");
    tdVal.textContent = String(value);
    tr.append(tdKey, tdVal);
    table.append(tr);
  }
  wrapper.append(table);
  return wrapper;
}

// ---------- Datainnlasting ----------

async function loadData() {
  const [railways, stations, stats, wikidata, planoverganger] = await Promise.all([
    fetch("data/railways.geojson").then((r) => r.json()),
    fetch("data/stations.geojson").then((r) => r.json()),
    fetch("data/stats.json").then((r) => r.json()),
    fetch("data/wikidata_stations.json").then((r) => r.ok ? r.json() : {}).catch(() => ({})),
    fetch("data/planoverganger.geojson").then((r) => r.ok ? r.json() : null).catch(() => null),
  ]);
  state.railwaysData = railways;
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
    onEachFeature: (f, layer) => {
      const p = f.properties || {};
      const lines = [];
      if (p.type) lines.push(`<strong>${p.type}</strong>`);
      if (p.fare) lines.push(`Særskilt fare: ${p.fare}`);
      if (p.tilleggsinfo) lines.push(p.tilleggsinfo);
      lines.push(`<small>NVDB ID ${p.id}</small>`);
      lines.push(
        `<a class="btn btn-primary btn-sm popup-action" href="planovergang.html?id=${p.id}">Åpne side →</a>`
      );
      layer.bindPopup(`<div class="popup-planovergang">${lines.join("<br>")}</div>`);
    },
  }).addTo(map);
}

// Beregn nåværende rendret posisjon for en tween-entry.
function currentLerpLatLng(entry, now) {
  const span = entry.tEnd - entry.tStart;
  if (span <= 0) return { lat: entry.to.lat, lon: entry.to.lon };
  const t = Math.max(0, Math.min(1, (now - entry.tStart) / span));
  return {
    lat: entry.from.lat + (entry.to.lat - entry.from.lat) * t,
    lon: entry.from.lon + (entry.to.lon - entry.from.lon) * t,
  };
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
  const tooltipHtml =
    `<strong>${code}</strong>` +
    (lineName ? ` — ${lineName}` : "") +
    (v.bearing != null ? ` (${Math.round(v.bearing)}°)` : "");

  const marker = L.circleMarker(latLng, {
    radius: 6,
    color: "#fff",
    weight: 2,
    fillColor: "#16a34a",
    fillOpacity: 0.95,
  }).bindTooltip(tooltipHtml, { direction: "top" });

  const journeyId = v.datedServiceJourney?.id;
  if (journeyId) {
    const popupHtml =
      `<div class="popup-tog">` +
        `<strong>${code}</strong>` +
        (lineName ? `<br><small>${lineName}</small>` : "") +
        `<br><a class="btn btn-primary btn-sm popup-action" href="tog.html?id=${encodeURIComponent(journeyId)}">Følg dette toget →</a>` +
      `</div>`;
    marker.bindPopup(popupHtml);
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

  for (const v of vehicles) {
    const loc = v.location;
    const journeyId = v.datedServiceJourney?.id;
    if (!loc || !journeyId) continue;
    const ageMs = v.lastUpdated ? now - Date.parse(v.lastUpdated) : 0;
    if (ageMs > 5 * 60 * 1000) continue;
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
    } else {
      // Ny markør — start uten animasjon.
      const marker = buildLiveTrainMarker(v, [newPos.lat, newPos.lon]);
      state.liveTrainsLayer.addLayer(marker);
      state.liveTrainsTrains.set(journeyId, {
        marker,
        from: newPos,
        to: newPos,
        tStart: now,
        tEnd: now,
        bearing: v.bearing,
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

function setLiveTrains(map, on) {
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
    refreshLiveTrains(map);
    state.liveTrainsTimer = setInterval(() => refreshLiveTrains(map), LIVE_TRAINS_INTERVAL_MS);
  } else {
    const cnt = document.getElementById("cnt-live-trains");
    if (cnt) cnt.textContent = "";
  }
}

function renderStations(map) {
  if (state.stationLayer) map.removeLayer(state.stationLayer);
  const filtered = {
    type: "FeatureCollection",
    features: state.stationsData.features.filter(stationVisible),
  };
  state.stationLayer = L.geoJSON(filtered, {
    pointToLayer: (_f, latlng) =>
      L.circleMarker(latlng, {
        radius: state.searchQuery ? 6 : 4,
        color: state.searchQuery ? "#f59e0b" : "#1a3a52",
        weight: state.searchQuery ? 2 : 1,
        fillColor: "#fff",
        fillOpacity: 0.9,
      }),
    onEachFeature: (f, layer) => attachStationPopup(f, layer),
  }).addTo(map);
}

function attachStationPopup(feature, layer) {
  const content = buildPopup(feature.properties);

  // Vernestatus-badge øverst i popupen hvis vi har en Wikidata-match
  // med kulturminnestatus. Klikk på badgen åpner full stasjonsside.
  const wd = state.wikidata?.[feature.properties.name];
  if (wd?.heritage?.length) {
    const badge = document.createElement("div");
    badge.className = "popup-heritage-badge";
    badge.textContent = `🏛 ${wd.heritage[0]}`;
    badge.title = wd.heritage.join(" · ");
    content.prepend(badge);
  }

  // Reisetid-knapp — kjører Dijkstra fra denne stasjonen og fargelegger
  // sporene etter reisetid. Tilgjengelig på alle stasjons-popupper siden
  // det er et generelt analyseverktøy.
  const isoBtn = document.createElement("button");
  isoBtn.type = "button";
  isoBtn.className = "btn btn-secondary btn-block iso-btn";
  isoBtn.textContent = "Vis reisetider herfra";
  isoBtn.addEventListener("click", () => {
    const [lon, lat] = feature.geometry.coordinates;
    if (window.Isochrone && window.__app?.map) {
      window.__app.map.closePopup();
      window.Isochrone.run(window.__app.map, lat, lon);
    }
  });
  content.append(isoBtn);

  // Lenke til full stasjonsside (rik popup-erstatning).
  const name = feature.properties.name;
  if (name) {
    const link = document.createElement("a");
    link.className = "btn btn-primary btn-block station-page-link";
    link.href = `stasjon.html?navn=${encodeURIComponent(name)}`;
    link.textContent = "Åpne stasjonsside →";
    content.append(link);
  }

  const sit = document.createElement("div");
  sit.className = "situations";
  sit.dataset.role = "situations";
  content.append(sit);

  const dep = document.createElement("div");
  dep.className = "departures";
  dep.dataset.role = "departures";
  const placeholder = document.createElement("div");
  placeholder.className = "dep-placeholder";
  placeholder.textContent = "Avganger lastes når popup åpnes…";
  dep.append(placeholder);
  content.append(dep);

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
  return state.operators.slice(12).map(([op]) => op);
}

// ---------- Live statistikk i filterpanelet ----------

function updateLiveStats(visible) {
  if (!visible) visible = state.railwaysData.features.filter(featureVisible);
  const totalKm = visible.reduce((s, f) => s + (f.properties.length_km || 0), 0);
  const elecKm = visible.reduce((s, f) =>
    s + (isElectrified(f.properties) ? (f.properties.length_km || 0) : 0), 0);
  const all = state.stats.total_km;
  const pctOfAll = all > 0 ? (totalKm / all) * 100 : 0;
  const pctElec = totalKm > 0 ? (elecKm / totalKm) * 100 : 0;

  const el = document.getElementById("live-stats");
  el.replaceChildren();

  const labelEl = document.createElement("div");
  labelEl.className = "label";
  labelEl.textContent = "Synlig utvalg";
  el.append(labelEl);

  const big = document.createElement("div");
  big.className = "big";
  big.textContent = `${Math.round(totalKm).toLocaleString("nb-NO")} km`;
  el.append(big);

  const meter = document.createElement("div");
  meter.className = "meter";
  const fill = document.createElement("div");
  fill.style.width = `${Math.min(100, pctOfAll)}%`;
  meter.append(fill);
  el.append(meter);

  const sec = document.createElement("div");
  sec.className = "secondary";
  sec.textContent = `${pctOfAll.toFixed(1)}% av total · ${pctElec.toFixed(1)}% elektrifisert`;
  el.append(sec);

  const seg = document.createElement("div");
  seg.className = "secondary";
  seg.style.opacity = "0.75";
  seg.textContent = `${visible.length.toLocaleString("nb-NO")} segmenter`;
  el.append(seg);

  updateStatusBar(visible, totalKm);
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
      el.append(swatchRow("#d23f3f", "Ikke elektrifisert"));
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
      el.append(swatchRow("#aaa", "Ukjent hastighet"));
      break;
    }
    case "type":
      for (const [type, color] of Object.entries(TYPE_COLORS)) {
        el.append(swatchRow(color, prettyType(type)));
      }
      break;
    case "tracks":
      el.append(swatchRow("#ea580c", "Enkeltspor"));
      el.append(swatchRow("#16a34a", "Dobbeltspor"));
      el.append(swatchRow("#1d4ed8", "Multispor (3+)"));
      el.append(swatchRow("#bbb", "Ikke tagget"));
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

function updateStatusBar(visible, totalKm) {
  document.getElementById("status-km").textContent =
    Math.round(totalKm).toLocaleString("nb-NO");
  document.getElementById("status-segments").textContent =
    visible.length.toLocaleString("nb-NO");
  refreshFilterStatus();
}

// Oppdaterer kun filter-tekstdelen av statusbar — billig nok til å kjøre
// på hver filterendring (også når kun stasjoner endres).
function refreshFilterStatus() {
  const el = document.getElementById("status-filter");
  if (el) el.textContent = isFilterActive() ? filterSummary() : "Standardvisning";
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
  if (document.body.classList.contains("stats-hidden")) p.set("sp", "0");

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
  if (p.get("sp") === "0") document.body.classList.add("stats-hidden");

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
    if (e.key === "]") { e.preventDefault(); togglePanel(map, "stats"); return; }
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

  // URL-oppdatering: kjør etter hvert renderRailways/renderStations.
  // Wrap originale handler-utløsende renders ved å lytte på state-endring
  // via en MutationObserver-lignende variant. Enklere: bare oppdater URL i
  // wireFilters-callbackene. Lapper det her ved å etterhåndtere alle filter-events.
  document.querySelectorAll(
    '.sidebar input, .sidebar select, .sidebar button[data-bulk], #electrification-filter, #color-mode'
  ).forEach((el) => el.addEventListener("change", updateUrl));
  document.getElementById("search").addEventListener("input", () => {
    // Litt forsinket for at debounce-applySearch får oppdatere state først.
    setTimeout(updateUrl, 250);
  });
  document.querySelectorAll('.sidebar button[data-bulk]').forEach((b) =>
    b.addEventListener("click", updateUrl));
  document.getElementById("reset-filter").addEventListener("click", updateUrl);

  // Top-bar-knapper
  document.getElementById("btn-export").addEventListener("click", exportGeoJSON);
  document.getElementById("btn-help").addEventListener("click", openHelp);
  document.getElementById("help-close").addEventListener("click", closeHelp);
  document.getElementById("help-modal").addEventListener("click", (e) => {
    if (e.target.id === "help-modal") closeHelp();
  });

  document.getElementById("toggle-sidebar").addEventListener("click", () => togglePanel(map, "sidebar"));
  document.getElementById("toggle-stats").addEventListener("click", () => togglePanel(map, "stats"));

  // Icon-rail: klikk på en seksjons-ikon mens panelet er kollapset skal
  // ekspandere panelet og åpne den seksjonen — i stedet for å bare toggle
  // den (som er default <details>-oppførsel).
  bindRailClicks(map, document.querySelector(".sidebar"), "sidebar-hidden");
  bindRailClicks(map, document.querySelector(".stats-panel"), "stats-hidden");

  document.getElementById("loading").classList.add("hidden");
})();

function togglePanel(map, which) {
  const cls = which === "sidebar" ? "sidebar-hidden" : "stats-hidden";
  document.body.classList.toggle(cls);
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
