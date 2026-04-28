// bane.html-logikk: leser ?navn=, finner ruten i stats.routes,
// finner segmentene i railways.geojson, viser kart + stats + stasjoner.

(function () {
  "use strict";

  // Felles helpers fra helpers.js (lastes før denne).
  const { prettyType, buildSpeedProfile, slugify } = window.AppHelpers;

  function $(sel) { return document.querySelector(sel); }

  function styleForSpeed(props) {
    const speed = props.maxspeed_kmh;
    if (speed == null) return { color: "#aaa", weight: 3, opacity: 0.7 };
    const t = Math.max(0, Math.min(1, (speed - 40) / 160));
    const r = Math.round(43 + (229 - 43) * t);
    const g = Math.round(108 + (62 - 108) * t);
    const b = Math.round(176 + (62 - 176) * t);
    return { color: `rgb(${r}, ${g}, ${b})`, weight: 4, opacity: 0.95 };
  }

  function haversineKm([lon1, lat1], [lon2, lat2]) {
    const R = 6371;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  // Returnerer alle stasjoner som ligger innen `thresholdKm` fra et hvilket
  // som helst koordinatpunkt på en av rutens segmenter.
  function findStationsAlongRoute(stations, segments, thresholdKm = 0.2) {
    // Flat liste av alle [lon, lat] i rutens segmenter.
    const routeCoords = [];
    for (const f of segments) {
      if (f.geometry?.type === "LineString") {
        for (const c of f.geometry.coordinates) routeCoords.push(c);
      }
    }
    if (routeCoords.length === 0) return [];

    const matches = [];
    for (const st of stations.features) {
      const [lon, lat] = st.geometry.coordinates;
      let minKm = Infinity;
      for (const c of routeCoords) {
        const km = haversineKm([lon, lat], c);
        if (km < minKm) minKm = km;
        if (minKm < thresholdKm) break;  // tidlig exit
      }
      if (minKm < thresholdKm) {
        matches.push({ feature: st, distanceKm: minKm });
      }
    }
    return matches;
  }

  function renderEmpty(navn) {
    const root = $("#route-content");
    root.replaceChildren();
    const wrap = document.createElement("div");
    wrap.className = "route-empty";
    const h1 = document.createElement("h1");
    h1.textContent = "Bane ikke funnet";
    const p = document.createElement("p");
    if (navn) {
      p.textContent = `Fant ingen bane med navn «${navn}». Prøv en annen.`;
    } else {
      p.textContent = "Mangler ?navn=-parameter i URL-en.";
    }
    const back = document.createElement("p");
    const a = document.createElement("a");
    a.href = "index.html";
    a.textContent = "← Tilbake til kart";
    back.append(a);
    wrap.append(h1, p, back);
    root.append(wrap);
    window.__route = { ready: true, empty: true };
  }

  function renderRoute({ route, segments, stations, allStations }) {
    document.title = `${route.name} — Norsk jernbane`;
    $("#crumb-current").textContent = route.name;

    // Page-header: tittel + ev. type-pill ved siden
    const h1 = $("#route-h1");
    h1.replaceChildren(document.createTextNode(route.name));
    if (route.types?.length) {
      const badge = document.createElement("span");
      badge.className = "pill pill-primary";
      badge.textContent = route.types.map(prettyType).join(" · ");
      h1.append(badge);
    }

    const root = $("#route-content");
    root.replaceChildren();

    // Hero-tall (matcher dashbord-mønsteret)
    root.append(renderHero(route, stations.length));

    // 2-kol grid
    const grid = document.createElement("div");
    grid.className = "route-grid";

    const mapWrap = document.createElement("div");
    const mapEl = document.createElement("div");
    mapEl.id = "route-map";
    mapWrap.append(mapEl);

    const statsCard = renderStatsCard(route);

    grid.append(mapWrap, statsCard);
    root.append(grid);

    // Stasjoner langs banen
    const stationsSection = renderStationsSection(stations);
    root.append(stationsSection);

    // Andre baner du kan se
    if (allStations) {
      // allStations brukes ikke direkte her — vi trenger stats.routes.
      // Sender med via globalt route-data sat opp i init().
    }
    if (window.__route?.allRoutes) {
      const related = renderRelatedRoutes(route, window.__route.allRoutes);
      if (related) root.append(related);
    }

    // Init map etter at #route-map er i DOM
    initMap(mapEl, segments, stations);
  }

  function renderHero(route, stationCount) {
    return window.AppHelpers.renderHeroCards([
      [`${route.total_km.toFixed(0)}`, "TOTAL LENGDE (KM)"],
      [`${route.electrified_pct}%`, "ELEKTRIFISERT"],
      [stationCount.toString(), "STASJONER LANGS"],
      [route.max_speed_kmh ? `${route.max_speed_kmh}` : "—", "MAKS KM/T"],
    ]);
  }

  function renderRelatedRoutes(currentRoute, allRoutes) {
    // Finn 5 baner nærmest i størrelse (men ikke samme rute)
    const others = allRoutes
      .filter((r) => r.name !== currentRoute.name)
      .map((r) => ({ ...r, diff: Math.abs(r.total_km - currentRoute.total_km) }))
      .sort((a, b) => a.diff - b.diff)
      .slice(0, 5);
    if (others.length === 0) return null;

    const section = document.createElement("section");
    section.className = "card route-related-section";
    const h2 = document.createElement("h2");
    h2.className = "section-title";
    h2.textContent = "Lignende baner i størrelse";
    section.append(h2);

    const list = document.createElement("ol");
    list.className = "dash-link-list";
    for (const r of others) {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = `bane.html?navn=${encodeURIComponent(r.name)}`;
      a.className = "dash-route-link";
      a.textContent = r.name;
      const meta = document.createElement("span");
      meta.className = "tail";
      const speed = r.max_speed_kmh ? `${r.max_speed_kmh} km/t · ` : "";
      meta.textContent = ` — ${r.total_km.toFixed(0)} km · ${speed}${r.electrified_pct}% elek.`;
      li.append(a, meta);
      list.append(li);
    }
    section.append(list);
    return section;
  }

  function renderStatsCard(route) {
    const card = document.createElement("aside");
    card.className = "card route-stats-card";
    const h2 = document.createElement("h2");
    h2.className = "section-title";
    h2.textContent = "Nøkkeltall";
    card.append(h2);

    const ul = document.createElement("ul");
    ul.className = "micro-list";
    const rows = [
      ["Total lengde", `${route.total_km.toFixed(1)} km`],
      ["Elektrifisert", `${route.electrified_pct}% (${route.electrified_km.toFixed(1)} km)`],
      ["Maks-hastighet", route.max_speed_kmh ? `${route.max_speed_kmh} km/t` : "—"],
      ["Snitt-hastighet", route.mean_speed_kmh ? `${route.mean_speed_kmh} km/t` : "—"],
    ];
    if (route.double_track_pct != null) {
      rows.push(["Dobbeltspor", `${route.double_track_pct}% (${route.double_track_km.toFixed(1)} km)`]);
    } else {
      rows.push(["Dobbeltspor", "ukjent"]);
    }
    rows.push(["Antall segmenter", route.segments.toString()]);
    if (route.operators?.length) {
      rows.push(["Operatører", route.operators.join(", ")]);
    }
    for (const [k, v] of rows) {
      const li = document.createElement("li");
      const a = document.createElement("span"); a.textContent = k;
      const b = document.createElement("span"); b.className = "km"; b.textContent = v;
      li.append(a, b);
      ul.append(li);
    }
    card.append(ul);

    if (route.speed_distribution_km) {
      const sub = document.createElement("p");
      sub.className = "subhead";
      sub.style.marginTop = "var(--sp-3)";
      sub.textContent = "Hastighetsprofil";
      card.append(sub);
      card.append(buildSpeedProfile(route.speed_distribution_km));
    }
    return card;
  }

  // Pragmatisk region-mapping basert på lat/lon. OSM-stasjoner har ikke
  // fylke-tag, så vi grupperer geografisk til 5 store regioner. Ikke
  // perfekt på grenseområder, men godt nok for navigering.
  function regionFor(lat, lon) {
    if (lat >= 65) return "Nord-Norge";
    if (lat >= 62.5) return "Trøndelag";
    if (lon < 7.5) return "Vestlandet";
    if (lat < 59.5 && lon < 9) return "Sørlandet";
    return "Østlandet";
  }
  const REGION_ORDER = ["Nord-Norge", "Trøndelag", "Vestlandet", "Sørlandet", "Østlandet"];

  function renderStationsSection(stationMatches) {
    const section = document.createElement("section");
    section.className = "card route-stations-section";
    const h2 = document.createElement("h2");
    h2.className = "section-title";
    h2.textContent = `Stasjoner langs banen (${stationMatches.length})`;
    section.append(h2);

    if (stationMatches.length === 0) {
      const p = document.createElement("p");
      p.style.color = "var(--c-muted)";
      p.textContent = "Ingen stasjoner funnet innen 200 m fra rutens trasé.";
      section.append(p);
      return section;
    }

    // Søkeboks over listen — filtrerer live på navn og operatør.
    const searchWrap = document.createElement("div");
    searchWrap.className = "station-search-wrap";
    const search = document.createElement("input");
    search.type = "search";
    search.className = "station-search";
    search.placeholder = `Søk blant ${stationMatches.length} stasjoner …`;
    search.setAttribute("aria-label", "Søk i stasjoner");
    const counter = document.createElement("span");
    counter.className = "station-search-counter";
    counter.textContent = `${stationMatches.length} av ${stationMatches.length}`;
    searchWrap.append(search, counter);
    section.append(searchWrap);

    // Grupper per region, behold rekkefølgen innen hver region (allerede
    // sortert "langs ruten" av kalleren).
    const groups = new Map();
    for (const m of stationMatches) {
      const [lon, lat] = m.feature.geometry.coordinates;
      const region = regionFor(lat, lon);
      if (!groups.has(region)) groups.set(region, []);
      groups.get(region).push(m);
    }

    const wrap = document.createElement("div");
    wrap.className = "station-groups";
    section.append(wrap);

    // Bygg én gruppe per region i fast rekkefølge (nord → øst).
    const allItems = [];  // for filtering
    for (const region of REGION_ORDER) {
      const items = groups.get(region);
      if (!items) continue;
      const group = document.createElement("div");
      group.className = "station-group";
      group.dataset.region = region;

      const heading = document.createElement("div");
      heading.className = "station-group-head";
      const label = document.createElement("span");
      label.className = "station-group-label";
      label.textContent = region;
      const count = document.createElement("span");
      count.className = "station-group-count";
      count.textContent = `${items.length}`;
      heading.append(label, count);
      group.append(heading);

      const ul = document.createElement("ul");
      ul.className = "station-list";
      for (const { feature: st } of items) {
        const li = buildStationRow(st);
        allItems.push({ li, name: (st.properties.name || "").toLowerCase(), operator: (st.properties.operator || "").toLowerCase() });
        ul.append(li);
      }
      group.append(ul);
      wrap.append(group);
    }

    // Live-søk over alle stasjoner. Tom søketekst = vis alle.
    search.addEventListener("input", () => {
      const q = search.value.trim().toLowerCase();
      let shown = 0;
      for (const item of allItems) {
        const match = !q || item.name.includes(q) || item.operator.includes(q);
        item.li.hidden = !match;
        if (match) shown++;
      }
      counter.textContent = `${shown} av ${allItems.length}`;
      // Skjul tomme grupper (alle radene filtrert bort)
      for (const group of wrap.querySelectorAll(".station-group")) {
        const visibleRows = [...group.querySelectorAll("li")].some((li) => !li.hidden);
        group.hidden = !visibleRows;
      }
    });

    return section;
  }

  function buildStationRow(st) {
    const props = st.properties;
    const li = document.createElement("li");
    li.className = "station-row";

    const head = document.createElement("button");
    head.type = "button";
    head.className = "station-head";
    const name = document.createElement("span");
    name.className = "station-name";
    name.textContent = props.name || "(uten navn)";
    const meta = document.createElement("span");
    meta.className = "station-meta";
    const op = props.operator ? props.operator + " · " : "";
    const typ = prettyStationType(props.railway);
    meta.textContent = `${op}${typ}${props.uic_ref ? ` · UIC ${props.uic_ref}` : ""}`;
    head.append(name, meta);
    li.append(head);

    // Lenke til full stasjonsside ved siden av accordion-knappen.
    if (props.name) {
      const stationLink = document.createElement("a");
      stationLink.className = "station-row-link";
      stationLink.href = `stasjon.html?navn=${encodeURIComponent(props.name)}`;
      stationLink.textContent = "Åpne →";
      stationLink.title = "Åpne full stasjonsside";
      li.append(stationLink);
    }

    const slot = document.createElement("div");
    slot.className = "departures-slot";
    slot.textContent = "Klikk for å vise avganger";
    slot.style.display = "none";
    li.append(slot);

    head.addEventListener("click", () => {
      const visible = slot.style.display !== "none";
      if (visible) {
        slot.style.display = "none";
      } else {
        slot.style.display = "block";
        loadDepartures(st, slot);
      }
    });

    return li;
  }

  function prettyStationType(t) {
    return ({ station: "Tog-stasjon", halt: "Holdeplass", stop: "Stoppunkt" })[t] || t;
  }

  async function loadDepartures(feature, slot) {
    if (slot.dataset.loaded === "1") return;
    if (!window.Entur) {
      slot.textContent = "Entur-modul mangler.";
      return;
    }
    slot.textContent = "Henter avganger fra Entur…";
    const [lon, lat] = feature.geometry.coordinates;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    try {
      const stop = await window.Entur.findStopPlace(lat, lon, controller.signal);
      if (!stop) {
        clearTimeout(timeoutId);
        slot.textContent = "Ingen Entur-data for denne stasjonen.";
        return;
      }
      // Hent avganger og avvik parallelt for å holde latensen lav i accordion-listen.
      const [calls, situations] = await Promise.all([
        window.Entur.fetchDepartures(stop.id, 8, controller.signal),
        window.Entur.fetchSituations(stop.id, controller.signal).catch(() => []),
      ]);
      clearTimeout(timeoutId);
      slot.replaceChildren();

      if (situations.length > 0) {
        const sitBox = document.createElement("div");
        sitBox.className = "situations situations-mini";
        const sitHead = document.createElement("strong");
        sitHead.textContent = situations.length === 1
          ? "Driftsmelding"
          : `Driftsmeldinger (${situations.length})`;
        sitBox.append(sitHead);
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
          sitBox.append(item);
        }
        slot.append(sitBox);
      }

      if (!calls || calls.length === 0) {
        const empty = document.createElement("div");
        empty.textContent = "Ingen kommende avganger.";
        slot.append(empty);
        return;
      }

      const heading = document.createElement("strong");
      heading.textContent = `${stop.name} — neste avganger`;
      slot.append(heading);

      const list = document.createElement("ul");
      list.className = "micro-list dep-mini-list";
      for (const call of calls) {
        const expected = new Date(call.expectedDepartureTime);
        const aimed = new Date(call.aimedDepartureTime);
        const delaySec = Math.round((expected - aimed) / 1000);
        const time = expected.toLocaleTimeString("nb-NO", { hour: "2-digit", minute: "2-digit" });
        const dest = call.destinationDisplay?.frontText || "?";
        const line = call.serviceJourney?.line?.publicCode || "";

        const li = document.createElement("li");
        const tNode = document.createElement("span");
        tNode.textContent = `${time} → ${dest}`;
        if (delaySec > 60) {
          tNode.classList.add("dep-delayed");
          tNode.title = `${Math.round(delaySec / 60)} min forsinket`;
        } else if (call.realtime) {
          tNode.title = "Sanntid";
        }
        const lNode = document.createElement("span");
        lNode.className = "km";
        lNode.textContent = line;
        li.append(tNode, lNode);
        list.append(li);
      }
      slot.append(list);
      slot.dataset.loaded = "1";
    } catch (e) {
      clearTimeout(timeoutId);
      const aborted = e.name === "AbortError";
      slot.replaceChildren();
      const msg = document.createElement("span");
      msg.textContent = aborted
        ? "Forespørselen tok for lang tid. "
        : "Kunne ikke hente avganger. ";
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "btn btn-primary btn-sm";
      retry.textContent = "Prøv igjen";
      retry.addEventListener("click", () => {
        delete slot.dataset.loaded;
        loadDepartures(feature, slot);
      });
      slot.append(msg, retry);
    }
  }

  function initMap(mapEl, segments, stationMatches) {
    const map = L.map(mapEl, { zoomControl: true, preferCanvas: true });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© OpenStreetMap-bidragsytere",
      maxZoom: 19,
    }).addTo(map);

    // Segmenter fargelagt etter hastighet (gir mest visuell verdi).
    const layer = L.geoJSON(
      { type: "FeatureCollection", features: segments },
      { style: (f) => styleForSpeed(f.properties) }
    ).addTo(map);

    // Stasjon-markører
    const stationGroup = L.layerGroup().addTo(map);
    for (const { feature: st } of stationMatches) {
      const [lon, lat] = st.geometry.coordinates;
      L.circleMarker([lat, lon], {
        radius: 4, color: "#1a3a52", weight: 1,
        fillColor: "#fff", fillOpacity: 0.95,
      }).bindTooltip(st.properties.name || "(uten navn)").addTo(stationGroup);
    }

    // Fit map til rutens bbox med litt margin.
    if (layer.getBounds().isValid()) {
      map.fitBounds(layer.getBounds(), { padding: [20, 20] });
    } else {
      map.setView([62, 13], 6);
    }

    window.__route = { map, ready: true };
  }

  async function init() {
    const params = new URLSearchParams(location.search);
    const navn = params.get("navn");
    if (!navn) {
      renderEmpty(null);
      return;
    }

    // Steg 1: stats + stations (begge små). railways.geojson er 8 MB —
    // vi venter med den til vi vet hvilken rute brukeren ba om, og laster
    // da bare per-rute-fila routes/{slug}.geojson.
    let stats, stations;
    try {
      [stats, stations] = await Promise.all([
        fetch("data/stats.json").then((r) => r.json()),
        fetch("data/stations.geojson").then((r) => r.json()),
      ]);
    } catch (e) {
      renderEmpty(navn);
      console.error("[bane] Kunne ikke laste stats/stations:", e);
      return;
    }

    if (stats.generated_at) {
      const fd = $("#footer-date");
      if (fd) {
        try {
          fd.textContent = new Date(stats.generated_at).toLocaleDateString("nb-NO", {
            year: "numeric", month: "long", day: "numeric",
          });
        } catch { fd.textContent = stats.generated_at; }
      }
    }

    const route = (stats.routes || []).find(
      (r) => r.name.toLowerCase().trim() === navn.toLowerCase().trim()
    );
    if (!route) {
      renderEmpty(navn);
      return;
    }

    // Eksponer alle ruter slik at renderRelatedRoutes kan finne nabolag.
    window.__route = { ...(window.__route || {}), allRoutes: stats.routes || [] };

    // Steg 2: last per-rute geojson. Slug fra stats er autoritativ — fall
    // tilbake til JS-slugify hvis gammel stats.json mangler feltet.
    const slug = route.slug || slugify(route.name);
    let routeGeo;
    try {
      const res = await fetch(`data/routes/${slug}.geojson`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      routeGeo = await res.json();
    } catch (e) {
      renderEmpty(navn);
      console.error(`[bane] Kunne ikke laste data/routes/${slug}.geojson:`, e);
      return;
    }

    const segments = routeGeo.features || [];

    const stationMatches = findStationsAlongRoute(stations, segments, 0.2);
    // Sorter etter koordinat — bruk lengde-aksen fra første-til-siste segment-koord
    // som omtrentlig "langs ruten"-ordning. Greit for v1.
    if (segments.length > 0) {
      const first = segments[0].geometry.coordinates[0];
      const last = segments[segments.length - 1].geometry.coordinates.slice(-1)[0];
      const dx = last[0] - first[0];
      const dy = last[1] - first[1];
      stationMatches.sort((a, b) => {
        const ax = a.feature.geometry.coordinates[0] - first[0];
        const ay = a.feature.geometry.coordinates[1] - first[1];
        const bx = b.feature.geometry.coordinates[0] - first[0];
        const by = b.feature.geometry.coordinates[1] - first[1];
        return (ax * dx + ay * dy) - (bx * dx + by * dy);
      });
    }

    renderRoute({ route, segments, stations: stationMatches, allStations: stations });
  }

  init();
})();
