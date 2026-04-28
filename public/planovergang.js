// planovergang.html-logikk: leser ?id=, slår opp i planoverganger.geojson,
// viser hero + mini-kart + faktaboks + nærmeste-stasjon-kontekst.
//
// Hver av de ~2086 jernbanekryssingene i NVDB får sin egen URL via ?id=,
// uten at vi genererer statiske filer. Mønster kopiert fra stasjon.html.

(function () {
  "use strict";

  const { fmtDate } = window.AppHelpers;

  function $(sel) { return document.querySelector(sel); }

  function regionFor(lat, lon) {
    if (lat >= 65) return "Nord-Norge";
    if (lat >= 62.5) return "Trøndelag";
    if (lon < 7.5) return "Vestlandet";
    if (lat < 59.5 && lon < 9) return "Sørlandet";
    return "Østlandet";
  }

  function haversineM(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function renderEmpty(id) {
    const root = $("#planovergang-content");
    root.replaceChildren();
    const wrap = document.createElement("div");
    wrap.className = "route-empty";
    const h1 = document.createElement("h1");
    h1.textContent = "Planovergang ikke funnet";
    const p = document.createElement("p");
    p.textContent = id
      ? `Ingen jernbanekryssing med NVDB-ID «${id}» i datasettet. Datasettet ble sist oppdatert ved siste pipeline-kjøring.`
      : "Mangler ?id=-parameter i URL-en.";
    const back = document.createElement("p");
    const a = document.createElement("a");
    a.href = "index.html";
    a.textContent = "← Tilbake til kart";
    back.append(a);
    wrap.append(h1, p, back);
    root.append(wrap);
    window.__plov = { ready: true, empty: true };
  }

  function findNearestStation(stations, lat, lon) {
    let best = null;
    let bestDist = Infinity;
    for (const f of stations.features) {
      const p = f.properties || {};
      if (p.railway !== "station" && p.railway !== "halt") continue;
      const [olon, olat] = f.geometry.coordinates;
      if (Math.abs(olat - lat) > 0.5) continue; // bbox-prefilter
      const d = haversineM(lat, lon, olat, olon);
      if (d < bestDist) {
        bestDist = d;
        best = { feature: f, distanceM: Math.round(d) };
      }
    }
    return best;
  }

  function findNearestRoute(routes, lat, lon) {
    // Hver rute har et par representative koordinater i stats — vi har
    // ikke segmentene her uten å laste railways.geojson (8 MB). I stedet
    // bruker vi rutens innhold (route.bbox eller første-/siste-stasjon
    // hvis tilgjengelig). Vi går for en pragmatisk tilnærming: navnet på
    // den ruten som har en stasjon nær — videreført som sekundær info.
    return null;  // placeholder; fylles ut senere når vi har segment-data per rute
  }

  function findNeighbours(allCrossings, ownId, lat, lon, maxDistM = 5000, n = 5) {
    const others = [];
    for (const f of allCrossings.features) {
      if (String(f.properties.id) === String(ownId)) continue;
      const [olon, olat] = f.geometry.coordinates;
      if (Math.abs(olat - lat) > 0.05) continue;  // ~5.5 km bbox
      const d = haversineM(lat, lon, olat, olon);
      if (d > maxDistM) continue;
      others.push({ feature: f, distanceM: Math.round(d) });
    }
    others.sort((a, b) => a.distanceM - b.distanceM);
    return others.slice(0, n);
  }

  function renderPlanovergang(feature, allCrossings, stations) {
    const props = feature.properties || {};
    const [lon, lat] = feature.geometry.coordinates;
    const id = props.id;
    const type = props.type || "Ukjent type";

    document.title = `Planovergang ${id} — Norsk jernbane`;
    $("#crumb-current").textContent = `NVDB ${id}`;
    $("#planovergang-h1").textContent = type;

    const root = $("#planovergang-content");
    root.replaceChildren();

    // Hero
    const hero = window.AppHelpers.renderHeroCards([
      [type, "TYPE"],
      [props.fare || "Ingen", "SÆRSKILT FARE"],
      [regionFor(lat, lon), "REGION"],
      [`NVDB ${id}`, "ID"],
    ]);
    root.append(hero);

    // 2-kol: mini-kart + faktaboks
    const grid = document.createElement("div");
    grid.className = "route-grid";

    const mapWrap = document.createElement("div");
    const mapEl = document.createElement("div");
    mapEl.id = "planovergang-map";
    mapWrap.append(mapEl);

    grid.append(mapWrap, renderFactsCard(feature));
    root.append(grid);

    // Kontekst-seksjon
    root.append(renderContextSection(feature, stations));

    // Naboer
    const neighbours = findNeighbours(allCrossings, id, lat, lon);
    if (neighbours.length > 0) {
      root.append(renderNeighboursSection(neighbours));
    }

    initMap(mapEl, feature, stations, allCrossings);

    window.__plov = { ready: true, feature };
  }

  function renderFactsCard(feature) {
    const p = feature.properties || {};
    const [lon, lat] = feature.geometry.coordinates;
    const card = document.createElement("aside");
    card.className = "card route-stats-card";
    const h2 = document.createElement("h2");
    h2.className = "section-title";
    h2.textContent = "Fakta";
    card.append(h2);

    const rows = [
      ["NVDB-ID", String(p.id)],
      ["Type", p.type || "—"],
      ["Særskilt fare", p.fare || "—"],
      ["Region", regionFor(lat, lon)],
      ["Koordinat", `${lat.toFixed(5)}, ${lon.toFixed(5)}`],
    ];
    if (p.tilleggsinfo) {
      rows.push(["Tilleggsinfo", p.tilleggsinfo]);
    }

    const ul = document.createElement("ul");
    ul.className = "micro-list";
    for (const [k, v] of rows) {
      const li = document.createElement("li");
      const a = document.createElement("span"); a.textContent = k;
      const b = document.createElement("span"); b.className = "km"; b.textContent = v;
      li.append(a, b);
      ul.append(li);
    }
    card.append(ul);

    // Lenke til NVDB
    const nvdbLink = document.createElement("a");
    nvdbLink.className = "external-link";
    nvdbLink.href = `https://vegkart.atlas.vegvesen.no/#kartlag/geodata/objekt/100/${p.id}`;
    nvdbLink.target = "_blank";
    nvdbLink.rel = "noopener";
    nvdbLink.textContent = "Vis i NVDB Vegkart →";
    card.append(nvdbLink);

    return card;
  }

  function renderContextSection(feature, stations) {
    const [lon, lat] = feature.geometry.coordinates;
    const section = document.createElement("section");
    section.className = "card";
    const h2 = document.createElement("h2");
    h2.className = "section-title";
    h2.textContent = "Kontekst";
    section.append(h2);

    const nearest = findNearestStation(stations, lat, lon);
    const ul = document.createElement("ul");
    ul.className = "micro-list";
    if (nearest) {
      const stName = nearest.feature.properties.name || "(uten navn)";
      const li = document.createElement("li");
      const k = document.createElement("span");
      k.textContent = "Nærmeste stasjon";
      const v = document.createElement("span");
      v.className = "km";
      const a = document.createElement("a");
      a.href = `stasjon.html?navn=${encodeURIComponent(stName)}`;
      a.textContent = `${stName} (${nearest.distanceM} m)`;
      v.append(a);
      li.append(k, v);
      ul.append(li);
    } else {
      const li = document.createElement("li");
      const k = document.createElement("span"); k.textContent = "Nærmeste stasjon";
      const v = document.createElement("span"); v.className = "km"; v.textContent = "—";
      li.append(k, v);
      ul.append(li);
    }
    section.append(ul);

    return section;
  }

  function renderNeighboursSection(neighbours) {
    const section = document.createElement("section");
    section.className = "card";
    const h2 = document.createElement("h2");
    h2.className = "section-title";
    h2.textContent = `Andre kryssinger i nærheten (${neighbours.length})`;
    section.append(h2);

    const ul = document.createElement("ul");
    ul.className = "micro-list";
    for (const { feature: f, distanceM } of neighbours) {
      const p = f.properties || {};
      const li = document.createElement("li");
      const left = document.createElement("span");
      const a = document.createElement("a");
      a.href = `planovergang.html?id=${p.id}`;
      a.textContent = `NVDB ${p.id} — ${p.type || "Ukjent type"}`;
      left.append(a);
      const right = document.createElement("span");
      right.className = "km";
      right.textContent = `${distanceM} m`;
      li.append(left, right);
      ul.append(li);
    }
    section.append(ul);
    return section;
  }

  function initMap(mapEl, feature, stations, allCrossings) {
    const [lon, lat] = feature.geometry.coordinates;
    const map = L.map(mapEl, { zoomControl: true, preferCanvas: true })
      .setView([lat, lon], 15);

    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© OpenStreetMap-bidragsytere",
      maxZoom: 19,
    }).addTo(map);

    // Hovedmarkør
    L.circleMarker([lat, lon], {
      radius: 10,
      color: "#fff",
      weight: 2,
      fillColor: "#dc2626",
      fillOpacity: 1,
    }).addTo(map).bindTooltip(`NVDB ${feature.properties.id}`, {
      permanent: true, direction: "top", offset: [0, -10],
    });

    // Naboer (andre planoverganger) i nærheten
    const dLat = 0.05;
    const dLon = 0.1;
    let neighbours = 0;
    for (const f of allCrossings.features) {
      if (String(f.properties.id) === String(feature.properties.id)) continue;
      const [olon, olat] = f.geometry.coordinates;
      if (Math.abs(olat - lat) > dLat) continue;
      if (Math.abs(olon - lon) > dLon) continue;
      const m = L.circleMarker([olat, olon], {
        radius: 4,
        color: "#fff",
        weight: 1,
        fillColor: "#fca5a5",
        fillOpacity: 0.9,
      }).addTo(map);
      m.bindTooltip(`NVDB ${f.properties.id}`);
      m.on("click", () => {
        location.href = `planovergang.html?id=${f.properties.id}`;
      });
      neighbours++;
      if (neighbours >= 25) break;
    }

    // Stasjoner i samme bbox — som klikkbare lenker
    let stns = 0;
    for (const f of stations.features) {
      const p = f.properties || {};
      if (p.railway !== "station" && p.railway !== "halt") continue;
      const [olon, olat] = f.geometry.coordinates;
      if (Math.abs(olat - lat) > dLat) continue;
      if (Math.abs(olon - lon) > dLon) continue;
      const m = L.circleMarker([olat, olon], {
        radius: 5,
        color: "#fff",
        weight: 2,
        fillColor: "#1a3a52",
        fillOpacity: 0.9,
      }).addTo(map);
      const name = p.name || "(uten navn)";
      m.bindTooltip(name);
      m.on("click", () => {
        location.href = `stasjon.html?navn=${encodeURIComponent(name)}`;
      });
      stns++;
      if (stns >= 15) break;
    }

    return map;
  }

  async function init() {
    const params = new URLSearchParams(location.search);
    const id = params.get("id");
    if (!id) {
      renderEmpty(null);
      return;
    }

    let crossings, stations, stats;
    try {
      [crossings, stations, stats] = await Promise.all([
        fetch("data/planoverganger.geojson").then((r) => r.json()),
        fetch("data/stations.geojson").then((r) => r.json()),
        fetch("data/stats.json").then((r) => r.json()).catch(() => null),
      ]);
    } catch (e) {
      renderEmpty(id);
      console.error("[planovergang] kunne ikke laste data:", e);
      return;
    }

    if (stats?.generated_at) {
      const fd = $("#footer-date");
      if (fd) {
        try { fd.textContent = fmtDate(stats.generated_at); }
        catch { fd.textContent = stats.generated_at; }
      }
    }

    const feature = crossings.features.find(
      (f) => String(f.properties?.id) === String(id)
    );
    if (!feature) {
      renderEmpty(id);
      return;
    }

    renderPlanovergang(feature, crossings, stations);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
