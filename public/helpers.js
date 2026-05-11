// Felles helpers for sub-sider (bane.html, dashboard.html).
// Disse er rene funksjoner uten avhengighet til kart-tilstand i app.js,
// så de kan deles uten å laste hele app.js på sub-sidene.
//
// På index.html lastes app.js etter denne filen og overstyrer
// window.AppHelpers med en utvidet versjon (samme subset + flere
// kart-spesifikke helpers). Det er trygt fordi felles-funksjonene
// er identiske med kopiene i app.js.

(function () {
  "use strict";

  const SPEED_BUCKET_COLORS = {
    "<80": "#94a3b8",
    "80–130": "#60a5fa",
    "130–160": "#3b82f6",
    "160–200": "#2563eb",
    "200+": "#1d4ed8",
    "Ukjent": "#cbd5e1",
  };

  const TYPE_COLORS = {
    rail: "#1a3a52",
    narrow_gauge: "#a16207",
    preserved: "#7c3aed",
  };

  // Brukes av befolkningsdekning på både kart og dashbord. Speiler
  // `bands`-rekkefølgen i process.py:compute_population_coverage.
  const COVERAGE_COLORS = {
    "≤2 km": "#16a34a",
    "2–5 km": "#65a30d",
    "5–10 km": "#ca8a04",
    "10–25 km": "#ea580c",
    ">25 km": "#dc2626",
  };

  // Sidespor og rangering ekskluderes fra hastighets-/sporkapasitets-
  // aggregering på alle sider. MÅ stemme med `excluded_service` i
  // process.py:compute_speed_distribution / track_capacity_km.
  const EXCLUDED_SERVICE = Object.freeze(
    new Set(["siding", "yard", "spur", "crossover"])
  );

  // CO₂-anslag for ikke-elektrifiserte strekninger. Konstantene speiler
  // process.py:estimate_diesel_co2_tonnes — endrer du Python-versjonen,
  // endre disse også. Paritet håndheves av tests/binning-parity.test.js.
  const CO2_ASSUMPTIONS = Object.freeze({
    trainsPerDay: 10,
    grossTonnes: 250,
    days: 365,
    kgPerGtk: 0.05,
  });
  const CO2_ASSUMPTION_TEXT =
    `${CO2_ASSUMPTIONS.trainsPerDay} tog/døgn × ${CO2_ASSUMPTIONS.grossTonnes} t × ${CO2_ASSUMPTIONS.kgPerGtk} kg CO₂/GTK`;

  function co2EstimateTonnesPerYear(nonElectrifiedKm) {
    const c = CO2_ASSUMPTIONS;
    return Math.round(
      nonElectrifiedKm * c.trainsPerDay * c.grossTonnes * c.days * c.kgPerGtk / 1000
    );
  }

  // Returner bøttenavnet for en hastighet (km/t) — eller null hvis
  // segmentet skal ekskluderes basert på service-tag. Speiler
  // process.py:compute_speed_distribution.
  function bucketSpeed(speed, service) {
    if (service && EXCLUDED_SERVICE.has(service)) return null;
    if (speed == null) return "Ukjent";
    if (speed < 80) return "<80";
    if (speed < 130) return "80–130";
    if (speed < 160) return "130–160";
    if (speed < 200) return "160–200";
    return "200+";
  }

  // Returner bøttenavnet for sporkapasitet basert på OSM-tag
  // `passenger_lines` (kan være null/string/tall). Speiler
  // process.py:track_capacity_km.
  function bucketTrack(passengerLinesRaw, service) {
    if (service && EXCLUDED_SERVICE.has(service)) return null;
    if (passengerLinesRaw == null || passengerLinesRaw === "") return "Ikke tagget";
    const n = parseInt(passengerLinesRaw, 10);
    if (Number.isNaN(n)) return "Ikke tagget";
    if (n <= 1) return "Enkeltspor";
    if (n === 2) return "Dobbeltspor";
    return "Multispor (3+)";
  }

  function isElectrified(props) {
    const e = (props.electrified || "").toLowerCase();
    return Boolean(e) && e !== "no";
  }

  function prettyType(type) {
    return ({
      rail: "Tog",
      narrow_gauge: "Smalspor",
      preserved: "Museumsbane",
    })[type] || type;
  }

  function fmtNum(n) {
    return Math.round(n).toLocaleString("nb-NO");
  }

  function fmtDate(iso) {
    if (!iso) return "—";
    try {
      return new Date(iso).toLocaleDateString("nb-NO", {
        year: "numeric", month: "long", day: "numeric",
      });
    } catch { return iso; }
  }

  // Hardkodet sammenligningstall fra offentlige kilder. Oppdateres manuelt
  // ~1× per år. Hver tall har kilde + årstall i kommentar slik at vi ser
  // når de bør refreshes.
  const BENCHMARKS = Object.freeze({
    countries_km: {
      "Sverige": 14600,    // Trafikverket, 2023
      "Sveits": 5200,      // BAV, 2023 (sammenlignbart med Norge)
      "Tyskland": 33000,   // DB Netz, 2023
      "Danmark": 3000,     // Banedanmark, 2023
      "Norge": null,       // settes til stats.total_km ved bruk
    },
    // Elektrifiseringsrate per land (%). Brukes i sammenligningskortet.
    // Kilder: nasjonale jernbanestatistikker, 2023.
    countries_electrified_pct: {
      "Sverige": 75,       // Trafikverket
      "Sveits": 100,       // BAV (nær 100 % siden 1960-tallet)
      "Tyskland": 62,      // DB Netz
      "Danmark": 30,       // Banedanmark (mye av-elektrifisering på sidebaner)
      "Norge": null,       // settes til stats.electrified_pct ved bruk
    },
    norway_road_km: 94000, // SSB offentlig vei, 2023
  });

  // MÅ stemme med `slugify()` i data/process.py — endrer du den ene,
  // endre begge. Brukes til å mappe rute-navn → routes/{slug}.geojson.
  function slugify(name) {
    return (name || "").toLowerCase().trim()
      .replace(/æ/g, "ae")
      .replace(/ø/g, "o")
      .replace(/å/g, "a")
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9\-]/g, "")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "uten-navn";
  }

  // Bygger en .dash-hero-section med fire (eller flere) tall-kort.
  // `items` er [[num, desc], ...]. Brukes på dashbord og bane-siden.
  // Lag en liten "?"-knapp med popover-forklaring. Brukes ved tekniske
  // termer (passenger_lines, service=siding) som ikke alle vet hva er.
  // Klikk åpner popover; klikk utenfor eller Esc lukker.
  function infoTip(text) {
    const wrap = document.createElement("span");
    wrap.className = "info-tip-wrap";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "info-tip";
    btn.setAttribute("aria-label", "Mer informasjon");
    btn.setAttribute("aria-expanded", "false");
    btn.textContent = "?";
    const pop = document.createElement("span");
    pop.className = "info-tip-pop";
    pop.setAttribute("role", "tooltip");
    pop.hidden = true;
    pop.textContent = text;
    wrap.append(btn, pop);

    function close() {
      pop.hidden = true;
      btn.setAttribute("aria-expanded", "false");
      document.removeEventListener("click", onDocClick, true);
      document.removeEventListener("keydown", onKey);
    }
    function onDocClick(e) {
      if (!wrap.contains(e.target)) close();
    }
    function onKey(e) {
      if (e.key === "Escape") close();
    }
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = !pop.hidden;
      if (open) { close(); return; }
      pop.hidden = false;
      btn.setAttribute("aria-expanded", "true");
      document.addEventListener("click", onDocClick, true);
      document.addEventListener("keydown", onKey);
    });
    return wrap;
  }

  function renderHeroCards(items) {
    const wrap = document.createElement("section");
    wrap.className = "dash-hero";
    wrap.setAttribute("aria-label", "Nøkkeltall");
    for (const [num, desc] of items) {
      const card = document.createElement("div");
      card.className = "card dash-hero-card";
      const n = document.createElement("span");
      n.className = "num";
      n.textContent = num;
      const d = document.createElement("span");
      d.className = "desc";
      d.textContent = desc;
      card.append(n, d);
      wrap.append(card);
    }
    return wrap;
  }

  // Generell stacked-bar med farger per bøtte og legend under.
  // `entries` er [[label, value], ...] (ikke et objekt — bevarer rekkefølge).
  // `colors` er en map fra label→hex. `fmtTitle(label, value, total)`
  // returnerer hover-tekst per segment. `fmtLegend(label, value)` returnerer
  // tekst i legend-itemet. `totalOverride` brukes når totalen ikke er
  // summen av entries (f.eks. når noen verdier er filtrert bort).
  function buildStackedBar({ entries, colors, fmtTitle, fmtLegend, totalOverride }) {
    const wrap = document.createElement("div");
    wrap.className = "speed-profile";
    const total = totalOverride ?? entries.reduce((s, [, v]) => s + v, 0);
    if (total === 0) return wrap;

    const bar = document.createElement("div");
    bar.className = "speed-bar";
    for (const [label, value] of entries) {
      if (value <= 0) continue;
      const seg = document.createElement("span");
      seg.className = "seg";
      seg.style.width = `${(value / total) * 100}%`;
      seg.style.background = colors[label] || "#888";
      seg.title = fmtTitle ? fmtTitle(label, value, total) : `${label}: ${value}`;
      bar.append(seg);
    }
    wrap.append(bar);

    const legend = document.createElement("div");
    legend.className = "speed-legend";
    for (const [label, value] of entries) {
      if (value <= 0) continue;
      const item = document.createElement("span");
      const sw = document.createElement("i");
      sw.style.background = colors[label] || "#888";
      const text = fmtLegend ? fmtLegend(label, value) : `${label}: ${value}`;
      item.append(sw, document.createTextNode(text));
      legend.append(item);
    }
    wrap.append(legend);
    return wrap;
  }

  // Bakoverkompatibel wrapper rundt buildStackedBar med
  // hastighets-spesifikke fargesett og format.
  function buildSpeedProfile(distribution) {
    return buildStackedBar({
      entries: Object.entries(distribution),
      colors: SPEED_BUCKET_COLORS,
      fmtTitle: (b, km, total) =>
        `${b} km/t — ${km.toFixed(1)} km (${Math.round(100 * km / total)}%)`,
      fmtLegend: (b, km) => `${b}: ${km.toFixed(0)} km`,
    });
  }

  window.AppHelpers = Object.assign(window.AppHelpers || {}, {
    SPEED_BUCKET_COLORS,
    TYPE_COLORS,
    COVERAGE_COLORS,
    EXCLUDED_SERVICE,
    CO2_ASSUMPTIONS,
    CO2_ASSUMPTION_TEXT,
    BENCHMARKS,
    isElectrified,
    prettyType,
    fmtNum,
    fmtDate,
    slugify,
    bucketSpeed,
    bucketTrack,
    co2EstimateTonnesPerYear,
    buildStackedBar,
    buildSpeedProfile,
    renderHeroCards,
    infoTip,
  });
})();
