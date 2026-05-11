// stasjon.html-logikk: leser ?navn= eller ?id=, finner stasjonen i
// stations.geojson, viser hero + mini-kart + live avganger/avvik.
//
// Stasjonsider er destinasjonen for rike per-stasjon-integrasjoner
// (Riksantikvaren, Wikidata, MET, Frost). Slot-er er allerede plassert
// så de kan kobles på uten layoutendringer.
//
// Lastes av: stasjon.html
// Krever: Leaflet (global L), window.AppHelpers (helpers.js), window.Entur (entur.js)
// Data:    data/stations.geojson, data/wikidata_stations.json (valgfritt)

(function () {
  "use strict";

  const { prettyType, fmtDate } = window.AppHelpers;

  function $(sel) { return document.querySelector(sel); }

  function regionFor(lat, lon) {
    if (lat >= 65) return "Nord-Norge";
    if (lat >= 62.5) return "Trøndelag";
    if (lon < 7.5) return "Vestlandet";
    if (lat < 59.5 && lon < 9) return "Sørlandet";
    return "Østlandet";
  }

  function prettyStationType(t) {
    return ({
      station: "Tog-stasjon",
      halt: "Holdeplass",
      stop: "Stoppunkt",
    })[t] || t;
  }

  // Velger beste match ved navne-kollisjon: forrang til railway=station
  // med UIC-ref, deretter station med ref, deretter station, så halt/stop.
  function pickBest(matches) {
    function score(f) {
      const p = f.properties;
      let s = 0;
      if (p.railway === "station") s += 100;
      else if (p.railway === "halt") s += 50;
      if (p.uic_ref) s += 20;
      if (p.ref) s += 10;
      if (p.operator) s += 5;
      return s;
    }
    return matches.slice().sort((a, b) => score(b) - score(a))[0];
  }

  function renderEmpty(navn) {
    const root = $("#station-content");
    root.replaceChildren();
    const wrap = document.createElement("div");
    wrap.className = "route-empty";
    const h1 = document.createElement("h1");
    h1.textContent = "Stasjon ikke funnet";
    const p = document.createElement("p");
    p.textContent = navn
      ? `Fant ingen stasjon med navn «${navn}».`
      : "Mangler ?navn=-parameter i URL-en.";
    const back = document.createElement("p");
    const a = document.createElement("a");
    a.href = "index.html";
    a.textContent = "← Tilbake til kart";
    back.append(a);
    wrap.append(h1, p, back);
    root.append(wrap);
    window.__station = { ready: true, empty: true };
  }

  function renderStation(feature, all) {
    const props = feature.properties;
    const [lon, lat] = feature.geometry.coordinates;
    const navn = props.name || "(uten navn)";

    document.title = `${navn} — Norsk jernbane`;
    $("#crumb-current").textContent = navn;

    const h1 = $("#station-h1");
    h1.replaceChildren(document.createTextNode(navn));
    const badge = document.createElement("span");
    badge.className = "pill pill-primary";
    badge.textContent = prettyStationType(props.railway);
    h1.append(badge);

    const root = $("#station-content");
    root.replaceChildren();

    // Hero-kort
    const heroItems = [
      [props.operator || "—", "OPERATØR"],
      [props.uic_ref || "—", "UIC-REF"],
      [regionFor(lat, lon), "REGION"],
      [`${lat.toFixed(3)}, ${lon.toFixed(3)}`, "POSISJON"],
    ];
    root.append(window.AppHelpers.renderHeroCards(heroItems));

    // 2-kol: kart + faktaboks
    const grid = document.createElement("div");
    grid.className = "route-grid";

    const mapWrap = document.createElement("div");
    const mapEl = document.createElement("div");
    mapEl.id = "station-map";
    mapWrap.append(mapEl);

    grid.append(mapWrap, renderFactsCard(feature));
    root.append(grid);

    // Live avganger og avvik
    root.append(renderLiveSection(feature));

    // Plassholder for kommende integrasjoner. Skjult inntil koblet på.
    root.append(renderSlot("station-cultural-slot", "Kulturminne"));
    root.append(renderSlot("station-wiki-slot", "Wikidata"));
    root.append(renderSlot("station-weather-slot", "Vær"));

    initMap(mapEl, feature, all);
    loadLive(feature);
    renderWikidata(feature);
    renderRoutesPassing(root, feature);

    window.__station = { ...(window.__station || {}), ready: true, feature };
  }

  function renderRoutesPassing(root, feature) {
    const lookup = window.__station?.stationRoutes || {};
    const routes = lookup[feature.properties.name];
    if (!routes || routes.length === 0) return;

    const section = document.createElement("section");
    section.className = "card station-routes-section";
    const h2 = document.createElement("h2");
    h2.className = "section-title";
    h2.textContent = `Ruter som stopper (${routes.length})`;
    section.append(h2);

    const ul = document.createElement("ul");
    ul.className = "micro-list station-routes-list";
    for (const r of routes) {
      const li = document.createElement("li");
      const left = document.createElement("span");
      const linkLabel = r.ref ? `${r.ref} ${r.name}` : r.name;
      // Hvis navnet matcher en bane i stats.routes, lenk til bane.html.
      const baneMatch = (window.__station?.allRoutes || []).find(
        (b) => b.name === r.name
      );
      if (baneMatch) {
        const a = document.createElement("a");
        a.href = `bane.html?navn=${encodeURIComponent(r.name)}`;
        a.textContent = linkLabel;
        left.append(a);
      } else {
        left.textContent = linkLabel;
      }
      const right = document.createElement("span");
      right.className = "km";
      right.textContent = r.operator || "—";
      li.append(left, right);
      ul.append(li);
    }
    section.append(ul);
    root.append(section);
  }

  function renderWikidata(feature) {
    const wd = window.__station?.wikidata?.[feature.properties.name];
    if (!wd) return;

    // Kulturminne-status får sin egen seksjon hvis tilgjengelig.
    if (wd.heritage && wd.heritage.length > 0) {
      const slot = document.getElementById("station-cultural-slot");
      slot.replaceChildren();
      slot.hidden = false;
      const h2 = document.createElement("h2");
      h2.className = "section-title";
      h2.textContent = "Kulturminne";
      slot.append(h2);

      const ul = document.createElement("ul");
      ul.className = "micro-list";
      for (const h of wd.heritage) {
        const li = document.createElement("li");
        const span = document.createElement("span");
        span.textContent = h;
        li.append(span);
        ul.append(li);
      }
      slot.append(ul);

      if (wd.ra_id) {
        const link = document.createElement("a");
        link.href = `https://kulturminnesok.no/minne?queryString=${wd.ra_id}`;
        link.target = "_blank";
        link.rel = "noopener";
        link.textContent = "Vis i Kulturminnesøk →";
        link.className = "external-link";
        slot.append(link);
      }
    }

    // Wikidata-info: bilde, åpningsår, arkitekt, lenke til Wikipedia.
    const slot = document.getElementById("station-wiki-slot");
    slot.replaceChildren();
    slot.hidden = false;
    const h2 = document.createElement("h2");
    h2.className = "section-title";
    h2.textContent = "Bakgrunn (Wikidata)";
    slot.append(h2);

    const wrap = document.createElement("div");
    wrap.className = "wiki-wrap";

    if (wd.image) {
      const img = document.createElement("img");
      // Wikimedia Commons-URL kan brukes direkte. Vi setter en bredde-grense
      // for å unngå å laste ned megabyte-store originalbilder.
      img.src = wd.image.replace(
        /^https:\/\/commons\.wikimedia\.org\/wiki\/Special:FilePath\//,
        "https://commons.wikimedia.org/wiki/Special:FilePath/",
      ) + "?width=480";
      img.alt = `Bilde av ${wd.name}`;
      img.className = "wiki-image";
      img.loading = "lazy";
      wrap.append(img);
    }

    const facts = document.createElement("ul");
    facts.className = "micro-list wiki-facts";
    if (wd.opened) {
      const li = document.createElement("li");
      const k = document.createElement("span"); k.textContent = "Åpnet";
      const v = document.createElement("span"); v.className = "km";
      v.textContent = wd.opened;
      li.append(k, v);
      facts.append(li);
    }
    if (wd.architects && wd.architects.length) {
      const li = document.createElement("li");
      const k = document.createElement("span"); k.textContent = "Arkitekt";
      const v = document.createElement("span"); v.className = "km";
      v.textContent = wd.architects.join(", ");
      li.append(k, v);
      facts.append(li);
    }
    const li = document.createElement("li");
    const k = document.createElement("span"); k.textContent = "Wikidata";
    const a = document.createElement("a");
    a.href = `https://www.wikidata.org/wiki/${wd.qid}`;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = wd.qid;
    a.className = "km";
    li.append(k, a);
    facts.append(li);
    wrap.append(facts);

    slot.append(wrap);
  }

  function renderFactsCard(feature) {
    const props = feature.properties;
    const [lon, lat] = feature.geometry.coordinates;
    const card = document.createElement("aside");
    card.className = "card route-stats-card";
    const h2 = document.createElement("h2");
    h2.className = "section-title";
    h2.textContent = "Fakta";
    card.append(h2);

    const rows = [
      ["Type", prettyStationType(props.railway)],
      ["Operatør", props.operator || "—"],
      ["UIC-ref", props.uic_ref || "—"],
      ["OSM-ref", props.ref || "—"],
      ["Region", regionFor(lat, lon)],
      ["Koordinat", `${lat.toFixed(5)}, ${lon.toFixed(5)}`],
    ];
    if (props.uic_name && props.uic_name !== props.name) {
      rows.push(["UIC-navn", props.uic_name]);
    }
    if (props.network) {
      rows.push(["Nettverk", props.network]);
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
    return card;
  }

  function renderSlot(id, label) {
    const section = document.createElement("section");
    section.className = "card station-slot";
    section.id = id;
    section.dataset.label = label;
    section.hidden = true;
    return section;
  }

  function renderLiveSection(feature) {
    const section = document.createElement("section");
    section.className = "card station-live-section";
    const h2 = document.createElement("h2");
    h2.className = "section-title";
    h2.textContent = "Sanntid (Entur)";
    section.append(h2);

    const sit = document.createElement("div");
    sit.className = "situations";
    sit.dataset.role = "situations";
    section.append(sit);

    const dep = document.createElement("div");
    dep.className = "departures";
    dep.dataset.role = "departures";
    const placeholder = document.createElement("div");
    placeholder.className = "dep-placeholder";
    placeholder.textContent = "Henter avganger fra Entur…";
    dep.append(placeholder);
    section.append(dep);

    return section;
  }

  function initMap(mapEl, feature, all) {
    const [lon, lat] = feature.geometry.coordinates;
    const map = L.map(mapEl, { zoomControl: true, preferCanvas: true })
      .setView([lat, lon], 14);

    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© OpenStreetMap-bidragsytere",
      maxZoom: 19,
    }).addTo(map);

    // Hovedmarker for valgt stasjon
    L.circleMarker([lat, lon], {
      radius: 9,
      fillColor: "#2563eb",
      color: "#fff",
      weight: 2,
      fillOpacity: 1,
    }).addTo(map).bindTooltip(feature.properties.name || "(uten navn)", {
      permanent: true, direction: "top", offset: [0, -10],
    });

    // Naboer i samme bbox — gir kontekst uten å laste hele kartet.
    const dLat = 0.025;
    const dLon = 0.05;
    let neighbours = 0;
    for (const f of all.features) {
      if (f === feature) continue;
      const [olon, olat] = f.geometry.coordinates;
      if (Math.abs(olat - lat) > dLat) continue;
      if (Math.abs(olon - lon) > dLon) continue;
      const m = L.circleMarker([olat, olon], {
        radius: 4,
        fillColor: "#94a3b8",
        color: "#fff",
        weight: 1,
        fillOpacity: 0.9,
      }).addTo(map);
      const name = f.properties.name || "(uten navn)";
      m.bindTooltip(name);
      m.on("click", () => {
        location.href = `stasjon.html?navn=${encodeURIComponent(name)}`;
      });
      neighbours++;
      if (neighbours >= 30) break; // tak på markører
    }

    return map;
  }

  async function loadLive(feature) {
    const [lon, lat] = feature.geometry.coordinates;
    const sitSlot = document.querySelector(".station-live-section .situations");
    const depSlot = document.querySelector(".station-live-section .departures");
    if (!window.Entur) return;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    try {
      const stop = await window.Entur.findStopPlace(lat, lon, controller.signal);
      if (!stop) {
        clearTimeout(timeoutId);
        depSlot.replaceChildren();
        const p = document.createElement("p");
        p.className = "dep-status muted";
        p.textContent = "Ingen Entur-data for denne stasjonen.";
        depSlot.append(p);
        return;
      }

      const [calls, situations] = await Promise.all([
        window.Entur.fetchDepartures(stop.id, 10, controller.signal),
        window.Entur.fetchSituations(stop.id, controller.signal).catch(() => []),
      ]);
      clearTimeout(timeoutId);

      renderSituations(sitSlot, situations);
      renderDepartures(depSlot, stop, calls);
    } catch (err) {
      clearTimeout(timeoutId);
      depSlot.replaceChildren();
      const p = document.createElement("p");
      p.className = "dep-status error";
      p.textContent = `Klarte ikke hente sanntidsdata: ${err.message}`;
      depSlot.append(p);
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

  function renderDepartures(slot, stop, calls) {
    slot.replaceChildren();

    const heading = document.createElement("strong");
    heading.textContent = `${stop.name} — neste avganger`;
    slot.append(heading);

    if (!calls || calls.length === 0) {
      const p = document.createElement("p");
      p.className = "dep-status muted";
      p.textContent = "Ingen togavganger neste 2 timer.";
      slot.append(p);
      return;
    }

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

  async function init() {
    const params = new URLSearchParams(location.search);
    const navn = params.get("navn");
    const id = params.get("id");
    if (!navn && !id) {
      renderEmpty(null);
      return;
    }

    let stations, stats, wikidata, stationRoutes;
    try {
      [stations, stats, wikidata, stationRoutes] = await Promise.all([
        fetch("data/stations.geojson").then((r) => r.json()),
        fetch("data/stats.json").then((r) => r.json()).catch(() => null),
        fetch("data/wikidata_stations.json").then((r) => r.ok ? r.json() : {}).catch(() => ({})),
        fetch("data/station_routes.json").then((r) => r.ok ? r.json() : {}).catch(() => ({})),
      ]);
    } catch (e) {
      renderEmpty(navn || id);
      console.error("[stasjon] Kunne ikke laste stations:", e);
      return;
    }
    window.__station = { ...(window.__station || {}), wikidata, stationRoutes };

    if (stats?.generated_at) {
      const fd = $("#footer-date");
      if (fd) {
        try {
          fd.textContent = fmtDate(stats.generated_at);
        } catch { fd.textContent = stats.generated_at; }
      }
    }
    if (stats?.routes) {
      window.__station = { ...(window.__station || {}), allRoutes: stats.routes };
    }

    let feature = null;
    if (id) {
      feature = stations.features.find((f) => String(f.properties.ref) === id || String(f.properties.uic_ref) === id);
    }
    if (!feature && navn) {
      const target = navn.toLowerCase().trim();
      const matches = stations.features.filter(
        (f) => (f.properties.name || "").toLowerCase().trim() === target
      );
      if (matches.length > 0) feature = pickBest(matches);
    }

    if (!feature) {
      renderEmpty(navn || id);
      return;
    }

    renderStation(feature, stations);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
