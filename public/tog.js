// tog.html-logikk: følger ett bestemt tog (datedServiceJourney) i sanntid.
//
// Polling: 10 s når fanen er synlig, pause når den er skjult (Page
// Visibility API). Etter 3 påfølgende «ikke funnet»-polls regnes toget
// som ute av drift, og siden viser sist kjente posisjon med en banner.
//
// Identifikator (?id=) er datedServiceJourney.id som er stabil for hele
// avgangsdagen. Eksempel:
//   tog.html?id=VYG:DatedServiceJourney:67_OSL-BRG_26-04-28
//
// Lastes av: tog.html
// Krever: Leaflet (global L), window.Entur (entur.js)

(function () {
  "use strict";

  const POLL_MS = 10_000;
  const NOT_FOUND_TOLERANCE = 3;  // antall polls før vi merker som ute av drift

  function $(sel) { return document.querySelector(sel); }

  const ui = {
    initialized: false,
    map: null,
    marker: null,
    bearing: null,
    pollTimer: null,
    notFoundCount: 0,
    declaredEnded: false,
    lastSeen: null,        // siste vehicle-payload
    centerOnNext: true,
    journeyId: null,
    // LERP-state — animerer markøren glatt mellom to kjente posisjoner
    tween: null,           // { from: {lat,lon}, to: {lat,lon}, tStart, tEnd }
    raf: null,
  };

  const TOG_LERP_MS = POLL_MS;  // animer over hele poll-intervallet

  function fmtDelay(secondsRaw) {
    if (secondsRaw == null) return "—";
    const s = Number(secondsRaw);
    if (Number.isNaN(s)) return "—";
    if (Math.abs(s) < 60) return s > 0 ? `+${Math.round(s)} s` : `${Math.round(s)} s`;
    const m = Math.round(s / 60);
    return m > 0 ? `+${m} min` : `${m} min`;
  }

  function fmtSpeedKmh(speedMs) {
    if (speedMs == null) return "—";
    return `${Math.round(speedMs * 3.6)} km/t`;
  }

  function fmtRelative(iso) {
    if (!iso) return "—";
    const ms = Date.now() - Date.parse(iso);
    if (Number.isNaN(ms)) return iso;
    const s = Math.round(ms / 1000);
    if (s < 60) return `for ${s} sek siden`;
    const m = Math.round(s / 60);
    if (m < 60) return `for ${m} min siden`;
    const h = Math.round(m / 60);
    return `for ${h} t siden`;
  }

  function destinationFromLineName(name) {
    // lineName er ofte på format "A-B-C" — siste segment er endepunkt.
    if (!name) return null;
    const parts = name.split(/\s*[-–]\s*/);
    return parts.length > 1 ? parts[parts.length - 1].trim() : null;
  }

  function renderEmpty(id, reason) {
    const root = $("#tog-content");
    root.replaceChildren();
    const wrap = document.createElement("div");
    wrap.className = "route-empty";
    const h1 = document.createElement("h1");
    h1.textContent = "Toget ble ikke funnet";
    const p = document.createElement("p");
    p.textContent = id
      ? (reason || `Ingen aktive vehicles matcher datedServiceJourney «${id}». Avgangen er enten fullført, ennå ikke startet, eller utløpt fra Enturs sanntidsstrøm.`)
      : "Mangler ?id=-parameter i URL-en.";
    const back = document.createElement("p");
    const a = document.createElement("a");
    a.href = "index.html";
    a.textContent = "← Tilbake til kart";
    back.append(a);
    wrap.append(h1, p, back);
    root.append(wrap);
    window.__tog = { ready: true, empty: true };
  }

  function buildHero(v) {
    const lineCode = v.line?.publicCode || "?";
    const lineName = v.line?.lineName || "";
    const dest = v.destinationName || destinationFromLineName(lineName) || "—";
    return window.AppHelpers.renderHeroCards([
      [`${lineCode}`, "LINJE"],
      [dest, "RETNING"],
      [fmtDelay(v.delay), "FORSINKELSE"],
      [fmtSpeedKmh(v.speed), "HASTIGHET"],
    ]);
  }

  function buildStatusCard(v) {
    const card = document.createElement("aside");
    card.className = "card route-stats-card";
    const h2 = document.createElement("h2");
    h2.className = "section-title";
    h2.textContent = "Status";
    card.append(h2);

    const rows = [
      ["Linje", v.line?.lineName || v.line?.publicCode || "—"],
      ["Operatør", v.operator?.operatorRef || "—"],
      ["Sist sett", fmtRelative(v.lastUpdated)],
      ["Utløper", v.expiration ? fmtRelative(v.expiration) : "—"],
      ["Forsinkelse", fmtDelay(v.delay)],
      ["Sanntid", v.monitored ? "Ja" : "Nei"],
      ["VehicleID", v.vehicleId || "—"],
      ["DatedServiceJourney", v.datedServiceJourney?.id || "—"],
    ];

    const ul = document.createElement("ul");
    ul.className = "micro-list";
    for (const [k, val] of rows) {
      const li = document.createElement("li");
      const a = document.createElement("span"); a.textContent = k;
      const b = document.createElement("span"); b.className = "km"; b.textContent = val;
      li.append(a, b);
      ul.append(li);
    }
    card.append(ul);
    return card;
  }

  function renderInitial(v) {
    const root = $("#tog-content");
    root.replaceChildren();

    document.title = `${v.line?.publicCode || "Tog"} ${v.line?.lineName || ""} — Norsk jernbane`;
    $("#crumb-current").textContent = v.line?.publicCode || "Live";
    $("#tog-h1").replaceChildren(document.createTextNode(`${v.line?.publicCode || "?"} — ${v.line?.lineName || "Live tog"}`));

    // Hero
    root.append(buildHero(v));

    // 2-kol: kart + statuskort
    const grid = document.createElement("div");
    grid.className = "route-grid";

    const mapWrap = document.createElement("div");
    const mapEl = document.createElement("div");
    mapEl.id = "tog-map";
    mapWrap.append(mapEl);

    grid.append(mapWrap, buildStatusCard(v));
    root.append(grid);

    // Banner (skjult som standard, brukes ved «ute av drift»)
    const banner = document.createElement("div");
    banner.id = "tog-ended-banner";
    banner.className = "tog-ended";
    banner.hidden = true;
    root.append(banner);

    initMap(mapEl, v);

    ui.initialized = true;
    ui.lastSeen = v;
    window.__tog = { ready: true, journey: v.datedServiceJourney?.id };
  }

  function initMap(mapEl, v) {
    const lat = v.location?.latitude;
    const lon = v.location?.longitude;
    if (lat == null || lon == null) return;

    ui.map = L.map(mapEl, { zoomControl: true, preferCanvas: true })
      .setView([lat, lon], 12);

    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© OpenStreetMap-bidragsytere",
      maxZoom: 19,
    }).addTo(ui.map);

    ui.marker = L.circleMarker([lat, lon], {
      radius: 10,
      color: "#fff",
      weight: 3,
      fillColor: "#16a34a",
      fillOpacity: 1,
      className: "tog-marker",
    }).addTo(ui.map).bindTooltip(v.line?.publicCode || "Tog", {
      permanent: true, direction: "top", offset: [0, -10],
    });

    if (v.bearing != null) addBearingArrow(ui.map, lat, lon, v.bearing);
  }

  function addBearingArrow(map, lat, lon, bearing) {
    if (ui.bearing) {
      ui.bearing.remove();
    }
    // Liten DivIcon med roterende SVG-pil — lett, ingen runtime-cost.
    const html = `<svg width="22" height="22" viewBox="0 0 24 24" style="transform: rotate(${bearing}deg);">
      <path d="M12 2 L7 12 L12 9 L17 12 Z" fill="#16a34a" stroke="#fff" stroke-width="1.5"/>
    </svg>`;
    ui.bearing = L.marker([lat, lon], {
      icon: L.divIcon({
        html,
        className: "tog-bearing",
        iconSize: [22, 22],
        iconAnchor: [11, 11],
      }),
      interactive: false,
    }).addTo(map);
  }

  function updateStatusCard(v) {
    const oldCard = document.querySelector(".route-stats-card");
    if (!oldCard) return;
    const newCard = buildStatusCard(v);
    oldCard.replaceWith(newCard);
  }

  function updateHero(v) {
    const oldHero = document.querySelector(".dash-hero");
    if (!oldHero) return;
    const newHero = buildHero(v);
    oldHero.replaceWith(newHero);
  }

  function currentTweenLatLng(now) {
    if (!ui.tween) return null;
    const span = ui.tween.tEnd - ui.tween.tStart;
    if (span <= 0) return ui.tween.to;
    const t = Math.max(0, Math.min(1, (now - ui.tween.tStart) / span));
    return {
      lat: ui.tween.from.lat + (ui.tween.to.lat - ui.tween.from.lat) * t,
      lon: ui.tween.from.lon + (ui.tween.to.lon - ui.tween.from.lon) * t,
    };
  }

  function ensureRaf() {
    if (ui.raf) return;
    const tick = () => {
      if (!ui.marker || !ui.tween) {
        ui.raf = null;
        return;
      }
      const pos = currentTweenLatLng(Date.now());
      if (pos) {
        ui.marker.setLatLng([pos.lat, pos.lon]);
        if (ui.bearing) ui.bearing.setLatLng([pos.lat, pos.lon]);
      }
      ui.raf = requestAnimationFrame(tick);
    };
    ui.raf = requestAnimationFrame(tick);
  }

  function updateMarker(v) {
    if (!ui.map || !ui.marker) return;
    const lat = v.location?.latitude;
    const lon = v.location?.longitude;
    if (lat == null || lon == null) return;

    const now = Date.now();
    // Start fra der markøren faktisk er nå (kan være midt i en tidligere tween).
    const cur = ui.marker.getLatLng();
    ui.tween = {
      from: { lat: cur.lat, lon: cur.lng },
      to: { lat, lon },
      tStart: now,
      tEnd: now + TOG_LERP_MS,
    };
    ensureRaf();

    if (v.bearing != null) addBearingArrow(ui.map, lat, lon, v.bearing);
    if (ui.centerOnNext) {
      ui.map.panTo([lat, lon], { animate: true, duration: 1.2 });
      ui.centerOnNext = false;  // bare første gang, deretter må bruker re-sentere manuelt
    }
  }

  function showEndedBanner() {
    const banner = $("#tog-ended-banner");
    if (!banner || ui.declaredEnded) return;
    ui.declaredEnded = true;
    banner.hidden = false;
    banner.replaceChildren();
    const strong = document.createElement("strong");
    strong.textContent = "Toget rapporterer ikke lenger.";
    const p = document.createElement("p");
    p.textContent = "Avgangen er sannsynligvis fullført eller utløpt fra Enturs sanntidsstrøm. Siste kjente posisjon vises på kartet.";
    banner.append(strong, p);
    if (ui.pollTimer) {
      clearInterval(ui.pollTimer);
      ui.pollTimer = null;
    }
    if (ui.raf) {
      cancelAnimationFrame(ui.raf);
      ui.raf = null;
    }
    ui.tween = null;
  }

  async function pollOnce() {
    if (document.visibilityState !== "visible") return; // pause i bakgrunn
    let v;
    try {
      v = await window.Entur.findVehicle(ui.journeyId);
    } catch (err) {
      console.warn("[tog] poll feilet:", err.message);
      return;
    }

    if (!v) {
      ui.notFoundCount += 1;
      if (ui.notFoundCount >= NOT_FOUND_TOLERANCE && ui.initialized) {
        showEndedBanner();
      } else if (!ui.initialized) {
        renderEmpty(ui.journeyId);
      }
      return;
    }

    ui.notFoundCount = 0;
    if (!ui.initialized) {
      renderInitial(v);
    } else {
      ui.lastSeen = v;
      updateHero(v);
      updateStatusCard(v);
      updateMarker(v);
    }
  }

  function startPolling() {
    if (ui.pollTimer) return;
    pollOnce();
    ui.pollTimer = setInterval(pollOnce, POLL_MS);
  }

  function stopPolling() {
    if (ui.pollTimer) {
      clearInterval(ui.pollTimer);
      ui.pollTimer = null;
    }
    // Pause også animasjonen — vi vekkes opp igjen ved visibilitychange.
    if (ui.raf) {
      cancelAnimationFrame(ui.raf);
      ui.raf = null;
    }
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      startPolling();
    } else {
      stopPolling();
    }
  });

  async function init() {
    const params = new URLSearchParams(location.search);
    const id = params.get("id");
    if (!id) {
      renderEmpty(null);
      return;
    }
    ui.journeyId = id;

    // Footer: bruk stats.generated_at hvis den finnes
    fetch("data/stats.json").then((r) => r.json()).then((stats) => {
      if (stats?.generated_at) {
        const fd = $("#footer-date");
        if (fd) fd.textContent = window.AppHelpers.fmtDate(stats.generated_at);
      }
    }).catch(() => {});

    startPolling();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
