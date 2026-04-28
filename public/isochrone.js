// Reisetids-isokroner: bygg en graf fra jernbanesegmenter, kjør Dijkstra
// fra valgt stasjon, og fargelegg sporene etter reisetid i timer.
//
// Eksponerer window.Isochrone med:
//   - run(map, startLat, startLon, options) → starter analyse + tegning
//   - clear(map) → fjerner overlay
//   - isActive() → bool

(function () {
  "use strict";

  // Cachet graf — bygges først ved første kjøring siden det tar noen sekunder
  // og ikke alle brukere vil bruke funksjonen.
  let _graph = null;
  let _layer = null;
  let _statusEl = null;

  // Antatt hastighet for segmenter uten maxspeed-tag. 60 km/t er rimelig
  // konservativt (gjelder for det meste sidelinjer/lokal trafikk).
  const DEFAULT_SPEED_KMH = 60;

  // Avrunding av koordinater til ~11 m (4 desimaler) for å koble segmenter
  // som deler endepunkter — OSM-data har ofte små numeriske avvik mellom
  // tilstøtende segmenter.
  const COORD_PRECISION = 1e4;
  const nodeKey = (lon, lat) =>
    Math.round(lon * COORD_PRECISION) + "," + Math.round(lat * COORD_PRECISION);

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

  function buildGraph(features) {
    console.time("[isochrone] buildGraph");
    const nodes = new Map(); // key -> { lon, lat, edges: [{ toKey, hours }] }
    let edgeCount = 0;

    function getNode(lon, lat) {
      const k = nodeKey(lon, lat);
      let n = nodes.get(k);
      if (!n) {
        n = { lon, lat, edges: [] };
        nodes.set(k, n);
      }
      return n;
    }

    for (const f of features) {
      if (!f.geometry || f.geometry.type !== "LineString") continue;
      const coords = f.geometry.coordinates;
      // Hopp over museumsbaner — separate øyer som forurenser isokroner.
      // (T-bane/trikk/bybane/funicular er allerede filtrert bort i process.py.)
      if (f.properties.railway === "preserved") continue;
      const speed = f.properties.maxspeed_kmh || DEFAULT_SPEED_KMH;

      for (let i = 1; i < coords.length; i++) {
        const a = getNode(coords[i - 1][0], coords[i - 1][1]);
        const b = getNode(coords[i][0], coords[i][1]);
        if (a === b) continue;
        const km = haversineKm(coords[i - 1], coords[i]);
        const hours = km / speed;
        a.edges.push({ to: b, hours });
        b.edges.push({ to: a, hours });
        edgeCount += 2;
      }
    }
    console.timeEnd("[isochrone] buildGraph");
    console.log(`[isochrone] ${nodes.size} noder, ${edgeCount} kanter`);
    return nodes;
  }

  // Enkel binær min-heap. Ingen dependency, ~30 LOC, dekker behovet.
  class MinHeap {
    constructor() { this.h = []; }
    push(item) {
      this.h.push(item);
      let i = this.h.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (this.h[p][0] <= this.h[i][0]) break;
        [this.h[p], this.h[i]] = [this.h[i], this.h[p]];
        i = p;
      }
    }
    pop() {
      const top = this.h[0];
      const last = this.h.pop();
      if (this.h.length > 0) {
        this.h[0] = last;
        let i = 0;
        const n = this.h.length;
        while (true) {
          const l = 2 * i + 1, r = 2 * i + 2;
          let s = i;
          if (l < n && this.h[l][0] < this.h[s][0]) s = l;
          if (r < n && this.h[r][0] < this.h[s][0]) s = r;
          if (s === i) break;
          [this.h[s], this.h[i]] = [this.h[i], this.h[s]];
          i = s;
        }
      }
      return top;
    }
    get size() { return this.h.length; }
  }

  function dijkstra(graph, startNode, maxHours) {
    const dist = new Map();
    dist.set(startNode, 0);
    const pq = new MinHeap();
    pq.push([0, startNode]);

    while (pq.size > 0) {
      const [d, node] = pq.pop();
      if (d > maxHours) continue;
      if (d > (dist.get(node) ?? Infinity)) continue;

      for (const { to, hours } of node.edges) {
        const nd = d + hours;
        if (nd > maxHours) continue;
        if (nd < (dist.get(to) ?? Infinity)) {
          dist.set(to, nd);
          pq.push([nd, to]);
        }
      }
    }
    return dist;
  }

  function nearestNode(graph, lat, lon) {
    let best = null;
    let bestKm = Infinity;
    for (const node of graph.values()) {
      const km = haversineKm([lon, lat], [node.lon, node.lat]);
      if (km < bestKm) {
        bestKm = km;
        best = node;
      }
    }
    return { node: best, distanceKm: bestKm };
  }

  // Tidsbånd og fargene som rendres på kartet.
  const BANDS = [
    { maxHours: 0.5, color: "#16a34a", label: "≤30 min" },
    { maxHours: 1.0, color: "#65a30d", label: "30–60 min" },
    { maxHours: 2.0, color: "#ca8a04", label: "1–2 t" },
    { maxHours: 4.0, color: "#ea580c", label: "2–4 t" },
    { maxHours: 8.0, color: "#dc2626", label: "4–8 t" },
  ];

  function bandColor(hours) {
    for (const b of BANDS) if (hours <= b.maxHours) return b.color;
    return "#7f1d1d";
  }

  function ensureStatusBar(map) {
    if (_statusEl) return _statusEl;
    const div = L.DomUtil.create("div", "isochrone-status leaflet-bar");
    div.style.cssText = `
      position: absolute; top: 70px; left: 50%; transform: translateX(-50%);
      background: white; padding: 8px 14px; border-radius: 6px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.18); z-index: 1000;
      font-size: 13px; display: none; align-items: center; gap: 12px;
      max-width: 480px; line-height: 1.3;
    `;
    map.getContainer().append(div);
    _statusEl = div;
    return div;
  }

  function showStatus(map, ...children) {
    const el = ensureStatusBar(map);
    el.replaceChildren();
    el.append(...children);
    el.style.display = "flex";
  }

  function hideStatus() {
    if (_statusEl) _statusEl.style.display = "none";
  }

  function makeLegend() {
    const wrap = document.createElement("div");
    wrap.style.cssText = "display:flex; flex-wrap:wrap; gap:8px; align-items:center;";
    for (const b of BANDS) {
      const sw = document.createElement("span");
      sw.style.cssText = `display:inline-block;width:10px;height:10px;border-radius:2px;background:${b.color};margin-right:4px;vertical-align:middle;`;
      const item = document.createElement("span");
      item.style.cssText = "font-size:11px;color:#475569;display:inline-flex;align-items:center;";
      item.append(sw, document.createTextNode(b.label));
      wrap.append(item);
    }
    return wrap;
  }

  function clear(map) {
    if (_layer) {
      map.removeLayer(_layer);
      _layer = null;
    }
    hideStatus();
  }

  function run(map, lat, lon, options) {
    const features = options?.features
      || window.__app?.state?.railwaysData?.features;
    if (!features) {
      console.warn("[isochrone] mangler railways features");
      return;
    }
    if (!_graph) _graph = buildGraph(features);

    showStatus(map, document.createTextNode("Beregner reisetider…"));

    // Kort delay slik at "beregner…"-meldingen rekker å rendre.
    setTimeout(() => {
      const { node: startNode, distanceKm } = nearestNode(_graph, lat, lon);
      if (!startNode || distanceKm > 5) {
        showStatus(map, document.createTextNode(
          `Fant ingen jernbanenode innen 5 km av (${lat.toFixed(3)}, ${lon.toFixed(3)}).`
        ));
        return;
      }

      const maxHours = BANDS[BANDS.length - 1].maxHours;
      const dist = dijkstra(_graph, startNode, maxHours);

      // Tegn segmentene fargelagt etter beste reisetid (snitt av endepunktene).
      const drawn = [];
      for (const f of features) {
        if (!f.geometry || f.geometry.type !== "LineString") continue;
        if (f.properties.railway === "preserved") continue;
        const coords = f.geometry.coordinates;
        const a = _graph.get(nodeKey(coords[0][0], coords[0][1]));
        const b = _graph.get(nodeKey(coords[coords.length - 1][0], coords[coords.length - 1][1]));
        const da = a ? dist.get(a) : undefined;
        const db = b ? dist.get(b) : undefined;
        if (da == null && db == null) continue;
        const t = Math.min(da ?? Infinity, db ?? Infinity);
        drawn.push({ feature: f, hours: t });
      }

      if (_layer) map.removeLayer(_layer);
      _layer = L.geoJSON(
        { type: "FeatureCollection", features: drawn.map((d) => d.feature) },
        {
          style: (f, idx) => {
            const t = drawn.find((d) => d.feature === f)?.hours ?? 0;
            return { color: bandColor(t), weight: 4.5, opacity: 0.95 };
          },
        }
      ).addTo(map);

      // Pin på startpunktet
      const startMarker = L.circleMarker([startNode.lat, startNode.lon], {
        radius: 8,
        color: "#0f172a",
        weight: 2,
        fillColor: "#fff",
        fillOpacity: 1,
      }).addTo(_layer);
      startMarker.bindTooltip("Startpunkt", { permanent: false });

      // Status: stat + legend + lukk-knapp
      const text = document.createElement("span");
      text.append(
        document.createTextNode(`Nådd `),
      );
      const strong = document.createElement("strong");
      strong.textContent = `${drawn.length.toLocaleString("nb-NO")}`;
      text.append(strong, document.createTextNode(` segmenter på inntil ${maxHours} t fra startpunkt`));

      const legend = makeLegend();

      const close = document.createElement("button");
      close.type = "button";
      close.textContent = "✕ Lukk";
      close.style.cssText = "background:#1a3a52;color:white;border:none;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:12px;";
      close.addEventListener("click", () => clear(map));

      showStatus(map, text, legend, close);
    }, 50);
  }

  window.Isochrone = {
    run,
    clear,
    isActive: () => Boolean(_layer),
  };
})();
